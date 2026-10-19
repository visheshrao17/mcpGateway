export type SeedServer = {
  slug: string;
  name: string;
  url: string;
  auth_type: 'none' | 'bearer' | 'header';
  auth_header_name?: string;
  credential_env?: string;
};

export type Config = {
  port: number;
  databaseUrl: string;
  masterKey: Buffer;
  publicUrl: string;
  bootstrapAdminEmail?: string;
  bootstrapAdminPassword?: string;
  seedServers: SeedServer[];
  seedAdminOnlyTools: string[];
  llmBaseUrl: string;
  llmModel?: string;
  llmApiKey?: string;
  allowedPrivateHostSuffixes: string[];
  listTimeoutMs: number;
  callTimeoutMs: number;
  refreshIntervalMs: number;
  maxAgentSteps: number;
  cookieSecure: boolean;
  staticDir?: string;
  env: Record<string, string | undefined>;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const missing = ['DATABASE_URL', 'MASTER_KEY', 'PUBLIC_URL'].filter((name) => !env[name]);
  if (missing.length) throw new Error(`missing required env: ${missing.join(', ')}`);

  const masterKey = Buffer.from(env.MASTER_KEY!, 'base64');
  if (masterKey.length !== 32) throw new Error('MASTER_KEY must be base64 of exactly 32 bytes');

  const publicUrl = env.PUBLIC_URL!.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(publicUrl)) throw new Error('PUBLIC_URL must start with http:// or https://');

  let seedServers: SeedServer[] = [];
  if (env.SEED_SERVERS) {
    try {
      seedServers = JSON.parse(env.SEED_SERVERS);
    } catch {
      throw new Error('SEED_SERVERS is not valid JSON');
    }
    if (!Array.isArray(seedServers)) throw new Error('SEED_SERVERS must be a JSON array');
  }

  const int = (name: string, fallback: number) => {
    const raw = env[name];
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    return value;
  };
  const list = (raw: string | undefined) => (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  return {
    port: int('PORT', 8080),
    databaseUrl: env.DATABASE_URL!,
    masterKey,
    publicUrl,
    bootstrapAdminEmail: env.BOOTSTRAP_ADMIN_EMAIL || undefined,
    bootstrapAdminPassword: env.BOOTSTRAP_ADMIN_PASSWORD || undefined,
    seedServers,
    seedAdminOnlyTools: list(env.SEED_ADMIN_ONLY_TOOLS),
    llmBaseUrl: (env.LLM_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
    llmModel: env.LLM_MODEL || undefined,
    llmApiKey: env.LLM_API_KEY || undefined,
    allowedPrivateHostSuffixes: env.ALLOWED_PRIVATE_HOST_SUFFIXES !== undefined ? list(env.ALLOWED_PRIVATE_HOST_SUFFIXES) : ['.svc.cluster.local'],
    listTimeoutMs: int('LIST_TIMEOUT_MS', 3000),
    callTimeoutMs: int('CALL_TIMEOUT_MS', 20000),
    refreshIntervalMs: int('REFRESH_INTERVAL_MS', 15000),
    maxAgentSteps: int('MAX_AGENT_STEPS', 8),
    cookieSecure: env.COOKIE_SECURE === 'true',
    staticDir: env.STATIC_DIR || undefined,
    env,
  };
}
