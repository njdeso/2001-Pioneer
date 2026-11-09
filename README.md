# Agency Sale Manager

**Developed by Vudu Tech.** A standalone, confidential web app that builds an accurate,
auditable **trailing 12-month commission snapshot** of an insurance agency for a sale:
client list → commission statements (AI-read) → policy matching → reconciliation to the
cent → reports, valuation and a due-diligence package for the buyer.

Independent of Broker Desk: separate repository, Firebase project, Netlify site and logins.

## Status

Phase 3, Stage 3A (statement upload, extraction, reconciliation) — see [docs/CHECKLIST.md](docs/CHECKLIST.md).
Development happens in `pioneer-2001-dev`: [docs/DEV-ENVIRONMENT.md](docs/DEV-ENVIRONMENT.md).

## Stack

| Layer | Choice |
|---|---|
| Web app | React 19 + TypeScript + Vite + Tailwind CSS 4 (`apps/admin`) |
| Hosting | Netlify (static site only) |
| Auth | Firebase Authentication + role custom claims |
| Database | Cloud Firestore (deny-by-default rules; browser is read-only) |
| Files | Cloud Storage (closed to the browser) |
| Backend | Firebase Cloud Functions 2nd gen, Node 22 (`functions`) |
| Shared core | `packages/shared` — integer-cents money, normalization, periods, schemas, ledger math |
| AI (Phase 3) | Anthropic Claude API, server-side only, key in Secret Manager |

## Repository layout

```
apps/admin/          React admin app
functions/           Cloud Functions (all writes go through here)
packages/shared/     money, schemas, normalization, periods, ledger aggregation (+ tests)
firebase/            firestore.rules, storage.rules, firestore.indexes.json
tests/rules/         security rules tests (Firestore emulator)
docs/                setup, deployment, testing, backup & recovery, checklist
```

## Quick start

```bash
npm install
npm test                 # financial core tests
npm run test:rules       # security rules tests (needs Java for the emulator)
npm run typecheck
npm run dev              # app at http://localhost:5173
```

Full instructions: [docs/SETUP.md](docs/SETUP.md).

## Money rules

All amounts are signed **integer cents**; rates are integer **basis points** (15% = 1500).
Statement text is parsed with a strict decimal parser — never `parseFloat`. Totals are integer
sums; percentage math rounds once, half-even. Reports are computed from the posted ledger.

## Data handling

- No customer data, statements or exports are ever committed (see `.gitignore`).
- Application logs carry record IDs only — never names, policy numbers or amounts.
- The browser cannot write to Firestore or Storage; Cloud Functions check the caller's role
  on the server and record every change in the audit log.
