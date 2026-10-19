import * as z from 'zod/v4';
import { env, json, serveMcp, toolError } from '@urumi/mcp-kit';
import { createWooClient, dayWindow, sumByCurrency, WooError, type WooClient } from './woo.ts';

const ORDER_STATUSES = ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed'] as const;
const MAX_ORDERS = 500;

type WooOrder = {
  id: number;
  number: string;
  status: string;
  currency: string;
  total: string;
  date_created_gmt: string;
  billing: { first_name: string; last_name: string; email: string };
  line_items: { name: string; quantity: number; total: string }[];
};

type WooProduct = { id: number; name: string; status: string; price: string; regular_price: string; stock_status: string; permalink: string };

const product = (p: WooProduct) => ({
  id: p.id,
  name: p.name,
  status: p.status,
  price: p.price || p.regular_price,
  stock_status: p.stock_status,
  permalink: p.permalink,
});

const order = (o: WooOrder) => ({
  id: o.id,
  number: o.number,
  status: o.status,
  total: o.total,
  currency: o.currency,
  created_at: `${o.date_created_gmt}Z`,
  customer: `${o.billing.first_name} ${o.billing.last_name}`.trim() || o.billing.email || 'guest',
  items: o.line_items.map((li) => ({ name: li.name, quantity: li.quantity, total: li.total })),
});

async function run<T>(fn: () => Promise<T>) {
  try {
    return json(await fn());
  } catch (err) {
    if (err instanceof WooError) return toolError(err.message);
    throw err;
  }
}

export function registerWooTools(server: import('@modelcontextprotocol/server').McpServer, woo: WooClient, timeZone: string) {
  server.registerTool(
    'list_products',
    {
      description: 'List store products. Optional search text and status filter.',
      inputSchema: z.object({
        search: z.string().max(100).optional(),
        status: z.enum(['publish', 'draft', 'pending', 'private', 'any']).default('any'),
        page: z.number().int().min(1).default(1),
        per_page: z.number().int().min(1).max(100).default(20),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ search, status, page, per_page }) =>
      run(async () => {
        const { data, totalPages } = await woo.get('/products', { search, status, page, per_page });
        return { page, total_pages: totalPages, products: (data as WooProduct[]).map(product) };
      }),
  );

  server.registerTool(
    'create_product',
    {
      description: 'Create a simple product. It is published on the storefront unless status is draft.',
      inputSchema: z.object({
        name: z.string().min(1).max(200),
        regular_price: z.string().regex(/^\d+(\.\d{1,2})?$/, 'price like 19.99'),
        description: z.string().max(5000).optional(),
        status: z.enum(['publish', 'draft']).default('publish'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    (input) => run(async () => product((await woo.post('/products', { type: 'simple', ...input })).data as WooProduct)),
  );

  server.registerTool(
    'list_orders',
    {
      description: `List orders, newest first. Use period "today" or "yesterday" for calendar days in the store timezone (${timeZone}), or give after/before as ISO 8601 UTC instants. Fetches every page up to ${MAX_ORDERS} orders and returns totals per currency.`,
      inputSchema: z.object({
        period: z.enum(['today', 'yesterday']).optional(),
        after: z.iso.datetime().optional(),
        before: z.iso.datetime().optional(),
        status: z.enum(ORDER_STATUSES).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ period, after, before, status }) =>
      run(async () => {
        const window = period ? dayWindow(timeZone, Date.now(), period === 'today' ? 0 : -1) : { after, before };
        const orders: WooOrder[] = [];
        for (let page = 1; orders.length < MAX_ORDERS; page++) {
          const { data, totalPages } = await woo.get('/orders', {
            ...window,
            dates_are_gmt: 'true',
            status,
            page,
            per_page: 100,
            orderby: 'date',
            order: 'desc',
          });
          orders.push(...(data as WooOrder[]));
          if (page >= totalPages) break;
        }
        return {
          timezone: timeZone,
          window,
          count: orders.length,
          truncated: orders.length >= MAX_ORDERS,
          totals_by_currency: sumByCurrency(orders),
          orders: orders.map(order),
        };
      }),
  );

  server.registerTool(
    'get_order',
    {
      description: 'Get one order by id, including line items and billing contact.',
      inputSchema: z.object({ order_id: z.number().int().positive() }),
      annotations: { readOnlyHint: true },
    },
    ({ order_id }) =>
      run(async () => {
        const o = (await woo.get(`/orders/${order_id}`)).data as WooOrder;
        return { ...order(o), billing_email: o.billing.email };
      }),
  );

  server.registerTool(
    'update_order_status',
    {
      description: 'Change the status of an order.',
      inputSchema: z.object({ order_id: z.number().int().positive(), status: z.enum(ORDER_STATUSES) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    ({ order_id, status }) =>
      run(async () => {
        const o = (await woo.put(`/orders/${order_id}`, { status })).data as WooOrder;
        return { id: o.id, number: o.number, status: o.status };
      }),
  );
}

if (import.meta.main) {
  const woo = createWooClient({
    inClusterUrl: env('WC_BASE_URL'),
    publicHost: env('WC_PUBLIC_HOST'),
    consumerKey: env('WC_CONSUMER_KEY'),
    consumerSecret: env('WC_CONSUMER_SECRET'),
    timeoutMs: Number(env('WC_TIMEOUT_MS', '15000')),
  });
  const timeZone = env('STORE_TIMEZONE', 'UTC');
  serveMcp({ name: 'woocommerce', version: '1.0.0', register: (server) => registerWooTools(server, woo, timeZone) });
}
