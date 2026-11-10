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
- ✅ Production dependency audit remediated (zod 4.6.6+, grpc-js and uuid overrides) — see docs/SECURITY-AUDIT.md
- 🟡 Type-check / build / deploy on your machine
- ✅ Phase 2 signed off by you (deployed to pioneer-285cf; Excel import, duplicates and undo verified)
## Phase 3 — Commission statements (plan approved; stages 3A–3F)

Decisions: match on carrier + normalized policy number (stored numbers untouched; multiple candidates → manual review);
separate `pioneer-2001-dev` project; broker statement month = carrier statement month; two-step payment approval;
one PR per stage; per-policy broker % (default broker %); payment-only rows kept as reference; Lancer = Stage 3F.

### Stage 3A — Upload, extraction, reconciliation (PR open, branch `feature/phase-3a-statement-extraction`)
- ✅ Upload registration with SHA-256 fingerprint; duplicate files rejected; one-time upload path; Storage rules (admin-only create, PDF/XLSX/CSV ≤ 20 MB, no reads/overwrites)
- ✅ Server re-verifies size, fingerprint and file type; preserves the original at `statements/{id}/original.*` (never overwritten)
- ✅ Deterministic Travelers PL parser; reconciles exactly to $3,631.14 on the real statement (local test) and on the anonymized fixture
- ✅ Exact-to-the-cent reconciliation: paid commission, month payable (with adjustments), payment received, premiums, fees; per-line rate and sign checks
- ✅ Payment-only rows, negative adjustments, multiple rows per policy and identical installment rows handled
- ✅ Claude fallback (PDF and spreadsheets): native structured output (JSON schema; tool with auto choice as fallback; never a forced tool, which Sonnet 5.5 rejects) + strict validation, amounts as printed, retries/backoff, timeouts, malformed-output handling, monthly limit; key in Secret Manager only
- ✅ Carrier resolution by agency code / name; same carrier+agency+month detection; manual carrier choice; discard with reason
- ✅ Review screen, processing queue, upload page, DEV banner, AI settings, carrier agency codes
- ✅ pioneer-2001-dev configuration (aliases, guarded scripts, env examples, seed) — instructions only, nothing created
- 🟡 Run `npm test`, `npm run test:rules`, `npm run typecheck`, `npm run build` in Cloud Shell; manual test in pioneer-2001-dev (docs/STAGE-3A-TESTING.md)
- ⏳ Stage 3A review and approval

### Stage 3A ✅ deployed to production (October 2026 extracted and reconciled)

### Stage 3B — Commission matching (PR open, branch `feature/stage-3b-commission-matching`) — docs/STAGE-3B-MATCHING.md
- ✅ Automatic matching: normalized policy number within the statement's carrier or wholesaler; name as supporting evidence only; alternate numbers
- ✅ Excel scientific notation expanded only when every digit is present; leading-zero loss needs an agreeing name; no digits ever guessed
- ✅ Matched / ambiguous / unmatched with reasons and up to 5 candidates; manual matches kept on re-run
- ✅ Manual assign / unmatch / return to automatic, with client and policy search, split preview and audit before/after
- ✅ Broker vs agency commission in integer cents (half-even, sums exact); negatives and chargebacks; adjustments agency-only; per-policy broker share (default: broker's share)
- ✅ Review screen: progress, totals with balance check, per-broker table, match and broker filters, search on matched records
- ✅ Writes only line match, statement summary and audit log; no clients/policies/ledger writes; posted statements locked; rules test
- ✅ Live test in pioneer-2001-dev: all matching checks pass (run 42744707814)
- ⏳ Stage 3B review and approval (PR #3)

### Stage 3C — Approval and posting (PR #4, branch `feature/stage-3c-posting`) — docs/STAGE-3C-POSTING.md
- ✅ Readiness: reconciled, payer, month, matching current/balanced, no ambiguous/unreviewed lines, duplicate acknowledged
- ✅ Approve (fingerprint) → post in one transaction with deterministic entry IDs; concurrent/double posting refused
- ✅ Allocations stored per entry: policy-specific or broker %, chargebacks, suspense (100 % agency), adjustments (carrier-level)
- ✅ Reversal with reason: exact negative twins, originals marked reversed, statement back in review, re-post as posting #2
- ✅ Retained commission (manual, idempotent, policy split) with reversal
- ✅ Admin-only on the server; staff refused; browser cannot write ledger/statement status (rules test)
- ✅ Rolling-12-month reports from the ledger; Dashboard broker share from stored allocations
- ✅ Live test in pioneer-2001-dev: 48 of 48 checks (matching + posting end to end)
- ⏳ Stage 3C review and approval (PR #4); production checklist docs/RELEASE-3B-3C.md

### Stages 3D–3F ⏳ (broker statements & payments · corrections & revisions · Lancer)

## Phase 4 — Reports, valuation, lock, due-diligence package ⏳
## Phase 5 — Final hardening ⏳
