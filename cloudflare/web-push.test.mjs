// Checks the Workers web-push stand-in against independent implementations: the payload must
// decrypt with http_ece (what the npm web-push package encrypts with) using the subscriber's
// keys, and the VAPID JWT must verify against the public key /api/push/public-key serves.
//   node --test cloudflare/web-push.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import webpush, { generateVAPIDKeysAsync } from './web-push.js';

const require = createRequire(new URL('../api/package.json', import.meta.url));
const ece = require('http_ece');

test('payload decrypts with the subscriber keys and the JWT verifies with the VAPID key', async () => {
  const vapid = await generateVAPIDKeysAsync();
  assert.equal(Buffer.from(vapid.publicKey, 'base64url').length, 65);
  webpush.setVapidDetails('https://gym.davidovichequity.com', vapid.publicKey, vapid.privateKey);

  const client = crypto.createECDH('prime256v1');
  client.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = { endpoint: 'https://push.example.test/send/abc', keys: { p256dh: client.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };

  let seen;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen = { url, init }; return new Response('', { status: 201 }); };
  try {
    await webpush.sendNotification(sub, JSON.stringify({ title: 'Rest over', body: 'Next set' }), { urgency: 'high' });
  } finally { globalThis.fetch = realFetch; }

  assert.equal(seen.url, sub.endpoint);
  const h = seen.init.headers;
  assert.equal(h['content-encoding'], 'aes128gcm');
  assert.equal(h.urgency, 'high');
  assert.equal(h.ttl, '2419200');
  const plain = ece.decrypt(Buffer.from(seen.init.body), { version: 'aes128gcm', privateKey: client, authSecret: auth.toString('base64url') });
  assert.deepEqual(JSON.parse(plain.toString('utf8').replace(/\0+$/, '')), { title: 'Rest over', body: 'Next set' });

  const m = /^vapid t=([^,]+), k=(.+)$/.exec(h.authorization);
  assert.ok(m, h.authorization);
  assert.equal(m[2], vapid.publicKey);
  const [hd, pl, sig] = m[1].split('.');
  const claims = JSON.parse(Buffer.from(pl, 'base64url'));
  assert.equal(claims.aud, 'https://push.example.test');
  assert.equal(claims.sub, 'https://gym.davidovichequity.com');
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: Buffer.from(vapid.publicKey, 'base64url').subarray(1, 33).toString('base64url'), y: Buffer.from(vapid.publicKey, 'base64url').subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${hd}.${pl}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
});

test('a refusal from the push service carries statusCode and body, like web-push', async () => {
  const vapid = await generateVAPIDKeysAsync();
  webpush.setVapidDetails('mailto:a@b.c', vapid.publicKey, vapid.privateKey);
  const client = crypto.createECDH('prime256v1'); client.generateKeys();
  const sub = { endpoint: 'https://push.example.test/x', keys: { p256dh: client.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('gone', { status: 410 });
  try {
    await assert.rejects(webpush.sendNotification(sub, '{}'), e => e.statusCode === 410 && e.body === 'gone');
  } finally { globalThis.fetch = realFetch; }
});
