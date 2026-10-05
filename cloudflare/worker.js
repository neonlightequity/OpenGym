// Cloudflare Worker entry for gym.davidovichequity.com (fork-owned; see CLOUDFLARE.md).
// Serves the built frontend from static assets and hands /api/* to the OpenGymServer Durable
// Object, which runs api/server.js.
export { OpenGymServer } from './server-do.js';

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
      return withHeaders(await server(env).fetch(new Request(request, { headers })));
    }
    return withHeaders(await env.ASSETS.fetch(request));
  }
};
