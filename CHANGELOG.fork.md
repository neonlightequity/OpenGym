# Fork changelog

Changes specific to the davidovichequity fork and its Cloudflare deployment at
gym.davidovichequity.com. Upstream application changes are in `CHANGELOG.md`.

## [Unreleased]

### Added

- Cloudflare Workers deployment: `wrangler.toml`, `cloudflare/worker.js` serving `frontend/dist`
  as static assets (SPA fallback) with the security headers `web/nginx.conf.template` sets, plus
  HSTS. Exercise media comes from the pinned jsDelivr dataset, as in upstream's mobile build.
- Interim `/api` that reports a guest-only instance (`allow_guest: true`) until the API port lands.
- Shared Claude/Codex Git synchronization (`GIT_SYNC.md`, `scripts/git-sync.mjs`, hooks),
  `AGENTS.md`, `ToDo.md`, `docs/changelog.md`.

### Production deployment

- 2026-10-04: Worker `opengym` version `fa75cb58-11a7-450a-b1dd-3a05b33cdcfc` on the
  `gym.davidovichequity.com` custom domain (based on upstream `1350409`, v1.3.9).
