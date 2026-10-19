import { oauthQuery, type OAuthCredentials } from './oauth.ts';

export type WooConfig = OAuthCredentials & {
  inClusterUrl: string;
  /** Public host WordPress is configured with; WooCommerce verifies the signature against it. */
  publicHost: string;
  timeoutMs: number;
};

export class WooError extends Error {}

type Query = Record<string, string | number | undefined>;

export function createWooClient(config: WooConfig) {
  async function request(method: string, path: string, query: Query = {}, body?: unknown) {
    const clean = Object.fromEntries(
      Object.entries(query).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])),
    );
    const route = `/wp-json/wc/v3${path}`;
    const signed = oauthQuery(config, method, `http://${config.publicHost}${route}`, clean);
    const url = `${config.inClusterUrl}${route}?${new URLSearchParams(signed)}`;
    let res: Response;
    let text: string;
    try {
      res = await fetch(url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      if (timedOut && method !== 'GET') {
        throw new WooError(
          `store did not answer within ${config.timeoutMs}ms; the ${method} may have been applied. Check with get_order or list_products before retrying.`,
        );
      }
      throw new WooError(`store unreachable: ${timedOut ? `timed out after ${config.timeoutMs}ms` : String(err)}`);
    }
    if (!res.ok) {
      let message = text.slice(0, 300);
      try {
        message = JSON.parse(text).message ?? message;
      } catch {}
      throw new WooError(`store returned HTTP ${res.status}: ${message}`);
    }
    return { data: JSON.parse(text), totalPages: Number(res.headers.get('x-wp-totalpages') ?? '1') };
  }

  return {
    get: (path: string, query?: Query) => request('GET', path, query),
    post: (path: string, body: unknown) => request('POST', path, {}, body),
    put: (path: string, body: unknown) => request('PUT', path, {}, body),
  };
}

export type WooClient = ReturnType<typeof createWooClient>;

function offsetMs(timeZone: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - at;
}

function localDate(timeZone: string, at: number): [number, number, number] {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone }).format(at).split('-').map(Number);
  return [y!, m!, d!];
}

function localMidnightUtc(timeZone: string, y: number, m: number, d: number): number {
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - offsetMs(timeZone, guess);
  return guess - offsetMs(timeZone, first);
}

export function dayWindow(timeZone: string, now: number, daysFromToday: number) {
  const [y, m, d] = localDate(timeZone, now);
  const start = localMidnightUtc(timeZone, y, m, d + daysFromToday);
  const end = localMidnightUtc(timeZone, y, m, d + daysFromToday + 1);
  return { after: new Date(start).toISOString(), before: new Date(end).toISOString() };
}

const SCALE = 10_000;

export function toMinor(amount: string): number {
  const [whole, frac = ''] = amount.trim().split('.');
  const sign = whole!.startsWith('-') ? -1 : 1;
  return sign * (Math.abs(Number(whole)) * SCALE + Number(frac.padEnd(4, '0').slice(0, 4)));
}

export function fromMinor(minor: number, decimals = 2): string {
  return (minor / SCALE).toFixed(decimals);
}

export function sumByCurrency(orders: { total: string; currency: string }[]): Record<string, string> {
  const totals = new Map<string, number>();
  for (const o of orders) totals.set(o.currency, (totals.get(o.currency) ?? 0) + toMinor(o.total));
  return Object.fromEntries([...totals].map(([c, minor]) => [c, fromMinor(minor)]));
}
