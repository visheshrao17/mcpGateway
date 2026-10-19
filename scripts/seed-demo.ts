// Fills a bootstrapped install with demo orders, team members with keys,
// extra upstream servers in each state, and real tool calls so the audit log and notes are populated.
// Idempotent: rerunning skips what already exists. Usage: node scripts/seed-demo.ts
import { execFileSync } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createWooClient } from '../apps/woo-mcp/src/woo.ts';

const APP = process.env.APP_URL ?? 'http://app.localtest.me';
const STORE_HOST = process.env.STORE_HOST ?? 'store.localtest.me';
const PLATFORM_NS = process.env.PLATFORM_NS ?? 'urumi-platform';
const MCP_NS = process.env.MCP_NS ?? 'urumi-mcp';
const STORE_NS = process.env.STORE_NS ?? 'urumi-store';
const DEMO_PASSWORD = 'demo-password-2026';
const WITH_CHAT = process.env.SKIP_CHAT !== '1';

const kubectl = (...args: string[]) => execFileSync('kubectl', args, { encoding: 'utf8' }).trim();
const secret = (ns: string, name: string, key: string) =>
  Buffer.from(kubectl('get', 'secret', '-n', ns, name, '-o', `jsonpath={.data.${key}}`), 'base64').toString();
const step = (msg: string) => console.log(`- ${msg}`);

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
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }
  static async login(email: string, password: string) {
    const s = new Session();
    await s.api('POST', '/api/auth/login', { email, password });
    return s;
  }
}

const woo = createWooClient({
  inClusterUrl: `http://${STORE_HOST}`,
  publicHost: STORE_HOST,
  consumerKey: secret(MCP_NS, 'mcp-credentials', 'woo-consumer-key'),
  consumerSecret: secret(MCP_NS, 'mcp-credentials', 'woo-consumer-secret'),
  timeoutMs: 20_000,
});


const CUSTOMERS = [
  { first_name: 'Rohan', last_name: 'Mehta', city: 'Mumbai', state: 'MH', postcode: '400001' },
  { first_name: 'Priya', last_name: 'Nair', city: 'Kochi', state: 'KL', postcode: '682001' },
  { first_name: 'Karthik', last_name: 'Iyer', city: 'Chennai', state: 'TN', postcode: '600001' },
  { first_name: 'Meera', last_name: 'Shah', city: 'Ahmedabad', state: 'GJ', postcode: '380001' },
  { first_name: 'Arjun', last_name: 'Singh', city: 'Delhi', state: 'DL', postcode: '110001' },
  { first_name: 'Ananya', last_name: 'Das', city: 'Kolkata', state: 'WB', postcode: '700001' },
];

const ORDERS: { customer: number; items: [string, number][]; status: string; daysAgo: number }[] = [
  { customer: 0, items: [['Masala Chai Tin', 2], ['Ceramic Mug Set', 1]], status: 'processing', daysAgo: 0 },
  { customer: 1, items: [['Handloom Tote Bag', 1]], status: 'processing', daysAgo: 0 },
  { customer: 2, items: [['Filter Coffee Pack', 3]], status: 'on-hold', daysAgo: 0 },
  { customer: 3, items: [['Brass Diya Set', 1], ['Block-Print Cushion Cover', 2]], status: 'completed', daysAgo: 1 },
  { customer: 4, items: [['Masala Chai Tin', 1]], status: 'completed', daysAgo: 1 },
  { customer: 5, items: [['Ceramic Mug Set', 2]], status: 'cancelled', daysAgo: 2 },
  { customer: 0, items: [['Filter Coffee Pack', 1], ['Handloom Tote Bag', 1]], status: 'completed', daysAgo: 3 },
  { customer: 2, items: [['Block-Print Cushion Cover', 4]], status: 'pending', daysAgo: 4 },
];

const MEMBERS = [
  { email: 'priya.nair@urumi.local', name: 'Priya Nair', role: 'member', keys: ['claude-code', 'cursor'] },
  { email: 'rohan.mehta@urumi.local', name: 'Rohan Mehta', role: 'member', keys: ['mcp-inspector'], revoke: ['old-laptop'] },
  { email: 'ops.lead@urumi.local', name: 'Ops Lead', role: 'admin', keys: ['claude-code'] },
];

