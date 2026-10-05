# ToDo

Open work for Claude and Codex, across machines. Check items off when done.

- [ ] Restore custom-exercise media from the R2 mirror (`media/<uid>/…`) after losing the Durable
      Object: needs a command that writes them back and refreshes media.js's per-profile cache.
- [ ] Owner: add a photo or video to a custom exercise on a phone, to confirm uploads in the real app
      (verified locally only; production is invite-only, so no test profile was made).
- [ ] Decide on the AI Coach (upstream's runs a local agent process; HTTP providers would need
      keys as Worker secrets and the coach modules ported off `node:fs`).
- [ ] Push notifications on a real phone: subscribe in Settings and confirm a rest-timer alert
      and the day reminder arrive (verified locally only against a test endpoint).
- [ ] Three upstream API tests fail on Node 25 locally, on the untouched base too (media route
      session check; two password-change race tests). Re-check on Node 22, which upstream CI uses.
- [ ] `do-fs` `appendFileSync` rewrites the whole audit log per event; switch to a chunk append
      if sign-in latency or storage writes become noticeable.
- [x] Custom-exercise photo/video uploads (Durable Object storage, mirrored to R2 nightly; videos
      ≤ 16 MB) — 2026-10-05.
- [x] Daily backups of the API data to R2 (`opengym-backups`, 30 daily + 12 monthly), with
      token-protected restore — 2026-10-04, see `CLOUDFLARE.md` → Backups.
- [x] Owner profile `ROFl0cz7ERY2iHBg` is admin (`ADMIN_UIDS`) and `INVITE_ONLY` is on — 2026-10-04.
- [x] Port the API to Cloudflare (accounts, passkeys, sync, admin, push) — 2026-10-04, see `CLOUDFLARE.md`.
- [x] Create the GitHub repository `neonlightequity/OpenGym` (public fork) — 2026-10-04.
- [x] Serve the frontend from Workers static assets at gym.davidovichequity.com — 2026-10-04.
