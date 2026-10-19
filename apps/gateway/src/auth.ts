import type { Pool } from './db.ts';
import { randomToken, sha256hex } from './crypto.ts';

export type User = { id: string; email: string; name: string; role: 'admin' | 'member'; active: boolean };

export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const USER_COLUMNS = 'u.id, u.email, u.name, u.role, u.active';

export function publicUser(u: User) {
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

export async function createSession(pool: Pool, userId: string): Promise<string> {
  const token = randomToken();
  await pool.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [sha256hex(token), userId, new Date(Date.now() + SESSION_TTL_MS)]);
  return token;
}

export async function userForSession(pool: Pool, token: string | undefined): Promise<User | undefined> {
  if (!token) return undefined;
  const { rows } = await pool.query<User>(
    `SELECT ${USER_COLUMNS} FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`,
    [sha256hex(token)],
  );
  return rows[0];
}

export function newApiKey() {
  const key = `mcpg_${randomToken(32)}`;
  return { key, prefix: key.slice(0, 12), hash: sha256hex(key) };
}

export async function userForApiKey(pool: Pool, authorization: string | undefined): Promise<User | undefined> {
  const match = /^Bearer\s+(mcpg_[A-Za-z0-9_-]{20,100})$/.exec(authorization ?? '');
  if (!match) return undefined;
  const { rows } = await pool.query<User>(
    `UPDATE api_keys k SET last_used_at = now() FROM users u
     WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND u.id = k.user_id AND u.active
     RETURNING ${USER_COLUMNS}`,
    [sha256hex(match[1]!)],
  );
  return rows[0];
}
