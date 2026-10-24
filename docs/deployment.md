# Deployment

PowerBICraft has two deployment shapes:

1. **Single origin (recommended):** `npm run build && npm run serve` on a VM,
   container or persistent host. The API serves `dist/` and owns `/v` and `/e`.
   SQLite, the scheduler, the outbox and snapshots are durable.
2. **Vercel:** static Vite frontend plus Node 22 serverless functions. Useful
   for demos and low-traffic teams, with the storage caveats below.

## Local production check

```bash
npm install
npm run build
npm run serve
# open http://localhost:5180
```

Set `PBC_PUBLIC_URL` if the public origin is not `http://localhost:5180`.
Share links, Google OAuth redirects and email snapshots use it.

## Vercel

### What is committed

- `api/[...path].ts` forwards every `/api/*` request to the same `createApp()`
  router used locally.
- `api/view.ts` serves `/v/*` and `/e/*` and keeps per-share CSP and validation.
  It uses `includeFiles: "dist/viewer.html"`.
- `vercel.json` builds with `npm run build`, publishes `dist/`, rewrites the
  viewer paths, configures the daily cron and sets security/cache headers.
- `node:sqlite` requires the Node 22 runtime configured in `vercel.json`.

### Steps

1. Push the repository to a Git provider and import it in Vercel.
2. Add the environment variables from `.env.example`. At minimum:
   - `PBC_SECRET` — a stable random value; without it each function instance
     can create a different key and sealed links/Drive tokens will not decrypt.
   - `FIREBASE_*` — the Firebase web config.
   - `GROQ_API_KEY` if AI is enabled.
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` if Drive is enabled.
   - `CRON_SECRET` — required for `/api/cron/tick`; Vercel sends it as a bearer
     token for the cron request.
3. Set `PBC_PUBLIC_URL` to the production domain. Google and Firebase must use
   the same origin.
4. In Firebase Authentication → Settings → Authorized domains, add the Vercel
   production and preview domains. Enable Email/Password.
5. In Google Cloud, add `https://<domain>/api/google/callback` as an authorized
   redirect URI for the OAuth web client.
6. Deploy. Confirm:
   - `/api/config` returns `publicUrl` and the expected provider flags.
   - the app loads, the service worker registers and `/manifest.webmanifest`
     returns 200;
   - a share link `/v/<token>` renders and its response carries
     `frame-ancestors`;
   - `/api/cron/tick` returns 401 without the secret and runs with it.
7. Vercel Hobby allows only daily cron. `vercel.json` therefore uses
   `17 3 * * *`. Minute-level refresh needs Pro or an external scheduler that
   calls the endpoint with `CRON_SECRET`.

### Serverless storage caveat

Vercel functions only have a writable `/tmp`. PowerBICraft points `PBC_DB` and
`PBC_DATA` there when `VERCEL` is set. That means:

- SQLite data is **ephemeral** and may be lost on a cold start or redeploy.
- Two warm instances do not share the database; workspaces, share links and
  jobs can appear inconsistent under concurrency.
- The in-process scheduler is disabled by default; the cron endpoint is the
  only reliable refresh trigger.
- `PBC_SECRET` must be set or sealed tokens are not portable across instances.

For durable production use a container/VM with a persistent volume, or replace
SQLite with a shared database before scaling beyond one warm instance.

### Security headers

`vercel.json` sets CSP, `nosniff` and `Referrer-Policy` for `/`, and cache rules
for `/assets`, `/sw.js` and the manifest. The API sets `Cache-Control: no-store`
on JSON responses. CSP allows the Firebase and Google auth endpoints used by the
client; a new provider requires updating both `vercel.json` and the server's CSP
if it is called from the page.

## Firebase

1. Create a project and a Web app.
2. Enable Email/Password.
3. Copy `apiKey`, `authDomain`, `projectId`, `appId` and `messagingSenderId` into
   `FIREBASE_*` (or `VITE_FIREBASE_*`).
4. Add every app origin to Authorized domains.
5. The server needs no service-account key: it verifies ID tokens against
   Google's public JWKS with the project id as issuer/audience.

Email verification is enforced server-side. Unverified accounts can sign in to
Firebase but `/api/me` reports `unverified` and protected routes return 403.
Password reset and verification mail are Firebase-hosted flows.

## Google Drive

1. Enable the Google Drive API.
2. Configure the OAuth consent screen.
3. Create a Web application OAuth client.
4. Add `PUBLIC_URL/api/google/callback` as an authorized redirect URI.
5. Set `GOOGLE_CLIENT_ID` and, for a web client, `GOOGLE_CLIENT_SECRET`.

The backend uses the authorization-code flow with state + PKCE and requests only
`drive.file`. Refresh tokens are sealed with AES-256-GCM and never sent to the
browser. Connecting is always an explicit user action; nothing is uploaded
without pressing **Save to Drive**.

## Groq

Set `GROQ_API_KEY` on the server. The key is never exposed in the client bundle.
Tune `GROQ_GUEST_*` and `GROQ_USER_*` quotas for your traffic. The endpoint
requires a disclosure version and consent flag; sample rows are off by default.
If the key is absent, the AI panel reports that the feature is not configured
and the rest of the app still works.

Rotate any key that has been pasted into a chat, issue tracker or commit.
