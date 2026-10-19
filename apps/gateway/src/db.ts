import { readFileSync } from 'node:fs';
import pg from 'pg';

export type Pool = pg.Pool;

export function createPool(databaseUrl: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  pool.on('error', () => {});
  return pool;
}

const MIGRATION_LOCK = 7_340_211;

// New pods can start before the database Service or its NetworkPolicy rules are reachable.
export async function waitForDatabase(pool: pg.Pool, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

export async function migrate(pool: pg.Pool) {
  const sql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  await tx(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    await client.query(sql);
  });
}

export async function tx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
