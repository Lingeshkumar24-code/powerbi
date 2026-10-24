# PowerBICraft

A guest-first, local business-intelligence workbench rebuilt from the observable
report model of **Power BI Desktop**, plus a small service tier for everything
that happens after a report leaves the authoring canvas: workspaces, sharing,
deployment stages, scheduled refresh, email subscriptions and embedding.

The workbench runs entirely in the browser. Datasets, report projects and
autosaves live in **IndexedDB**; local preferences are the only thing kept in
`localStorage`. No account is needed to import data, build visuals, write DAX,
save or reopen projects. Signing in is required only for cloud features.

The design is driven by the REA evidence in
[`docs/powerbi-desktop-analysis.md`](docs/powerbi-desktop-analysis.md). Clean-room
rules still apply: no Microsoft code or assets, no Power Query M, and no
`/DataModel` (ABF) decoding.

![Executive summary](docs/screenshot.png)

<sub>Second page: a matrix with totals, a Top-N bar chart and an area chart.</sub>

![Product detail](docs/screenshot-page2.png)

**Live deployment:** <https://powerbicraft.vercel.app> — the guest workbench,
PWA, AI proxy and Firebase email/password accounts are live. Google Drive
remains disabled until a Google OAuth client is configured.

## Run it

```bash
npm install

npm run dev     # authoring workbench on http://localhost:5178
npm run api     # service tier on http://127.0.0.1:5180 (dev proxy target)

npm run build   # type-check app + server + Vercel functions, build dist/
npm run serve   # built app and API on one origin: http://localhost:5180
npm test        # 120 Vitest unit/integration checks
```

Node.js 22.23.4+ / 24.22.1+ / 26.12.1+ (the service uses `node:sqlite`).

`npm run dev` proxies `/api`, `/v`, `/e` and the viewer's `/assets` to the
service. `npm run serve` is the simplest way to try sharing, embedding and the
installed app: share links, the viewer, the service worker and the API share one
origin.

Guest authoring needs no environment variables. Copy `.env.example` to `.env` for
cloud workspaces (Firebase), Google Drive, Groq or Vercel. See
[`docs/deployment.md`](docs/deployment.md) for setup and serverless storage
caveats.

## Guest workbench

| Area | Behaviour |
| --- | --- |
| Storage | projects, datasets and the autosave record in IndexedDB (`powerbicraft`); zoom, panel and restore preferences in `localStorage` only |
| Library | **Library** saves, reopens, lists and deletes browser projects; the dataset tab lists imported data; no service call and no account |
| Autosave | debounced autosave after edits; a corrupt or missing record never blanks the sample report on startup |
| Project files | `.pbc` download/open still works, alongside browser storage |
| AI | **AI insights** opens a disclosure panel; nothing is sent until the consent box is ticked and **Analyze** is pressed |

The service is never required to start the app. `/?library=1` and `/?ai=1`
deep-link to the two panels.

## The service tier

![Cloud dialog](docs/screenshot-service-overview.png)

Click **Cloud** in the top bar. Guests see the Firebase sign-in/create-account
form; local work keeps running behind the dialog.

