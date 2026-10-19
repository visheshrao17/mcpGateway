import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import * as z from 'zod/v4';
import { createSession, newApiKey, publicUser, SESSION_TTL_MS, userForSession, type User } from './auth.ts';
import type { Ctx } from './calltool.ts';
import { TIMING_EQUALIZER_HASH, encryptSecret, hashPassword, randomToken, sha256hex, verifyPassword } from './crypto.ts';
import { tx } from './db.ts';
import { exposedName } from './naming.ts';
import { checkUpstreamUrl, SsrfError, type SsrfPolicy } from './ssrf.ts';
import { notifyChange } from './upstreams.ts';

export type ApiEnv = { Variables: { user: User } };

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORBIDDEN_HEADERS = new Set(['host', 'content-type', 'content-length', 'accept', 'connection', 'transfer-encoding', 'mcp-session-id', 'mcp-protocol-version', 'cookie']);

export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  const raw = await c.req.json().catch(() => {
    throw new ApiError(400, 'bad_request', 'request body must be JSON');
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new ApiError(400, 'bad_request', `${issue.path.join('.') || 'body'}: ${issue.message}`);
  }
  return parsed.data;
}

function uuidParam(c: Context, name: string): string {
  const value = c.req.param(name) ?? '';
  if (!UUID.test(value)) throw new ApiError(404, 'not_found', `${name === 'id' ? 'resource' : name} not found`);
  return value;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function requireSession(ctx: Ctx): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const user = await userForSession(ctx.pool, getCookie(c, 'sid'));
    if (!user) throw new ApiError(401, 'unauthorized', 'not signed in');
    c.set('user', user);
    await next();
  };
}

export const requireAdmin: MiddlewareHandler<ApiEnv> = async (c, next) => {
  if (c.get('user').role !== 'admin') throw new ApiError(403, 'forbidden', 'admin only');
  await next();
};

type ServerDbRow = {
  id: string;
  slug: string;
  name: string;
  url: string;
  auth_type: string;
  auth_header_name: string | null;
  has_credential: boolean;
  enabled: boolean;
  status: string;
  last_error: string | null;
  last_checked_at: Date | null;
  tools_changed_at: Date | null;
};

async function loadServers(ctx: Ctx, user: User, id?: string) {
  const servers = await ctx.pool.query<ServerDbRow>(
    `SELECT id, slug, name, url, auth_type, auth_header_name, credential_enc IS NOT NULL AS has_credential, enabled, status, last_error, last_checked_at, tools_changed_at
     FROM servers ${id ? 'WHERE id = $1' : ''} ORDER BY slug`,
    id ? [id] : [],
  );
  const ids = servers.rows.map((s) => s.id);
  const [tools, policies] = await Promise.all([
    ctx.pool.query('SELECT server_id, name, description, input_schema, annotations FROM server_tools WHERE server_id = ANY($1) ORDER BY name', [ids]),
    ctx.pool.query('SELECT server_id, tool_name FROM tool_policies WHERE admin_only AND server_id = ANY($1)', [ids]),
  ]);
  const adminOnly = new Set(policies.rows.map((p) => `${p.server_id}\0${p.tool_name}`));
  const exposed = new Map([...ctx.manager.catalog.routes.values()].map((r) => [`${r.server.id}\0${r.tool.name}`, r.exposedName]));
  return servers.rows.map((s) => ({
    id: s.id,
    slug: s.slug,
    name: s.name,
    url: s.url,
    auth_type: s.auth_type,
    auth_header_name: s.auth_header_name,
    has_credential: s.has_credential,
    enabled: s.enabled,
    status: s.enabled ? s.status : 'disabled',
    last_error: s.enabled ? s.last_error : null,
    last_checked_at: iso(s.last_checked_at),
    tools_changed_at: iso(s.tools_changed_at),
    tools: tools.rows
      .filter((t) => t.server_id === s.id)
      .map((t) => ({
        name: t.name,
        exposed_name: exposed.get(`${s.id}\0${t.name}`) ?? exposedName(s.slug, t.name),
        description: t.description,
        input_schema: t.input_schema,
        annotations: t.annotations ?? {},
        admin_only: adminOnly.has(`${s.id}\0${t.name}`),
      }))
      .filter((t) => user.role === 'admin' || !t.admin_only),
  }));
}

