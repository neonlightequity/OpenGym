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
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      // nginx overwrote these with the real peer; do the same so the client cannot choose them.
      const headers = new Headers(request.headers);
      const ip = request.headers.get('cf-connecting-ip') || '';
      headers.set('x-forwarded-for', ip);
      headers.set('x-real-ip', ip);
      const stub = env.OPENGYM.get(env.OPENGYM.idFromName('main'));
      return withHeaders(await stub.fetch(new Request(request, { headers })));
    }
    return withHeaders(await env.ASSETS.fetch(request));
  }
};
