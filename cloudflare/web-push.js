// Stand-in for the `web-push` npm package in the Workers build (aliased in wrangler.toml).
// Keeps the calls api/server.js makes, on WebCrypto + fetch instead of node:https/crypto.
// Keys stay in web-push's format (base64url raw P-256 public point, base64url private scalar),
// so /api/push/public-key and stored subscriptions mean the same thing on either runtime.
import { buildPushPayload } from '@block65/webcrypto-web-push';

let vapid = null;
const b64u = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

// web-push generates keys synchronously; WebCrypto cannot. The Worker generates a pair with
// generateVAPIDKeysAsync() and stores it before server.js boots, so this is only reached if that
// step was skipped — which is a bug, not a state to paper over.
function generateVAPIDKeys() {
  throw new Error('VAPID keys must be provisioned before boot (cloudflare/server-do.js)');
}

export async function generateVAPIDKeysAsync() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
  return { publicKey: b64u(raw), privateKey: jwk.d };
}

function setVapidDetails(subject, publicKey, privateKey) {
  if (fromB64u(publicKey).length !== 65) throw new Error('VAPID public key must be a 65-byte uncompressed point');
  vapid = { subject, publicKey, privateKey };
}

// The browsers' push services. Upstream refuses private addresses at connect time; a Worker
// cannot reach those anyway, but would otherwise POST to any public URL a signed-in user names.
// An endpoint elsewhere is answered like a dead subscription (410), so server.js prunes it.
const PUSH_HOSTS = [
  'fcm.googleapis.com',                 // Chrome, Edge, Android
  'updates.push.services.mozilla.com',  // Firefox
  'push.apple.com',                     // Safari / iOS (web.push.apple.com)
  'notify.windows.com'                  // legacy Edge (*.notify.windows.com)
];
const allowedEndpoint = raw => {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && PUSH_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch { return false; }
};

// At most this much of a push service's answer is kept (it only goes into a log line).
const MAX_ANSWER = 4096;
async function readCapped(res) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (size < MAX_ANSWER) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); size += value.byteLength;
    }
  } finally { reader.cancel().catch(() => {}); }
  const all = new Uint8Array(size); let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(all.subarray(0, MAX_ANSWER));
}

// Mirrors web-push's default TTL (four weeks): a briefly offline phone still gets the alert.
const DEFAULT_TTL = 2419200;

async function sendNotification(subscription, body, opts = {}) {
  if (!vapid) throw new Error('setVapidDetails was not called');
  if (!allowedEndpoint(subscription.endpoint)) {
    throw Object.assign(new Error('endpoint is not a known push service'), { statusCode: 410, body: 'endpoint not allowed' });
  }
  const payload = await buildPushPayload(
    { data: body, options: { ttl: opts.TTL ?? DEFAULT_TTL, ...(opts.urgency ? { urgency: opts.urgency } : {}) } },
    { endpoint: subscription.endpoint, expirationTime: null, keys: subscription.keys },
    vapid
  );
  const res = await fetch(subscription.endpoint, { ...payload, signal: AbortSignal.timeout(opts.timeout || 10000) });
  const text = await readCapped(res).catch(() => '');
  if (!res.ok) throw Object.assign(new Error(`push service answered ${res.status}`), { statusCode: res.status, body: text });
  return { statusCode: res.status, body: text, headers: Object.fromEntries(res.headers) };
}

export default { generateVAPIDKeys, setVapidDetails, sendNotification };
export { generateVAPIDKeys, setVapidDetails, sendNotification };
