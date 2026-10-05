// The openGym API as one Durable Object. api/server.js runs inside it unchanged in shape: one
// instance, its in-memory db, synchronous writes — here into the object's SQLite storage
// (do-fs.js) instead of ./data. Timers that must survive the object being evicted (rest-timer
// pushes, the daily reminder tick) are kept as rows and driven by the object's alarm.
import { DurableObject } from 'cloudflare:workers';
import { createDoFs } from './do-fs.js';
import { generateVAPIDKeysAsync } from './web-push.js';
import { runNodeHandler } from './node-http.js';
import * as backup from './backup.js';
import { mediaLimits } from '../api/media.js';

const DATA_DIR = '/data';
const MAX_BODY = 5 * 1024 * 1024;   // api/server.js MAX_BODY
const MEDIA_PUT = /^\/api\/media\/[0-9a-f]{64}$/;
const UPLOADS = `${DATA_DIR}/uploads`;
// Bodies are read into memory before api/server.js sees them, in an isolate of 128 MB. All the
// requests in flight together may hold at most this much; past it a request is refused (503)
// instead of risking the object being reset with everyone's requests in it.
const BUFFER_BUDGET = 48 * 1024 * 1024;
// Without a session, a body is a sign-in, registration or pairing payload of a few KB. Such
// requests get a small cap, a short deadline and a per-address limit, so nobody can hold the
// shared budget (and lock out signed-in users) without an account.
const ANON_CAP = 64 * 1024;
const ANON_DEADLINE_MS = 10000;
const ANON_PER_ADDRESS = 8;
// All anonymous bodies together get this slice of BUFFER_BUDGET, so however many addresses a
// sender has, signed-in requests always keep the rest.
const ANON_BUDGET = 8 * 1024 * 1024;
// One client may hold a whole IPv6 /64; it is counted as one address.
const addressKey = ip => {
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
};
const TICK_MS = 60000;              // reminders are owed for 15 minutes after their time

// The request body, or null once it passes `cap` — read as a stream so a body sent without a
// Content-Length is cut off at the cap instead of being buffered whole first.
// `budget` is shared by every request in flight: { used }. Returns null past `cap`, 'busy'
// when the shared budget would be exceeded. A body that is returned stays counted until the
// caller releases it, when its request is done.
async function readBody(request, cap, budget, deadlineMs = 0, pool = null) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  const release = () => { budget.used -= size; if (pool) pool.used -= size; };
  const refuse = result => { reader.cancel().catch(() => {}); release(); return result; };
  const until = deadlineMs ? Date.now() + deadlineMs : 0;
  for (;;) {
    let step, timer;
    try {
      const next = reader.read();
      step = until
        ? await Promise.race([next, new Promise(r => { timer = setTimeout(() => r('late'), Math.max(0, until - Date.now())); })])
        : await next;
    } catch (e) { release(); throw e; }
    finally { clearTimeout(timer); }
    if (step === 'late') return refuse('late');
    if (step.done) break;
    size += step.value.byteLength;
    budget.used += step.value.byteLength;
    if (pool) pool.used += step.value.byteLength;
    if (size > cap) return refuse(null);
    if (budget.used > BUFFER_BUDGET || (pool && pool.used > pool.max)) return refuse('busy');
    chunks.push(step.value);
  }
  const out = new Uint8Array(size); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

export { addressKey };

