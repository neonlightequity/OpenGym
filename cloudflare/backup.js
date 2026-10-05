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

// Reads every stored file. Synchronous: call it with no await in between.
export function snapshot(fs) {
  const files = fs.listFiles().map(f => ({ name: f.name, mtime: f.mtime, text: fs.readFileSync(f.name, 'utf8') }));
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

export const stampKey = (prefix, snap) => `${prefix}/${snap.createdAt.replace(/[:.]/g, '-')}.json.gz`;
