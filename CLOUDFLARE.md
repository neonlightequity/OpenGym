# Cloudflare deployment — gym.davidovichequity.com

openGym normally runs as two Docker containers with a `./data` folder. This fork runs the same
app on Cloudflare Workers, with no server to maintain.

## Architecture

```
browser ──► Worker `opengym` (cloudflare/worker.js)
              ├─ /api/*  ──► Durable Object `OpenGymServer` "main" (cloudflare/server-do.js)
              │                 └─ api/server.js handle()  — upstream code, unchanged in shape
              │                      fs  ──► cloudflare/do-fs.js  (DO SQLite storage)
              │                      web-push ──► cloudflare/web-push.js (WebCrypto + fetch)
              └─ everything else ──► static assets (frontend/dist, SPA fallback)
```

- **One Durable Object runs the API.** Upstream's server is one process with its database in
  memory and synchronous file writes. A single Durable Object is the same model: requests run
  one at a time, `db` stays in memory while the object is alive, and Durable Object SQLite
  writes are synchronous. `api/server.js` imports `fs` from `api/fs.js`. That module is
  `node:fs` on Node and `cloudflare/do-fs.js` in the Worker. The rest of server.js is upstream code.
- **Seams in `api/server.js`** (keep them when merging upstream): the `./fs.js` import;
  `reminderTick()` exported instead of an inline `setInterval` callback; the
  `globalThis.__opengymRestTimers` hook in `scheduleRestTimer`/`cancelRestTimer`;
  `fireRestTimer`, `hasPushSubscribers` and `handle` exported; `listen` skipped when
  `globalThis.__opengymHost` is set. `api/Dockerfile` copies `fs.js`.
- **Timers.** Durable Objects are evicted when idle, so in-memory timers cannot be relied on.
  Rest-timer pushes are rows in the `rest_timers` table. The reminder tick runs from the
  object's alarm every minute while anyone has a push subscription. The alarm is re-armed
  after every request and every alarm. The other in-memory state (passkey challenges, pairing
  codes, presence, rate-limit windows) is short-lived and may be lost on eviction. Upstream
  loses the same state on a restart.
- **Request adapter.** `cloudflare/node-http.js` turns a fetch `Request` into the
  `req`/`res` members server.js uses and returns a `Response`. Bodies are capped at 2 × 5 MB
  before the handler runs; server.js applies its own 5 MB limit.
- **Web Push** uses `@block65/webcrypto-web-push` (aes128gcm + VAPID), aliased in place of
  the npm `web-push`. Keys keep web-push's format. They are generated once, at first boot,
  into `/data/vapid.json` in storage. Pushes go only to the browsers' push services
  (FCM, Mozilla, Apple, WNS). Any other endpoint is answered as gone (410) and pruned, where
  upstream checks for private addresses at connect time.

## Where data lives

All data is in the Durable Object's SQLite storage (tables `fs_meta`/`fs_chunks`; files are
split into chunks because a row holds at most 2 MB). The files match a Docker install's
`./data`: `db.json` (users, passkeys, subscriptions, invites), `state-<uid>.json`, `secret`
(session HMAC key, generated on first boot), `vapid.json`, `audit.log`. None of it is in
Git. **Back it up**: the open item in `ToDo.md` covers an export.

## Configuration

`wrangler.toml` `[vars]`: `RP_ID`, `ORIGIN` (both must be the exact production host, because
passkeys are bound to it), `VAPID_SUBJECT`, `TRUST_PROXY=1` (the Worker sets `X-Forwarded-For`
from `CF-Connecting-IP`), `COACH_DISABLED=1`, `MEDIA_UPLOADS=off`. All other variables in
`docs/SELF_HOSTING.md` work the same way (`INVITE_ONLY`, `ADMIN_UIDS`, `ALLOW_GUEST`,
`PASSWORD_LOGIN`, `SESSION_DAYS`, `AUDIT_*`, `DEFAULT_LANG`). Changing one is a deploy.

Disabled on Workers:
- **AI Coach**: upstream runs a local agent process or calls providers with keys stored on
  disk.
- **Custom-exercise photos/videos** (`/api/media/*`): these need a file store; R2 is the
  planned port.

## Commands

| Command | What it does |
|---------|--------------|
| `npm run cf:install` | Install root (wrangler, web-push lib), `frontend/` and `api/` dependencies; the bundle needs all three |
| `npm run cf:build` | Build `frontend/dist` with exercise media from the pinned jsDelivr dataset |
| `cp .dev.vars.example .dev.vars && npm run cf:dev` | Local Worker at http://localhost:8787 with persistent local storage in `.wrangler/state` |
| `node cloudflare/smoke.mjs http://localhost:8787` | Full API smoke test (needs `PASSWORD_LOGIN=1`, as in `.dev.vars.example`) |
| `node cloudflare/smoke.mjs https://gym.davidovichequity.com --public` | Read-only production smoke test |
| `npm run test:cf` | Web Push interoperability tests (decrypts with `http_ece` from `api/node_modules`) |
| `cd api && npm test` | Upstream API suite on Node, to confirm the seams did not change behavior |

`cf:dev` passes `--local-upstream localhost:8787`. Without it, wrangler rewrites `Origin` to the
production host and the CSRF guard refuses every POST.

## Deploy

1. `npm run cf:build`, `cd api && npm test`, `npm run test:cf`, and the local smoke test.
2. `npx wrangler deploy --dry-run`, then `npx wrangler deploy`.
3. `node cloudflare/smoke.mjs https://gym.davidovichequity.com --public`, then load the app.
4. Record the Worker version ID in `CHANGELOG.fork.md`.

Rollback: `npx wrangler rollback <version-id>`. Storage is not rolled back. Versions before
the Durable Object (`fa75cb58`, guest-only) predate the `v1` migration, so a rollback to one
may be refused. The fallback is redeploying that commit's code.
`[[migrations]]` tags are append-only: never edit or remove `v1`.
