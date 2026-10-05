// Just enough of node:http's IncomingMessage and ServerResponse for api/server.js's handle(),
// built from a fetch Request and resolving to a fetch Response.
import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';

// The body is already in memory (the Durable Object read it), so it is handed over in one
// 'data' event. It is emitted only once a reader is listening: readBody() attaches its
// listeners inside the route, after the route has awaited other things.
class Req extends EventEmitter {
  constructor(request, url, body, ip) {
    super();
    this.method = request.method;
    this.url = url.pathname + url.search;
    this.headers = Object.fromEntries(request.headers);   // already lower-case
    this.socket = { remoteAddress: ip, destroy: () => { this.destroyed = true; } };
    // Nothing trickles in: there is no slow body for bodyDeadline() to cut off.
    this.complete = true;
    this.readableEnded = false;
    this.destroyed = false;
    this.body = body;
    this.flushed = false;
  }
  on(ev, fn) {
    super.on(ev, fn);
    if ((ev === 'data' || ev === 'end') && !this.flushed) {
      this.flushed = true;
      setTimeout(() => {
        if (this.destroyed) return;
        if (this.body.byteLength) this.emit('data', Buffer.from(this.body));
        this.readableEnded = true;
        this.emit('end');
      }, 0);
    }
    return this;
  }
  once(ev, fn) {
    const wrap = (...a) => { this.off(ev, wrap); fn(...a); };
    return this.on(ev, wrap);
  }
  pause() { return this; }
  resume() { return this; }
  destroy() { this.destroyed = true; this.emit('close'); return this; }
}

class Res extends EventEmitter {
  constructor(resolve) {
    super();
    this.statusCode = 200;
    this.headersSent = false;
    this.writableEnded = false;
    this.headers = new Map();
    this.chunks = [];
    this.resolve = resolve;
  }
  setHeader(k, v) { this.headers.set(k.toLowerCase(), v); return this; }
  getHeader(k) { return this.headers.get(k.toLowerCase()); }
  removeHeader(k) { this.headers.delete(k.toLowerCase()); }
  hasHeader(k) { return this.headers.has(k.toLowerCase()); }
  writeHead(code, msg, headers) {
    if (typeof msg === 'object' && msg) headers = msg;
    this.statusCode = code;
    if (Array.isArray(headers)) for (let i = 0; i < headers.length; i += 2) this.setHeader(headers[i], headers[i + 1]);
    else for (const [k, v] of Object.entries(headers || {})) this.setHeader(k, v);
    this.headersSent = true;
    return this;
  }
  write(chunk) {
    this.headersSent = true;
    if (chunk != null) this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
    return true;
  }
  end(chunk) {
    if (this.writableEnded) return this;
    if (chunk != null && typeof chunk !== 'function') this.write(chunk);
    this.headersSent = true;
    this.writableEnded = true;
    const h = new Headers();
    // Several Set-Cookie values (session + cleared legacy cookie) must stay separate headers.
    for (const [k, v] of this.headers) for (const one of [].concat(v)) h.append(k, String(one));
    const noBody = this.statusCode === 204 || this.statusCode === 304;
    this.resolve(new Response(noBody ? null : Buffer.concat(this.chunks), { status: this.statusCode, headers: h }));
    this.emit('finish');
    this.emit('close');
    return this;
  }
  destroy() {
    if (!this.writableEnded) { this.writableEnded = true; this.resolve(new Response(null, { status: 500 })); }
    this.emit('close');
  }
}

// Runs a node-style handler against a fetch Request. handle() awaits its route, so once it
// returns the response is either ended or never will be; the latter is answered with a 500.
export async function runNodeHandler(handle, request, body, ip) {
  const url = new URL(request.url);
  let resolve;
  const answered = new Promise(r => { resolve = r; });
  const req = new Req(request, url, body, ip);
  const res = new Res(resolve);
  try { await handle(req, res); }
  catch (e) { console.error('unhandled', e); }
  if (res.writableEnded) return answered;
  return new Response(JSON.stringify({ error: 'server error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
}
