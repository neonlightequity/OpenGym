#!/usr/bin/env node
// Backup operations against a deployed (or `wrangler dev`) openGym Worker.
//   OPS_TOKEN=… node cloudflare/ops.mjs list                  [--url https://gym.davidovichequity.com]
//   OPS_TOKEN=… node cloudflare/ops.mjs backup                — take a manual backup now
//   OPS_TOKEN=… node cloudflare/ops.mjs restore <key>         — replace ALL data with that backup
// The token is the Worker secret OPS_TOKEN. To copy a backup to this machine:
//   npx wrangler r2 object get opengym-backups/<key> --remote --file <key-basename>
const args = process.argv.slice(2);
const urlIdx = args.indexOf('--url');
const base = (urlIdx >= 0 ? args.splice(urlIdx, 2)[1] : 'https://gym.davidovichequity.com').replace(/\/+$/, '');
const [cmd, key] = args;
const token = process.env.OPS_TOKEN;
if (!token) { console.error('Set OPS_TOKEN to the Worker secret.'); process.exit(2); }

const call = async (method, path) => {
  const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}` } });
  // A Worker without the ops routes answers with the app's index.html, not JSON.
  if (!(res.headers.get('content-type') || '').includes('application/json')) {
    console.error(`${base} did not answer as the ops API (${res.status}); is this version deployed?`); process.exit(1);
  }
  const body = await res.json();
  if (!res.ok) { console.error(res.status, body.error || ''); process.exit(1); }
  return body;
};

if (cmd === 'list') {
  for (const b of await call('GET', '/__ops/backups')) console.log(`${b.key}\t${b.bytes} B\t${b.users ?? '?'} users\t${b.files ?? '?'} files`);
} else if (cmd === 'backup') {
  console.log(await call('POST', '/__ops/backup'));
} else if (cmd === 'restore' && key) {
  console.log(await call('POST', `/__ops/restore?key=${encodeURIComponent(key)}`));
} else {
  console.error('usage: ops.mjs list | backup | restore <key>  [--url <base>]');
  process.exit(2);
}
