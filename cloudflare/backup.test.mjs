// Backup format and retention, against an in-memory stand-in for an R2 bucket.
//   node --test cloudflare/backup.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as backup from './backup.js';

function memoryBucket() {
  const m = new Map();
  return {
    m,
    async put(key, body, opts) { m.set(key, { body, opts }); },
    async head(key) { return m.has(key) ? { key } : null; },
    async delete(keys) { for (const k of [].concat(keys)) m.delete(k); },
    async list({ prefix = '', cursor } = {}) {
      const all = [...m.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = cursor ? +cursor : 0;
      const page = all.slice(start, start + 2);   // tiny pages, so pagination is exercised
      return { objects: page.map(key => ({ key })), truncated: start + 2 < all.length, cursor: String(start + 2) };
    }
  };
}
const fakeFs = files => ({
  listFiles: () => Object.keys(files).sort().map(name => ({ name, size: files[name].length, mtime: 1 })),
  readFileSync: name => files[name]
});
const files = { '/data/db.json': JSON.stringify({ users: [{ id: 'u1' }, { id: 'u2' }] }), '/data/state-u1.json': '{"workouts":[]}', '/data/secret': 'abc' };

test('a snapshot round-trips through gzip with every file intact', async () => {
  const snap = backup.snapshot(fakeFs(files));
  const back = await backup.decode(await backup.encode(snap));
  assert.deepEqual(back.files.map(f => [f.name, f.text]), Object.entries(files).sort());
});

test('decode refuses what is not a well-formed openGym backup', async () => {
  const enc = obj => backup.encode(obj);
  await assert.rejects(backup.decode(await enc({ hello: 1 })), /not an openGym backup/);
  await assert.rejects(backup.decode(await enc({ format: backup.FORMAT, version: 1, files: [{ name: '/etc/x', text: '' }, { name: '/data/db.json', text: '{}' }] })), /malformed/);
  await assert.rejects(backup.decode(await enc({ format: backup.FORMAT, version: 1, files: [{ name: '/data/state-a.json', text: '{}' }] })), /no db.json/);
  await assert.rejects(backup.decode(new Uint8Array([1, 2, 3])));
});

test('scheduled runs keep the newest 30 daily and one object per month for 12 months', async () => {
  const bucket = memoryBucket();
  const day = new Date('2025-01-01T03:17:00Z');
  for (let i = 0; i < 500; i++) {
    const snap = { ...backup.snapshot(fakeFs(files)), createdAt: new Date(day.getTime() + i * 86400000).toISOString() };
    await backup.scheduled(bucket, snap);
  }
  const keys = [...bucket.m.keys()];
  const daily = keys.filter(k => k.startsWith('daily/')).sort();
  const monthly = keys.filter(k => k.startsWith('monthly/')).sort();
  assert.equal(daily.length, backup.DAILY_KEEP);
  assert.equal(daily.at(-1), 'daily/2026-05-15T03-17-00-000Z.json.gz');   // day 499
  assert.equal(monthly.length, backup.MONTHLY_KEEP);
  assert.equal(monthly.at(-1), 'monthly/2026-05.json.gz');
  assert.equal(bucket.m.get(daily.at(-1)).opts.customMetadata.users, '2');
});

test('a restore signs everyone out: sv moves past both the backed-up and the current value', () => {
  const restored = JSON.stringify({ users: [{ id: 'a', sv: 2 }, { id: 'b' }, { id: 'gone-now' , sv: 5 }] });
  const current = JSON.stringify({ users: [{ id: 'a', sv: 7 }, { id: 'b', sv: 0 }, { id: 'new-since' }] });
  const out = JSON.parse(backup.bumpSessions(restored, current));
  assert.deepEqual(out.users.map(u => [u.id, u.sv]), [['a', 8], ['b', 1], ['gone-now', 6]]);
  assert.deepEqual(JSON.parse(backup.bumpSessions(restored, 'not json')).users.map(u => u.sv), [3, 1, 6]);
});

test('mirrored media: copied once, and deleted 30 days after the upload is gone', async () => {
  const bucket = memoryBucket();
  const marks = new Map();
  const gone = { get: k => marks.get(k), set: (k, t) => marks.set(k, t), delete: k => marks.delete(k), keys: () => [...marks.keys()] };
  const h1 = 'a'.repeat(64), h2 = 'b'.repeat(64);
  const files = { [`/data/uploads/u1/${h1}.jpg`]: Buffer.from('one'), [`/data/uploads/u1/${h2}.mp4`]: Buffer.from('two'), '/data/uploads/u1/.gc.json': '{}' };
  const mfs = {
    listFiles: () => Object.keys(files).map(name => ({ name, mtime: 1, bin: typeof files[name] !== 'string' ? 1 : 0 })),
    readBytes: name => files[name] ?? null
  };
  const day = 86400000, t0 = Date.UTC(2026, 0, 1);
  let r = await backup.mirrorMedia(bucket, mfs, '/data/uploads', gone, t0);
  assert.equal(r.copied, 2);
  r = await backup.mirrorMedia(bucket, mfs, '/data/uploads', gone, t0 + day);
  assert.deepEqual([r.copied, r.present], [0, 2]);

  delete files[`/data/uploads/u1/${h2}.mp4`];                       // the owner deletes the video
  r = await backup.mirrorMedia(bucket, mfs, '/data/uploads', gone, t0 + 2 * day);
  assert.deepEqual([r.expiring, r.deleted], [1, 0]);
  r = await backup.mirrorMedia(bucket, mfs, '/data/uploads', gone, t0 + 31 * day);
  assert.deepEqual([r.expiring, r.deleted], [1, 0]);                // 29 days since it went
  r = await backup.mirrorMedia(bucket, mfs, '/data/uploads', gone, t0 + 32 * day);
  assert.equal(r.deleted, 1);
  assert.deepEqual([...bucket.m.keys()], [`media/u1/${h1}.jpg`]);
  assert.equal(marks.size, 0);

  // A file that comes back within the window (uploaded again) is kept, and its mark cleared.
  files[`/data/uploads/u1/${h2}.mp4`] = Buffer.from('two');
  await backup.mirrorMedia(bucket, mfs, '/data/uploads', gone, t0 + 33 * day);
  delete files[`/data/uploads/u1/${h2}.mp4`];
  await backup.mirrorMedia(bucket, mfs, '/data/uploads', gone, t0 + 34 * day);
  files[`/data/uploads/u1/${h2}.mp4`] = Buffer.from('two');
  r = await backup.mirrorMedia(bucket, mfs, '/data/uploads', gone, t0 + 70 * day);
  assert.equal(r.deleted, 0);
  assert.equal(marks.size, 0);
});
