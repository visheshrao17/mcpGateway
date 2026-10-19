import * as z from 'zod/v4';
import { env, json, serveMcp, toolError } from '@urumi/mcp-kit';

const currency = z.string().regex(/^[A-Za-z]{3}$/, 'ISO 4217 code like USD').transform((c) => c.toUpperCase());

type Rates = { base: string; date: string; rates: Record<string, number> };

export function createFx(apiUrl: string, timeoutMs: number) {
  return async function latest(base: string, symbols: string[]): Promise<Rates> {
    const url = `${apiUrl}/latest?base=${base}&symbols=${symbols.join(',')}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`rates provider returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as Rates;
  };
}

export function registerFxTools(server: import('@modelcontextprotocol/server').McpServer, latest: ReturnType<typeof createFx>) {
  const source = 'European Central Bank reference rates via frankfurter.dev';

  server.registerTool(
    'convert',
    {
      description: 'Convert an amount between currencies using the latest ECB reference rate. Returns the rate and the date it was published.',
      inputSchema: z.object({ amount: z.number().finite(), from: currency, to: currency }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ amount, from, to }) => {
      if (from === to) return json({ amount, from, to, rate: 1, converted: amount, rate_date: null, source });
      try {
        const r = await latest(from, [to]);
        const rate = r.rates[to];
        if (rate === undefined) return toolError(`no rate for ${from} to ${to}`);
        return json({ amount, from, to, rate, converted: Math.round(amount * rate * 100) / 100, rate_date: r.date, source });
      } catch (err) {
        return toolError(`could not fetch rates: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    'get_rates',
    {
      description: 'Latest ECB reference rates for a base currency.',
      inputSchema: z.object({ base: currency, symbols: z.array(currency).min(1).max(30) }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ base, symbols }) => {
      try {
        return json({ ...(await latest(base, symbols)), source });
      } catch (err) {
        return toolError(`could not fetch rates: ${(err as Error).message}`);
      }
    },
  );
}

if (import.meta.main) {
  const latest = createFx(env('FX_API_URL', 'https://api.frankfurter.dev/v1'), Number(env('FX_TIMEOUT_MS', '5000')));
  serveMcp({ name: 'fx', version: '1.0.0', register: (server) => registerFxTools(server, latest) });
}
