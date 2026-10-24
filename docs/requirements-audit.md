# Requirements audit — PowerBICraft (service tier + guest workbench)

Date: 2026-10-24. Baseline: the original local workbench and service tier
(79 Vitest checks, 78 editor browser checks, 46 service browser checks) before
the guest-first, Firebase, Drive, Groq, refresh, PWA and Vercel work.

## Status

| # | Requirement | Final state | Evidence | Remaining gap |
| --- | --- | --- | --- | --- |
| 1 | Guest-first workbench | **Implemented.** Editor, import, DAX, charts, project files, IndexedDB library and autosave work with no login. The Cloud dialog is the only auth surface. | Editor browser suite: 99/99, including library save/open/delete, autosave, dataset persistence and AI disclosure. | None for local authoring. Cloud actions still require a signed-in account by design. |
| 2 | IndexedDB for data/projects, localStorage only for prefs | **Implemented.** `src/storage.ts` stores projects, datasets and autosave in IndexedDB; `src/prefs.ts` keeps only zoom/panel/restore/install flags in localStorage. Library UI and startup restore added. Legacy file I/O retained. | `tests/storage.test.ts` 7/7; editor suite checks autosave, saved projects, datasets and a small localStorage record. | IndexedDB is not encrypted at rest; that is documented, not solved. |
| 3 | Firebase Authentication (register/login/verify/reset) | **Implemented in code.** Firebase JS SDK for email/password, verification mail, reset and sign-out. Server verifies bearer ID tokens with `jose` against Google JWKS. Legacy scrypt/password/session code and routes removed. `email_verified` enforced. | `tests/firebase.test.ts` 4/4 (claims, issuer/audience, expiry, missing email); bearer auth in `tests/server.test.ts`; migration test relinks a verified email. | **No Firebase project or web config in this workspace, so no live Firebase login/email delivery was run.** Client and server paths are covered by injected/mock identities only. |
| 4 | Google Drive OAuth per user, consent-gated files | **Implemented in code.** Backend authorization-code flow with state + PKCE, optional client secret, `drive.file` scope, sealed refresh tokens, status/connect/callback/disconnect/files/save/open, consent logs and a popup callback page. | `tests/google.test.ts` 8/8 with mocked token/exchange/upload transports. | **No Google OAuth client, so no live Drive consent or real file upload was run.** |
| 5 | Groq analysis through backend, disclosure, guest limits | **Implemented and live.** `/api/ai/analyze` keeps the key server-side, persists guest-per-IP and user quotas, validates disclosure/consent, sends schema + aggregates with raw rows off by default, logs usage/consent. UI shows the exact payload first. | `tests/ai.test.ts` 8/8; editor suite checks disclosure, disabled send, payload preview and a mocked analysis result. A real production call to `https://powerbicraft.vercel.app/api/ai/analyze` returned 200 from `openai/gpt-oss-120b` with the expected analysis and usage. | The pasted key was also uploaded to Vercel as a server-only variable; rotate it after verification. Real-provider behavior is not part of the automated suite. |
| 6 | Preserve workspaces, roles, sharing, publishing, stages, subscriptions; authorize every protected operation | **Preserved and re-pointed to Firebase identities.** Personal workspaces are created on first verified login; existing users relink by email so ids/workspaces survive. Every route re-checks membership/role. | `tests/server.test.ts` 28/28; cloud suite 44/44 covers workspace roles, publish, share, viewer, stages, embed, refresh, schedule and subscription. | Tenant isolation is still a trusted-team model; no hostile multi-tenancy or RLS. |
| 7 | Refresh persistence, restart behavior, connectors, production-safe scheduling | **Hardened.** SQLite persistence, atomic claim + lease, separate worker mode, Vercel cron tick, SSRF/DNS guard, manual redirects, 50 MB cap, data-dir path confinement, `last_error`, restart and duplicate-claim tests. | `tests/refresh.test.ts` 4/4; server suite covers refresh into promoted stages and failure reporting. | Vercel cron is daily on Hobby; minute-level scheduling needs Pro or an external worker. Serverless SQLite is ephemeral. |
| 8 | Responsive, installable PWA, working Vercel frontend + backend | **Implemented and deployed.** Manifest, generated PNG/maskable icons, service worker (production only), offline shell, install/update/offline UI, responsive breakpoints, mobile drawer/full-screen panels. Vercel frontend plus a single `/api/index` function and separate viewer function, with rewrites for nested `/api/*` paths. | PWA suite 24/24 on the production build; `npm run build`; `tests/security.test.ts` covers static/PWA assets and headers. Production deployment verified: app shell, `manifest.webmanifest`, `/sw.js`, `/offline.html`, `/api/config`, nested `/api/google/status` and `/api/ai/analyze` all respond correctly. | Install prompt depends on browser engagement and was not auto-triggered. Mobile layout was checked by CSS breakpoints, not a real device matrix. |
| 9 | Remove conflicting auth systems | **Implemented.** `pbc_session` cookies, scrypt password hashes, register/login/logout routes and client forms are gone. Only Firebase bearer verification remains. Verified-email relink preserves users. | Server suite 28/28 uses injected bearer tokens; migration test 1/1; grep shows no session/password routes in the service. | Old rows retain unused legacy columns for migration; they are not used for authentication. |
| 10 | Rerun unit, integration, browser, security and production-build tests; report actual results and every incomplete feature | **Done for the checks available here.** | See results below; Vercel and a live Groq call were verified after deployment. | Live Firebase and Google Drive verification remain blocked by missing provider credentials; listed explicitly. |

