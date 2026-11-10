# Production release — Stage 3B (matching) + Stage 3C (approval and posting)

**Status:** ready for your acceptance testing in development. **Not deployed to production. Nothing merged.**

| | |
|---|---|
| PRs | **#3** Stage 3B (base `main`) → **#4** Stage 3C (stacked on #3) |
| Dev verification | `pioneer-2001-dev`, run [42744707814](https://github.com/njdeso/2001-Pioneer/actions/runs/42744707814): **48 of 48** live checks |
| CI | unit tests 134 passed / 1 skipped; rules 14 of 14; typecheck, build, guards |
| Production target | `pioneer-285cf` (functions us-central1; web app 2001-pioneer.netlify.app) |

## What changes in production
- **Functions:** 8 new: `runStatementMatching`, `setLineMatch`, `approveStatement`, `unapproveStatement`,
  `postStatement`, `reverseStatementPosting`, `recordRetainedCommission`, `reverseLedgerEntry`.
  - Two are updated: `processStatement` (resets matching on re-extraction; refuses statements with posting history)
    and `setStatementPayer` (flags matching stale). `discardStatement` now refuses approved and posted statements.
  - Everything stays in us-central1 with the same URLs.
- **Rules and indexes:** no changes in 3B or 3C. Rules tests were added only.
- **Web app:** matching, approval and posting panels; retained commission and ledger history on policies; Dashboard
  broker share from stored allocations; an optional broker-share field on the policy form; the read-only **Ledger**
  report (filters, posting history, net totals, CSV export); corrected Reports & Analytics and Reconciliation text.
- **Re-extraction guard:** `processStatement` also refuses to re-read a statement that has posting history (posted,
  even if since reversed), so the lines its ledger entries came from are never replaced.
- **Data:** **no migration.** New fields are added only when you act: `lines.match`, `statements.matching`,
  `approval` and `posting`, ledger entries and audit entries. Existing clients, policies, statements and PDFs are not
  touched by the deploy.
- **The ledger is still empty in production.** It starts filling only when you post a statement.

## Pre-flight (read-only, Cloud Shell)
```bash
git clone https://github.com/njdeso/2001-Pioneer.git pioneer-release && cd pioneer-release
git checkout feature/stage-3c-posting          # only to get the script; it changes nothing
bash scripts/prod-preflight.sh before
```
Check:
- all functions are in us-central1
- the key starts with sk-ant-
- clients 157, policies 233
- the ledger count, which should be 0
- **the snapshot window.** If it says October 2026 is OUTSIDE the window, plan to adjust Settings → Snapshot window
  after the deploy, or the October posting will not show on the Dashboard.

## Release steps (after your approval)
1. **Merge PR #3** ("Create a merge commit"), and delete its branch so #4 retargets to `main`.
2. **Merge PR #4** ("Create a merge commit"). Wait for CI on `main` and for Netlify to publish production.
3. **Deploy functions** (Cloud Shell, on `main`):
   ```bash
   git checkout main && git pull --ff-only && npm install
   cp functions/.env.pioneer-285cf.example functions/.env.pioneer-285cf   # OWNER_EMAILS = production owner email
   CONFIRM_PRODUCTION_DEPLOY=pioneer-285cf npm run deploy:prod
   ```
   - Answer **No** to any prompt that offers to delete functions or indexes.
   - New functions can take **1–3 minutes** before they accept calls ("permission denied" or 401 meanwhile).
4. **Snapshot again:** run `bash scripts/prod-preflight.sh after`. Every count must be the same, and the ledger must
   still be 0.

## First production use (October 2026)
1. **Statements → October 2026 → Run automatic matching.**
2. **Resolve every Ambiguous and Unmatched line.** Match it, or *Mark unmatched* to send it to suspense.
3. **Check the matching card.** The totals must balance, and the broker split must be what you expect.
4. **Approve for posting.** Review the totals: commission, broker, agency, suspense and adjustments.
5. **Post to ledger.**
6. **Check the Dashboard.** The October bar and the trailing-12-month total should rise by exactly the posted
   amount, and broker share should equal the posted broker total.
7. **If anything is wrong:** use *Reverse posting…* with a reason, correct, then approve and post again.

## Rollback
| What | How | Data |
|---|---|---|
| A wrong posting | Reverse it in the app (never delete ledger entries) | Reversal entries net to zero; history kept |
| Functions | `git checkout <previous main commit> && npm install && npx firebase deploy --project pioneer-285cf --only functions`. Answer **No** to deleting the new functions while postings exist. | None |
| Web app | Netlify → Deploys → previous production deploy → **Publish deploy** | None |
| Rules and indexes | Unchanged by this release | — |

## Known limitations and open decisions
See `docs/STAGE-3C-POSTING.md`, "Open decisions":
- retained-commission calculation is manual
- discrepancy statements cannot be posted
- the same admin can approve and post
- reversal is per statement
- broker statements and payments (3D) and Lancer automation (3F) are not built
