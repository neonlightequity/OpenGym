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