| Capability | Behaviour |
| --- | --- |
| Accounts | Firebase Authentication email/password in the browser; the server verifies Firebase ID tokens as `Authorization: Bearer` against Google JWKS. Registration, email verification and password reset are Firebase flows. A verified email can relink a user from an older PowerBICraft install. |
| Workspaces | personal workspace per account, team workspaces, invite by email, roles **owner / editor / viewer**, last-owner protection; every protected operation re-checks membership server-side |
| Publishing | every publish stores a full model + report snapshot as an immutable version; a `PUT` with just `report` or just `model` is allowed |
| Deployment | `dev` follows the newest publish automatically; `test` and `prod` are explicit promotions; rollback to the previous version; structural diff between versions |
| Share links | `/v/<token>` read-only viewer; SHA-256 hash for lookup **and** an AES-256-GCM sealed copy so the link can be shown again; optional expiry; revocable; records `lastUsedAt` |
| Viewer | same query/visual layer as the editor, pages, cross-filtering, slicers, scale-to-fit, `?snapshot=1` chrome-less mode |
| Embedding | `/e/<token>` iframe entry point; allowed origins become a `frame-ancestors` CSP header; tokens expire and are revocable; the public API sends no CORS headers |
| Google Drive | each signed-in user explicitly connects their own Drive with OAuth 2.0 + PKCE, `drive.file` scope. Save/open is consent-gated and refresh tokens are sealed with AES-256-GCM; the browser never receives them. |
| AI analysis | **AI insights** sends a minimized schema/aggregate summary to `/api/ai/analyze`; the server adds the Groq key and enforces persisted guest (per IP) and account quotas. Sample rows are off by default, the exact payload can be previewed, and every send records consent. |
| Refresh | CSV/TSV/JSON/XLSX from the data directory or an http(s) URL; retries with backoff; new version; promoted stages receive data without unreleased report edits |
| Schedules | per-source interval, persisted `nextRunAt`, atomic claim + lease so two instances cannot run the same job, separate worker mode, Vercel cron tick |
| Subscriptions | per-dashboard email + interval; **Send now**; a headless Edge/Chrome renders a PNG snapshot; mail goes to the outbox or to SMTP |
| Jobs | every refresh/subscription is a job row with attempts, status, error and detail |

![Viewer](docs/screenshot-viewer.png)

Share links resolve **production** when a version has been promoted, otherwise
the newest version. That is why the link above shows a *Production* badge.

### Deployment stages

![Stages](docs/screenshot-service-stages.png)

Promotions move a pointer, not a copy: `dev`, `test` and `prod` each reference a
version id. A data refresh appends a version per promoted stage so production
keeps its report layout while picking up new rows.

### Refresh and email

![Refresh and email](docs/screenshot-service-refresh.png)

- A source is `(kind, location, targetTable)`. Relative locations are resolved
  inside the data directory; `http(s)://` locations are downloaded.
- The scheduler and **Refresh now** run the same job code. The scheduler claims
  a due row atomically, keeps a lease, and records `last_error`.
- HTTP sources reject loopback/private/link-local addresses and manual redirects
  by default (`PBC_ALLOW_PRIVATE_SOURCES=1` is test-only).
- Subscriptions render `PUBLIC_URL/v/<preview token>?snapshot=1` in a headless
  browser and attach a 1440×900 PNG. Without a browser the mail still goes out,
  with the preview link only.
- **Outbox** is the default transport: messages are stored in the database and
  written to `data/outbox/<id>.html`. Set `PBC_SMTP_URL` to send real mail.

