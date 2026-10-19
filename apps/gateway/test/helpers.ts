import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createGateway, type Gateway } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

process.env.LOG_SILENT = '1';

export const PG_ADMIN_URL = process.env.TEST_PG_URL ?? 'postgres://postgres:test@127.0.0.1:55432/postgres';
export const ADMIN = { email: 'admin@example.com', password: 'correct-horse-battery' };

export async function freshDatabase(): Promise<string> {
  const name = `gw_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: PG_ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(PG_ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

export function testConfig(databaseUrl: string, env: Record<string, string> = {}) {
  return loadConfig({
    DATABASE_URL: databaseUrl,
    MASTER_KEY: randomBytes(32).toString('base64'),
    PUBLIC_URL: 'http://app.localtest.me',
    BOOTSTRAP_ADMIN_EMAIL: ADMIN.email,
    BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
    LIST_TIMEOUT_MS: '1000',
    CALL_TIMEOUT_MS: '1000',
    REFRESH_INTERVAL_MS: '60000',
    ...env,
  });
}

export async function startGateway(config: ReturnType<typeof testConfig>): Promise<{ gw: Gateway; url: string }> {
  const gw = createGateway(config, { ssrfOverride: { allowLoopback: true } });
  const url = await gw.start(0);
  return { gw, url };
}

export type Upstream = { url: string; close: () => Promise<void>; headers: http.IncomingHttpHeaders[] };

export async function fakeUpstream(register: (server: McpServer) => void, opts: { requireAuth?: { header: string; value: string } } = {}): Promise<Upstream> {
  const headers: http.IncomingHttpHeaders[] = [];
  const handler = toNodeHandler(createMcpHandler(() => {
    const server = new McpServer({ name: 'fake', version: '1.0.0' });
    register(server);
    return server;
  }, { legacy: 'stateless' }));
  const server = http.createServer(async (req, res) => {
    headers.push(req.headers);
    if (opts.requireAuth && req.headers[opts.requireAuth.header.toLowerCase()] !== opts.requireAuth.value) {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
      return;
    }
    await handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    headers,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export async function deadUrl(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}/mcp`;
}

export type ApiResult = { status: number; body: any; text: string; headers: Headers };

export function apiClient(base: string) {
  let cookie = '';
  const request = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<ApiResult> => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...(method !== 'GET' && { 'x-requested-with': 'fetch' }),
        ...(cookie && { cookie }),
        ...extra,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0]!;
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { status: res.status, body: parsed, text, headers: res.headers };
  };
  return {
    request,
    get cookie() {
      return cookie;
    },
    get: (path: string) => request('GET', path),
    post: (path: string, body?: unknown) => request('POST', path, body ?? {}),
    patch: (path: string, body: unknown) => request('PATCH', path, body),
    put: (path: string, body: unknown) => request('PUT', path, body),
    del: (path: string) => request('DELETE', path),
    async login(email: string, password: string) {
      const res = await request('POST', '/api/auth/login', { email, password });
      if (res.status !== 200) throw new Error(`login failed ${res.status} ${res.text}`);
      return res;
    },
  };
}

export async function inviteMember(base: string, admin: ReturnType<typeof apiClient>, email: string) {
  const invite = await admin.post('/api/invites', { email, role: 'member' });
  const token = String(invite.body.invite_url).split('/invite/')[1];
  const member = apiClient(base);
  const accepted = await member.post(`/api/invites/${token}/accept`, { name: 'Member', password: 'member-password-1' });
  if (accepted.status !== 200) throw new Error(`accept failed ${accepted.text}`);
  return member;
}

export async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 5000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function rpc(base: string, key: string | undefined, body: unknown, extraHeaders: Record<string, string> = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(key && { authorization: `Bearer ${key}` }),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
  let json: any;
  try {
    json = JSON.parse(dataLine ? dataLine.slice(6) : text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
}
