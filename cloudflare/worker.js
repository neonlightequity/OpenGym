// Cloudflare Worker entry for gym.davidovichequity.com (fork-owned; see CLOUDFLARE.md).
// Serves the built frontend from static assets and hands /api/* to the OpenGymServer Durable
// Object, which runs api/server.js.
export { OpenGymServer } from './server-do.js';
import { mediaLimits } from '../api/media.js';

// Request bodies are read whole HERE, in the Worker, before the Durable Object sees them. The
// Worker runs as many isolates as there are requests; the API is one object. A sender that
// trickles a body, or many at once, then occupies Worker requests (which Cloudflare scales),
// never the object everyone's requests go through.
const MAX_JSON = 10 * 1024 * 1024;                    // 2 × api/server.js MAX_BODY
const MEDIA_PUT = /^\/api\/media\/[0-9a-f]{64}$/;
const JSON_DEADLINE_MS = 60000;                        // a few MB of JSON, even on a slow phone
async function readWhole(request, cap, deadlineMs) {
  if (!request.body) return new Uint8Array(0);
  const declared = +(request.headers.get('content-length') || 0);
  if (declared > cap) return null;
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  const until = deadlineMs ? Date.now() + deadlineMs : 0;
  for (;;) {
    let step, timer;
    try {
      const next = reader.read();
      step = until ? await Promise.race([next, new Promise(r => { timer = setTimeout(() => r('late'), Math.max(0, until - Date.now())); })]) : await next;
    } finally { clearTimeout(timer); }
    if (step === 'late') { reader.cancel().catch(() => {}); return 'late'; }
    if (step.done) break;
    size += step.value.byteLength;
    if (size > cap) { reader.cancel().catch(() => {}); return null; }
    chunks.push(step.value);
  }
  const out = new Uint8Array(size); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

// The headers web/nginx.conf.template sets on every response, plus HSTS (TLS ends here).
const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000'
};

function withHeaders(response) {
  const out = new Response(response.body, response);
  // Only where the response has not set its own: uploaded media carry a stricter CSP
  // (default-src 'none'; sandbox), as they do behind nginx.
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!out.headers.has(k)) out.headers.set(k, v);
  return out;
}

const server = env => env.OPENGYM.get(env.OPENGYM.idFromName('main'));

// Operator routes for backups. They exist only while the OPS_TOKEN secret is set
// (`wrangler secret put OPS_TOKEN`) and need it as a bearer token; anything else is a 404, as if
// the path did not exist. cloudflare/ops.mjs calls them.
async function tokenOk(request, env) {
  const given = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.OPS_TOKEN || !given) return false;
  const digest = s => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return crypto.subtle.timingSafeEqual(await digest(given), await digest(env.OPS_TOKEN));
}

async function ops(request, env, url) {
  const notFound = () => Response.json({ error: 'not found' }, { status: 404 });
  if (!(await tokenOk(request, env))) return notFound();
  const route = request.method + ' ' + url.pathname;
  try {
    if (route === 'GET /__ops/backups') return Response.json(await server(env).listBackups());
    if (route === 'POST /__ops/backup') return Response.json(await server(env).manualBackup());
    if (route === 'POST /__ops/restore') {
      const key = url.searchParams.get('key') || '';
      if (!/^(daily|monthly|manual|pre-restore)\/[\w.-]+\.json\.gz$/.test(key)) return Response.json({ error: 'key must name a backup object' }, { status: 400 });
      return Response.json(await server(env).restoreBackup(key));
    }
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
  return notFound();
}

export default {
  // Daily backup to R2 (crons in wrangler.toml).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(server(env).scheduledBackup());
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/__ops/')) return withHeaders(await ops(request, env, url));
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      // nginx overwrote these with the real peer; do the same so the client cannot choose them.
      const headers = new Headers(request.headers);
      const ip = request.headers.get('cf-connecting-ip') || '';
      headers.set('x-forwarded-for', ip);
      headers.set('x-real-ip', ip);
      let body = null;
      if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') {
        const upload = request.method === 'PUT' && MEDIA_PUT.test(url.pathname);
        // An upload body is only read for a signed-in profile (the route would answer 401 anyway).
        if (upload && !(await server(env).sessionValid(request.headers.get('cookie'), request.headers.get('authorization')))) {
          request.body?.cancel().catch(() => {});
          return withHeaders(Response.json({ error: 'not signed in' }, { status: 401 }));
        }
        const L = mediaLimits(env);
        const cap = upload && L.enabled ? 2 * Math.ceil(Math.max(L.imageMB, L.gifMB, L.videoMB) * 1024 * 1024) : MAX_JSON;
        // Uploads over a slow uplink may take long (upstream allows half an hour); they occupy
        // only this Worker request while they do.
        body = await readWhole(request, cap, upload ? 0 : JSON_DEADLINE_MS);
        if (body === null) return withHeaders(Response.json({ error: 'body too large' }, { status: 413 }));
        if (body === 'late') return withHeaders(Response.json({ error: 'request body took too long' }, { status: 408 }));
        headers.delete('transfer-encoding');
        headers.set('content-length', String(body.byteLength));
      }
      return withHeaders(await server(env).fetch(new Request(request.url, { method: request.method, headers, body, redirect: 'manual' })));
    }
    return withHeaders(await env.ASSETS.fetch(request));
  }
};
