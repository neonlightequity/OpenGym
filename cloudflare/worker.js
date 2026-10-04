// Cloudflare Worker entry for gym.davidovichequity.com (fork-owned; see CLOUDFLARE.md).
// Serves the built frontend from static assets and answers /api/*. Until the API port to
// Workers lands, /api answers as an instance that only offers guest mode, so the app boots
// to "Continue without account" instead of a dead sign-in screen.

// The headers web/nginx.conf.template sets on every response.
const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000'
};

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

function api(request, url) {
  if (request.method === 'GET' && url.pathname === '/api/config') return json(200, { invite_only: false, allow_guest: true });
  if (request.method === 'GET' && url.pathname === '/api/health') return json(200, { ok: true, users: 0 });
  if (request.method === 'GET' && url.pathname === '/api/me') return json(401, { error: 'not signed in' });
  return json(503, { error: 'accounts are not available on this instance yet' });
}

function withHeaders(response) {
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return withHeaders(api(request, url));
    return withHeaders(await env.ASSETS.fetch(request));
  }
};
