import { createHash } from 'node:crypto';
import pg from 'pg';
import { Client, StreamableHTTPClientTransport, type CallToolResult, type Tool } from '@modelcontextprotocol/client';
import type { Config } from './config.ts';
import { decryptSecret } from './crypto.ts';
import { tx, type Pool } from './db.ts';
import { log } from './log.ts';
import { assignExposedNames } from './naming.ts';
import { guardedFetch, SsrfError, type SsrfPolicy } from './ssrf.ts';

export const CHANNEL = 'urumi_changes';

export type ServerRow = {
  id: string;
  slug: string;
  name: string;
  url: string;
  auth_type: 'none' | 'bearer' | 'header';
  auth_header_name: string | null;
  credential_enc: Buffer | null;
  enabled: boolean;
  config_version: number;
};

export type ToolRow = {
  server_id: string;
  name: string;
  description: string | null;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown> | null;
  annotations: Record<string, unknown> | null;
};

export type Route = { exposedName: string; server: ServerRow; tool: ToolRow; adminOnly: boolean };

type Catalog = { servers: Map<string, ServerRow>; routes: Map<string, Route>; fingerprint: string };

export type UpstreamFailure = 'timeout' | 'unreachable' | 'error';

export class UpstreamError extends Error {
  kind: UpstreamFailure;
  constructor(kind: UpstreamFailure, message: string) {
    super(message);
    this.kind = kind;
  }
}

