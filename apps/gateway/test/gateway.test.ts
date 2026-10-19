import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as z from 'zod/v4';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Gateway } from '../src/app.ts';
import { ADMIN, apiClient, deadUrl, fakeUpstream, freshDatabase, inviteMember, rpc, startGateway, testConfig, waitFor, type Upstream } from './helpers.ts';

const ALPHA_SECRET = 'alpha-secret-credential-123';
const BETA_SECRET = 'beta-secret-credential-456';

let gw: Gateway;
let base: string;
let alpha: Upstream;
let beta: Upstream;
let alphaExtraTool = false;
let createCalls = 0;
const admin = () => adminClient;
let adminClient: ReturnType<typeof apiClient>;
const responses: string[] = [];
const ids: Record<string, string> = {};
let adminKey: string;

async function track<T extends { text: string }>(p: Promise<T>): Promise<T> {
  const res = await p;
  responses.push(res.text);
  return res;
}

async function mcpClient(key: string) {
  const client = new Client({ name: 'test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return client;
}

before(async () => {
  alpha = await fakeUpstream(
    (s) => {
      s.registerTool('search', { description: 'alpha search', inputSchema: z.object({ q: z.string() }), annotations: { readOnlyHint: true } }, async ({ q }) => ({
        content: [{ type: 'text', text: `alpha:${q}` }],
        structuredContent: { hits: [q], source: 'alpha' },
      }));
      s.registerTool('create_thing', { description: 'writes', inputSchema: z.object({ name: z.string() }) }, async ({ name }) => {
        createCalls++;
        return { content: [{ type: 'text', text: `created ${name}` }] };
      });
      s.registerTool('fail', { inputSchema: z.object({}), annotations: { readOnlyHint: true } }, async () => ({ isError: true, content: [{ type: 'text', text: 'upstream says no' }] }));
      s.registerTool('hang', { inputSchema: z.object({}), annotations: { readOnlyHint: true } }, () => new Promise(() => {}));
      s.registerTool('hang_write', { inputSchema: z.object({}) }, () => new Promise(() => {}));
      if (alphaExtraTool) s.registerTool('extra', { inputSchema: z.object({}) }, async () => ({ content: [] }));
    },
    { requireAuth: { header: 'authorization', value: `Bearer ${ALPHA_SECRET}` } },
  );
  beta = await fakeUpstream(
    (s) => {
      s.registerTool('search', { description: 'beta search', inputSchema: z.object({ q: z.string() }), annotations: { readOnlyHint: true } }, async ({ q }) => ({
        content: [{ type: 'text', text: `beta:${q}` }],
      }));
    },
    { requireAuth: { header: 'x-api-key', value: BETA_SECRET } },
  );
  ({ gw, url: base } = await startGateway(testConfig(await freshDatabase())));
  adminClient = apiClient(base);
  await adminClient.login(ADMIN.email, ADMIN.password);
});

after(async () => {
  await gw.stop();
  await alpha.close();
  await beta.close();
});

test('state-changing /api requests without X-Requested-With are refused', async () => {
  const res = await admin().request('POST', '/api/keys', { name: 'x' }, { 'x-requested-with': '' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'csrf');
});

test('admin adds servers with credentials; they connect and expose collision-free names', async () => {
  const a = await track(admin().post('/api/servers', { slug: 'alpha', name: 'Alpha', url: alpha.url, auth_type: 'bearer', credential: ALPHA_SECRET }));
  assert.equal(a.status, 201, a.text);
  const b = await track(admin().post('/api/servers', { slug: 'beta', name: 'Beta', url: beta.url, auth_type: 'header', auth_header_name: 'X-Api-Key', credential: BETA_SECRET }));
  assert.equal(b.status, 201, b.text);
  ids.alpha = a.body.id;
  ids.beta = b.body.id;
  assert.equal(a.body.has_credential, true);

  const servers = await waitFor(async () => {
    const res = await track(admin().get('/api/servers'));
    return res.body.every((s: any) => s.status === 'connected') && res.body;
  });
  const exposed = servers.flatMap((s: any) => s.tools.map((t: any) => t.exposed_name)).sort();
  assert.deepEqual(exposed, ['alpha__create_thing', 'alpha__fail', 'alpha__hang', 'alpha__hang_write', 'alpha__search', 'beta__search']);
  assert.ok(servers[0].last_checked_at);
  assert.ok(alpha.headers.some((h) => h.authorization === `Bearer ${ALPHA_SECRET}`));
  assert.ok(beta.headers.some((h) => h['x-api-key'] === BETA_SECRET));
});

test('slug conflicts and SSRF-blocked URLs are rejected', async () => {
  const dup = await admin().post('/api/servers', { slug: 'alpha', name: 'x', url: alpha.url, auth_type: 'none' });
  assert.equal(dup.status, 409);
  for (const url of ['http://169.254.169.254/latest/meta-data', 'http://10.0.0.8/mcp', 'file:///etc/passwd']) {
    const res = await admin().post('/api/servers', { slug: 'evil', name: 'x', url, auth_type: 'none' });
    assert.equal(res.status, 400, url);
    assert.equal(res.body.error.code, 'url_rejected');
  }
});

test('real MCP client (auto negotiation) lists and calls through the gateway', async () => {
  const created = await track(admin().post('/api/keys', { name: 'laptop' }));
  assert.equal(created.status, 201);
  adminKey = created.body.key;
  assert.match(adminKey, /^mcpg_/);
  assert.equal(created.body.prefix, adminKey.slice(0, 12));

  const client = await mcpClient(adminKey);
  assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28');
  const tools = (await client.listTools()).tools;
  assert.ok(tools.some((t) => t.name === 'alpha__search' && t.annotations?.readOnlyHint === true));
  assert.ok(tools.some((t) => t.name === 'beta__search'));

  const a = await client.callTool({ name: 'alpha__search', arguments: { q: 'shoes' } });
  assert.deepEqual(a.content, [{ type: 'text', text: 'alpha:shoes' }]);
  assert.deepEqual(a.structuredContent, { hits: ['shoes'], source: 'alpha' });
  const b = await client.callTool({ name: 'beta__search', arguments: { q: 'hats' } });
  assert.deepEqual(b.content, [{ type: 'text', text: 'beta:hats' }]);
  const f = await client.callTool({ name: 'alpha__fail', arguments: {} });
  assert.equal(f.isError, true);
  assert.deepEqual(f.content, [{ type: 'text', text: 'upstream says no' }]);
  await client.close();

  const audit = await track(admin().get('/api/audit?limit=3'));
  assert.deepEqual(audit.body.rows.map((r: any) => r.outcome), ['tool_error', 'ok', 'ok']);
  assert.equal(audit.body.rows[2].server_slug, 'alpha');
  assert.equal(audit.body.rows[2].tool_name, 'search');
  assert.equal(audit.body.rows[2].source, 'mcp');

  const keys = await track(admin().get('/api/keys'));
  assert.ok(keys.body[0].last_used_at);
  assert.equal(JSON.stringify(keys.body).includes(adminKey), false);
});

test('legacy 2025 client: initialize then tools/list over plain JSON-RPC', async () => {
  const init = await rpc(base, adminKey, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'curl', version: '0' } },
  });
  assert.equal(init.status, 200, init.text);
  assert.equal(init.json.result.protocolVersion, '2025-06-18');
  assert.equal(init.json.result.capabilities.tools.listChanged, true);
  const list = await rpc(base, adminKey, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-protocol-version': '2025-06-18' });
  assert.equal(list.status, 200, list.text);
  assert.ok(list.json.result.tools.some((t: any) => t.name === 'beta__search'));
});

test('MCP rejects missing/unknown keys with 401 and a bad Host with 403', async () => {
  const none = await rpc(base, undefined, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(none.status, 401);
  assert.match(none.headers.get('www-authenticate') ?? '', /^Bearer/);
  const bogus = await rpc(base, 'mcpg_' + 'x'.repeat(43), { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(bogus.status, 401);
  // fetch() won't send a custom Host header, so use node:http.
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request(`${base}/mcp`, { method: 'POST', headers: { host: 'evil.example.com', authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  });
  assert.equal(status, 403);
});

test('hung read tool: outcome timeout within CALL_TIMEOUT_MS; audit goes pending -> timeout', async () => {
  const client = await mcpClient(adminKey);
  const started = Date.now();
  const call = client.callTool({ name: 'alpha__hang', arguments: {} });
  const pending = await waitFor(async () => {
    const res = await admin().get('/api/audit?outcome=pending');
    return res.body.rows.find((r: any) => r.tool_name === 'hang');
  }, 900, 'pending audit row');
  assert.equal(pending.duration_ms, null);
  const result = await call;
  const elapsed = Date.now() - started;
  assert.equal(result.isError, true);
  assert.ok(elapsed < 2000, `took ${elapsed}ms`);
  const final = (await admin().get('/api/audit?limit=50')).body.rows.find((r: any) => r.id === pending.id);
  assert.equal(final.outcome, 'timeout');
  assert.ok(final.duration_ms >= 900 && final.duration_ms < 2000);
  assert.match(final.error, /timed out after 1000ms/);
  await client.close();
});

test('hung write tool: outcome unknown, warns that it may have been applied', async () => {
  const client = await mcpClient(adminKey);
  const result = await client.callTool({ name: 'alpha__hang_write', arguments: {} });
  assert.equal(result.isError, true);
  assert.match((result.content as any)[0].text, /may have been applied; verify before retrying/);
  const row = (await admin().get('/api/audit?limit=1')).body.rows[0];
  assert.equal(row.outcome, 'unknown');
  await client.close();
});

test('dead upstream: unreachable with reason, listing stays fast and complete for others', async () => {
  const res = await track(admin().post('/api/servers', { slug: 'dead', name: 'Dead', url: await deadUrl(), auth_type: 'none' }));
  assert.equal(res.status, 201);
  ids.dead = res.body.id;
  const dead = await waitFor(async () => {
    const list = await admin().get('/api/servers');
    const s = list.body.find((x: any) => x.slug === 'dead');
    return s.status === 'unreachable' && s;
  });
  assert.equal(dead.last_error, 'connection refused');

  const client = await mcpClient(adminKey);
  const started = Date.now();
  const tools = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(Date.now() - started < 500);
  assert.ok(tools.includes('alpha__search') && tools.includes('beta__search'));
  assert.ok(!tools.some((t) => t.startsWith('dead__')));
  await client.close();
});

test('upstream 401 is reported clearly', async () => {
  const res = await admin().post('/api/servers', { slug: 'noauth', name: 'Wrong creds', url: alpha.url, auth_type: 'bearer', credential: 'wrong' });
  const s = await waitFor(async () => {
    const list = await admin().get('/api/servers');
    const s = list.body.find((x: any) => x.id === res.body.id);
    return s.status === 'unreachable' && s;
  });
  assert.equal(s.last_error, 'HTTP 401 from upstream');
  assert.equal((await admin().del(`/api/servers/${res.body.id}`)).status, 204);
});

test('refresh picks up changed tools and bumps tools_changed_at', async () => {
  const beforeRes = await admin().get('/api/servers');
  const before = beforeRes.body.find((s: any) => s.slug === 'alpha');
  assert.equal(before.tools_changed_at, null, 'first discovery is not a change');
  alphaExtraTool = true;
  const res = await track(admin().post(`/api/servers/${ids.alpha}/refresh`));
  assert.equal(res.status, 200);
  assert.ok(res.body.tools.some((t: any) => t.exposed_name === 'alpha__extra'));
  assert.notEqual(res.body.tools_changed_at, before.tools_changed_at);
});

test('member cannot see or call an admin_only tool, and the attempt is audited as denied', async () => {
  const policy = await track(admin().put(`/api/servers/${ids.alpha}/tools/create_thing/policy`, { admin_only: true }));
  assert.equal(policy.status, 200);
  assert.equal(policy.body.tools.find((t: any) => t.name === 'create_thing').admin_only, true);

  const member = await inviteMember(base, admin(), 'member@example.com');
  const key = (await member.post('/api/keys', { name: 'member key' })).body.key;
  const client = await mcpClient(key);
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes('alpha__search'));
  assert.ok(!names.includes('alpha__create_thing'));
  const memberServers = await member.get('/api/servers');
  assert.ok(!memberServers.body.find((s: any) => s.slug === 'alpha').tools.some((t: any) => t.name === 'create_thing'));

  const denied = await client.callTool({ name: 'alpha__create_thing', arguments: { name: 'x' } });
  assert.equal(denied.isError, true);
  assert.equal(createCalls, 0);
  const own = await member.get('/api/audit');
  assert.equal(own.body.rows.length, 1);
  assert.equal(own.body.rows[0].outcome, 'denied');
  assert.equal(own.body.rows[0].user_email, 'member@example.com');
  const all = await admin().get('/api/audit?outcome=denied');
  assert.ok(all.body.rows.some((r: any) => r.user_email === 'member@example.com' && r.tool_name === 'create_thing'));
  assert.equal((await member.get('/api/users')).status, 403);
  assert.equal((await member.post('/api/servers', { slug: 'm', name: 'm', url: alpha.url, auth_type: 'none' })).status, 403);

  const adminMcp = await mcpClient(adminKey);
  const ok = await adminMcp.callTool({ name: 'alpha__create_thing', arguments: { name: 'widget' } });
  assert.deepEqual(ok.content, [{ type: 'text', text: 'created widget' }]);
  await adminMcp.close();
  await client.close();
});

test('disabled server: tools vanish from tools/list, direct calls are refused, listeners are notified', async () => {
  const client = await mcpClient(adminKey);
  let notified = false;
  client.setNotificationHandler('notifications/tools/list_changed', async () => {
    notified = true;
  });
  await client.listen({ toolsListChanged: true });

  const res = await track(admin().patch(`/api/servers/${ids.beta}`, { enabled: false }));
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'disabled');
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(!names.includes('beta__search'));
  const refused = await client.callTool({ name: 'beta__search', arguments: { q: 'x' } });
  assert.equal(refused.isError, true);
  const row = (await admin().get('/api/audit?limit=1')).body.rows[0];
  assert.equal(row.outcome, 'denied');
  assert.match(row.error, /disabled/);
  await waitFor(async () => notified, 3000, 'list_changed notification');
  await client.close();
});

test('revoked key: the very next /mcp request gets 401', async () => {
  const created = await admin().post('/api/keys', { name: 'to revoke' });
  const key = created.body.key;
  assert.equal((await rpc(base, key, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '0' } } })).status, 200);
  assert.equal((await admin().del(`/api/keys/${created.body.id}`)).status, 204);
  const after = await rpc(base, key, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-protocol-version': '2025-06-18' });
  assert.equal(after.status, 401);
  const listed = (await admin().get('/api/keys')).body.find((k: any) => k.id === created.body.id);
  assert.ok(listed.revoked_at);
});

test('deleting a server keeps its audit history', async () => {
  assert.equal((await admin().del(`/api/servers/${ids.beta}`)).status, 204);
  const rows = (await admin().get('/api/audit?server=beta')).body.rows;
  assert.ok(rows.length >= 1);
});

test('no /api response ever contains an upstream credential', async () => {
  for (const path of ['/api/servers', '/api/users', '/api/keys?all=1', '/api/audit?limit=200', '/api/invites', '/api/meta', '/api/auth/me']) {
    responses.push((await admin().get(path)).text);
  }
  const all = responses.join('\n');
  assert.ok(all.length > 1000);
  assert.equal(all.includes(ALPHA_SECRET), false);
  assert.equal(all.includes(BETA_SECRET), false);
  assert.equal(/credential_enc/.test(all), false);
});