## Test results (actual, final run)

| Suite | Command | Result |
| --- | --- | --- |
| Unit/integration (12 files) | `npm test` | **120/120 passed** |
| Server + API type check | `npm run check:server` | **passed** (includes `api/` and `tests/smoke-server.ts`) |
| App type check | `npx tsc --noEmit` | **passed** |
| Production build | `npm run build` | **passed** |
| Editor browser suite | `tests/browser-smoke.js` | **99/99 passed** |
| Cloud/service browser suite | `tests/cloud-smoke.js` | **44/44 passed** |
| PWA browser suite (production build) | `tests/pwa-smoke.js` | **24/24 passed** |
| Vercel production smoke | `curl` + browser against `https://powerbicraft.vercel.app` | **passed** — app shell, PWA assets, `/api/config`, nested `/api/google/status` (401 auth), live `/api/ai/analyze` (200) |

Browser suites ran in desktop Edge through the OpenCode browser control, against
`tests/smoke-server.ts` (test-only bearer verifier, mocked Groq, temporary
SQLite DB) and Vite on `localhost:5178` for the DEV-only auth hook. The PWA suite
ran on the built app at `127.0.0.1:5180` so the production service worker was
active. The service worker shell cache was also checked after a controlled
reload: hashed JS/CSS assets were present in `pbc-shell-v1-2026-10-24`.

Vitest files: engine 11, DAX 18, importers 10, PBIR 13, storage 7, Firebase 4,
AI 8, Google 8, security 8, refresh 4, migration 1, server 28.

## Incomplete or unverified features

These are real gaps, not hidden by passing tests:

1. **Live Firebase Auth** — no project/web config here. Registration, email
   verification delivery, password-reset email and token refresh were not
   exercised against Google's production endpoints.
2. **Live Google Drive** — no OAuth client. The consent screen, real token
   exchange, Drive file listing/upload/open and revocation were not run against
   Google.
3. **Live Groq** — automated browser tests use a mock provider. One real call
   was verified in production, but continuous provider behavior (rate limits,
   outages and model changes) is not part of the automated suite. Rotate any key
   pasted into chat.
4. **Vercel deployment** — the production deployment is live at
   `https://powerbicraft.vercel.app`; the app shell, PWA assets, nested API
   routes and a live AI call were verified. The daily cron invocation and
   preview-domain behavior were not observed live, and serverless SQLite remains
   ephemeral.
5. **Serverless persistence** — SQLite in `/tmp` is ephemeral and per-instance.
   This is documented, not fixed. Durable multi-instance production needs a
   shared database or a persistent host.
6. **PWA install prompt** — registration, control, shell cache and offline page
   were verified; the browser `beforeinstallprompt` event was not auto-fired, so
   the actual install button flow is a manual check.
7. **Mobile device matrix** — responsive CSS at 900px/760px ships and mobile
   drawer/full-screen rules exist, but no real iOS/Android device or emulator
   run was performed.
8. **Email/SMTP** — outbox delivery is tested; real SMTP was not configured.
   Headless PNG snapshots depend on Edge/Chrome and were not part of the final
   browser suite.
9. **Power BI parity** — no Power Query M, `/DataModel` ABF decoding, RLS,
   incremental refresh, real-time streaming or Pro/PPU/Embedded licensing. Demo
   and paid plan features are intentionally out of scope.

## Security decisions

- The Groq key is server-side only (`GROQ_API_KEY`), never sent to or bundled in
  the client. Rotate the key pasted into chat.
- Client Firebase config (API key, project id, app id) is public by design; the
  server verifies ID tokens against Google's JWKS.
- Google refresh tokens are sealed with AES-256-GCM using `PBC_SECRET` or
  `data/secret.key` and are never returned to the browser.
- `assertSameOrigin` accepts the request host or the configured `PBC_PUBLIC_URL`,
  which covers the Vite dev proxy without trusting arbitrary origins.
- Guest AI quota uses `X-Forwarded-For` only when `PBC_TRUST_PROXY=1` (default on
  Vercel), preventing a client from bypassing the limit with a forged header.
- Test authentication is injected through `createApp({ verifyToken })` and a
  DEV-only browser hook; production builds contain no test login path.