export async function notifyChange(client: pg.PoolClient | Pool, kind: 'registry' | 'users' = 'registry') {
  await client.query('SELECT pg_notify($1, $2)', [CHANNEL, kind]);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new UpstreamError('timeout', `timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function causes(err: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let e = err; e && chain.length < 6; e = (e as { cause?: unknown }).cause) chain.push(e);
  return chain;
}

export function classifyError(err: unknown, timeoutMs: number): UpstreamError {
  if (err instanceof UpstreamError) return err;
  for (const e of causes(err)) {
    if (e instanceof SsrfError) return new UpstreamError('unreachable', `blocked: ${e.message}`);
    const any = e as { code?: unknown; name?: string; status?: number };
    if (any.code === 'REQUEST_TIMEOUT' || any.name === 'TimeoutError') return new UpstreamError('timeout', `timed out after ${timeoutMs}ms`);
    if (typeof any.status === 'number') return new UpstreamError('error', `HTTP ${any.status} from upstream`);
    if (any.code === 'ECONNREFUSED') return new UpstreamError('unreachable', 'connection refused');
    if (any.code === 'ENOTFOUND' || any.code === 'EAI_AGAIN') return new UpstreamError('unreachable', 'host not found');
    if (any.code === 'EHOSTUNREACH' || any.code === 'ENETUNREACH') return new UpstreamError('unreachable', 'host unreachable');
    if (any.code === 'ECONNRESET' || any.code === 'UND_ERR_SOCKET') return new UpstreamError('error', 'connection reset by upstream');
  }
  return new UpstreamError('error', ((err as Error)?.message ?? String(err)).slice(0, 300));
}

function hashTools(tools: Tool[]): string {
  const canonical = [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => [t.name, t.description ?? null, t.inputSchema, t.outputSchema ?? null, t.annotations ?? null]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export class UpstreamManager {
  catalog: Catalog = { servers: new Map(), routes: new Map(), fingerprint: '' };
  onToolsChanged: () => void = () => {};

  private pool: Pool;
  private config: Config;
  private fetch: typeof fetch;
  private clients = new Map<string, { key: number; client: Promise<Client> }>();
  private generations = new Map<string, number>();
  private timers = new Map<string, NodeJS.Timeout>();
  private inflight = new Map<string, Promise<void>>();
  private listener?: pg.Client;
  private reloading?: Promise<void>;
  private reloadAgain = false;
  private stopped = false;

  constructor(pool: Pool, config: Config, policy: SsrfPolicy) {
    this.pool = pool;
    this.config = config;
    this.fetch = guardedFetch(policy);
  }

  async start() {
    await this.listen();
    await this.reload();
  }

  async stop() {
    this.stopped = true;
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    await this.listener?.end().catch(() => {});
    await Promise.allSettled([...this.inflight.values()]);
    for (const id of [...this.clients.keys()]) this.dropClient(id);
  }

  private async listen() {
    if (this.stopped) return;
    const listener = new pg.Client({ connectionString: this.config.databaseUrl });
    listener.on('notification', (msg) => {
      if (msg.payload === 'users') this.onToolsChanged();
      else this.reload().catch((err) => log('error', 'registry reload failed', { error: (err as Error).message }));
    });
    listener.on('error', (err) => {
      log('warn', 'change listener lost, reconnecting', { error: err.message });
      listener.end().catch(() => {});
      if (this.listener === listener) this.listener = undefined;
      setTimeout(() => {
        this.listen().then(() => this.reload()).catch(() => {});
      }, 1000).unref();
    });
    await listener.connect();
    await listener.query(`LISTEN ${CHANNEL}`);
    this.listener = listener;
  }

  reload(): Promise<void> {
    if (this.reloading) {
      this.reloadAgain = true;
      return this.reloading;
    }
    this.reloading = (async () => {
      do {
        this.reloadAgain = false;
        await this.loadOnce();
      } while (this.reloadAgain);
    })().finally(() => {
      this.reloading = undefined;
    });
    return this.reloading;
  }

  private async loadOnce() {
    const [servers, tools, policies] = await Promise.all([
      this.pool.query<ServerRow>('SELECT id, slug, name, url, auth_type, auth_header_name, credential_enc, enabled, config_version FROM servers ORDER BY slug'),
      this.pool.query<ToolRow>('SELECT t.server_id, t.name, t.description, t.input_schema, t.output_schema, t.annotations FROM server_tools t JOIN servers s ON s.id = t.server_id ORDER BY s.slug, t.name'),
      this.pool.query<{ server_id: string; tool_name: string }>('SELECT server_id, tool_name FROM tool_policies WHERE admin_only'),
    ]);
    const serverMap = new Map(servers.rows.map((s) => [s.id, s]));
    const adminOnly = new Set(policies.rows.map((p) => `${p.server_id}\0${p.tool_name}`));
    const names = assignExposedNames(tools.rows.map((t) => ({ slug: serverMap.get(t.server_id)!.slug, tool: t.name })));
    const routes = new Map<string, Route>();
    tools.rows.forEach((tool, i) => {
      routes.set(names[i]!, { exposedName: names[i]!, server: serverMap.get(tool.server_id)!, tool, adminOnly: adminOnly.has(`${tool.server_id}\0${tool.name}`) });
    });
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([...routes.values()].map((r) => [r.exposedName, r.server.enabled, r.adminOnly, r.tool.description, r.tool.input_schema, r.tool.output_schema, r.tool.annotations])))
      .digest('hex');

    const previous = this.catalog.servers;
    this.catalog = { servers: serverMap, routes, fingerprint: this.catalog.fingerprint };

    for (const [id, old] of previous) {
      const now = serverMap.get(id);
      if (!now || !now.enabled || now.config_version !== old.config_version) this.invalidate(id);
    }
    for (const server of serverMap.values()) {
      const old = previous.get(server.id);
      const changed = !old || !old.enabled || old.config_version !== server.config_version;
      if (server.enabled && (changed || !this.timers.has(server.id))) {
        this.schedule(server.id);
        if (changed) void this.refresh(server.id);
      }
    }

    if (fingerprint !== this.catalog.fingerprint) {
      this.catalog.fingerprint = fingerprint;
      this.onToolsChanged();
    }
  }

  private invalidate(id: string) {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    this.dropClient(id);
    const timer = this.timers.get(id);
    if (timer) clearInterval(timer);
    this.timers.delete(id);
  }

  private schedule(id: string) {
    if (this.stopped) return;
    const existing = this.timers.get(id);
    if (existing) clearInterval(existing);
    const timer = setInterval(() => void this.refresh(id), this.config.refreshIntervalMs);
    timer.unref();
    this.timers.set(id, timer);
  }

  private dropClient(id: string) {
    const entry = this.clients.get(id);
    this.clients.delete(id);
    entry?.client.then((c) => c.close()).catch(() => {});
  }

  private client(server: ServerRow): Promise<Client> {
    const key = server.config_version;
    const existing = this.clients.get(server.id);
    if (existing && existing.key === key) return existing.client;
    if (existing) this.dropClient(server.id);

    const headers: Record<string, string> = {};
    if (server.auth_type !== 'none' && server.credential_enc) {
      const credential = decryptSecret(this.config.masterKey, server.credential_enc, server.slug);
      if (server.auth_type === 'bearer') headers.Authorization = `Bearer ${credential}`;
      else if (server.auth_header_name) headers[server.auth_header_name] = credential;
    }
    const ms = this.config.listTimeoutMs;
    const client = new Client({ name: 'urumi-mcp-gateway', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers }, fetch: this.fetch });
    const connecting = withTimeout(client.connect(transport, { timeout: ms }), ms).then(
      () => client,
      (err) => {
        client.close().catch(() => {});
        if (this.clients.get(server.id)?.client === connecting) this.clients.delete(server.id);
        throw classifyError(err, ms);
      },
    );
    this.clients.set(server.id, { key, client: connecting });
    return connecting;
  }

  refresh(id: string): Promise<void> {
    const running = this.inflight.get(id);
    if (running) return running;
    const run = this.refreshOnce(id)
      .catch((err) => log('error', 'refresh failed', { server_id: id, error: (err as Error).message }))
      .finally(() => this.inflight.delete(id));
    this.inflight.set(id, run);
    return run;
  }

  private async refreshOnce(id: string) {
    const server = this.catalog.servers.get(id);
    if (!server || !server.enabled || this.stopped) return;
    const generation = this.generations.get(id) ?? 0;
    const stale = () => this.stopped || (this.generations.get(id) ?? 0) !== generation;
    const ms = this.config.listTimeoutMs;

    let tools: Tool[];
    try {
      tools = await withTimeout(
        (async () => {
          const client = await this.client(server);
          const all: Tool[] = [];
          let cursor: string | undefined;
          do {
            const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: ms });
            all.push(...page.tools);
            cursor = page.nextCursor;
          } while (cursor);
          return all;
        })(),
        ms,
      );
    } catch (err) {
      if (stale()) return;
      this.dropClient(id);
      const reason = classifyError(err, ms).message;
      await this.pool
        .query(`UPDATE servers SET status = 'unreachable', last_error = $3, last_checked_at = now() WHERE id = $1 AND enabled AND config_version = $2`, [id, server.config_version, reason])
        .catch((e) => log('error', 'status write failed', { server: server.slug, error: (e as Error).message }));
      log('warn', 'upstream unreachable', { server: server.slug, reason });
      return;
    }
    if (stale()) return;

    const hash = hashTools(tools);
    let changed = false;
    await tx(this.pool, async (db) => {
      const current = await db.query<{ tools_hash: string | null }>('SELECT tools_hash FROM servers WHERE id = $1 AND enabled AND config_version = $2 FOR UPDATE', [id, server.config_version]);
      if (!current.rowCount) return;
      if (current.rows[0]!.tools_hash !== hash) {
        changed = true;
        await db.query('DELETE FROM server_tools WHERE server_id = $1', [id]);
        for (const t of tools) {
          await db.query('INSERT INTO server_tools (server_id, name, description, input_schema, output_schema, annotations) VALUES ($1, $2, $3, $4, $5, $6)', [
            id,
            t.name,
            t.description ?? null,
            JSON.stringify(t.inputSchema ?? { type: 'object' }),
            t.outputSchema ? JSON.stringify(t.outputSchema) : null,
            t.annotations ? JSON.stringify(t.annotations) : null,
          ]);
        }
        await db.query(
          'UPDATE servers SET tools_changed_at = CASE WHEN tools_hash IS NULL THEN tools_changed_at ELSE now() END, tools_hash = $2 WHERE id = $1',
          [id, hash],
        );
        await notifyChange(db);
      }
      await db.query(`UPDATE servers SET status = 'connected', last_error = NULL, last_checked_at = now() WHERE id = $1`, [id]);
    });
    if (changed) {
      log('info', 'upstream tools changed', { server: server.slug, tools: tools.length });
      await this.reload();
    }
  }

  async call(route: Route, args: Record<string, unknown>): Promise<CallToolResult> {
    const server = route.server;
    let client: Client;
    try {
      client = await this.client(server);
    } catch (err) {
      const e = classifyError(err, this.config.listTimeoutMs);
      throw new UpstreamError(e.kind === 'error' ? 'error' : 'unreachable', e.kind === 'timeout' ? `connect ${e.message}` : e.message);
    }
    const ms = this.config.callTimeoutMs;
    try {
      return (await withTimeout(client.callTool({ name: route.tool.name, arguments: args }, { timeout: ms }), ms)) as CallToolResult;
    } catch (err) {
      const e = classifyError(err, ms);
      if (e.kind !== 'error' || (err as { status?: number }).status) this.dropClient(server.id);
      throw e;
    }
  }
}
