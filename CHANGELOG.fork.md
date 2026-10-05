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

### Production deployment

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
