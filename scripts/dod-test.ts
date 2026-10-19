import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const APP = process.env.APP_URL ?? 'http://app.localtest.me';
const STORE = process.env.STORE_URL ?? 'http://store.localtest.me';
const PLATFORM_NS = process.env.PLATFORM_NS ?? 'urumi-platform';
const MCP_NS = process.env.MCP_NS ?? 'urumi-mcp';
const SKIP_CHAT = process.env.SKIP_CHAT === '1';
const CLAUDE_CLI = process.env.CLAUDE_CLI === '1';

const kubectl = (...args: string[]) => execFileSync('kubectl', args, { encoding: 'utf8' }).trim();
const secret = (ns: string, name: string, key: string) =>
  Buffer.from(kubectl('get', 'secret', '-n', ns, name, '-o', `jsonpath={.data.${key}}`), 'base64').toString();

let step = 0;
async function check(name: string, fn: () => Promise<void>) {
  step++;
  const started = Date.now();
  try {
    await fn();
    console.log(`ok ${step} - ${name} (${Date.now() - started}ms)`);
  } catch (err) {
    console.log(`not ok ${step} - ${name}\n  ${(err as Error).message.replaceAll('\n', '\n  ')}`);
    process.exitCode = 1;
  }
}

class Session {
  cookie = '';
  async api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${APP}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch', cookie: this.cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0]!;
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

async function mcpClient(key: string) {
  const client = new Client({ name: 'dod-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${APP}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }),
  );
  return client;
}

const toolNames = async (client: Client) => (await client.listTools()).tools.map((t) => t.name).sort();
const text = (result: any) => result.content.map((c: any) => c.text ?? '').join('\n');

async function storefrontOrder(productId: number) {
  const s = `${STORE}/wp-json/wc/store/v1`;
  const cart = await fetch(`${s}/cart`);
  const headers = {
    nonce: cart.headers.get('nonce')!,
    'cart-token': cart.headers.get('cart-token')!,
    'content-type': 'application/json',
  };
  const add = await fetch(`${s}/cart/add-item`, { method: 'POST', headers, body: JSON.stringify({ id: productId, quantity: 1 }) });
  assert.equal(add.status, 201, `add to cart: ${await add.text()}`);
  const res = await fetch(`${s}/checkout`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      payment_method: 'cod',
      billing_address: {
        first_name: 'Asha', last_name: 'Rao', address_1: '1 MG Road', city: 'Bengaluru',
        state: 'KA', postcode: '560001', country: 'IN', email: 'asha@example.com', phone: '9999999999',
      },
    }),
  });
  const body = await res.json();
  assert.ok(body.order_id, `checkout failed: ${JSON.stringify(body).slice(0, 300)}`);
  return body.order_id as number;
}

async function storeProductByName(name: string) {
  const res = await fetch(`${STORE}/wp-json/wc/store/v1/products?search=${encodeURIComponent(name)}`);
  return ((await res.json()) as { id: number; name: string }[]).find((p) => p.name === name);
}