export class OpenGymServer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.boot = ctx.blockConcurrencyWhile(() => this.start(env));
    this.buffered = { used: 0 };
    this.anonReads = new Map();   // address (IPv6: its /64) -> anonymous bodies being read now
    this.anonPool = { used: 0, max: ANON_BUDGET };
  }

  async start(env) {
    // server.js reads its configuration from process.env at import time.
    for (const [k, v] of Object.entries(env)) if (typeof v === 'string' && process.env[k] == null) process.env[k] = v;
    process.env.DATA_DIR = DATA_DIR;

    const fs = createDoFs(this.ctx.storage);
    this.fs = fs;
    globalThis.__opengymFs = fs;
    globalThis.__opengymHost = 'cloudflare';
    // web-push makes VAPID keys synchronously on first boot; WebCrypto cannot, so they are made
    // here, before server.js looks for them, in the file and format it expects.
    const vapidFile = `${DATA_DIR}/vapid.json`;
    if (!fs.existsSync(vapidFile)) fs.writeFileSync(vapidFile, JSON.stringify(await generateVAPIDKeysAsync()));

    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS rest_timers (k TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_id TEXT, due INTEGER NOT NULL, lang TEXT)`);
    globalThis.__opengymRestTimers = {
      schedule: (userId, deviceId, sec, lang) => {
        const k = `${userId}:${deviceId || ''}`;
        sql.exec('INSERT OR REPLACE INTO rest_timers (k, user_id, device_id, due, lang) VALUES (?, ?, ?, ?, ?)',
          k, userId, deviceId || null, Date.now() + sec * 1000, lang || null);
      },
      cancel: (userId, deviceId) => {
        // No device id: an older client — clear everything the account has pending.
        if (deviceId) sql.exec('DELETE FROM rest_timers WHERE k = ?', `${userId}:${deviceId}`);
        else sql.exec('DELETE FROM rest_timers WHERE user_id = ?', userId);
      }
    };

    // An upload may be larger than any JSON body; media.js answers an oversized one itself, so
    // the cap here is twice the largest media cap, as its own drain() allows.
    const L = mediaLimits(process.env);
    this.mediaCap = L.enabled ? 2 * Math.ceil(Math.max(L.imageMB, L.gifMB, L.videoMB) * 1024 * 1024) : 0;

    this.api = await import('../api/server.js');
  }

  async fetch(request) {
    await this.boot;
    const path = new URL(request.url).pathname;
    const ip = request.headers.get('cf-connecting-ip') || '';
    const signedIn = this.api.hasSession(Object.fromEntries(request.headers));
    const upload = request.method === 'PUT' && MEDIA_PUT.test(path) && this.mediaCap > 0;
    const drop = r => { request.body?.cancel().catch(() => {}); return r; };
    // An upload's large cap is only for a signed-in profile: anyone else is answered before a
    // byte of the body is read (the same 401 the route itself would give).
    if (upload && !signedIn) return drop(Response.json({ error: 'not signed in' }, { status: 401 }));
    const cap = !signedIn ? ANON_CAP : upload ? this.mediaCap : 2 * MAX_BODY;
    const declared = +(request.headers.get('content-length') || 0);
    if (declared > cap) return drop(Response.json({ error: 'body too large' }, { status: 413 }));
    const anonymous = !signedIn && !!request.body;
    const addr = addressKey(ip);
    if (anonymous) {
      const n = this.anonReads.get(addr) || 0;
      if (n >= ANON_PER_ADDRESS) return drop(Response.json({ error: 'too many requests', code: 'rate' }, { status: 429, headers: { 'Retry-After': '5' } }));
      this.anonReads.set(addr, n + 1);
    }
    let body;
    try { body = await readBody(request, cap, this.buffered, anonymous ? ANON_DEADLINE_MS : 0, anonymous ? this.anonPool : null); }
    finally {
      if (anonymous) {
        const n = (this.anonReads.get(addr) || 1) - 1;
        if (n > 0) this.anonReads.set(addr, n); else this.anonReads.delete(addr);
      }
    }
    if (!body) return Response.json({ error: 'body too large' }, { status: 413 });
    if (body === 'late') return Response.json({ error: 'request body took too long' }, { status: 408 });
    if (body === 'busy') return Response.json({ error: 'the server is busy — try again in a moment', code: 'busy' }, { status: 503, headers: { 'Retry-After': '2' } });
    let res;
    try { res = await runNodeHandler(this.api.handle, request, body, ip); }
    finally {
      this.buffered.used -= body.byteLength;
      if (anonymous) this.anonPool.used -= body.byteLength;
    }
    await this.arm();
    return res;
  }

  async alarm() {
    await this.boot;
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    const due = sql.exec('SELECT k, user_id, device_id, lang FROM rest_timers WHERE due <= ?', now).toArray();
    for (const t of due) sql.exec('DELETE FROM rest_timers WHERE k = ?', t.k);
    const sends = due.map(t => this.api.fireRestTimer(t.user_id, t.device_id || undefined, t.lang || undefined));
    if (this.api.hasPushSubscribers()) sends.push(this.api.reminderTick());
    await Promise.allSettled(sends);
    await this.arm();
  }

  // Backups (cloudflare/backup.js), called over RPC by the Worker: the daily cron and the
  // token-protected /__ops routes. Each snapshot is taken with no await in between.
  async scheduledBackup() {
    await this.boot;
    const result = await backup.scheduled(this.env.BACKUPS, backup.snapshot(this.fs));
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS media_mirror_gone (key TEXT PRIMARY KEY, since INTEGER NOT NULL)');
    const gone = {
      get: key => sql.exec('SELECT since FROM media_mirror_gone WHERE key = ?', key).toArray()[0]?.since,
      set: (key, t) => sql.exec('INSERT OR REPLACE INTO media_mirror_gone (key, since) VALUES (?, ?)', key, t),
      delete: key => sql.exec('DELETE FROM media_mirror_gone WHERE key = ?', key),
      keys: () => sql.exec('SELECT key FROM media_mirror_gone').toArray().map(r => r.key)
    };
    result.media = await backup.mirrorMedia(this.env.BACKUPS, this.fs, UPLOADS, gone);
    console.log('backup', JSON.stringify(result));
    return result;
  }

  async manualBackup() {
    await this.boot;
    const snap = backup.snapshot(this.fs);
    return backup.put(this.env.BACKUPS, backup.stampKey('manual', snap), snap);
  }

  async listBackups() {
    const out = [];
    let cursor;
    do {
      const page = await this.env.BACKUPS.list({ cursor, include: ['customMetadata'] });
      out.push(...page.objects.map(o => ({ key: o.key, bytes: o.size, uploaded: o.uploaded, ...o.customMetadata })));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return out;
  }

  // Replaces all API data with the backup at `key`. The current data is saved under
  // pre-restore/ first. Everyone is signed out once (backup.bumpSessions), so a session that was
  // revoked after the backup was taken cannot come back with it.
  async restoreBackup(key) {
    await this.boot;
    // Requests wait until the restore is done, so nothing written after the pre-restore
    // snapshot can be lost by the swap.
    return this.ctx.blockConcurrencyWhile(() => this.restoreLocked(key));
  }

  async restoreLocked(key) {
    const obj = await this.env.BACKUPS.get(key);
    if (!obj) throw new Error(`no backup at ${key}`);
    const snap = await backup.decode(new Uint8Array(await obj.arrayBuffer()));
    const before = backup.snapshot(this.fs);
    const saved = await backup.put(this.env.BACKUPS, backup.stampKey('pre-restore', before), before);
    const dbName = `${DATA_DIR}/db.json`;
    const currentDb = before.files.find(f => f.name === dbName)?.text;
    const files = snap.files.map(f => (f.name === dbName ? { ...f, text: backup.bumpSessions(f.text, currentDb) } : f));
    // Uploaded media are not in JSON backups (they are mirrored to R2 separately), so the ones
    // stored now stay; media.js forgets nothing, and a file no state references is swept later.
    this.fs.replaceAll(files, [`${DATA_DIR}/secret`], [UPLOADS]);
    this.api.reloadData();
    this.ctx.storage.sql.exec('DELETE FROM rest_timers');
    console.log('restored', key, 'previous data saved at', saved.key);
    return { restored: key, files: snap.files.length, createdAt: snap.createdAt, previous: saved.key };
  }

  // The alarm is set to whichever comes first: the next due rest timer, or the next reminder
  // tick while anyone is subscribed to pushes. Nobody subscribed and nothing pending: no alarm.
  async arm() {
    const next = this.ctx.storage.sql.exec('SELECT MIN(due) AS due FROM rest_timers').one().due;
    const tick = this.api.hasPushSubscribers() ? Date.now() + TICK_MS : null;
    const want = [next, tick].filter(v => v != null).reduce((a, b) => Math.min(a, b), Infinity);
    if (want === Infinity) return;
    const current = await this.ctx.storage.getAlarm();
    if (current == null || current > want) await this.ctx.storage.setAlarm(want);
  }
}
