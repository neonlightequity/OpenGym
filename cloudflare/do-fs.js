// A synchronous stand-in for the node:fs calls api/server.js and api/media.js make, kept in
// the Durable Object's SQLite storage. sql.exec() is synchronous, so upstream code keeps its
// shape: writes land before the next line runs, and the output gate holds the response until
// they are durable.
//
// Files are rows in fs_meta (name, size, mtime, bin) plus their content in fs_chunks, split
// because a row holds at most 2 MB. Text files (db.json, state, audit log, .gc.json) are TEXT
// chunks of TEXT_CHUNK UTF-16 code units (at most 3 bytes of UTF-8 each). Binary files
// (uploaded photos and videos) are BLOB chunks of exactly BIN_CHUNK bytes except the last, so a
// byte offset maps straight to a chunk. Directories are implied by names: "/a/b" exists as a
// directory when some file's name starts with "/a/b/".
import { Buffer } from 'node:buffer';
import { Readable, Writable } from 'node:stream';

const TEXT_CHUNK = 600 * 1024;
const BIN_CHUNK = 1024 * 1024;

const fsError = (code, op, file) => Object.assign(new Error(`${code}: ${op} '${file}'`), { code, syscall: op, path: file });
const enoent = (op, file) => fsError('ENOENT', op, file);
const asText = data => (typeof data === 'string' ? data : new TextDecoder().decode(data));
const trimSlash = p => String(p).replace(/\/+$/, '');