async function waitFor(what: string, fn: () => Promise<boolean>, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const runId = Date.now().toString(36);
const productName = `DoD Widget ${runId}`;
const admin = new Session();
const memberB = new Session();
let keyB = '';
let orderId = 0;
let fxId = '';
let notesId = '';
let adminEmail = '';

await check('user A (admin) logs into the dashboard', async () => {
  const password = secret(PLATFORM_NS, 'gateway-credentials', 'gateway-admin-password');
  const email = JSON.parse(kubectl('get', 'deploy', '-n', PLATFORM_NS, 'gateway', '-o', 'jsonpath={.spec.template.spec.containers[0].env}'))
    .find((e: any) => e.name === 'BOOTSTRAP_ADMIN_EMAIL').value;
  adminEmail = email;
  const { user } = await admin.api('POST', '/api/auth/login', { email, password });
  assert.equal(user.role, 'admin');
});

await check('WooCommerce is pre-registered, three upstreams connected', async () => {
  await waitFor('all servers connected', async () => {
    const servers = await admin.api<any[]>('GET', '/api/servers');
    return ['woo', 'notes', 'fx'].every((slug) => servers.find((s) => s.slug === slug)?.status === 'connected');
  });
  const servers = await admin.api<any[]>('GET', '/api/servers');
  fxId = servers.find((s) => s.slug === 'fx').id;
  notesId = servers.find((s) => s.slug === 'notes').id;
  assert.ok(JSON.stringify(servers).indexOf(secret(MCP_NS, 'mcp-credentials', 'woo-mcp-token')) === -1, 'upstream credential leaked');
});

await check('admin invites user B as member; B accepts and creates an API key', async () => {
  const invite = await admin.api('POST', '/api/invites', { email: `b-${runId}@example.com`, role: 'member' });
  const token = new URL(invite.invite_url).pathname.split('/').pop()!;
  await memberB.api('POST', `/api/invites/${token}/accept`, { name: 'User B', password: 'correct horse battery' });
  keyB = (await memberB.api('POST', '/api/keys', { name: 'claude-code' })).key;
  assert.match(keyB, /^mcpg_/);
});

if (!SKIP_CHAT) {
  await check('chat as A: create a product, it appears on the storefront', async () => {
    const res = await admin.api('POST', '/api/chat', {
      message: `Create a product named "${productName}" priced 149. Use the store tool.`,
    });
    assert.ok(res.tool_calls.some((c: any) => c.name === 'woo__create_product' && c.outcome === 'ok'), JSON.stringify(res.tool_calls));
    assert.ok(await storeProductByName(productName), 'product not on storefront');
  });
}

await check('place a COD order through the storefront\'s cart and checkout API (the browser flow is in docs/DEMO.md)', async () => {
  const product = (await storeProductByName(productName)) ?? (await storeProductByName('Urumi Mug'));
  assert.ok(product, 'no product to order');
  orderId = await storefrontOrder(product.id);
});

if (!SKIP_CHAT) {
  await check('chat as A: "what orders came in today" returns that order', async () => {
    const res = await admin.api('POST', '/api/chat', { message: 'What orders came in today? List their numbers.' });
    assert.ok(res.tool_calls.some((c: any) => c.name === 'woo__list_orders'), JSON.stringify(res.tool_calls));
    assert.match(res.reply, new RegExp(`\\b${orderId}\\b`), res.reply);
  });
}

await check('external client as B sees tools of every enabled server, minus admin-only ones', async () => {
  const client = await mcpClient(keyB);
  const names = await toolNames(client);
  for (const t of ['woo__list_orders', 'woo__get_order', 'notes__create_note', 'fx__convert']) assert.ok(names.includes(t), `missing ${t}`);
  assert.ok(!names.includes('woo__create_product'), 'member can see admin-only create_product');
  await client.close();
});

await check('B asks for today\'s orders and gets the storefront order', async () => {
  const client = await mcpClient(keyB);
  const result = await client.callTool({ name: 'woo__list_orders', arguments: { period: 'today' } });
  assert.ok(!result.isError, text(result));
  assert.ok((result.structuredContent as any).orders.some((o: any) => o.id === orderId), text(result).slice(0, 400));
  await client.close();
});

await check('B chains tools from three upstreams via the SDK (orders total -> EUR -> note)', async () => {
  const client = await mcpClient(keyB);
  const orders = (await client.callTool({ name: 'woo__list_orders', arguments: { period: 'today' } })).structuredContent as any;
  const [currency, total] = Object.entries(orders.totals_by_currency)[0] as [string, string];
  const fx = await client.callTool({ name: 'fx__convert', arguments: { amount: Number(total), from: currency, to: 'EUR' } });
  assert.ok(!fx.isError, text(fx));
  const note = await client.callTool({
    name: 'notes__create_note',
    arguments: { title: `Sales ${runId}`, body: `Today: ${total} ${currency} = ${(fx.structuredContent as any).converted} EUR` },
  });
  assert.ok(!note.isError, text(note));
  await client.close();
});

if (CLAUDE_CLI) {
  await check('B in the real Claude Code CLI answers a two-server prompt with only the gateway URL and key', async () => {
    const lastAuditId = Number((await admin.api('GET', '/api/audit?limit=1')).rows[0]?.id ?? 0);
    const dir = mkdtempSync(join(tmpdir(), 'dod-claude-'));
    try {
      writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { urumi: { type: 'http', url: `${APP}/mcp`, headers: { Authorization: `Bearer ${keyB}` } } } }));
      const out = execFileSync(
        'claude',
        ['-p', 'Using the urumi tools: list the order numbers from today and their total in EUR.', '--strict-mcp-config', '--mcp-config', 'mcp.json',
          '--allowedTools', 'mcp__urumi__woo__list_orders', 'mcp__urumi__fx__convert'],
        { cwd: dir, encoding: 'utf8', timeout: 240_000 },
      );
      assert.match(out, new RegExp(`\\b${orderId}\\b`), out);
      assert.match(out, /EUR/, out);
      const { rows } = await admin.api('GET', '/api/audit?limit=50');
      const fresh = rows.filter((r: any) => r.user_email === `b-${runId}@example.com` && r.source === 'mcp' && r.outcome === 'ok' && Number(r.id) > lastAuditId);
      assert.ok(fresh.some((r: any) => r.server_slug === 'woo' && r.tool_name === 'list_orders'), 'Claude Code did not call woo__list_orders');
      assert.ok(fresh.some((r: any) => r.server_slug === 'fx' && r.tool_name === 'convert'), 'Claude Code did not call fx__convert');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

await check('member B calling an admin-only tool directly is refused', async () => {
  const client = await mcpClient(keyB);
  const result = await client.callTool({ name: 'woo__create_product', arguments: { name: 'nope', regular_price: '1' } }).catch((e) => ({ isError: true, content: [{ text: e.message }] }));
  assert.ok(result.isError, 'expected denial');
  await client.close();
});

await check('disable fx: its tools disappear for the external client and the chat agent', async () => {
  await admin.api('PATCH', `/api/servers/${fxId}`, { enabled: false });
  const client = await mcpClient(keyB);
  assert.ok(!(await toolNames(client)).some((n) => n.startsWith('fx__')), 'fx tools still listed');
  const call = await client.callTool({ name: 'fx__convert', arguments: { amount: 1, from: 'USD', to: 'EUR' } }).catch((e) => ({ isError: true, content: [{ text: e.message }] }));
  assert.ok(call.isError, 'call to disabled server succeeded');
  await client.close();
  const servers = await admin.api<any[]>('GET', '/api/servers');
  assert.equal(servers.find((s) => s.id === fxId).status, 'disabled');
  if (!SKIP_CHAT) {
    const res = await admin.api('POST', '/api/chat', { message: 'Convert 10 USD to EUR using a currency tool.' });
    assert.ok(!res.tool_calls.some((c: any) => c.name.startsWith('fx__')), `chat still called fx: ${JSON.stringify(res.tool_calls)}`);
  }
  await admin.api('PATCH', `/api/servers/${fxId}`, { enabled: true });
});

await check('kill the notes pod: others keep working, dashboard shows notes unreachable', async () => {
  kubectl('scale', 'deploy/notes-mcp', '-n', MCP_NS, '--replicas=0');
  try {
    await waitFor('notes unreachable', async () => {
      const servers = await admin.api<any[]>('GET', '/api/servers');
      return servers.find((s) => s.id === notesId).status === 'unreachable';
    });
    const client = await mcpClient(keyB);
    const result = await client.callTool({ name: 'woo__list_orders', arguments: { period: 'today' } });
    assert.ok(!result.isError, 'woo broke while notes was down');
    const dead = await client.callTool({ name: 'notes__list_notes', arguments: {} }).catch((e) => ({ isError: true, content: [{ text: e.message }] }));
    assert.ok(dead.isError, 'call to dead upstream did not fail');
    await client.close();
  } finally {
    kubectl('scale', 'deploy/notes-mcp', '-n', MCP_NS, '--replicas=1');
  }
});

await check('revoke B\'s key: the next call is rejected', async () => {
  const keys = await memberB.api<any[]>('GET', '/api/keys');
  await memberB.api('DELETE', `/api/keys/${keys.find((k) => keyB.startsWith(k.prefix)).id}`);
  const err = await mcpClient(keyB).then(toolNames).then(() => null, (e) => e);
  assert.ok(err, 'revoked key still works');
  assert.match(String(err.status ?? err.message), /401/);
});

await check('audit log attributes every call to the right user and source', async () => {
  const { rows } = await admin.api('GET', '/api/audit?limit=200');
  const mine = rows.filter((r: any) => Date.parse(r.started_at) > Date.now() - 30 * 60_000);
  const bMcp = mine.filter((r: any) => r.user_email === `b-${runId}@example.com` && r.source === 'mcp');
  assert.ok(bMcp.some((r: any) => r.tool_name === 'list_orders' && r.outcome === 'ok'), 'B list_orders missing');
  assert.ok(bMcp.some((r: any) => r.server_slug === 'fx'), 'B fx call missing');
  assert.ok(bMcp.some((r: any) => r.outcome === 'denied'), 'B denied call missing');
  if (!SKIP_CHAT) {
    assert.ok(mine.some((r: any) => r.user_email === adminEmail && r.source === 'chat' && r.tool_name === 'create_product' && r.outcome === 'ok'), 'A chat create_product missing');
    assert.ok(mine.some((r: any) => r.user_email === adminEmail && r.source === 'chat' && r.tool_name === 'list_orders'), 'A chat list_orders missing');
  }
});

console.log(process.exitCode ? '\nDEFINITION OF DONE: FAILED' : '\nDEFINITION OF DONE: PASSED');
