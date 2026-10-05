#!/usr/bin/env node
// Smoke test for a running openGym API (wrangler dev or production).
//   node cloudflare/smoke.mjs http://localhost:8787            — full: needs PASSWORD_LOGIN=1
//   node cloudflare/smoke.mjs https://gym.davidovichequity.com --public   — read-only checks
// The full run creates a throwaway profile, syncs a ~1.5 MB state and reads it back.
// `--keep NAME` reuses/keeps a fixed profile so a restart can be checked for persistence.
const base = (process.argv[2] || 'http://localhost:8787').replace(/\/+$/, '');
const publicOnly = process.argv.includes('--public');
const keepIdx = process.argv.indexOf('--keep');
const keep = keepIdx > 0 ? process.argv[keepIdx + 1] : null;
let failures = 0, cookie = '';
const check = (ok, label, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`); if (!ok) failures++; };

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { Origin: base, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const set = res.headers.getSetCookie?.() || [];
  const sid = set.map(c => c.split(';')[0]).find(c => /gymsid=./.test(c));
  if (sid) cookie = sid;
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

const cfg = await call('GET', '/api/config');
check(cfg.status === 200 && typeof cfg.json?.allow_guest === 'boolean', 'GET /api/config', cfg.text.slice(0, 120));
const health = await call('GET', '/api/health');
check(health.status === 200 && health.json?.ok === true, 'GET /api/health', health.text);
const pk = await call('GET', '/api/push/public-key');
const raw = pk.json?.key || pk.json?.publicKey;
const bytes = raw ? Buffer.from(raw, 'base64url') : Buffer.alloc(0);
check(pk.status === 200 && bytes.length === 65 && bytes[0] === 4, 'VAPID public key is a 65-byte P-256 point', pk.text.slice(0, 80));
const me0 = await call('GET', '/api/me');
check(me0.status === 401, 'GET /api/me without a session is 401');
const forged = await fetch(base + '/api/logout', { method: 'POST', headers: { Origin: 'https://evil.example' } });
check(forged.status === 403, 'cross-origin POST is refused', String(forged.status));

if (!publicOnly) {
  const name = keep || `smoke-${Date.now().toString(36)}`;
  const password = 'correct horse battery staple 42';
  let reg = await call('POST', '/api/register/password', { name, password, code: '' });
  if (keep && reg.status === 409) reg = await call('POST', '/api/login/password', { name, password });
  check(reg.status === 200 && !!cookie, `register/sign in "${name}"`, `${reg.status} ${reg.text.slice(0, 100)}`);
  const me = await call('GET', '/api/me');
  check(me.status === 200 && me.json?.user?.name === name, 'session cookie round-trip on /api/me', me.text.slice(0, 100));

  const before = await call('GET', '/api/data');
  if (keep && before.json?.state?.workouts?.length) {
    check(before.json.state.workouts.length === 3000, 'kept profile still has its 3000 workouts after restart');
  }
  const workouts = Array.from({ length: 3000 }, (_, i) => ({ id: 'w' + i, d: '2026-01-01', note: 'x'.repeat(480) }));
  const state = { workouts, routines: [{ id: 'r1', name: 'Push' }], bw: [] };
  const size = JSON.stringify({ state }).length;
  const put = await call('PUT', '/api/data', { state, baseRev: before.json?.rev ?? before.json?.state?._rev ?? 0 });
  check(put.status === 200, `PUT /api/data (${(size / 1048576).toFixed(2)} MB)`, `${put.status} ${put.text.slice(0, 120)}`);
  const got = await call('GET', '/api/data');
  const back = got.json?.state;
  check(got.status === 200 && back?.workouts?.length === 3000 && back.workouts[2999].note === workouts[2999].note, 'GET /api/data returns the state intact');
  const rev = await call('GET', '/api/data/rev');
  check(rev.status === 200, 'GET /api/data/rev', rev.text.slice(0, 80));
  const big = await call('PUT', '/api/data', { state: { workouts: [{ id: 'a', note: 'y'.repeat(6 * 1048576) }], routines: [] } });
  check(big.status === 413, 'a state over 5 MB is refused with 413', String(big.status));
  if (!keep) {
    const out = await call('POST', '/api/logout');
    check(out.status === 200 || out.status === 204, 'logout', String(out.status));
    cookie = '';
    const after = await call('GET', '/api/me');
    check(after.status === 401, 'signed out after logout');
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exitCode = failures ? 1 : 0;
