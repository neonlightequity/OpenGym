# ToDo

Open work for Claude and Codex, across machines. Check items off when done.

- [ ] **Owner: create your profile** at https://gym.davidovichequity.com (Create new profile →
      passkey), then tell Claude/Codex the profile id shown in Settings so it can be set as
      `ADMIN_UIDS` and `INVITE_ONLY = "1"` turned on in `wrangler.toml` (signup is open until then).
- [ ] **Back up the API data**: Durable Object storage has no export yet. Add an admin-only
      export of the stored files and/or a scheduled dump to R2.
- [ ] Custom-exercise photo/video uploads on R2 (`/api/media/*`; `MEDIA_UPLOADS = "off"` for now).
- [ ] Decide on the AI Coach (upstream's runs a local agent process; HTTP providers would need
      keys as Worker secrets and the coach modules ported off `node:fs`).
- [ ] Push notifications on a real phone: subscribe in Settings and confirm a rest-timer alert
      and the day reminder arrive (verified locally only against a test endpoint).
- [ ] Three upstream API tests fail on Node 25 locally, on the untouched base too (media route
      session check; two password-change race tests). Re-check on Node 22, which upstream CI uses.
- [ ] `do-fs` `appendFileSync` rewrites the whole audit log per event; switch to a chunk append
      if sign-in latency or storage writes become noticeable.
- [x] Port the API to Cloudflare (accounts, passkeys, sync, admin, push) — 2026-10-04, see `CLOUDFLARE.md`.
- [x] Create the GitHub repository `neonlightequity/OpenGym` (public fork) — 2026-10-04.
- [x] Serve the frontend from Workers static assets at gym.davidovichequity.com — 2026-10-04.