async function seedStore() {
  const existing = new Map<string, number>();
  for (let page = 1; ; page++) {
    const { data, totalPages } = await woo.get('/products', { per_page: 100, page, status: 'any' });
    for (const p of data as { id: number; name: string }[]) existing.set(p.name, p.id);
    if (page >= totalPages) break;
  }
  step(`store: ${existing.size} bootstrap-owned products available`);

  const { data: seeded } = await woo.get('/orders', { search: 'example.in', per_page: 100, status: 'any' });
  if ((seeded as unknown[]).length > 0) {
    step('store: demo orders already seeded');
    return;
  }
  const backdate: [number, number][] = [];
  for (const o of ORDERS) {
    const c = CUSTOMERS[o.customer]!;
    const email = `${c.first_name.toLowerCase()}.${c.last_name.toLowerCase()}@example.in`;
    const { data: order } = await woo.post('/orders', {
      status: o.status,
      payment_method: 'cod',
      payment_method_title: 'Cash on delivery',
      set_paid: o.status === 'completed',
      customer_note: 'urumi-demo-seed',
      billing: { ...c, address_1: '12 Main Road', country: 'IN', email, phone: '9800000000' },
      line_items: o.items.map(([name, quantity]) => ({ product_id: existing.get(name), quantity })),
    });
    if (o.daysAgo > 0) backdate.push([order.id, o.daysAgo]);
  }
  // The REST API ignores date_created on create, so older orders are backdated through WooCommerce itself.
  const php = `require '/var/www/html/wp-load.php'; foreach (json_decode('${JSON.stringify(backdate)}') as [$id, $days]) { $o = wc_get_order($id); $o->set_date_created(time() - $days * 86400 - 7200); $o->save(); }`;
  kubectl('exec', '-n', STORE_NS, 'deploy/wordpress', '-c', 'wordpress', '--', 'php', '-r', php);
  step(`store: ${ORDERS.length} orders across processing, on-hold, completed, cancelled and pending, spread over 5 days`);
}

async function seedTeam(admin: Session) {
  const users = await admin.api<{ email: string }[]>('GET', '/api/users');
  const keys: Record<string, string> = {};
  for (const m of MEMBERS) {
    if (!users.some((u) => u.email === m.email)) {
      const invite = await admin.api('POST', '/api/invites', { email: m.email, role: m.role });
      const token = new URL(invite.invite_url).pathname.split('/').pop()!;
      await new Session().api('POST', `/api/invites/${token}/accept`, { name: m.name, password: DEMO_PASSWORD });
    }
    const me = await Session.login(m.email, DEMO_PASSWORD);
    const mine = await me.api<{ name: string; revoked_at: string | null }[]>('GET', '/api/keys');
    for (const name of m.keys) {
      if (mine.some((k) => k.name === name && !k.revoked_at)) continue;
      keys[`${m.email}/${name}`] = (await me.api('POST', '/api/keys', { name })).key;
    }
    for (const name of m.revoke ?? []) {
      if (mine.some((k) => k.name === name)) continue;
      const k = await me.api('POST', '/api/keys', { name });
      await me.api('DELETE', `/api/keys/${k.id}`);
    }
  }
  const outstanding = await admin.api<{ email: string; accepted_at: string | null }[]>('GET', '/api/invites');
  if (!outstanding.some((i) => i.email === 'karthik.iyer@urumi.local')) {
    await admin.api('POST', '/api/invites', { email: 'karthik.iyer@urumi.local', role: 'member' });
  }
  step(`team: ${MEMBERS.length} members (one extra admin), API keys incl. one revoked, one pending invite`);
  return keys;
}

async function seedServers(admin: Session) {
  const servers = await admin.api<{ slug: string; id: string }[]>('GET', '/api/servers');
  const has = (slug: string) => servers.some((s) => s.slug === slug);
  if (!has('deepwiki')) {
    await admin.api('POST', '/api/servers', { slug: 'deepwiki', name: 'DeepWiki (public docs)', url: 'https://mcp.deepwiki.com/mcp', auth_type: 'none' });
  }
  if (!has('inventory')) {
    await admin.api('POST', '/api/servers', {
      slug: 'inventory',
      name: 'Warehouse inventory (not deployed)',
      url: `http://inventory-mcp.${MCP_NS}.svc.cluster.local:8000/mcp`,
      auth_type: 'bearer',
      credential: 'demo-inventory-token',
    });
  }
  if (!has('crm')) {
    const crm = await admin.api('POST', '/api/servers', {
      slug: 'crm',
      name: 'Legacy CRM (switched off)',
      url: `http://crm-mcp.${MCP_NS}.svc.cluster.local:8000/mcp`,
      auth_type: 'header',
      auth_header_name: 'X-Api-Key',
      credential: 'demo-crm-key',
    });
    await admin.api('PATCH', `/api/servers/${crm.id}`, { enabled: false });
  }
  for (let i = 0; i < 30; i++) {
    const current = await admin.api<{ slug: string; status: string }[]>('GET', '/api/servers');
    if (current.find((s) => s.slug === 'deepwiki')?.status === 'connected') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  step('servers: + deepwiki (public, connected), inventory (unreachable), crm (disabled, header credential)');
}

async function mcp(key: string) {
  const client = new Client({ name: 'seed-demo', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${APP}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  type Result = { isError?: boolean; structuredContent?: any; content: unknown };
  const call = async (name: string, args: Record<string, unknown>): Promise<Result> => {
    try {
      return (await client.callTool({ name, arguments: args })) as Result;
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: (err as Error).message }] };
    }
  };
  return { client, call };
}

