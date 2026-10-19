import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayWindow, sumByCurrency } from '../src/woo.ts';

test('today in Asia/Kolkata just after local midnight starts at 18:30 UTC the previous day', () => {
  const now = Date.parse('2026-10-15T18:45:00Z');
  assert.deepEqual(dayWindow('Asia/Kolkata', now, 0), {
    after: '2026-10-15T18:30:00.000Z',
    before: '2026-10-16T18:30:00.000Z',
  });
});

test('yesterday window across a DST change is 23 hours long', () => {
  const now = Date.parse('2026-03-09T15:00:00Z');
  const { after, before } = dayWindow('America/New_York', now, -1);
  assert.equal(after, '2026-03-08T05:00:00.000Z');
  assert.equal(before, '2026-03-09T04:00:00.000Z');
});

test('totals are exact per currency', () => {
  const orders = [
    { total: '0.10', currency: 'USD' },
    { total: '0.20', currency: 'USD' },
    { total: '1999.99', currency: 'INR' },
  ];
  assert.deepEqual(sumByCurrency(orders), { USD: '0.30', INR: '1999.99' });
});

test('a write that times out says it may have been applied; a read just says unreachable', async () => {
  const { createServer } = await import('node:http');
  const { createWooClient } = await import('../src/woo.ts');
  const hang = createServer(() => {});
  await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r));
  const { port } = hang.address() as { port: number };
  const woo = createWooClient({ inClusterUrl: `http://127.0.0.1:${port}`, publicHost: 'store.test', consumerKey: 'ck', consumerSecret: 'cs', timeoutMs: 200 });
  await assert.rejects(woo.post('/products', { name: 'x' }), /may have been applied/);
  await assert.rejects(woo.get('/orders'), /store unreachable: timed out after 200ms/);
  hang.closeAllConnections();
  hang.close();
});

test('a write whose response body stalls after the headers still warns it may have been applied', async () => {
  const { createServer } = await import('node:http');
  const { createWooClient } = await import('../src/woo.ts');
  const stall = createServer((_req, res) => {
    res.writeHead(201, { 'content-type': 'application/json' });
    res.write('{"id": 1');
  });
  await new Promise<void>((r) => stall.listen(0, '127.0.0.1', r));
  const { port } = stall.address() as { port: number };
  const woo = createWooClient({ inClusterUrl: `http://127.0.0.1:${port}`, publicHost: 'store.test', consumerKey: 'ck', consumerSecret: 'cs', timeoutMs: 200 });
  await assert.rejects(woo.post('/products', { name: 'x' }), /may have been applied/);
  stall.closeAllConnections();
  stall.close();
});
