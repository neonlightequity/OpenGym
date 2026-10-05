// The filesystem server.js persists through. On Node (Docker, tests) it is node:fs itself; the
// Cloudflare build sets globalThis.__opengymFs to a synchronous store with the same calls before
// server.js is imported (cloudflare/do-fs.js). Nothing else differs between the two.
import nodeFs from 'node:fs';

export default globalThis.__opengymFs || nodeFs;
