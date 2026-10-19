import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

export class SsrfError extends Error {}

export type SsrfPolicy = {
  allowedPrivateHostSuffixes: string[];
  allowLoopback?: boolean;
};

type Lookup = (hostname: string) => Promise<{ address: string; family: number }[]>;

const blocked = new net.BlockList();
for (const [net4, prefix] of [
  ['0.0.0.0', 8],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) blocked.addSubnet(net4, prefix, 'ipv4');
for (const [net6, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) blocked.addSubnet(net6, prefix, 'ipv6');

const loopback = new net.BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');

const privateRanges = new net.BlockList();
for (const [net4, prefix] of [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
] as const) privateRanges.addSubnet(net4, prefix, 'ipv4');
privateRanges.addSubnet('fc00::', 7, 'ipv6');

function normalize(address: string): { address: string; type: 'ipv4' | 'ipv6' } {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return { address: mapped[1]!, type: 'ipv4' };
  return { address, type: net.isIPv6(address) ? 'ipv6' : 'ipv4' };
}

export function checkAddress(hostname: string, rawAddress: string, policy: SsrfPolicy) {
  const { address, type } = normalize(rawAddress);
  if (policy.allowLoopback && loopback.check(address, type)) return;
  if (blocked.check(address, type)) throw new SsrfError(`address ${address} is not allowed (loopback, link-local, multicast or unspecified)`);
  if (privateRanges.check(address, type)) {
    const host = hostname.toLowerCase().replace(/\.$/, '');
    if (!policy.allowedPrivateHostSuffixes.some((suffix) => host.endsWith(suffix.toLowerCase()))) {
      throw new SsrfError(`private address ${address} is only allowed for hosts ending in ${policy.allowedPrivateHostSuffixes.join(', ') || '(none configured)'}`);
    }
  }
}

const systemLookup: Lookup = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

export async function checkUpstreamUrl(rawUrl: string, policy: SsrfPolicy, lookup: Lookup = systemLookup) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError('not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SsrfError('only http and https URLs are allowed');
  if (url.username || url.password) throw new SsrfError('credentials in the URL are not allowed; use the credential field');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname)) return checkAddress(hostname, hostname, policy);
  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname);
  } catch {
    return;
  }
  for (const { address } of addresses) checkAddress(hostname, address, policy);
}

export function guardedFetch(policy: SsrfPolicy): typeof fetch {
  const agent = new Agent({
    connect: {
      lookup(hostname, options, callback) {
        const host = hostname.replace(/^\[|\]$/g, '');
        const done = (err: Error | null, list: { address: string; family: number }[] = []) => {
          if (err) return callback(err, '', 4);
          try {
            for (const { address } of list) checkAddress(host, address, policy);
          } catch (e) {
            return callback(e as Error, '', 4);
          }
          if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, l: typeof list) => void)(null, list);
          callback(null, list[0]!.address, list[0]!.family);
        };
        if (net.isIP(host)) return done(null, [{ address: host, family: net.isIP(host) }]);
        dns.lookup(host, { all: true, verbatim: true }, (err, list) => done(err, list));
      },
    },
  });
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SsrfError('only http and https URLs are allowed');
    // net.connect skips lookup() for IP literals, so check those here.
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host)) checkAddress(host, host, policy);
    return undiciFetch(url, { ...(init as object), redirect: 'manual', dispatcher: agent } as Parameters<typeof undiciFetch>[1]);
  }) as unknown as typeof fetch;
}
