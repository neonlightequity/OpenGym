# ToDo

Open work for Claude and Codex, across machines. Check items off when done.

- [ ] **Owner: create the GitHub repository** `neonlightequity/OpenGym` (public fork of
      DuarteSantos8/openGym — AGPL §13 needs the hosted source available), then
      `git remote add origin https://github.com/neonlightequity/OpenGym.git && git push -u origin main`.
      Until then this checkout only exists on the MacBook.
- [ ] **Port the API to Cloudflare** (accounts, passkeys, sync, admin, push) — see `CLOUDFLARE.md`.
- [ ] Custom-exercise photo/video uploads on R2 (`/api/media/*`), after the API port.
- [ ] Decide on the AI Coach (upstream's runs a local agent process; not portable to Workers as-is).
- [x] Serve the frontend from Workers static assets at gym.davidovichequity.com (2026-10-04,
      version `fa75cb58`), guest mode only.
