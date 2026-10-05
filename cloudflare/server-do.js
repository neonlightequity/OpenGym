// The openGym API as one Durable Object. api/server.js runs inside it unchanged in shape: one
// instance, its in-memory db, synchronous writes — here into the object's SQLite storage
// (do-fs.js) instead of ./data. Timers that must survive the object being evicted (rest-timer
// pushes, the daily reminder tick) are kept as rows and driven by the object's alarm.
import { DurableObject } from 'cloudflare:workers';
import { createDoFs } from './do-fs.js';
import { generateVAPIDKeysAsync } from './web-push.js';
import { runNodeHandler } from './node-http.js';
import * as backup from './backup.js';

const DATA_DIR = '/data';
const MAX_BODY = 5 * 1024 * 1024;   // api/server.js MAX_BODY
const TICK_MS = 60000;              // reminders are owed for 15 minutes after their time

// The request body, or null once it passes `cap` — read as a stream so a body sent without a
// Content-Length is cut off at the cap instead of being buffered whole first.
async function readBody(request, cap) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) { reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(size); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

export class OpenGymServer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.boot = ctx.blockConcurrencyWhile(() => this.start(env));
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

    this.api = await import('../api/server.js');
  }

  async fetch(request) {
    await this.boot;
    const declared = +(request.headers.get('content-length') || 0);
    if (declared > 2 * MAX_BODY) return Response.json({ error: 'body too large' }, { status: 413 });
    const body = await readBody(request, 2 * MAX_BODY);
    if (!body) return Response.json({ error: 'body too large' }, { status: 413 });
    const ip = request.headers.get('cf-connecting-ip') || '';
    const res = await runNodeHandler(this.api.handle, request, body, ip);
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
    this.fs.replaceAll(files, [`${DATA_DIR}/secret`]);
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
