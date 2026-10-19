import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { assignExposedNames, exposedName } from '../src/naming.ts';
import { checkUpstreamUrl, guardedFetch, SsrfError } from '../src/ssrf.ts';
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from '../src/crypto.ts';
import { argsSummary } from '../src/calltool.ts';
import { loadConfig } from '../src/config.ts';

test('naming: two servers exposing the same tool stay distinct', () => {
  const names = assignExposedNames([
    { slug: 'github', tool: 'search' },
    { slug: 'linear', tool: 'search' },
  ]);
  assert.deepEqual(names, ['github__search', 'linear__search']);
});

test('naming: long and odd names are shortened, valid, unique and stable', () => {
  const longA = 'a'.repeat(80) + '_one';
  const longB = 'a'.repeat(80) + '_two';
  const a = exposedName('woo', longA);
  const b = exposedName('woo', longB);
  assert.notEqual(a, b);
  for (const n of [a, b, exposedName('woo', 'get.order/v2'), exposedName('woo', 'ünïcode tool')]) {
    assert.match(n, /^[A-Za-z0-9_-]{1,64}$/);
  }
  assert.equal(a, exposedName('woo', longA));
  assert.equal(a.length, 64);
  assert.notEqual(exposedName('x', 'a.b'), exposedName('x', 'a/b'));
  const names = assignExposedNames([{ slug: 'x', tool: 'a.b' }, { slug: 'x', tool: 'a/b' }, { slug: 'x', tool: 'a_b' }]);
  assert.equal(new Set(names).size, 3);
});

const policy = { allowedPrivateHostSuffixes: ['.svc.cluster.local'] };
const fakeLookup = (map: Record<string, string>) => async (host: string) => {
  if (!map[host]) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  return [{ address: map[host]!, family: map[host]!.includes(':') ? 6 : 4 }];
};

test('ssrf: rejects loopback, metadata, private without suffix, bad schemes', async () => {
  const lookup = fakeLookup({ 'internal.example.com': '10.1.2.3', 'rebind.example.com': '127.0.0.1', 'v6.example.com': '::1' });
  for (const url of [
    'http://127.0.0.1:8000/mcp',
    'http://localhost:8000/mcp',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.5/mcp',
    'http://192.168.1.10/mcp',
    'http://internal.example.com/mcp',
    'http://rebind.example.com/mcp',
    'http://v6.example.com/mcp',
    'http://[::1]/mcp',
    'http://[::ffff:127.0.0.1]/mcp',
    'http://[fe80::1]/mcp',
    'http://0.0.0.0/mcp',
    'http://224.0.0.1/mcp',
    'file:///etc/passwd',
    'ftp://example.com/',
  ]) {
    await assert.rejects(checkUpstreamUrl(url, policy, url.includes('localhost') ? fakeLookup({ localhost: '127.0.0.1' }) : lookup), SsrfError, url);
  }
});

test('ssrf: accepts cluster services and public hosts', async () => {
  const lookup = fakeLookup({ 'woo-mcp.urumi.svc.cluster.local': '10.43.0.12', 'mcp.example.com': '93.184.216.34' });
  await checkUpstreamUrl('http://woo-mcp.urumi.svc.cluster.local:8000/mcp', policy, lookup);
  await checkUpstreamUrl('https://mcp.example.com/mcp', policy, lookup);
  await checkUpstreamUrl('http://x.svc.cluster.local/mcp', policy, lookup);
  await checkUpstreamUrl('http://8.8.8.8/mcp', policy, lookup);
});

test('crypto: password hashing and credential encryption', async () => {
  const hash = await hashPassword('hunter2-hunter2');
  assert.equal(await verifyPassword('hunter2-hunter2', hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
  const key = randomBytes(32);
  const blob = encryptSecret(key, 'sk-secret', 'woo');
  assert.equal(blob.includes(Buffer.from('sk-secret')), false);
  assert.equal(decryptSecret(key, blob, 'woo'), 'sk-secret');
  assert.throws(() => decryptSecret(key, blob, 'other-slug'));
});

test('audit args summary redacts secret-looking keys and caps length', () => {
  const s = argsSummary({ query: 'shoes', api_key: 'abc', nested: { Authorization: 'Bearer x', password: 'p' }, accessToken: 't' });
  assert.ok(!s.includes('abc') && !s.includes('Bearer x') && !s.includes('"p"') && !s.includes('"t"'));
  assert.ok(s.includes('shoes'));
  assert.equal(argsSummary({ text: 'x'.repeat(2000) }).length, 500);
});

test('config fails fast on missing or bad env', () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL, MASTER_KEY, PUBLIC_URL/);
  assert.throws(() => loadConfig({ DATABASE_URL: 'postgres://x', MASTER_KEY: 'c2hvcnQ=', PUBLIC_URL: 'http://x' }), /32 bytes/);
});

test('ssrf: connect-time guard blocks loopback/metadata even when the URL slipped past create-time checks', async () => {
  const guarded = guardedFetch(policy);
  for (const url of ['http://127.0.0.1:8000/mcp', 'http://localhost:8000/mcp', 'http://169.254.169.254/latest', 'http://[::1]:8000/mcp']) {
    const err = await guarded(url).then(() => undefined, (e) => e);
    assert.ok(err, url);
    const chain = [err, err.cause, err.cause?.cause];
    assert.ok(chain.some((e) => e instanceof SsrfError), `${url}: ${err}`);
  }
});
