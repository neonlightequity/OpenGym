# Session log

A running summary of each working session (Claude Code or Codex), newest first.
Each entry says what changed, what was verified, and what is still open, so the
next session can pick up without re-reading the whole git history. See
`GIT_SYNC.md` item 8. Commit-level detail stays in `git log`; open work goes
in `ToDo.md` at the repository root.

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