export function createDoFs(storage) {
  const sql = storage.sql;
  sql.exec(`CREATE TABLE IF NOT EXISTS fs_meta (name TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime INTEGER NOT NULL, bin INTEGER NOT NULL DEFAULT 0)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS fs_chunks (name TEXT NOT NULL, idx INTEGER NOT NULL, data NOT NULL, PRIMARY KEY (name, idx))`);
  // Tables made before binary files existed have no `bin` column.
  if (!sql.exec('PRAGMA table_info(fs_meta)').toArray().some(c => c.name === 'bin')) {
    sql.exec('ALTER TABLE fs_meta ADD COLUMN bin INTEGER NOT NULL DEFAULT 0');
  }
  // Chunks of an upload the object was evicted in the middle of: no file ever owned them.
  sql.exec('DELETE FROM fs_chunks WHERE name NOT IN (SELECT name FROM fs_meta)');

  const meta = name => sql.exec('SELECT size, mtime, bin FROM fs_meta WHERE name = ?', name).toArray()[0] || null;
  // Is `dir` a directory: does any file live under it? substr, not LIKE: `_` is a LIKE wildcard
  // and profile ids may contain it.
  const isDir = dir => {
    const p = trimSlash(dir) + '/';
    return sql.exec('SELECT 1 FROM fs_meta WHERE substr(name, 1, ?) = ? LIMIT 1', p.length, p).toArray().length > 0;
  };
  const nextMtime = name => { const prev = meta(name); return Math.max(Date.now(), prev ? prev.mtime + 1 : 0); };

  const readText = name => sql.exec('SELECT data FROM fs_chunks WHERE name = ? ORDER BY idx', name).toArray().map(r => r.data).join('');
  const readBytes = name => Buffer.concat(sql.exec('SELECT data FROM fs_chunks WHERE name = ? ORDER BY idx', name).toArray().map(r => Buffer.from(r.data)));
  const read = name => { const m = meta(name); return m == null ? null : m.bin ? readBytes(name) : readText(name); };

  // Within one transaction, so a reader never sees half a file.
  const writeText = (name, text) => storage.transactionSync(() => {
    const mtime = nextMtime(name);   // must move on every write: readStateCached compares it
    sql.exec('DELETE FROM fs_chunks WHERE name = ?', name);
    for (let i = 0, idx = 0; i < text.length || idx === 0; i += TEXT_CHUNK, idx++) {
      sql.exec('INSERT INTO fs_chunks (name, idx, data) VALUES (?, ?, ?)', name, idx, text.slice(i, i + TEXT_CHUNK));
    }
    sql.exec('INSERT OR REPLACE INTO fs_meta (name, size, mtime, bin) VALUES (?, ?, ?, 0)', name, new TextEncoder().encode(text).length, mtime);
  });
  const writeBytes = (name, bytes) => storage.transactionSync(() => {
    const mtime = nextMtime(name);
    sql.exec('DELETE FROM fs_chunks WHERE name = ?', name);
    for (let off = 0, idx = 0; off < bytes.length; off += BIN_CHUNK, idx++) {
      sql.exec('INSERT INTO fs_chunks (name, idx, data) VALUES (?, ?, ?)', name, idx, bytes.subarray(off, off + BIN_CHUNK));
    }
    sql.exec('INSERT OR REPLACE INTO fs_meta (name, size, mtime, bin) VALUES (?, ?, ?, 1)', name, bytes.length, mtime);
  });
  const write = (name, data) => (typeof data === 'string' ? writeText(name, data) : writeBytes(name, Buffer.from(data)));
  const remove = name => storage.transactionSync(() => {
    sql.exec('DELETE FROM fs_chunks WHERE name = ?', name);
    sql.exec('DELETE FROM fs_meta WHERE name = ?', name);
  });
  const removeUnder = dir => {
    const p = trimSlash(dir) + '/';
    storage.transactionSync(() => {
      sql.exec('DELETE FROM fs_chunks WHERE substr(name, 1, ?) = ?', p.length, p);
      sql.exec('DELETE FROM fs_meta WHERE substr(name, 1, ?) = ?', p.length, p);
    });
  };

  // Bytes [pos, pos+len) of a binary file, or of a text file's UTF-8.
  function readRange(name, m, pos, len) {
    if (!m.bin) return Buffer.from(readText(name)).subarray(pos, pos + len);
    const first = Math.floor(pos / BIN_CHUNK), last = Math.floor((pos + Math.max(len, 1) - 1) / BIN_CHUNK);
    const rows = sql.exec('SELECT idx, data FROM fs_chunks WHERE name = ? AND idx BETWEEN ? AND ? ORDER BY idx', name, first, last).toArray();
    const joined = Buffer.concat(rows.map(r => Buffer.from(r.data)));
    const start = pos - first * BIN_CHUNK;
    return joined.subarray(start, start + len);
  }

  const fds = new Map();
  let nextFd = 100;
  const fdName = fd => { const f = fds.get(fd); if (!f) throw fsError('EBADF', 'read', String(fd)); return f.name; };

  const dirent = (name, dir) => ({ name, isFile: () => !dir, isDirectory: () => dir, isSymbolicLink: () => false });
  const statOf = m => ({ size: m.size, mtimeMs: m.mtime, mtime: new Date(m.mtime), isFile: () => true, isDirectory: () => false });

  const fs = {
    mkdirSync() {},
    chmodSync(p) { if (!meta(p) && !isDir(p)) throw enoent('chmod', p); },
    existsSync: p => !!meta(p) || isDir(p),
    readFileSync(file, opts) {
      const enc = typeof opts === 'string' ? opts : opts?.encoding;
      const m = meta(file);
      if (!m) throw enoent('open', file);
      const data = read(file);
      if (enc) return typeof data === 'string' ? data : data.toString(enc);
      return typeof data === 'string' ? Buffer.from(data) : data;
    },
    writeFileSync(file, data) { write(file, data); },
    appendFileSync(file, data) {
      const m = meta(file);
      if (m?.bin) writeBytes(file, Buffer.concat([readBytes(file), Buffer.from(data)]));
      else writeText(file, (m ? readText(file) : '') + asText(data));
    },
    renameSync(from, to) {
      if (!meta(from)) throw enoent('rename', from);
      storage.transactionSync(() => {
        if (from === to) return;
        sql.exec('DELETE FROM fs_chunks WHERE name = ?', to);
        sql.exec('DELETE FROM fs_meta WHERE name = ?', to);
        sql.exec('UPDATE fs_chunks SET name = ? WHERE name = ?', to, from);
        sql.exec('UPDATE fs_meta SET name = ?, mtime = ? WHERE name = ?', to, Date.now(), from);
      });
    },
    unlinkSync(file) {
      if (!meta(file)) throw enoent('unlink', file);
      remove(file);
    },
    rmSync(p, { recursive = false, force = false } = {}) {
      if (meta(p)) return remove(p);
      if (isDir(p)) {
        if (!recursive) throw fsError('ERR_FS_EISDIR', 'rm', p);
        return removeUnder(p);
      }
      if (!force) throw enoent('rm', p);
    },
    statSync(p) {
      const m = meta(p);
      if (m) return statOf(m);
      if (isDir(p)) return { size: 0, mtimeMs: Date.now(), mtime: new Date(), isFile: () => false, isDirectory: () => true };
      throw enoent('stat', p);
    },
    // There is no disk to measure; media.js then applies no free-space floor.
    statfsSync(p) { throw fsError('ENOSYS', 'statfs', p); },
    readdirSync(dir, opts = {}) {
      const p = trimSlash(dir) + '/';
      const names = sql.exec('SELECT name FROM fs_meta WHERE substr(name, 1, ?) = ?', p.length, p).toArray().map(r => r.name.slice(p.length));
      if (!names.length && !meta(trimSlash(dir))) throw enoent('scandir', dir);
      const seen = new Map();
      for (const rest of names) {
        const i = rest.indexOf('/');
        const name = i < 0 ? rest : rest.slice(0, i);
        if (!seen.has(name) || i >= 0) seen.set(name, i >= 0);
      }
      const list = [...seen].sort(([a], [b]) => (a < b ? -1 : 1));
      return opts.withFileTypes ? list.map(([name, d]) => dirent(name, d)) : list.map(([name]) => name);
    },
    openSync(file) {
      if (!meta(file)) throw enoent('open', file);
      const fd = nextFd++;
      fds.set(fd, { name: file });
      return fd;
    },
    closeSync(fd) { fds.delete(fd); },
    fstatSync(fd) {
      const m = meta(fdName(fd));
      if (!m) throw enoent('fstat', String(fd));
      return statOf(m);
    },
    readSync(fd, buf, off, len, pos) {
      const name = fdName(fd);
      const m = meta(name);
      if (!m) throw enoent('read', name);
      const got = readRange(name, m, pos ?? 0, len);
      got.copy(buf, off);
      return got.length;
    },
    // Writes each full BIN_CHUNK as a row as soon as it is complete, so an upload is never held
    // whole a second time. The file only exists (has a meta row) once the stream finishes;
    // a stream destroyed before that leaves no rows behind.
    createWriteStream(file, opts = {}) {
      let pending = Buffer.alloc(0), idx = 0, size = 0, done = false;
      const flush = all => {
        while (pending.length >= BIN_CHUNK || (all && pending.length)) {
          sql.exec('INSERT OR REPLACE INTO fs_chunks (name, idx, data) VALUES (?, ?, ?)', file, idx++, pending.subarray(0, BIN_CHUNK));
          pending = pending.subarray(BIN_CHUNK);
        }
      };
      return new Writable({
        highWaterMark: opts.highWaterMark,
        construct(cb) {
          if (String(opts.flags || 'w').includes('x') && meta(file)) return cb(fsError('EEXIST', 'open', file));
          sql.exec('DELETE FROM fs_chunks WHERE name = ?', file);
          cb();
        },
        write(chunk, enc, cb) {
          try {
            const b = Buffer.from(chunk, enc);
            size += b.length;
            pending = pending.length ? Buffer.concat([pending, b]) : b;
            flush(false);
            cb();
          } catch (e) { cb(e); }
        },
        final(cb) {
          try {
            storage.transactionSync(() => {
              flush(true);
              sql.exec('INSERT OR REPLACE INTO fs_meta (name, size, mtime, bin) VALUES (?, ?, ?, 1)', file, size, nextMtime(file));
            });
            done = true;
            cb();
          } catch (e) { cb(e); }
        },
        destroy(err, cb) {
          if (!done) { try { sql.exec('DELETE FROM fs_chunks WHERE name = ?', file); } catch { /* storage gone */ } }
          cb(err);
        }
      });
    },
    // Streams a file a chunk at a time: createReadStream(path) or createReadStream(null, { fd }).
    createReadStream(file, opts = {}) {
      const name = file ?? fdName(opts.fd);
      let idx = 0, fd = file == null ? opts.fd : null;
      return new Readable({
        read() {
          try {
            const m = meta(name);
            if (!m) return this.destroy(enoent('read', name));
            if (!m.bin) { this.push(idx++ === 0 ? Buffer.from(readText(name)) : null); return; }
            const row = sql.exec('SELECT data FROM fs_chunks WHERE name = ? AND idx = ?', name, idx++).toArray()[0];
            this.push(row ? Buffer.from(row.data) : null);
          } catch (e) { this.destroy(e); }
        },
        destroy(err, cb) { if (fd != null) fds.delete(fd); cb(err); }
      });
    },

    // Not node:fs — for backups.
    listFiles: () => sql.exec('SELECT name, size, mtime, bin FROM fs_meta ORDER BY name').toArray(),
    readBytes: name => (meta(name) ? readBytes(name) : null),
    // Restoring a backup: every file replaced by `files` ({name, text}), except the names in
    // `keep` and everything under the prefixes in `keepUnder` (uploaded media, which JSON
    // backups do not carry). One transaction: on any error nothing changes.
    replaceAll(files, keep = [], keepUnder = []) {
      const prefixes = keepUnder.map(p => trimSlash(p) + '/');
      const kept = name => keep.includes(name) || prefixes.some(p => name.startsWith(p));
      storage.transactionSync(() => {
        const held = keep.map(name => [name, read(name)]).filter(([, data]) => data != null);
        for (const { name } of sql.exec('SELECT name FROM fs_meta').toArray()) {
          if (!prefixes.some(p => name.startsWith(p))) remove(name);
        }
        for (const f of files) if (!kept(f.name)) writeText(f.name, f.text);
        for (const [name, data] of held) write(name, data);
      });
    }
  };
  return fs;
}
