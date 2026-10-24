# Power BI Desktop — static analysis with REA

Target: **Power BI Desktop 2.159.883.0 (x64)**, installed as an MSIX/AppX package
for the current user.

```
InstallLocation : C:\Program Files\WindowsApps\Microsoft.MicrosoftPowerBIDesktop_2.159.883.0_x64__8wekyb3d8bbwe
Entry point     : bin\pbidesktop.exe   (783,680 bytes, native launcher)
Package status  : Ok, architecture x64
```

Everything below was produced with REA (`rea-agents@6.7.0`) using its
**static .NET / package analysis** lanes, which need no Ghidra/Hopper/IDA
installation. Native-binary decompilation was *not* performed — no native
provider is configured on this machine, so `rea inspect` on `pbidesktop.exe`
returned `provider_unavailable` (candidates: ghidra, hopper, ida, kuna).

## Commands used

| Command | What it gave us |
| --- | --- |
| `rea inspect-managed-artifact <dll>` | PE/CLI identity, runtime family, managed vs native classification |
| `rea inspect-managed-members <dll>` | Types, methods, CIL anchors and `ldstr` string literals with file offsets |
| `rea inspect <dir>` | Correctly refused a directory and pointed at the executable (evidence-first errors) |

### Evidence 1 — the shell is a managed .NET Framework application on top of native engines

```
Microsoft.PowerBI.Client.Windows.dll
  sha256      5c49618814888815ec3649ad2bf7dcf0209de1b3722d30372c126b3ebaf79938
  format      pe / x86_64 / pe32-plus / section_count 2
  cli         runtime_version 2.5, flags il-only + strong-name-signed
  metadata    3,894,284 bytes, resources 23,220,376 bytes
  framework   assembly-level TargetFrameworkAttribute = .NET Framework
```

`Microsoft.PowerBI.Packaging.dll` (478 KB, 487 types) is the component that owns
the document format. Its `ldstr` literals contain the complete package layout:

```
/Version /Settings /Metadata /Connections /DataModel /DataModelSchema
/DiagramLayout /SecurityBindings
/Report/Layout /Report/CustomVisuals /Report/StaticResources
/Report/LinguisticSchema /Report/MobileState /Report/Document
/Report/definition/report.json
/Report/definition/pages/pages.json
/Report/definition/pages/<page>/page.json
/Report/definition/pages/<page>/visuals/<visual>/visual.json
bookmarks/bookmarks.json  bookmarks/<id>.bookmark.json
```

and the mutual-exclusion rules the loader enforces:

```
"Package cannot contain both a DataModel and DataModelSchema part."
"Package cannot contain both a Layout and Report/definition parts."
```

### Evidence 2 — the runtime is four cooperating engines, not one program

