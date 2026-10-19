import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rfc3986, sign, signatureBaseString } from '../src/oauth.ts';

test('rfc3986 encodes the characters encodeURIComponent leaves alone', () => {
  assert.equal(rfc3986("a b!'()*~"), 'a%20b%21%27%28%29%2A~');
});

test('matches the published Twitter OAuth 1.0a HMAC-SHA1 example', () => {
  const params = {
    status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
    include_entities: 'true',
    oauth_consumer_key: 'xvz1evFS4wEEPTGEFPHBog',
    oauth_nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: '1318622958',
    oauth_token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
    oauth_version: '1.0',
  };
  const base = signatureBaseString('post', 'https://api.twitter.com/1.1/statuses/update.json', params);
  const signature = sign(
    'sha1',
    base,
    'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
    'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
  );
  assert.equal(signature, 'hCtSmYh+iHYCEqBWrE7C7hYmtUk=');
});