![Email snapshot](docs/screenshot-email.png)

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `5180` | service port |
| `HOST` | `127.0.0.1` | bind address |
| `PBC_DB` | `data/powerbicraft.db` | SQLite file |
| `PBC_DATA` | `data` | data directory (sources, outbox, snapshots, secret) |
| `PBC_DIST` | `dist` | static build served by the API |
| `PBC_PUBLIC_URL` | `http://localhost:<port>` | absolute base used in share links, OAuth redirects and mail |
| `PBC_SECRET` | — | key material for sealed link tokens and Drive refresh tokens; otherwise `data/secret.key` |
| `PBC_SCHEDULER` | on (off on Vercel) | `0` disables the in-process scheduler loop |
| `PBC_TICK_MS` | `30000` | scheduler interval |
| `PBC_SCHEDULE_LEASE` | `300000` | schedule lease before another worker may claim it |
| `PBC_JOB_ATTEMPTS` | `3` | refresh/subscription retries |
| `PBC_RETRY_DELAY` | `400` | delay between retries (ms) |
| `PBC_BODY_LIMIT` | `67108864` | largest accepted request body (bytes) |
| `PBC_SNAPSHOT` | on | `0` disables headless-browser snapshots |
| `PBC_SNAPSHOT_WAIT` | `8000` | per-snapshot browser budget (ms) |
| `PBC_BROWSER` | auto | explicit Edge/Chrome binary |
| `PBC_SMTP_URL` | — | e.g. `smtp://user:pass@smtp.example.com:587` |
| `PBC_MAIL_FROM` | `PowerBICraft <no-reply@powerbicraft.local>` | envelope sender |
| `PBC_TRUST_PROXY` | on for Vercel | trust `X-Forwarded-For` for guest quota and client IP |
| `PBC_ALLOW_PRIVATE_SOURCES` | off | allow private HTTP refresh sources (tests only) |
| `PBC_ALLOW_ABSOLUTE_SOURCES` | off | allow absolute local source paths outside the data dir |
| `PBC_INSTANCE_ID` | `pbc-<pid>` | scheduler/worker instance label |
| `FIREBASE_PROJECT_ID` | — | Firebase project; server verifies ID tokens with this audience |
| `FIREBASE_API_KEY` | — | public Firebase web API key |
| `FIREBASE_AUTH_DOMAIN` | `<project>.firebaseapp.com` | public auth domain |
| `FIREBASE_APP_ID` | — | public Firebase app id |
| `FIREBASE_MESSAGING_SENDER_ID` | — | public sender id |
| `VITE_FIREBASE_*` | — | accepted as aliases for the same public Firebase values |
| `GOOGLE_CLIENT_ID` | — | Google OAuth web client |
| `GOOGLE_CLIENT_SECRET` | — | optional for installed/PKCE clients, required for the web code flow |
| `GOOGLE_REDIRECT_URI` | `PUBLIC_URL/api/google/callback` | must match the Google console |
| `GROQ_API_KEY` | — | server-only Groq key; never sent to the browser |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Groq model |
| `GROQ_BASE_URL` | `https://api.groq.com/openai/v1` | OpenAI-compatible base URL |
| `GROQ_TIMEOUT_MS` | `45000` | provider timeout |
| `GROQ_GUEST_PER_HOUR` / `GROQ_GUEST_PER_DAY` | `3` / `10` | guest quota per client IP |
| `GROQ_USER_PER_HOUR` / `GROQ_USER_PER_DAY` | `20` / `100` | signed-in quota per user |
| `GROQ_MAX_BODY` | `49152` | request body limit for AI summaries |
| `CRON_SECRET` | — | bearer secret required by `/api/cron/tick` |

Data directory layout:

```
data/
  powerbicraft.db      SQLite (users, workspaces, versions, jobs, consent logs)
  secret.key           token-sealing key (created on first run)
  outbox/              HTML previews when no SMTP is configured
  snapshots/           PNG renders attached to subscription mail
  targets.csv          optional example refresh source
```

### Security and privacy model

- **Firebase replaces the old login.** Password hashing and session cookies are
  gone; only bearer ID tokens are accepted. The token is verified against
  Google's JWKS with the Firebase project as issuer and audience; unverified
  emails are refused before a local user row is touched.
- **Legacy users are relinked, not duplicated.** A verified email links the
  existing user id to the Firebase uid once; an email already linked to a
  different uid returns `409`.
- **Authorization is server-side.** Every workspace/dashboard route re-checks
  membership and role; viewers cannot publish, share, schedule or delete. The
  tenant model is still one trusted team per install, not hostile multi-tenancy.
- **Writes check `Origin`.** A request with an `Origin` header must match the
  request host or the configured public URL, which also covers the Vite proxy.
- **Browser storage is local.** IndexedDB is not encrypted at rest; use disk
  encryption if the machine is shared.
- **AI data is disclosed first.** The client shows the exact payload, sample
  rows are opt-in, the server strips identity, and consent plus usage are logged.
- **Drive tokens stay on the server.** Refresh tokens are sealed with
  AES-256-GCM and the browser only sees connection status and file metadata.
- **Share and embed tokens are bearer secrets.** 32 random bytes, stored hashed;
  the sealed copy exists so the dialog can re-display a link, not so links
  survive key rotation.
- **Embedding is enforced twice.** CSP `frame-ancestors` on the page and a JSON
  API that refuses cross-origin reads and emits no CORS headers.
- **Test auth is not production auth.** Tests inject `verifyToken`; the browser
  dev hook is behind `import.meta.env.DEV` and is eliminated from production
  builds.

### Not implemented

- SSO, MFA and custom password storage (Firebase owns passwords now).
- Tenant isolation for mutually untrusted users, row-level security (RLS) and
  per-user data permissions.
