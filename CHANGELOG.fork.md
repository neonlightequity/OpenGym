# Fork changelog

Changes specific to the davidovichequity fork and its Cloudflare deployment at
gym.davidovichequity.com. Upstream application changes are in `CHANGELOG.md`.

## [Unreleased]

### Added

- Cloudflare Workers deployment: `wrangler.toml`, `cloudflare/worker.js` serving `frontend/dist`
  as static assets (SPA fallback) with the security headers `web/nginx.conf.template` sets, plus
  HSTS. Exercise media comes from the pinned jsDelivr dataset, as in upstream's mobile build.
- The API runs on Workers: one SQLite-backed Durable Object (`OpenGymServer`) hosts
  `api/server.js`, which persists through a synchronous fs stand-in on Durable Object storage
  (`cloudflare/do-fs.js`). Accounts, passkeys, password sign-in (when enabled), sync, device
  pairing, admin and Web Push work as on Docker. Rest-timer pushes and the daily reminder run
  from the Durable Object alarm. Web Push uses WebCrypto (`cloudflare/web-push.js`, aliased for
  `web-push`). The AI Coach and custom-exercise uploads are off. Runbook: `CLOUDFLARE.md`.
- Small seams in `api/server.js` (fs import via `api/fs.js`, exported `handle`,
  `reminderTick`, `fireRestTimer`, `hasPushSubscribers`, a rest-timer hook). Node/Docker
  behavior is unchanged: `cd api && npm test` fails only the 3 tests that also fail on the
  base commit locally (Node 25).
- `cloudflare/smoke.mjs` (API smoke test) and `cloudflare/web-push.test.mjs` (decrypts with
  `http_ece` and verifies the VAPID JWT).
- Shared Claude/Codex Git synchronization (`GIT_SYNC.md`, `scripts/git-sync.mjs`, hooks),
  `AGENTS.md`, `ToDo.md`, `docs/changelog.md`.

- Backups: a daily cron (03:17 UTC) snapshots all API data into the private R2 bucket
  `opengym-backups` (newest 30 daily and 12 monthly kept). `cloudflare/ops.mjs` lists, takes
  and restores backups through `/__ops/*`, which needs the `OPS_TOKEN` secret. A restore saves
  the replaced data under `pre-restore/` and signs everyone out once, so sessions revoked after
  the backup cannot come back (found by a background security review). Adds a `reloadData()` seam to
  `api/server.js`.

- Custom-exercise photo and video uploads work. Upstream's `media.js` runs unchanged apart from its
  fs import, with bytes stored in Durable Object storage. Videos are capped at 16 MB (upstream:
  40). JSON backups exclude uploads; the nightly run mirrors each one to R2
  (`media/<uid>/<hash>.<ext>`) once, and restores keep stored uploads. The Worker no longer
  overwrites a response's own CSP, so media keep `default-src 'none'; sandbox`.

- Hardening from background security reviews of the media commit: upload bodies are read only
  for a signed-in session (anyone else gets 401 before the body is read), and requests in flight
  share a 48 MB buffer budget (503 past it). Mirrored media are deleted from R2 30 days after
  their upload is gone.

- A request without a session may send at most 64 KB, within 10 s, with at most 8 at a time per
  address, so the shared buffer budget cannot be held without an account (background security
  review of `06d35585`).

- Anonymous bodies together use at most 8 MB of the buffer budget, and the per-address limit
  counts an IPv6 /64 as one address. A sender with many addresses can no longer lock out
  signed-in users (two background security findings on `882f5e7c`).

- Request bodies are read whole in the Worker before they reach the Durable Object, with a
  session check over RPC before an upload body. Flood test: 200 stalled bodies from 200
  addresses all ended at the Worker (408), and registration, sign-out and a 1.5 MB sync
  succeeded meanwhile (further background security findings on `4b14f8cc`).

### Production deployment

- 2026-10-05: version `1f91be76-396c-4d30-b059-3bf8110c5b23` reads bodies in the Worker. Public
  smoke test passed, an anonymous upload is 401, invite-only signup still answers 403, and a
  backup holds 1 user.

- 2026-10-05: version `4b14f8cc-a695-4feb-b202-68f07b62fd4f` reserves the buffer budget for
  signed-in requests. Public smoke test 5/5 (after one transient connect timeout from the
  MacBook), and a backup holds 1 user.

- 2026-10-05: version `882f5e7c-fa76-495d-a2b6-47d84df2ebb3` bounds anonymous bodies. Public
  smoke test passed, an anonymous 100 KB body is 413, and invite-only signup still answers 403.

- 2026-10-05: version `06d35585-ae53-40a0-b81c-90ce386f7a58`: session check before upload
  bodies, a 48 MB buffer budget, and expiry of mirrored media. Public smoke test passed, an
  anonymous upload is 401, and a backup still holds 1 user.

- 2026-10-05: version `2b16fd71-f7ea-47d3-8011-650cec4f7b51` turns media uploads on. The live
  storage migration (`fs_meta.bin`) kept all data: 1 user, and a manual backup of 5 files.
  `/api/config` advertises media, an upload without a session is 401, and the public smoke
  test passed.

- 2026-10-04: version `3302d490-f8c9-44fa-ad32-9f0a776b0513`: a restore signs everyone out.
  Public smoke test passed; the ops list still answers.

- 2026-10-04: version `37b6ac6d-aee4-403c-b141-fe0cfde0218c` adds the backup cron, the R2
  binding and the ops routes. `OPS_TOKEN` is set. The first manual backup
  (`manual/2026-10-05T00-36-16-280Z.json.gz`: 5 files, 1 user) was downloaded and decoded
  independently. Without the token, `/__ops/*` answers 404.

- 2026-10-04: version `5afd6e51-ed48-4b39-aada-da9e3d664c26` sets `ADMIN_UIDS` to the owner's
  profile and turns on `INVITE_ONLY`. `/api/config` reports `invite_only: true`, and signing up
  without a code answers 403. One profile exists.

- 2026-10-04: Worker `opengym` version `043550d1-2014-4cf6-b882-3b870ec1d498`, the API on the
  `OpenGymServer` Durable Object (migration `v1`), from commit `d132933`. Production
  `smoke.mjs --public` passed 5/5, and `/api/register/options` returns
  `rp.id = gym.davidovichequity.com`. No account was created. Signup stays open until the
  owner registers (see `ToDo.md`).

- 2026-10-04: Worker `opengym` version `fa75cb58-11a7-450a-b1dd-3a05b33cdcfc` on the
  `gym.davidovichequity.com` custom domain (based on upstream `1350409`, v1.3.9).
