import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { apiRoutes, ApiError, type ApiEnv } from './api.ts';
import { bootstrap } from './bootstrap.ts';
import type { Ctx } from './calltool.ts';
import { chatRoutes } from './chat.ts';
import type { Config } from './config.ts';
import { createPool, migrate, waitForDatabase } from './db.ts';
import { log } from './log.ts';
import { createMcpEndpoint } from './mcp.ts';
import type { SsrfPolicy } from './ssrf.ts';
import { UpstreamManager } from './upstreams.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

async function staticFile(root: string, urlPath: string): Promise<Response | undefined> {
  const resolved = path.resolve(root, '.' + decodeURIComponent(urlPath));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return undefined;
  const info = await stat(resolved).catch(() => undefined);
  if (!info?.isFile()) return undefined;
  const ext = path.extname(resolved);
  const immutable = urlPath.startsWith('/assets/');
  return new Response(await readFile(resolved), {
    headers: { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' },
  });
}

export type Gateway = { ctx: Ctx; app: Hono<ApiEnv>; start: (port?: number) => Promise<string>; stop: () => Promise<void> };

export function createGateway(config: Config, opts: { ssrfOverride?: Partial<SsrfPolicy> } = {}): Gateway {
  const policy: SsrfPolicy = { allowedPrivateHostSuffixes: config.allowedPrivateHostSuffixes, ...opts.ssrfOverride };
  const pool = createPool(config.databaseUrl);
  const manager = new UpstreamManager(pool, config, policy);
  const ctx: Ctx = { config, pool, manager };
  const mcp = createMcpEndpoint(ctx);
  manager.onToolsChanged = () => mcp.notifyAll();

  const app = new Hono<ApiEnv>();

  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    if (c.req.path !== '/healthz' && c.req.path !== '/readyz') {
      log('info', 'request', { method: c.req.method, route: c.req.routePath, status: c.res.status, ms: Date.now() - started });
    }
  });

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    log('error', 'unhandled error', { route: c.req.routePath, error: (err as Error).message });
    return c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
  });

  app.get('/healthz', (c) => c.text('ok'));
  app.get('/readyz', async (c) => {
    try {
      await pool.query('SELECT 1');
      return c.text('ok');
    } catch {
      return c.text('database unreachable', 503);
    }
  });

  app.all('/mcp', (c) => mcp.fetch(c.req.raw));

  app.use('/api/*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.req.header('x-requested-with') !== 'fetch') {
      throw new ApiError(403, 'csrf', 'state-changing requests must send X-Requested-With: fetch');
    }
    c.header('cache-control', 'no-store');
    await next();
  });
  const api = apiRoutes(ctx, policy, () => mcp.notifyAll());
  api.route('/chat', chatRoutes(ctx));
  app.route('/api', api);
  app.all('/api/*', () => {
    throw new ApiError(404, 'not_found', 'no such endpoint');
  });

  if (config.staticDir) {
    const root = path.resolve(config.staticDir);
    app.get('*', async (c) => {
      const file = (await staticFile(root, c.req.path)) ?? (await staticFile(root, '/index.html'));
      return file ?? c.text('not found', 404);
    });
  }

  let server: ServerType | undefined;
  return {
    ctx,
    app,
    async start(port = config.port) {
      await waitForDatabase(pool);
      await migrate(pool);
      await bootstrap(pool, config);
      await manager.start();
      server = await new Promise<ServerType>((resolve) => {
        const s = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => resolve(s));
      });
      const address = server.address() as AddressInfo;
      log('info', 'gateway listening', { port: address.port });
      return `http://127.0.0.1:${address.port}`;
    },
    async stop() {
      await manager.stop();
      await mcp.close();
      if (server) {
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        await new Promise((resolve) => server!.close(resolve));
      }
      await pool.end();
    },
  };
}