- HTTPS termination; put the single-node service behind a TLS reverse proxy.
- Distributed schedulers; the local worker uses one SQLite database. On Vercel,
  SQLite in `/tmp` is ephemeral and shared only by warm instances.
- Power Query (M), `/DataModel` (ABF) decoding, incremental refresh partitions,
  real-time streaming and XMLA.
- Power BI Pro/PPU/Embedded licensing and Fabric capacity semantics. The embed
  flow is a signed-token + CSP implementation, not Microsoft's embedding API.
- A Google OAuth client was not available in this workspace, so Drive was
  verified with mocked token/exchange/upload transports rather than against
  Google. Firebase Auth, Vercel and Groq were smoke-tested live.

## Test it

```bash
npm test              # 120 Vitest checks (12 files)
npm run check:server  # server + Vercel function type check
npm run build         # app, server and function type check + production build
```

Unit/integration coverage includes the engine, every supported DAX function,
importers, package I/O, IndexedDB storage, Firebase token verification, bearer
authorization, workspace permissions, versions/stages/diff, share revoke/expiry,
embed CSP and forged origins, refresh into promoted stages, restart persistence,
duplicate-claim protection, SSRF/path guards, subscription delivery, AI quotas
and consent, Google Drive OAuth state/PKCE/token sealing, and the PWA static
assets. See `tests/*.test.ts`.

### Browser suites

The suites are plain scripts; run them in DevTools against the real UI. Start
the test API first so no Firebase project, Google client or paid Groq key is
needed:

```bash
npm run build
npm run smoke:api     # 127.0.0.1:5180, accepts test-only bearer tokens, mocks Groq
npm run dev           # 5178, in another terminal
```

The smoke API serves `dist/` and injects a test token verifier. It never loads
Firebase, Google or the real Groq key.

| Suite | Where | Checks |
| --- | --- | --- |
| Editor — [`tests/browser-smoke.js`](tests/browser-smoke.js) | `http://localhost:5178`, run `await runPowerBICraftSmoke()` | 99: rendering, cross-filtering, slicers, zoom, 14 visual types, drag-and-drop, inspector, pages, measures, CSV import, project reopen, PBIR round-trip, text box, matrix totals, IndexedDB save/open/delete, autosave, dataset persistence, localStorage limits, AI disclosure and mocked analysis |
| Cloud — [`tests/cloud-smoke.js`](tests/cloud-smoke.js) | `http://localhost:5178`, run `await runPowerBICraftCloudSmoke()` | 44: test identity sign-in, personal/team workspaces, publish, share link, public API, viewer iframe, cross-filter, page switching, promote/rollback, share revocation, embed CSP + iframe, denied iframe, refresh failure report, schedule, subscription/outbox, sign-out |
| PWA — [`tests/pwa-smoke.js`](tests/pwa-smoke.js) | `http://127.0.0.1:5180` (production build), run `await runPowerBICraftPwaSmoke()` | 24: manifest, start URL/scope, icons, maskable icons, shortcuts, theme, service worker control, shell/offline cache, offline page, responsive breakpoints, install/offline host |

The cloud suite needs the Vite dev server because `window.__pbcTestToken` is a
DEV-only hook. The PWA suite must run against the production build because the
service worker is deliberately not registered in dev. Load a suite with a
script tag or paste it into DevTools, then call its `run...` function. The editor
suite restores the sample report and deletes the saved project it creates; the
cloud suite deletes the dashboard, share, embed and subscription it creates. The
smoke API itself uses a temporary database and never touches
`data/powerbicraft.db`.

### Live-provider status

| Integration | Code | Automated verification | Live verification |
| --- | --- | --- | --- |
| Firebase Auth | client SDK + JWKS verification | token claims, issuer/audience, expiry, unverified/conflict paths | **Live** — registration, verification/reset mail requests, UI sign-in and server token verification on Vercel |
| Google Drive | OAuth code flow, PKCE/state, sealed tokens, save/open | mock token/exchange/upload flows, consent logs, retry | **Not run** — no Google OAuth client |
| Groq | server proxy, quotas, disclosure, schema payload | mocked provider, quota/consent, payload minimization | **Live 200** — real `openai/gpt-oss-120b` call on Vercel |
| Vercel | API/view functions, rewrites, cron, headers | server type check, Vercel config present | **Deployed** — <https://powerbicraft.vercel.app>; app, PWA assets, nested API and AI verified |

