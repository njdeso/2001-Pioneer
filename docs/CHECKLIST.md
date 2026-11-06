# Development checklist

Legend: ✅ done & tested here · 🟡 written, must be verified on your machine · ⏳ pending · ⛔ blocked

## Plan

- ✅ Architecture & plan approved (retrospective 12-month snapshot; export package, no buyer portal; no redaction under NDA)
- ✅ Decisions: revenue month = statement period; wholesalers J&J, Jimcor, RTS, CRC as payers; Lancer retained commission from bind documents; brokers earn 50%, broker info excluded from buyer package; owner login only
- ⏳ Lancer bind documents — being gathered by you (needed in Phase 3)

## Phase 1 — Foundation

- ✅ Shared core: integer-cents money, basis points, half-even rounding, statement amount parser
- ✅ Policy-number and name normalization, carrier-scoped policy keys, search tokens
- ✅ Snapshot window / month math; ledger aggregation (T12, monthly, by payer, carrier, broker, line); broker 50% split
- ✅ Zod schemas shared by browser and server
- ✅ 28 automated tests passing (`npm test`); shared package type-checks
- ✅ Cloud Functions bundle with esbuild: `claimOwner`, `saveSettings`, `saveCarrier`, `saveBroker`, `saveClient`, `savePolicy`, `reassignPolicies` — server role checks, uniqueness keys in transactions, audit events
- ✅ Admin app compiles (esbuild): login with Vudu Tech branding, owner activation, idle sign-out, layout with all 12 sections, global search, dashboard, carriers/wholesalers (list, detail, 12-month grid, deactivate), brokers (list, detail, share/net, move policies), clients & policies (list, detail, add/edit, policy detail with ledger history), settings and audit log viewer
- 🟡 Firestore & Storage rules + emulator tests (`npm run test:rules`) — could not run here (no emulator)
- 🟡 Full TypeScript check of app and functions (`npm run typecheck`) — needs `npm install`
- 🟡 Production build (`npm run build`) and first Netlify / Firebase deploy
- ✅ Phase 1 signed off by you (deployed; Netlify dependency fix 152ed40)

## Phase 2 — Client import

- ✅ RFC 4180 CSV parser (quotes, embedded commas/newlines, BOM, delimiter detection); XLSX via SheetJS in the browser
- ✅ Automatic column detection for common agency-export headers; manual mapping; header-row picker for files with title rows; multi-sheet workbooks
- ✅ Value mapping: carrier/company, wholesaler and broker values matched by name, code or alias, with inline "Add carrier/broker"
- ✅ Flexible dates (MM/DD/YYYY, YY, ISO, month names, Excel serials), money, personal/commercial and status words
- ✅ Import planner: one client → many policies; Client ID matching; similar-name warnings (never merged); same policy number at different carriers; duplicates within file; conflicts with other clients; blank cells never erase data; ledger never touched
- ✅ Staged import: `stageImport` writes only the import batch; `commitImport` re-checks against current data, applies, and records before-values; `undoImport` removes/restores only records untouched since, never policies with commission history; `discardImport`
- ✅ Wizard UI (upload → columns → carriers & brokers → review with filters → commit → summary) and Import history with Undo
- ✅ 20 new automated tests incl. an end-to-end synthetic agency export (48 total); functions bundle and app compile
- 🟡 Rules test for import batches added — run `npm run test:rules`
- ✅ Excel reading switched to `exceljs` from the npm registry (no remote tarballs); .xlsx/.xlsm supported, legacy .xls asked to be re-saved as .xlsx
- 🟡 Type-check / build / deploy on your machine
- ⏳ Phase 2 sign-off by you
## Phase 3 — Statement processing ⏳
## Phase 4 — Reconciliation and ledger ⏳
## Phase 5 — Reports, valuation, lock, due-diligence package ⏳
## Phase 6 — Final hardening ⏳
