// Just enough of node:http's IncomingMessage and ServerResponse for api/server.js's handle(),
// built from a fetch Request and resolving to a fetch Response.
import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import { Writable } from 'node:stream';

// The body is already in memory (the Durable Object read it), so it is handed over in one
// 'data' event. It is emitted only once a reader is listening: readBody() and media.js attach
// their listeners inside the route, after the route has awaited other things.
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
        // A view, not a copy: an upload may be tens of MB in a 128 MB isolate.
        if (this.body.byteLength) this.emit('data', Buffer.from(this.body.buffer, this.body.byteOffset, this.body.byteLength));
        if (this.destroyed) return;
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

// A real Writable, so stream.pipeline() can write a file into it (sendMediaFile).
class Res extends Writable {
  constructor(resolve) {
    super();
    this.statusCode = 200;
    this.headersSent = false;
    this.answered = false;
    this.headerMap = new Map();
    this.chunks = [];
    this.resolveResponse = resolve;
  }
  setHeader(k, v) { this.headerMap.set(k.toLowerCase(), v); return this; }
  getHeader(k) { return this.headerMap.get(k.toLowerCase()); }
  removeHeader(k) { this.headerMap.delete(k.toLowerCase()); }
  hasHeader(k) { return this.headerMap.has(k.toLowerCase()); }
  writeHead(code, msg, headers) {
    if (typeof msg === 'object' && msg) headers = msg;
    this.statusCode = code;
    if (Array.isArray(headers)) for (let i = 0; i < headers.length; i += 2) this.setHeader(headers[i], headers[i + 1]);
    else for (const [k, v] of Object.entries(headers || {})) this.setHeader(k, v);
    this.headersSent = true;
    return this;
  }
  _write(chunk, enc, cb) {
    this.headersSent = true;
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc));
    cb();
  }
  _final(cb) {
    this.headersSent = true;
    this.answer(Buffer.concat(this.chunks));
    cb();
  }
  answer(body) {
    if (this.answered) return;
    this.answered = true;
    const h = new Headers();
    // Several Set-Cookie values (session + cleared legacy cookie) must stay separate headers.
    for (const [k, v] of this.headerMap) for (const one of [].concat(v)) h.append(k, String(one));
    const noBody = this.statusCode === 204 || this.statusCode === 304;
    this.resolveResponse(new Response(noBody ? null : body, { status: this.statusCode, headers: h }));
  }
  _destroy(err, cb) {
    // Destroyed before it finished (a download that failed midway): there is no complete answer.
    if (!this.answered) { this.answered = true; this.resolveResponse(new Response(null, { status: 500 })); }
    cb(err);
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
  if (res.writableEnded || res.answered) return answered;
  return new Response(JSON.stringify({ error: 'server error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
}