## What works today

| Area | Detail |
| --- | --- |
| Data import | CSV/TSV, JSON, XLSX (all sheets) with type inference |
| Model | multiple tables, typed columns, relationships, measures |
| DAX subset | `SUM AVERAGE MIN MAX COUNT COUNTA DISTINCTCOUNT COUNTROWS DIVIDE IF IFERROR ROUND ABS INT FORMAT CONCATENATE UPPER LOWER LEN YEAR MONTH DAY SELECTEDVALUE HASONEVALUE CALCULATE FILTER ALL ALLSELECTED VALUES DISTINCT`, `+ - * / ^ &`, comparisons, `&&`, `!`, `BLANK()` |
| Filter context | slicer selections + cross-filter selection + relationship propagation across a star schema |
| Visuals | card, KPI, bar, column, stacked column, line, area, pie, donut, table, matrix, slicer, text box, shape (14 types) |
| Number formats | report-locale formatting (`en-US`) for currency, percent, integer, decimal and compact (K/M) values |
| Authoring | drag fields into wells, move/resize visuals, rename, duplicate, delete, page management, zoom |
| Persistence | IndexedDB projects/datasets/autosave, `.pbc` project file, CSV export |
| Interop | **open `.pbix` / `.pbit`** (legacy `/Report/Layout` and PBIR `/Report/definition/**`), **export a PBIR-shaped definition zip** |
| Service | Firebase accounts, workspaces/roles, versioned publishing, stages, diffs, share links, viewer, embeds, refresh, schedules, subscriptions, jobs |
| Cloud extras | per-user Google Drive, AI analysis with disclosure and quotas |
| Install | PWA manifest, service worker, offline shell, install/update/offline UI, responsive breakpoints |

## Interop: what a .pbix gives you

REA recovered the package contract from `Microsoft.PowerBI.Packaging.dll`, so
the reader handles both on-disk report formats:

- **Legacy** — `/Report/Layout` (UTF-16 JSON) with `sections → visualContainers →
  config.singleVisual` and `queryRef` projections.
- **PBIR (enhanced metadata)** — `/Report/definition/pages/pages.json`,
  `pages/<page>/page.json`, `pages/<page>/visuals/<visual>/visual.json`.

`/DataModel` is a compressed Analysis Services backup and is *not* decoded; if
`/DataModelSchema` is present its tables, columns and measures are imported so
bindings resolve. Without either, the report opens structurally (pages, visual
types, positions, field wells) and you can re-bind fields to imported data.

Export writes the same part layout and `developer.microsoft.com/json-schemas/
fabric/item/report/definition/...` schema URLs, which makes the output easy to
diff against a real package. It is not validated against Microsoft's schema
validator.

The export carries structure — pages, positions, visual types, field wells and
titles. Authoring options that only exist in PowerBICraft (Top N, legend/label
toggles, text-box copy, visual colours) live in the `.pbc` project file, not in
the PBIR export.

## Architecture