Largest binaries in `bin\` (all verified by size/type on disk):

| Binary | Size | Role (from name + .NET metadata) |
| --- | --- | --- |
| `Microsoft.PowerBI.Client.Windows.Themes.dll` | 126 MB | visual theming / resource payload |
| `Microsoft.Mashup.Client.UI.dll` | 102 MB | Power Query UI |
| `msmdsrv.exe` | 71 MB | in-memory tabular (Analysis Services) engine |
| `xmsrv.dll` | 31 MB | formula / calculation engine |
| `Microsoft.PowerBI.Client.Windows.dll` | 27 MB | shell, report host, visual host |
| `Microsoft.MashupEngine.dll` | 15 MB | Power Query **M** evaluator |
| `Microsoft.PowerBI.Tabular.dll` + `Microsoft.PowerBI.Amo*.dll` | — | model object model / AMO bridge |
| `Microsoft.PowerBI.DAXParser.dll` | — | DAX parsing |
| `Microsoft.PowerBI.Packaging.dll` | 0.5 MB | `.pbix` / PBIR reader-writer |

So a `.pbix` is a **zip of parts**, and opening one spins up a local tabular
database (`msmdsrv.exe`), loads the model, and renders report pages from a
JSON visual-container tree.

## What is actually rebuildable

| Power BI capability | Rebuild status in PowerBICraft |
| --- | --- |
| Package format (`.pbix` legacy Layout + PBIR) | **Read + write** (structural) |
| Visual container / field-well model | **Rebuilt** (`pages → visuals → wells`) |
| In-memory tabular model | **Rebuilt** (tables, columns, typing, relationships) |
| Filter context + relationship propagation | **Rebuilt** (the semantic core) |
| DAX | **Subset** (aggregates, CALCULATE/FILTER/ALL, scalar functions) |
| Power Query M | Not rebuilt (import = CSV/JSON/XLSX instead) |
| SSAS compressed model (`/DataModel` ABF) | **Not decoded** |
| Visual rendering | **Rebuilt** (SVG charts, tables, matrix, slicer, cards) |
| Cross-filtering / slicers | **Rebuilt** |

### Honest limits

1. `/DataModel` is an Analysis Services backup (ABF) blob. PowerBICraft reads
   `/DataModelSchema` when present (column/measure metadata) and otherwise
   imports the report **structurally** — layout and field bindings without rows.
2. The PBIR writer emits the same part layout and schema URLs REA recovered, but
   it has **not** been validated against Power BI's actual schema validator, so
   treat it as a structurally faithful export rather than a guaranteed-importable
   document.
3. Native decompilation of `msmdsrv.exe` / `xmsrv.dll` was not attempted; that
   needs Ghidra/Hopper/IDA plus a review of Microsoft's licence terms.

## Verification

The rebuild is tested at three levels:

| Suite | Checks | Covers |
| --- | --- | --- |
| `npm test` (Vitest) | 79 | filter context + relationship propagation, DAX functions and errors, CSV/JSON typing, legacy `.pbix` parsing, PBIR round trip, `.pbc` round trip, demo model totals, plus a 27-check service suite: accounts/sessions, workspace roles, versions/stages/diff, share revoke/expiry, embed CSP and forged origins, refresh into promoted stages, retry on a missing source, due schedules, subscription delivery and outbox privacy |
| `tests/browser-smoke.js` | 78 | real DOM: rendering, cross-filter, slicers, zoom, 14 visual types, drag-and-drop wells, inspector, pages, measure editor, CSV import, package open, text-box editing, matrix totals |
| `tests/cloud-smoke.js` | 46 | live service: sign-up, workspaces, invite, publish, share link, viewer rendering/cross-filter/page switch, promote/rollback, embed CSP + iframe, revoked tokens, refresh failure, subscription delivery, teardown |

Defects found by running things rather than by inspection:

1. `fflate`'s `strFromU8(bytes, true)` decodes **latin1**, not UTF-16, so every
   legacy `/Report/Layout` part (Power BI writes UTF-16LE) would have failed to
   parse. Replaced with an explicit UTF-16LE/BE decoder plus BOM-less detection.
2. Number formatting followed the host locale — on an `en-IN` machine
   `502899064` rendered as `50,28,99,064` (lakh grouping). Formatting now uses a
   fixed report culture, matching Power BI's report-culture behaviour.
3. Publishing a report-only change (`PUT` with `report` but no `model`) was
   rejected because document validation demanded both halves. Validation now
   checks each side independently, which is what the version history needs.
4. Subscription mail could not be written because the outbox rows require
   non-null dashboard/job ids and the mail record did not carry them; the
   integration test caught the constraint failure.
5. Subscription snapshots launched Chromium with a profile inside the project
   root. Vite watched the GPU cache and died with `EBUSY` mid-refresh; profiles
   now live in the OS temp directory and are removed after the render.
6. Version history showed raw user ids (`createdBy`) in the dialog. Display
   names are now resolved server-side for both the version list and the
   dashboard detail view.
7. Scaling the fixed 1280×720 canvas *up* with `transform: scale()` made Chromium
   rasterize text before compositing, so screenshots looked soft. The viewer
   fits pages down (and fills snapshots) but never scales above 1:1.

The REA boundary is unchanged by the service work: it is an independent
implementation of observable behaviour (accounts, versions, stages, tokens)
rather than a reproduction of Microsoft's service internals.

## Reuse boundary

PowerBICraft is a clean-room reimplementation of *observable behaviour and file
structure*. No Microsoft code, binaries, themes, icons or other assets are copied
into this repository.
