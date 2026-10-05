// The filesystem server.js persists through. On Node (Docker, tests) it is node:fs itself; the
// Cloudflare build sets globalThis.__opengymFs to a synchronous store with the same calls
// (cloudflare/do-fs.js). Resolved on every call, not once at import: a Durable Object can be
// re-created inside an isolate that still holds this module, and must then write to its own
// storage, not to the handle of the instance before it.
import nodeFs from 'node:fs';

export default new Proxy({}, { get: (_, key) => (globalThis.__opengymFs || nodeFs)[key] });
