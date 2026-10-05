// Backups of the API's data (everything in the Durable Object's fs tables: db.json, every
// state-<uid>.json, vapid.json, audit.log, secret) to the private R2 bucket BACKUPS.
//
// A snapshot is taken synchronously inside the Durable Object, so no request can land halfway
// through it, then gzipped and written as one object:
//   daily/<ISO time>.json.gz       one per scheduled run, the newest DAILY_KEEP kept
//   monthly/<YYYY-MM>.json.gz      the first run of each month, the newest MONTHLY_KEEP kept
//   manual/<ISO time>.json.gz      on demand (POST /__ops/backup), kept until deleted by hand
//   pre-restore/<ISO time>.json.gz the data a restore replaced, kept until deleted by hand
export const FORMAT = 'opengym-backup';
export const VERSION = 1;
export const DAILY_KEEP = 30;
export const MONTHLY_KEEP = 12;

// Reads every stored text file. Synchronous: call it with no await in between. Uploaded media
// (binary, under /data/uploads/) are not included: they are mirrored to R2 by mirrorMedia().
export function snapshot(fs) {
  const files = fs.listFiles().filter(f => !f.bin && !f.name.startsWith('/data/uploads/')).map(f => ({ name: f.name, mtime: f.mtime, text: fs.readFileSync(f.name, 'utf8') }));
  return { format: FORMAT, version: VERSION, createdAt: new Date().toISOString(), files };
}

export async function encode(snap) {
  const gz = new Blob([JSON.stringify(snap)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(gz).arrayBuffer());
}

export async function decode(bytes) {
  const plain = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const snap = JSON.parse(await new Response(plain).text());
  if (snap?.format !== FORMAT || snap.version !== VERSION || !Array.isArray(snap.files)) throw new Error('not an openGym backup');
  for (const f of snap.files) {
    if (typeof f?.name !== 'string' || !f.name.startsWith('/data/') || typeof f.text !== 'string') throw new Error('malformed file entry in backup');
  }
  if (!snap.files.some(f => f.name === '/data/db.json')) throw new Error('backup has no db.json');
  return snap;
}

export async function put(bucket, key, snap) {
  const body = await encode(snap);
  const users = (() => { try { return JSON.parse(snap.files.find(f => f.name === '/data/db.json')?.text || '{}').users?.length || 0; } catch { return 0; } })();
  await bucket.put(key, body, {
    httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' },
    customMetadata: { files: String(snap.files.length), users: String(users), createdAt: snap.createdAt }
  });
  return { key, bytes: body.byteLength, files: snap.files.length, users };
}

async function listAll(bucket, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix, cursor });
    out.push(...page.objects.map(o => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out.sort();   // ISO keys sort by time
}

// Keeps the newest `keep` objects under `prefix`; returns the keys it deleted.
export async function prune(bucket, prefix, keep) {
  const keys = await listAll(bucket, prefix);
  const old = keys.slice(0, Math.max(0, keys.length - keep));
  if (old.length) await bucket.delete(old);
  return old;
}

// The scheduled run: a daily object, the month's object if this is its first run, then
// retention. Returns what it wrote, for the log.
export async function scheduled(bucket, snap) {
  const stamp = snap.createdAt.replace(/[:.]/g, '-');
  const wrote = [await put(bucket, `daily/${stamp}.json.gz`, snap)];
  const month = snap.createdAt.slice(0, 7);
  if (!(await bucket.head(`monthly/${month}.json.gz`))) wrote.push(await put(bucket, `monthly/${month}.json.gz`, snap));
  const pruned = [...await prune(bucket, 'daily/', DAILY_KEEP), ...await prune(bucket, 'monthly/', MONTHLY_KEEP)];
  return { wrote, pruned };
}

// The restored db.json with every profile's session version (`sv`) moved past both its backed-up
// and its current value. server.js accepts a session only at exactly the current `sv`, so this
// signs everyone out once: no session issued before the backup and none revoked since (sign out
// everywhere, a disabled profile) can come back with the restored records.
export function bumpSessions(restoredDbText, currentDbText) {
  const restored = JSON.parse(restoredDbText);
  let current = {};
  try { current = JSON.parse(currentDbText || '{}'); } catch { /* no usable current db */ }
  const was = new Map((current.users || []).map(u => [u.id, u.sv || 0]));
  for (const u of restored.users || []) u.sv = Math.max(u.sv || 0, was.get(u.id) || 0) + 1;
  return JSON.stringify(restored, null, 2);
}

// Copies every stored upload to media/<uid>/<hash>.<ext> in the bucket, unless it is already
// there. Uploads are named by their SHA-256, so an object under a name never changes, and one
// already present needs no second copy. Mirrored objects are kept when the upload is deleted.
const MEDIA_FILE = /^([A-Za-z0-9_-]+)\/([0-9a-f]{64}\.(?:jpg|png|webp|gif|mp4|mov|webm))$/;
export async function mirrorMedia(bucket, fs, uploadsDir) {
  const out = { copied: 0, present: 0, bytes: 0 };
  const prefix = uploadsDir.replace(/\/+$/, '') + '/';
  for (const f of fs.listFiles()) {
    if (!f.bin || !f.name.startsWith(prefix)) continue;
    const m = MEDIA_FILE.exec(f.name.slice(prefix.length));
    if (!m) continue;   // .tmp/ and anything that is not a finished upload
    const key = `media/${m[1]}/${m[2]}`;
    if (await bucket.head(key)) { out.present++; continue; }
    const bytes = fs.readBytes(f.name);
    if (!bytes) continue;   // deleted since the listing
    await bucket.put(key, bytes, { customMetadata: { uid: m[1], mtime: String(f.mtime) } });
    out.copied++;
    out.bytes += bytes.length;
  }
  return out;
}

export const stampKey = (prefix, snap) => `${prefix}/${snap.createdAt.replace(/[:.]/g, '-')}.json.gz`;
