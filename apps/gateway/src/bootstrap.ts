import type { Config } from './config.ts';
import { encryptSecret, hashPassword } from './crypto.ts';
import { tx, type Pool } from './db.ts';
import { log } from './log.ts';
import { notifyChange } from './upstreams.ts';

const BOOTSTRAP_LOCK = 7_340_212;

export async function bootstrap(pool: Pool, config: Config) {
  await tx(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock($1)', [BOOTSTRAP_LOCK]);

    const users = await db.query('SELECT 1 FROM users LIMIT 1');
    if (!users.rowCount) {
      if (!config.bootstrapAdminEmail || !config.bootstrapAdminPassword) {
        throw new Error('no users exist: set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD');
      }
      if (config.bootstrapAdminPassword.length < 10) throw new Error('BOOTSTRAP_ADMIN_PASSWORD must be at least 10 characters');
      await db.query(`INSERT INTO users (email, name, role, password_hash) VALUES ($1, 'Admin', 'admin', $2)`, [
        config.bootstrapAdminEmail.trim().toLowerCase(),
        await hashPassword(config.bootstrapAdminPassword),
      ]);
      log('info', 'bootstrap admin created');
    }

    const firstSeed = await db.query(`INSERT INTO bootstrap_state (key) VALUES ('seed') ON CONFLICT DO NOTHING`);
    if (!firstSeed.rowCount) return;

    let changed = false;
    for (const seed of config.seedServers) {
      if (!/^[a-z0-9-]{1,20}$/.test(seed.slug ?? '')) throw new Error(`SEED_SERVERS: invalid slug ${JSON.stringify(seed.slug)}`);
      if (!['none', 'bearer', 'header'].includes(seed.auth_type)) throw new Error(`SEED_SERVERS: invalid auth_type for ${seed.slug}`);
      let credential: Buffer | null = null;
      if (seed.auth_type !== 'none') {
        const value = seed.credential_env ? config.env[seed.credential_env] : undefined;
        if (!value) throw new Error(`SEED_SERVERS: ${seed.slug} needs a credential in env ${seed.credential_env ?? '(credential_env not set)'}`);
        credential = encryptSecret(config.masterKey, value, seed.slug);
      }
      const inserted = await db.query(
        `INSERT INTO servers (slug, name, url, auth_type, auth_header_name, credential_enc) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (slug) DO NOTHING`,
        [seed.slug, seed.name ?? seed.slug, seed.url, seed.auth_type, seed.auth_type === 'header' ? (seed.auth_header_name ?? null) : null, credential],
      );
      if (inserted.rowCount) {
        changed = true;
        log('info', 'seeded server', { slug: seed.slug });
      }
    }

    for (const exposed of config.seedAdminOnlyTools) {
      const split = exposed.indexOf('__');
      if (split <= 0) throw new Error(`SEED_ADMIN_ONLY_TOOLS: ${exposed} is not <slug>__<tool>`);
      const inserted = await db.query(
        `INSERT INTO tool_policies (server_id, tool_name, admin_only) SELECT id, $2, true FROM servers WHERE slug = $1 ON CONFLICT DO NOTHING`,
        [exposed.slice(0, split), exposed.slice(split + 2)],
      );
      if (inserted.rowCount) changed = true;
    }
    if (changed) await notifyChange(db);
  });
}
