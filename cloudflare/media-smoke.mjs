#!/usr/bin/env node
// Custom-exercise media against a running Worker (wrangler dev, PASSWORD_LOGIN=1):
//   node cloudflare/media-smoke.mjs http://localhost:8787
// Uses upstream's synthetic samples (api/test/media-samples.mjs): real magic bytes and a real
// MP4 box tree, random payload.
import { jpeg, png, mp4, sha } from '../api/test/media-samples.mjs';

const base = (process.argv[2] || 'http://localhost:8787').replace(/\/+$/, '');
let failures = 0, cookie = '';
const check = (ok, label, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`); if (!ok) failures++; };

async function call(method, path, body, headers = {}) {
  const isBytes = body instanceof Uint8Array;
  const res = await fetch(base + path, {
    method,
    headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(body && !isBytes ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body == null ? undefined : isBytes ? body : JSON.stringify(body)
  });
  const sid = (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).find(c => /gymsid=./.test(c));
  if (sid) cookie = sid;
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString()); } catch {}
  return { status: res.status, json, buf, headers: res.headers };
}
const put = (bytes, type) => call('PUT', `/api/media/${sha(bytes)}`, bytes, { 'Content-Type': type });

const cfg = await call('GET', '/api/config');
check(cfg.json?.media?.enabled !== false && !!cfg.json?.media, 'config advertises media', JSON.stringify(cfg.json?.media));
const name = `media-${Date.now().toString(36)}`;
const reg = await call('POST', '/api/register/password', { name, password: 'correct horse battery staple 42', code: '' });
check(reg.status === 200, `register "${name}"`, String(reg.status));

const photo = jpeg(50000);
const up = await put(photo, 'image/jpeg');
check(up.status === 201 && up.json?.existed === false, 'PUT a photo → 201', `${up.status} ${up.buf.toString().slice(0, 100)}`);
const again = await put(photo, 'image/jpeg');
check(again.status === 200 && again.json?.existed === true, 'same photo again → existed');
const got = await call('GET', `/api/media/${sha(photo)}`);
check(got.status === 200 && Buffer.compare(got.buf, photo) === 0, 'GET returns the same bytes', `${got.status} ${got.buf.length} B`);
check(got.headers.get('content-type') === 'image/jpeg' && /sandbox/.test(got.headers.get('content-security-policy') || ''), 'served as image/jpeg with a sandbox CSP');

const wrong = png(2000);
const mism = await call('PUT', `/api/media/${sha(photo).replace(/^./, c => (c === 'a' ? 'b' : 'a'))}`, wrong, { 'Content-Type': 'image/png' });
check(mism.status === 400, 'bytes that do not match the hash → 400', String(mism.status));

const video = mp4({ seconds: 20, mdatBytes: 15 * 1024 * 1024 });
const t0 = Date.now();
const vup = await put(video, 'video/mp4');
check(vup.status === 201, `PUT a ${(video.length / 1048576).toFixed(1)} MB video → 201`, `${vup.status} in ${Date.now() - t0} ms ${vup.buf.toString().slice(0, 80)}`);
const vget = await call('GET', `/api/media/${sha(video)}`);
check(vget.status === 200 && Buffer.compare(vget.buf, video) === 0, 'GET returns the whole video intact', `${vget.buf.length} B`);

const big = mp4({ seconds: 20, mdatBytes: 17 * 1024 * 1024 });
const tooBig = await put(big, 'video/mp4');
check(tooBig.status === 413 && tooBig.json?.maxMB === 16, 'a 17 MB video → 413 with maxMB 16', `${tooBig.status} ${tooBig.buf.toString().slice(0, 100)}`);
const bigPhoto = jpeg(3 * 1024 * 1024);
const tooBigPhoto = await put(bigPhoto, 'image/jpeg');
check(tooBigPhoto.status === 413, 'a 3 MB photo → 413', String(tooBigPhoto.status));

const missing = await call('POST', '/api/media/missing', { hashes: [sha(photo), sha(png(10))] });
check(missing.status === 200 && missing.json?.missing?.length === 1 && missing.json.usage?.count === 2, 'missing lists only the unknown hash; usage counts 2', JSON.stringify(missing.json));

// media.js never sweeps a profile whose state it cannot read, so give it one that references
// neither upload.
const st = await call('PUT', '/api/data', { state: { workouts: [{ id: 'w1', d: '2026-10-05' }], routines: [] } });
check(st.status === 200, 'sync a state that references neither upload', String(st.status));
const sweep = await call('POST', '/api/media/sweep', {});
check(sweep.status === 200 && sweep.json?.removed === 2, 'sweep removes uploads no state references', JSON.stringify(sweep.json));
const gone = await call('GET', `/api/media/${sha(photo)}`);
check(gone.status === 404, 'a swept upload is gone', String(gone.status));

const keep = jpeg(30000);
const kup = await put(keep, 'image/jpeg');
console.log(`KEPT_HASH=${sha(keep)} KEPT_COOKIE=${cookie} (${kup.status})`);
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exitCode = failures ? 1 : 0;
