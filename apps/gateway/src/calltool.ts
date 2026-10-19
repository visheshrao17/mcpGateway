import type { CallToolResult } from '@modelcontextprotocol/client';
import type { User } from './auth.ts';
import type { Config } from './config.ts';
import type { Pool } from './db.ts';
import { log } from './log.ts';
import { UpstreamError, type Route, type UpstreamManager } from './upstreams.ts';

export type Ctx = { config: Config; pool: Pool; manager: UpstreamManager };

export type Outcome = 'ok' | 'tool_error' | 'timeout' | 'unreachable' | 'denied' | 'unknown' | 'error';

export type CallResult = { outcome: Outcome; durationMs: number; result?: CallToolResult; error?: string };

const SECRET_KEY = /token|secret|password|key|authorization/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[…]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1)]));
  }
  return value;
}

export function argsSummary(args: unknown): string {
  return (JSON.stringify(redact(args ?? {})) ?? '').slice(0, 500);
}

export function viewFor(manager: UpstreamManager, user: Pick<User, 'role'>): Route[] {
  return [...manager.catalog.routes.values()].filter((r) => r.server.enabled && (user.role === 'admin' || !r.adminOnly));
}

function firstText(result: CallToolResult): string {
  const block = result.content?.find((c) => c.type === 'text') as { text?: string } | undefined;
  return (block?.text ?? '').slice(0, 300);
}

export async function recordDenial(
  pool: Pool,
  user: User,
  source: 'mcp' | 'chat',
  exposedName: string,
  args: Record<string, unknown>,
  error: string,
  route = undefined as Route | undefined,
): Promise<CallResult> {
  await pool.query(
    `INSERT INTO audit_log (user_id, user_email, source, server_slug, tool_name, args_summary, duration_ms, outcome, error) VALUES ($1, $2, $3, $4, $5, $6, 0, 'denied', $7)`,
    [user.id, user.email, source, route?.server.slug ?? null, route?.tool.name ?? exposedName, argsSummary(args), error],
  );
  return { outcome: 'denied', durationMs: 0, error };
}

async function refusalFromDatabase(pool: Pool, user: User, route: Route): Promise<string | undefined> {
  const { rows } = await pool.query<{ role: string; active: boolean; enabled: boolean | null; config_version: number | null; admin_only: boolean }>(
    `SELECT u.role, u.active, s.enabled, s.config_version, COALESCE(p.admin_only, false) AS admin_only
       FROM users u
       LEFT JOIN servers s ON s.id = $2
       LEFT JOIN tool_policies p ON p.server_id = $2 AND p.tool_name = $3
      WHERE u.id = $1`,
    [user.id, route.server.id, route.tool.name],
  );
  const current = rows[0];
  if (!current?.active) return 'user is deactivated';
  if (!current.enabled) return `server ${route.server.slug} is disabled or removed`;
  if (current.config_version !== route.server.config_version) return `server ${route.server.slug} configuration changed; list tools again`;
  if (current.admin_only && current.role !== 'admin') return 'this tool is restricted to admins';
  return undefined;
}

export async function callTool(ctx: Ctx, user: User, source: 'mcp' | 'chat', exposedName: string, args: Record<string, unknown>): Promise<CallResult> {
  const { pool, manager } = ctx;
  const route = manager.catalog.routes.get(exposedName);
  const summary = argsSummary(args);

  const deny = (error: string) => recordDenial(pool, user, source, exposedName, args, error, route);

  if (!route) return deny(`unknown tool: ${exposedName}`);
  const refusal = await refusalFromDatabase(pool, user, route);
  if (refusal) return deny(refusal);

  const started = Date.now();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO audit_log (user_id, user_email, source, server_slug, tool_name, args_summary, outcome) VALUES ($1, $2, $3, $4, $5, $6, 'pending') RETURNING id`,
    [user.id, user.email, source, route.server.slug, route.tool.name, summary],
  );
  const auditId = rows[0]!.id;

  let outcome: Outcome;
  let result: CallToolResult | undefined;
  let error: string | undefined;
  try {
    result = await manager.call(route, args);
    outcome = result.isError ? 'tool_error' : 'ok';
    if (result.isError) error = firstText(result) || 'upstream returned isError';
  } catch (err) {
    const e = err instanceof UpstreamError ? err : new UpstreamError('error', (err as Error).message);
    outcome = e.kind;
    error = e.message;
    if (e.kind === 'timeout' && (route.tool.annotations as { readOnlyHint?: boolean } | null)?.readOnlyHint !== true) {
      outcome = 'unknown';
      error = `${e.message}; the call may have been applied; verify before retrying`;
    }
  }
  const durationMs = Date.now() - started;
  await pool
    .query('UPDATE audit_log SET outcome = $2, duration_ms = $3, error = $4 WHERE id = $1', [auditId, outcome, durationMs, error ?? null])
    .catch((e) => log('error', 'audit finalize failed', { audit_id: auditId, error: (e as Error).message }));
  log('info', 'tool call', { source, user_id: user.id, server: route.server.slug, tool: route.tool.name, outcome, duration_ms: durationMs });
  return { outcome, durationMs, result, error };
}