async function oneServer(ctx: Ctx, user: User, id: string) {
  const [server] = await loadServers(ctx, user, id);
  if (!server) throw new ApiError(404, 'not_found', 'server not found');
  return server;
}

async function checkUrl(url: string, policy: SsrfPolicy) {
  try {
    await checkUpstreamUrl(url, policy);
  } catch (err) {
    if (err instanceof SsrfError) throw new ApiError(400, 'url_rejected', err.message);
    throw err;
  }
}

const headerName = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, 'must be a valid HTTP header name').refine((h) => !FORBIDDEN_HEADERS.has(h.toLowerCase()), 'this header cannot carry a credential');
const authType = z.enum(['none', 'bearer', 'header']);
const role = z.enum(['admin', 'member']);
const email = z.string().trim().toLowerCase().pipe(z.email());

const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === '23505';

export function apiRoutes(ctx: Ctx, policy: SsrfPolicy, onUsersChanged: () => void) {
  const api = new Hono<ApiEnv>();
  const session = requireSession(ctx);
  const cookieOpts = { httpOnly: true, sameSite: 'Lax' as const, secure: ctx.config.cookieSecure, path: '/', maxAge: SESSION_TTL_MS / 1000 };

  api.post('/auth/login', async (c) => {
    const { email: addr, password } = await body(c, z.object({ email: z.string().trim().toLowerCase(), password: z.string().max(1024) }));
    const { rows } = await ctx.pool.query<User & { password_hash: string }>('SELECT id, email, name, role, active, password_hash FROM users WHERE email = $1', [addr]);
    const user = rows[0];
    const ok = await verifyPassword(password, user?.password_hash ?? TIMING_EQUALIZER_HASH);
    if (!user || !ok || !user.active) throw new ApiError(401, 'invalid_credentials', 'wrong email or password');
    setCookie(c, 'sid', await createSession(ctx.pool, user.id), cookieOpts);
    return c.json({ user: publicUser(user) });
  });

  api.post('/auth/logout', async (c) => {
    const sid = getCookie(c, 'sid');
    if (sid) await ctx.pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256hex(sid)]);
    deleteCookie(c, 'sid', { path: '/' });
    return c.body(null, 204);
  });

  api.get('/auth/me', session, (c) => c.json({ user: publicUser(c.get('user')) }));

  const pendingInvite = async (token: string) => {
    const { rows } = await ctx.pool.query<{ id: string; email: string; role: 'admin' | 'member'; expires_at: Date }>(
      'SELECT id, email, role, expires_at FROM invites WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()',
      [sha256hex(token)],
    );
    if (!rows[0]) throw new ApiError(404, 'not_found', 'invite not found or expired');
    return rows[0];
  };

  api.get('/invites/:token{[A-Za-z0-9_-]{20,}}', async (c) => {
    const invite = await pendingInvite(c.req.param('token'));
    return c.json({ email: invite.email, role: invite.role, expires_at: iso(invite.expires_at) });
  });

  api.post('/invites/:token/accept', async (c) => {
    const { name, password } = await body(c, z.object({ name: z.string().trim().min(1).max(100), password: z.string().min(10).max(1024) }));
    const hash = await hashPassword(password);
    const user = await tx(ctx.pool, async (db) => {
      const { rows } = await db.query<{ id: string; email: string; role: 'admin' | 'member' }>(
        'UPDATE invites SET accepted_at = now() WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now() RETURNING id, email, role',
        [sha256hex(c.req.param('token'))],
      );
      const invite = rows[0];
      if (!invite) throw new ApiError(404, 'not_found', 'invite not found or expired');
      try {
        const created = await db.query<User>('INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, email, name, role, active', [
          invite.email,
          name,
          invite.role,
          hash,
        ]);
        return created.rows[0]!;
      } catch (err) {
        if (isUniqueViolation(err)) throw new ApiError(409, 'conflict', 'an account with this email already exists');
        throw err;
      }
    });
    setCookie(c, 'sid', await createSession(ctx.pool, user.id), cookieOpts);
    return c.json({ user: publicUser(user) });
  });

  api.use('*', session);

  api.get('/meta', (c) => c.json({ mcp_url: `${ctx.config.publicUrl}/mcp`, llm_model: ctx.config.llmModel ?? null }));

  api.get('/servers', async (c) => c.json(await loadServers(ctx, c.get('user'))));

  api.post('/servers', requireAdmin, async (c) => {
    const input = await body(
      c,
      z.object({
        slug: z.string().regex(/^[a-z0-9-]{1,20}$/, 'must match ^[a-z0-9-]{1,20}$'),
        name: z.string().trim().min(1).max(100),
        url: z.string().max(2000),
        auth_type: authType,
        auth_header_name: headerName.nullish(),
        credential: z.string().min(1).max(8192).nullish(),
      }),
    );
    if (input.auth_type === 'header' && !input.auth_header_name) throw new ApiError(400, 'bad_request', 'auth_header_name is required for header auth');
    if (input.auth_type !== 'none' && !input.credential) throw new ApiError(400, 'bad_request', 'credential is required for bearer or header auth');
    await checkUrl(input.url, policy);
    const credential = input.auth_type !== 'none' && input.credential ? encryptSecret(ctx.config.masterKey, input.credential, input.slug) : null;
    const id = await tx(ctx.pool, async (db) => {
      try {
        const { rows } = await db.query<{ id: string }>(
          'INSERT INTO servers (slug, name, url, auth_type, auth_header_name, credential_enc) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
          [input.slug, input.name, input.url, input.auth_type, input.auth_type === 'header' ? input.auth_header_name : null, credential],
        );
        await notifyChange(db);
        return rows[0]!.id;
      } catch (err) {
        if (isUniqueViolation(err)) throw new ApiError(409, 'conflict', `slug ${input.slug} is already taken`);
        throw err;
      }
    });
    await ctx.manager.reload();
    return c.json(await oneServer(ctx, c.get('user'), id), 201);
  });

  api.patch('/servers/:id', requireAdmin, async (c) => {
    const id = uuidParam(c, 'id');
    const input = await body(
      c,
      z.object({
        name: z.string().trim().min(1).max(100).optional(),
        url: z.string().max(2000).optional(),
        enabled: z.boolean().optional(),
        auth_type: authType.optional(),
        auth_header_name: headerName.nullish(),
        credential: z.string().min(1).max(8192).nullable().optional(),
      }),
    );
    await tx(ctx.pool, async (db) => {
      const { rows } = await db.query<{ slug: string; url: string; auth_type: string; auth_header_name: string | null; has_credential: boolean }>(
        'SELECT slug, url, auth_type, auth_header_name, credential_enc IS NOT NULL AS has_credential FROM servers WHERE id = $1 FOR UPDATE',
        [id],
      );
      const current = rows[0];
      if (!current) throw new ApiError(404, 'not_found', 'server not found');
      const next = {
        auth_type: input.auth_type ?? current.auth_type,
        auth_header_name: input.auth_header_name !== undefined ? input.auth_header_name : current.auth_header_name,
      };
      if (next.auth_type === 'header' && !next.auth_header_name) throw new ApiError(400, 'bad_request', 'auth_header_name is required for header auth');
      const sets: string[] = ['updated_at = now()', 'config_version = config_version + 1'];
      const values: unknown[] = [id];
      const set = (column: string, value: unknown) => {
        values.push(value);
        sets.push(`${column} = $${values.length}`);
      };
      if (input.name !== undefined) set('name', input.name);
      if (input.url !== undefined && input.url !== current.url) {
        await checkUrl(input.url, policy);
        set('url', input.url);
      }
      if (input.enabled !== undefined) set('enabled', input.enabled);
      if (input.auth_type !== undefined) set('auth_type', input.auth_type);
      set('auth_header_name', next.auth_type === 'header' ? next.auth_header_name : null);
      if (next.auth_type === 'none' || input.credential === null) set('credential_enc', null);
      else if (input.credential) set('credential_enc', encryptSecret(ctx.config.masterKey, input.credential, current.slug));
      else if (!current.has_credential && next.auth_type !== current.auth_type) throw new ApiError(400, 'bad_request', 'credential is required for bearer or header auth');
      if (input.url !== undefined || input.enabled !== undefined || input.auth_type !== undefined || input.auth_header_name !== undefined || input.credential !== undefined) {
        sets.push(`status = 'pending'`, 'last_error = NULL');
      }
      await db.query(`UPDATE servers SET ${sets.join(', ')} WHERE id = $1`, values);
      await notifyChange(db);
    });
    await ctx.manager.reload();
    return c.json(await oneServer(ctx, c.get('user'), id));
  });

  api.delete('/servers/:id', requireAdmin, async (c) => {
    const id = uuidParam(c, 'id');
    await tx(ctx.pool, async (db) => {
      const { rowCount } = await db.query('DELETE FROM servers WHERE id = $1', [id]);
      if (!rowCount) throw new ApiError(404, 'not_found', 'server not found');
      await notifyChange(db);
    });
    await ctx.manager.reload();
    return c.body(null, 204);
  });

  api.post('/servers/:id/refresh', requireAdmin, async (c) => {
    const id = uuidParam(c, 'id');
    const server = await oneServer(ctx, c.get('user'), id);
    if (!server.enabled) throw new ApiError(409, 'conflict', 'server is disabled');
    if (!ctx.manager.catalog.servers.has(id)) await ctx.manager.reload();
    await ctx.manager.refresh(id);
    return c.json(await oneServer(ctx, c.get('user'), id));
  });

  api.put('/servers/:id/tools/:tool/policy', requireAdmin, async (c) => {
    const id = uuidParam(c, 'id');
    const { admin_only } = await body(c, z.object({ admin_only: z.boolean() }));
    const tool = c.req.param('tool');
    await tx(ctx.pool, async (db) => {
      const exists = await db.query('SELECT 1 FROM servers WHERE id = $1', [id]);
      if (!exists.rowCount) throw new ApiError(404, 'not_found', 'server not found');
      await db.query('INSERT INTO tool_policies (server_id, tool_name, admin_only) VALUES ($1, $2, $3) ON CONFLICT (server_id, tool_name) DO UPDATE SET admin_only = EXCLUDED.admin_only', [
        id,
        tool,
        admin_only,
      ]);
      await notifyChange(db);
    });
    await ctx.manager.reload();
    return c.json(await oneServer(ctx, c.get('user'), id));
  });

  const userRow = (u: User & { created_at: Date }) => ({ id: u.id, email: u.email, name: u.name, role: u.role, active: u.active, created_at: iso(u.created_at) });

  api.get('/users', requireAdmin, async (c) => {
    const { rows } = await ctx.pool.query('SELECT id, email, name, role, active, created_at FROM users ORDER BY created_at');
    return c.json(rows.map(userRow));
  });

  api.patch('/users/:id', requireAdmin, async (c) => {
    const id = uuidParam(c, 'id');
    const input = await body(c, z.object({ role: role.optional(), active: z.boolean().optional() }));
    if (id === c.get('user').id && ((input.role && input.role !== 'admin') || input.active === false)) {
      throw new ApiError(400, 'bad_request', 'admins cannot demote or deactivate themselves');
    }
    const updated = await tx(ctx.pool, async (db) => {
      const { rows } = await db.query(
        'UPDATE users SET role = COALESCE($2, role), active = COALESCE($3, active) WHERE id = $1 RETURNING id, email, name, role, active, created_at',
        [id, input.role ?? null, input.active ?? null],
      );
      if (!rows[0]) throw new ApiError(404, 'not_found', 'user not found');
      if (input.active === false) await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
      await notifyChange(db, 'users');
      return rows[0];
    });
    onUsersChanged();
    return c.json(userRow(updated));
  });

  api.get('/invites', requireAdmin, async (c) => {
    const { rows } = await ctx.pool.query('SELECT id, email, role, expires_at, accepted_at FROM invites ORDER BY created_at DESC');
    return c.json(rows.map((r) => ({ id: r.id, email: r.email, role: r.role, expires_at: iso(r.expires_at), accepted_at: iso(r.accepted_at) })));
  });

  api.post('/invites', requireAdmin, async (c) => {
    const input = await body(c, z.object({ email, role }));
    const existing = await ctx.pool.query('SELECT 1 FROM users WHERE email = $1', [input.email]);
    if (existing.rowCount) throw new ApiError(409, 'conflict', 'a user with this email already exists');
    const token = randomToken();
    const { rows } = await ctx.pool.query(
      'INSERT INTO invites (email, role, token_hash, created_by, expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING id, email, role, expires_at',
      [input.email, input.role, sha256hex(token), c.get('user').id, new Date(Date.now() + INVITE_TTL_MS)],
    );
    const invite = rows[0];
    return c.json({ id: invite.id, email: invite.email, role: invite.role, expires_at: iso(invite.expires_at), invite_url: `${ctx.config.publicUrl}/invite/${token}` }, 201);
  });

  api.delete('/invites/:id', requireAdmin, async (c) => {
    const { rowCount } = await ctx.pool.query('DELETE FROM invites WHERE id = $1', [uuidParam(c, 'id')]);
    if (!rowCount) throw new ApiError(404, 'not_found', 'invite not found');
    return c.body(null, 204);
  });

  const keyRow = (k: { id: string; name: string; prefix: string; user_email: string; created_at: Date; last_used_at: Date | null; revoked_at: Date | null }) => ({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    user_email: k.user_email,
    created_at: iso(k.created_at),
    last_used_at: iso(k.last_used_at),
    revoked_at: iso(k.revoked_at),
  });
  const KEY_SELECT = 'SELECT k.id, k.name, k.prefix, u.email AS user_email, k.created_at, k.last_used_at, k.revoked_at FROM api_keys k JOIN users u ON u.id = k.user_id';

  api.get('/keys', async (c) => {
    const user = c.get('user');
    const all = c.req.query('all') === '1' && user.role === 'admin';
    const { rows } = await ctx.pool.query(`${KEY_SELECT} ${all ? '' : 'WHERE k.user_id = $1'} ORDER BY k.created_at DESC`, all ? [] : [user.id]);
    return c.json(rows.map(keyRow));
  });

  api.post('/keys', async (c) => {
    const { name } = await body(c, z.object({ name: z.string().trim().min(1).max(100) }));
    const { key, prefix, hash } = newApiKey();
    const { rows } = await ctx.pool.query<{ id: string }>('INSERT INTO api_keys (user_id, name, prefix, key_hash) VALUES ($1, $2, $3, $4) RETURNING id', [
      c.get('user').id,
      name,
      prefix,
      hash,
    ]);
    const created = await ctx.pool.query(`${KEY_SELECT} WHERE k.id = $1`, [rows[0]!.id]);
    return c.json({ ...keyRow(created.rows[0]), key }, 201);
  });

  api.delete('/keys/:id', async (c) => {
    const user = c.get('user');
    const { rowCount } = await ctx.pool.query(
      `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 ${user.role === 'admin' ? '' : 'AND user_id = $2'}`,
      user.role === 'admin' ? [uuidParam(c, 'id')] : [uuidParam(c, 'id'), user.id],
    );
    if (!rowCount) throw new ApiError(404, 'not_found', 'key not found');
    return c.body(null, 204);
  });

  api.get('/audit', async (c) => {
    const user = c.get('user');
    const where: string[] = [];
    const values: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      values.push(value);
      where.push(sql.replace('?', `$${values.length}`));
    };
    const userId = user.role === 'admin' ? c.req.query('user_id') : user.id;
    if (userId) {
      if (!UUID.test(userId)) throw new ApiError(400, 'bad_request', 'user_id must be a uuid');
      add('user_id = ?', userId);
    }
    if (c.req.query('server')) add('server_slug = ?', c.req.query('server'));
    if (c.req.query('outcome')) add('outcome = ?', c.req.query('outcome'));
    const before = c.req.query('before_id');
    if (before) {
      if (!/^\d+$/.test(before)) throw new ApiError(400, 'bad_request', 'before_id must be an integer');
      add('id < ?', before);
    }
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200);
    values.push(limit);
    const { rows } = await ctx.pool.query(
      `SELECT id, started_at, user_email, source, server_slug, tool_name, duration_ms, outcome, error FROM audit_log
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT $${values.length}`,
      values,
    );
    return c.json({
      rows: rows.map((r) => ({ ...r, id: Number(r.id), started_at: iso(r.started_at) })),
      next_before_id: rows.length === limit ? Number(rows.at(-1).id) : null,
    });
  });

  return api;
}