async function seedActivity(keys: Record<string, string>) {
  const priyaKey = keys['priya.nair@urumi.local/claude-code'];
  const rohanKey = keys['rohan.mehta@urumi.local/mcp-inspector'];
  const opsKey = keys['ops.lead@urumi.local/claude-code'];
  if (!priyaKey || !rohanKey || !opsKey) {
    step('activity: skipped (members already had keys from an earlier run)');
    return;
  }

  const priya = await mcp(priyaKey);
  const today = (await priya.call('woo__list_orders', { period: 'today' })).structuredContent as any;
  await priya.call('woo__list_orders', { period: 'yesterday' });
  if (today?.orders?.[0]) await priya.call('woo__get_order', { order_id: today.orders[0].id });
  const [currency, total] = Object.entries(today?.totals_by_currency ?? { INR: '0' })[0] as [string, string];
  const fx = (await priya.call('fx__convert', { amount: Number(total), from: currency, to: 'EUR' })).structuredContent as any;
  await priya.call('notes__create_note', {
    title: 'Daily sales summary',
    body: `Today: ${today?.count ?? 0} orders, ${total} ${currency} (about ${fx?.converted ?? '?'} EUR at the ECB rate of ${fx?.rate_date ?? 'n/a'}).`,
  });
  await priya.call('deepwiki__read_wiki_structure', { repoName: 'woocommerce/woocommerce' });
  await priya.client.close();

  const rohan = await mcp(rohanKey);
  await rohan.call('woo__list_products', { search: 'chai' });
  await rohan.call('woo__create_product', { name: 'Unapproved product', regular_price: '10' });
  await rohan.call('woo__update_order_status', { order_id: 1, status: 'completed' });
  await rohan.call('fx__convert', { amount: 100, from: 'INR', to: 'XXX' });
  await rohan.call('notes__create_note', { title: 'Restock request', body: 'Masala Chai Tin is selling fast; please reorder 50 tins.' });
  await rohan.client.close();

  const ops = await mcp(opsKey);
  const onHold = (await ops.call('woo__list_orders', { status: 'on-hold' })).structuredContent as any;
  if (onHold?.orders?.[0]) await ops.call('woo__update_order_status', { order_id: onHold.orders[0].id, status: 'processing' });
  await ops.call('notes__create_note', { title: 'On-hold orders policy', body: 'Move on-hold COD orders to processing after a phone confirmation.' });
  await ops.client.close();
  step('activity: tool calls by three users (ok, denied, tool_error) and three team notes');
}

async function seedChat(admin: Session) {
  const prompts = [
    'What orders came in today? Give me the total in EUR as well.',
    'Which products do we sell under 500 rupees?',
  ];
  for (const message of prompts) {
    try {
      await admin.api('POST', '/api/chat', { message });
    } catch (err) {
      step(`chat: "${message}" failed: ${(err as Error).message}`);
      return;
    }
  }
  step(`chat: ${prompts.length} conversations as the admin`);
}

const adminEmail = JSON.parse(kubectl('get', 'deploy', '-n', PLATFORM_NS, 'gateway', '-o', 'jsonpath={.spec.template.spec.containers[0].env}'))
  .find((e: { name: string }) => e.name === 'BOOTSTRAP_ADMIN_EMAIL').value as string;
const admin = await Session.login(adminEmail, secret(PLATFORM_NS, 'gateway-credentials', 'gateway-admin-password'));

await seedStore();
const keys = await seedTeam(admin);
await seedServers(admin);
await seedActivity(keys);
if (WITH_CHAT) await seedChat(admin);
console.log(`\nDemo users log in with password "${DEMO_PASSWORD}": ${MEMBERS.map((m) => m.email).join(', ')}`);
