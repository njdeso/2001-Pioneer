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
- ⏳ Phase 1 sign-off by you

## Phase 2 — Client import ⏳
## Phase 3 — Statement processing ⏳
## Phase 4 — Reconciliation and ledger ⏳
## Phase 5 — Reports, valuation, lock, due-diligence package ⏳
## Phase 6 — Final hardening ⏳
