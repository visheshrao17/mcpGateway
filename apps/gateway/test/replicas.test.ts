import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod/v4';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Gateway } from '../src/app.ts';
import { ADMIN, apiClient, fakeUpstream, freshDatabase, startGateway, testConfig, waitFor, type Upstream } from './helpers.ts';

let upstream: Upstream;
let one: { gw: Gateway; url: string };
let two: { gw: Gateway; url: string };

before(async () => {
  upstream = await fakeUpstream((s) => {
    s.registerTool('search', { inputSchema: z.object({}), annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: 'text', text: 'hit' }] }));
  });
  const config = testConfig(await freshDatabase());
  one = await startGateway(config);
  two = await startGateway(config);
});

after(async () => {
  await one.gw.stop();
  await two.gw.stop();
  await upstream.close();
});

test('two replicas converge: a disable on one removes the tools on the other', async () => {
  const admin1 = apiClient(one.url);
  await admin1.login(ADMIN.email, ADMIN.password);
  const created = await admin1.post('/api/servers', { slug: 'shared', name: 'Shared', url: upstream.url, auth_type: 'none' });
  assert.equal(created.status, 201);
  const key = (await admin1.post('/api/keys', { name: 'k' })).body.key;

  const client = new Client({ name: 'replica-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${two.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  let notified = false;
  client.setNotificationHandler('notifications/tools/list_changed', async () => {
    notified = true;
  });

  await waitFor(async () => (await client.listTools()).tools.some((t) => t.name === 'shared__search'), 5000, 'tool on replica two');
  assert.equal((await client.callTool({ name: 'shared__search', arguments: {} })).isError, undefined);
  await client.listen({ toolsListChanged: true });

  assert.equal((await admin1.patch(`/api/servers/${created.body.id}`, { enabled: false })).status, 200);

  await waitFor(async () => !(await client.listTools()).tools.some((t) => t.name === 'shared__search'), 3000, 'tool gone on replica two');
  assert.equal(two.gw.ctx.manager.catalog.servers.get(created.body.id)?.enabled, false);
  const refused = await client.callTool({ name: 'shared__search', arguments: {} });
  assert.equal(refused.isError, true);
  await waitFor(async () => notified, 3000, 'list_changed on replica two');

  const admin2 = apiClient(two.url);
  await admin2.login(ADMIN.email, ADMIN.password);
  await admin2.patch(`/api/servers/${created.body.id}`, { enabled: true });
  await admin2.put(`/api/servers/${created.body.id}/tools/search/policy`, { admin_only: true });
  await waitFor(async () => {
    const route = one.gw.ctx.manager.catalog.routes.get('shared__search');
    return route?.server.enabled && route.adminOnly;
  }, 3000, 'policy on replica one');
  await client.close();
});

test('dispatch authorizes against the database even when this replica has not reloaded yet', async () => {
  const admin = apiClient(one.url);
  await admin.login(ADMIN.email, ADMIN.password);
  const created = await admin.post('/api/servers', { slug: 'stale', name: 'Stale', url: upstream.url, auth_type: 'none' });
  const key = (await admin.post('/api/keys', { name: 'stale' })).body.key;
  const client = new Client({ name: 'stale-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${two.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  await waitFor(async () => (await client.listTools()).tools.some((t) => t.name === 'stale__search'), 5000, 'tool on replica two');

  await two.gw.ctx.pool.query('UPDATE servers SET enabled = false WHERE id = $1', [created.body.id]);
  assert.equal(two.gw.ctx.manager.catalog.servers.get(created.body.id)?.enabled, true, 'cache is still stale');
  const refused = await client.callTool({ name: 'stale__search', arguments: {} });
  assert.equal(refused.isError, true);
  const { rows } = await two.gw.ctx.pool.query(`SELECT outcome FROM audit_log WHERE server_slug = 'stale' ORDER BY id DESC LIMIT 1`);
  assert.equal(rows[0].outcome, 'denied');
  await client.close();
});

test('seed servers are created once; a deleted seed server stays deleted after restart', async () => {
  const seed = JSON.stringify([{ slug: 'seeded', name: 'Seeded', url: upstream.url, auth_type: 'none' }]);
  const config = testConfig(await freshDatabase(), { SEED_SERVERS: seed });
  let gw = await startGateway(config);
  const admin = apiClient(gw.url);
  await admin.login(ADMIN.email, ADMIN.password);
  const seeded = (await admin.get('/api/servers')).body.find((s: any) => s.slug === 'seeded');
  assert.ok(seeded, 'seed server created on first start');
  assert.equal((await admin.del(`/api/servers/${seeded.id}`)).status, 204);
  await gw.gw.stop();

  gw = await startGateway(config);
  const again = apiClient(gw.url);
  await again.login(ADMIN.email, ADMIN.password);
  assert.equal((await again.get('/api/servers')).body.some((s: any) => s.slug === 'seeded'), false);
  await gw.gw.stop();
});
