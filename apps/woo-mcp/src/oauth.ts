import { createHmac, randomBytes } from 'node:crypto';

export type OAuthCredentials = { consumerKey: string; consumerSecret: string };

export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function signatureBaseString(method: string, baseUrl: string, params: Record<string, string>): string {
  const pairs = Object.keys(params)
    .sort()
    .map((key) => `${rfc3986(key)}=${rfc3986(params[key]!)}`)
    .join('&');
  return [method.toUpperCase(), rfc3986(baseUrl), rfc3986(pairs)].join('&');
}

export function sign(
  algorithm: 'sha1' | 'sha256',
  baseString: string,
  consumerSecret: string,
  tokenSecret = '',
): string {
  return createHmac(algorithm, `${rfc3986(consumerSecret)}&${rfc3986(tokenSecret)}`).update(baseString).digest('base64');
}

/**
 * Returns the query parameters for a one-legged OAuth 1.0a request, the scheme WooCommerce
 * requires when the REST API is reached over plain HTTP. WooCommerce rebuilds the base URL from
 * its configured home URL with an http scheme, so `signingUrl` must be `http://<public host><path>`
 * even though the request itself goes to the in-cluster Service.
 */
export function oauthQuery(
  creds: OAuthCredentials,
  method: string,
  signingUrl: string,
  query: Record<string, string>,
  now = Date.now(),
  nonce = randomBytes(16).toString('hex'),
): Record<string, string> {
  const params: Record<string, string> = {
    ...query,
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: Math.floor(now / 1000).toString(),
  };
  const base = signatureBaseString(method, signingUrl, params);
  return { ...params, oauth_signature: sign('sha256', base, creds.consumerSecret) };
}
