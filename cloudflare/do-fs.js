// A synchronous stand-in for the handful of node:fs calls api/server.js makes, kept in the
// Durable Object's SQLite storage. sql.exec() is synchronous, so server.js keeps its upstream
// shape: writes land before the next line runs, and the output gate holds the response until
// they are durable. Only text files exist here; directories are implied by names.
//
// A row is capped at 2 MB, and a profile's state may be 5 MB, so each file is split into
// chunks. CHUNK is in UTF-16 code units, and a code unit is at most 3 bytes of UTF-8.
const CHUNK = 600 * 1024;

const enoent = (op, file) => Object.assign(new Error(`ENOENT: no such file or directory, ${op} '${file}'`), { code: 'ENOENT', errno: -2, syscall: op, path: file });
const asText = data => (typeof data === 'string' ? data : new TextDecoder().decode(data));

export function createDoFs(storage) {
  const sql = storage.sql;
  sql.exec(`CREATE TABLE IF NOT EXISTS fs_meta (name TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime INTEGER NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS fs_chunks (name TEXT NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (name, idx))`);

  const meta = name => sql.exec('SELECT size, mtime FROM fs_meta WHERE name = ?', name).toArray()[0] || null;
  const read = name => {
    if (!meta(name)) return null;
    return sql.exec('SELECT data FROM fs_chunks WHERE name = ? ORDER BY idx', name).toArray().map(r => r.data).join('');
  };
  // Within one transaction, so a reader never sees half a file.
  const write = (name, text) => storage.transactionSync(() => {
    sql.exec('DELETE FROM fs_chunks WHERE name = ?', name);
    for (let i = 0, idx = 0; i < text.length || idx === 0; i += CHUNK, idx++) {
      sql.exec('INSERT INTO fs_chunks (name, idx, data) VALUES (?, ?, ?)', name, idx, text.slice(i, i + CHUNK));
    }
    // mtime must move on every write: readStateCached compares it (with size) to skip re-parsing.
    const prev = meta(name);
    const mtime = Math.max(Date.now(), prev ? prev.mtime + 1 : 0);
    sql.exec('INSERT OR REPLACE INTO fs_meta (name, size, mtime) VALUES (?, ?, ?)', name, new TextEncoder().encode(text).length, mtime);
  });
  const remove = name => storage.transactionSync(() => {
    sql.exec('DELETE FROM fs_chunks WHERE name = ?', name);
    sql.exec('DELETE FROM fs_meta WHERE name = ?', name);
  });

  return {
    mkdirSync() {},
    chmodSync(file) { if (!meta(file)) throw enoent('chmod', file); },
    existsSync: file => !!meta(file),
    readFileSync(file, enc) {
      const text = read(file);
      if (text == null) throw enoent('open', file);
      return enc ? text : new TextEncoder().encode(text);
    },
    writeFileSync(file, data) { write(file, asText(data)); },
    appendFileSync(file, data) { write(file, (read(file) || '') + asText(data)); },
    renameSync(from, to) {
      const text = read(from);
      if (text == null) throw enoent('rename', from);
      storage.transactionSync(() => { write(to, text); remove(from); });
    },
    unlinkSync(file) {
      if (!meta(file)) throw enoent('unlink', file);
      remove(file);
    },
    statSync(file) {
      const m = meta(file);
      if (!m) throw enoent('stat', file);
      return { size: m.size, mtimeMs: m.mtime, isFile: () => true, isDirectory: () => false };
    },
    // Listing for backups/export.
    listFiles: () => sql.exec('SELECT name, size, mtime FROM fs_meta ORDER BY name').toArray()
  };
}