```
src/
  types.ts        model / report / filter-context types
  engine.ts       tabular engine: row visibility, relationship propagation
  dax.ts          DAX tokenizer, parser, evaluator (filter-context aware)
  importers.ts    CSV/TSV/JSON/XLSX → typed tables
  pbix.ts         .pbix + PBIR reader, PBIR writer, .pbc project I/O
  visuals.ts      SVG renderers (charts, tables, matrix, slicer, cards)
  sample.ts       deterministic Contoso demo model + report
  query.ts        shared query layer (editor + viewer)
  storage.ts      IndexedDB projects, datasets and autosave
  prefs.ts        localStorage preferences only
  library.ts      guest library UI
  firebase.ts     Firebase client auth (register/login/verify/reset)
  api.ts          bearer-token JSON client
  ai.ts           AI disclosure, payload preview and analysis UI
  cloud.ts        workspaces, publish, share, stages, embed, refresh, Drive
  pwa.ts          service worker registration, install/update/offline UI
  app.ts          authoring UI: pages, fields, wells, canvas, inspector
  viewer.ts       read-only viewer for /v/ and /e/
  styles.css      Power BI-flavoured theme (editor + service + viewer)

server/
  main.ts         entry point: banner, listen, graceful shutdown
  app.ts          HTTP wiring, static/SPA serving, /v/ and /e/ CSP
  http.ts         router, JSON helpers, errors, rate limiting, Origin check
  db.ts           SQLite schema (node:sqlite) and migrations
  auth.ts         Firebase identity → local user mapping, memberships
  firebase.ts     Firebase ID-token verification (Google JWKS)
  store.ts        permissions, dashboards, versions, stages, token lookup
  crypto.ts       AES-256-GCM sealing for links and Drive tokens
  routes-ai.ts    Groq proxy, quotas, consent/usage logging
  routes-google.ts Drive OAuth, save/open, consent logging
  routes-*.ts     auth, workspaces, dashboards, public, ops
  ops.ts          refresh, subscriptions, snapshots, SSRF/path guards, scheduler
  worker.ts       scheduler-only worker mode
  limits.ts       persisted rate limits

api/
  index.ts        Vercel API entry; vercel.json rewrites every /api/* path to it
  view.ts         Vercel /v and /e entry with CSP and share validation
```

The semantic core is two context layers (`columns` membership + `rows`
predicates). `Engine.allowedSet()` intersects direct filters with restrictions
translated across relationships, bounded by cycle protection; every visual
evaluates its measure inside that context.

The viewer reuses `engine.ts`, `dax.ts`, `query.ts` and `visuals.ts`, so a share
link renders the same numbers as the editor.

## Try it

1. `npm run dev`, open the URL — the Contoso demo report is loaded.
2. Click a column in *Revenue by Region and Category* to cross-filter the page.
3. Toggle **Year** / **Region** slicers, then clear chips in the filter bar.
4. **Measures** → edit `Margin %` or add one, e.g.
   `DIVIDE(SUM(Sales[Revenue]) - SUM(Sales[Cost]), SUM(Sales[Revenue]))`.
5. **Import data** with your own CSV, drag fields into wells, then open
   **Library** and save the project. Reload the page to see autosave restore.
6. **Open .pbix** to inspect a package, **Export PBIR** to see the definition.
7. For cloud features, configure Firebase and run `npm run api`; sign in, create
   a team workspace, publish, then open a share link. Promote a version to
   **Production** and reload the link.
8. Configure Google OAuth and connect Drive from the Cloud dialog to save/open
   report files explicitly.
9. Set `GROQ_API_KEY` and open **AI insights**; review the payload, opt in and
   analyze. Guests have stricter per-IP limits than signed-in users.
10. `npm run build && npm run serve`, open the installed app, then go offline:
    the shell still boots and guest editing/library remain available.

## Limits / next steps

- No Power Query (M) engine; data comes from files and URLs, not connectors.
- `/DataModel` (ABF) decoding is not implemented.
- DAX has no time intelligence, iterator semantics beyond `FILTER`, or
  `SUMMARIZE`/`ADDCOLUMNS` tables.
- The service is single-node, single-process SQLite; schedulers are in-process
  or driven by an external cron tick.
- No RLS, SSO or MFA. Tenant isolation is a trusted-team model.
- Refresh replaces a whole table; there are no incremental partitions.
- Snapshots depend on Edge/Chrome being installed; otherwise mail is HTML-only.
- Vercel serverless SQLite is warm-instance storage in `/tmp`; use a container,
  VM or external database for durable multi-instance production.
- Not a Fabric/PPU/Pro implementation: no capacity, licensing or tenant model.

## Licence

MIT License — see [`LICENSE`](LICENSE).

Copyright (c) 2026 **Lingesh Kumar M**.

Clean-room reimplementation of observable behaviour and file structure. No
Microsoft code or assets are included. "Power BI" is a Microsoft trademark; this
project is not affiliated with or endorsed by Microsoft.
