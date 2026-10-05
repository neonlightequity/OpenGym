# Session log

A running summary of each working session (Claude Code or Codex), newest first.
Each entry says what changed, what was verified, and what is still open, so the
next session can pick up without re-reading the whole git history. See
`GIT_SYNC.md` item 8. Commit-level detail stays in `git log`; open work goes
in `ToDo.md` at the repository root.

## 2026-10-05 — Claude Code — MacBook — Custom-exercise media; restore signs everyone out

- Restore fix (from a background security review): a restore now bumps every profile's session
  version, so sessions revoked after a backup cannot come back. Worker `3302d490`, commit
  `c3c9f4e`.
- Custom-exercise photos and videos are on. `api/media.js` now imports `./fs.js`. `do-fs`
  gained binary files, directories, fds and streams, and `Res` is a Writable. The video cap is
  16 MB. Uploads are left out of JSON backups and mirrored to R2 nightly, and a restore keeps
  them. Worker `2b16fd71`, commit `5ad37a8`.
- Verified locally: `media-smoke.mjs` 15/15 (incl. a 15 MB video round trip, caps, hash
  mismatch, missing, sweep), mirror copies once and then finds them present, JSON backup holds
  0 uploads, an upload survives a restore, the API suite is unchanged (same 3 Node 25
  failures), `test:cf` 7/7. Production: config, 401 without a session, data intact after the
  table migration, backup ok.
- Open: restoring media from the R2 mirror; the owner trying an upload on a phone; Coach; push
  on a real phone.
- Commits: `c3c9f4e`..HEAD.

## 2026-10-04 — Claude Code — MacBook — Backups to R2

- Daily cron backup of all API data to the private R2 bucket `opengym-backups` (30 daily, 12
  monthly). Token-protected `/__ops` routes and `cloudflare/ops.mjs` list, take and restore
  backups. Restore is transactional, saves `pre-restore/` first and signs everyone out once (session versions bumped). A background
  security review found that keeping sessions would revive revoked ones. Adds a
  `reloadData()` seam to `api/server.js`. The `OPS_TOKEN` copy on the MacBook is in
  `.git/opengym-ops-token`.
- Verified locally: cron → backup → data changed → restore brings back the 3,000 workouts,
  removes the profile created after the backup, and survives a restart. After the fix, the old
  session cookie is refused (401) and a fresh sign-in sees the restored data.
  Unit tests cover the format, malformed backups and retention over 500 days. The API suite
  is unchanged (same 3 Node 25 failures). Production: Worker `37b6ac6d`; a manual backup
  (1 user, 5 files) downloaded and decoded; `/__ops` is 404 without the token; public smoke
  test passed. No restore was run against production.
- Open: R2 media, Coach, push on a real phone.

## 2026-10-04 — Claude Code — MacBook — Owner admin, invite-only

- Owner registered (profile `ROFl0cz7ERY2iHBg`). It is now `ADMIN_UIDS`, and `INVITE_ONLY = "1"`
  is set in `wrangler.toml`. Deployed Worker `5afd6e51`.
- Verified: `/api/config` reports `invite_only: true`, signup without a code answers 403, and the
  instance has 1 user.
- Open: Durable Object storage backup, R2 media, Coach, push on a real phone.

## 2026-10-04 — Claude Code — MacBook — Fork, Cloudflare hosting, API port

- Forked DuarteSantos8/openGym to `neonlightequity/OpenGym` (public, AGPL §13); canonical
  checkout `~/repos/OpenGym`, `origin` = fork, `upstream` = DuarteSantos8 (push disabled).
  Added the shared Git sync tooling, `AGENTS.md`, `ToDo.md`, `CHANGELOG.fork.md`, this log.
- gym.davidovichequity.com is served by the `opengym` Worker (custom domain). The frontend is
  served from static assets, with exercise media from the pinned jsDelivr dataset. The API
  (`api/server.js`) runs in one SQLite-backed Durable Object, with small seams in server.js
  (fs via `api/fs.js`, exported `handle`/`reminderTick`/`fireRestTimer`). Timers use the
  alarm, and Web Push uses WebCrypto restricted to the browsers' push services. Coach and
  media uploads are off. Runbook: `CLOUDFLARE.md`.
- Verified: `api` suite unchanged vs base (same 3 Node 25 failures), local smoke test incl.
  1.5 MB sync, restart persistence and an 11 MB chunked body → 413; passkey register + sign-in
  through the UI (virtual authenticator); Web Push decrypted with `http_ece`; rest timer fired
  from the alarm; production public smoke 5/5 and WebAuthn options for the production RP ID.
  A background security review raised 3 findings (unbounded reads, push SSRF); all fixed in
  `d132933`.
- Deployed: Worker `fa75cb58` (guest only), then `043550d1` (API).
- Open: owner registers, then `ADMIN_UIDS` + `INVITE_ONLY`; no backup of the Durable Object
  storage yet; R2 media; Coach decision; push on a real phone.
- Commits: `9367f36`..HEAD.
