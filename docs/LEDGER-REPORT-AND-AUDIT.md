# Ledger report, CSV export and the read-only ledger audit

## One source, one calculation
Every financial figure comes from the posted entries in the `ledger` collection, through the shared functions in
`packages/shared/src/reports/ledger.ts`:

| Where | What it shows | Calculation |
|---|---|---|
| Dashboard | Trailing-12-month commission, broker share, agency net | `ledgerTotals()` over the snapshot window |
| Ledger page | Filtered transactions and postings, net totals, CSV | `filterLedger()`, `groupPostings()`, `ledgerTotals()`, `ledgerCsv()`, `postingsCsv()` |
| Dev ledger audit | Balance checks and window totals | `auditLedger()`, which uses `groupPostings()` and `ledgerTotals()` |

Rules shared by all three:
- **What counts:** an entry counts when its status is *posted* or *reversed* (`isReportable`). A reversal is a separate
  posted entry carrying the negated gross, broker and agency amounts, so a reversed posting nets to $0.00 in every
  column, and nothing is deleted.
- **Broker share:** the allocation stored on each entry when it was posted (policy %, else broker %, Unassigned 0 %).
  Agency = gross − broker.
- **Revenue month:** the statement period.

With the snapshot window selected, the Ledger page compares its totals with the Dashboard's and shows
**✓ Ties to the Dashboard**, or a red warning if they ever differ.

## Ledger page (left menu → Ledger)
The page is read-only: it never writes, and the security rules refuse any browser write to the ledger. Admin and staff
can open it.
- **Filters:**
  - statement-month range (defaults to the snapshot window)
  - carrier or wholesaler (either the payer or the underlying carrier)
  - broker
  - statement
  - posting status (posted or reversed)
  - source (statements, retained or manual)
  - free-text search (policy, insured, posting or entry ID)

  The status filter keeps each original together with its reversal, so any filtered view still nets exactly.
- **Totals:** net commission, broker share, agency net, and the number of postings posted and reversed. A partly
  reversed posting is shown in red; that should never happen.
- **Postings tab:** one row per posting, with posted, reversed and net amounts, net broker and agency, who posted and
  reversed it and when, and the reversal reason. Links go to the statement.
- **Transactions tab:** every entry, with each original followed by its reversal: policy, insured, payer, broker and
  share (policy or broker), amount, broker and agency.

## CSV export (from the Ledger page; the filtered rows)
| Export | Contents | Use |
|---|---|---|
| Transactions — accounting (internal) | Every column: entry and posting IDs, statement and line, original or reversal, period, payer and carrier, policy, insured, broker, share and source, amount, broker and agency amounts, posted at and by, reversal reason, note | Accounting review and reconciliation. Keep it internal. |
| Postings — accounting (internal) | One row per posting: original, reversal and net gross; original and net broker and agency; who and when | Tie-out per statement posting |
| Transactions — due diligence | The same rows **without** broker names, shares, broker and agency amounts, staff emails or notes | Buyer due diligence. Broker information is never shared. |
| Postings — due diligence | Per posting: original, reversal and net gross, and dates | Buyer due diligence |

- **Format:**
  - UTF-8 with BOM, so Excel opens it correctly
  - amounts as plain decimals, e.g. `-45.00`
  - text that could run as a spreadsheet formula is prefixed with `'`
- **Tie-out:** the amount column (and, internally, the broker_amount and agency_amount columns) totals exactly the
  figures on screen.

## Read-only dev ledger audit (`scripts/audit-dev-ledger.mts`)
- **What it checks against pioneer-2001-dev:**
  - Every reversal is the exact negative of its original in gross, broker and agency. Each reversal is in the same
    month and posting, and the original is marked reversed and points back to it.
  - Every reversed posting nets to zero in all three amounts, and none is partly reversed.
  - On every entry, broker + agency = gross, in whole cents.
  - Each statement's status, posted amount, current posting and recorded reversals agree with the ledger. A posted
    statement has exactly one active posting, for its posted amount.
  - The snapshot-window total from `ledgerTotals()` equals the aggregate behind the Dashboard charts.
- **How it is kept read-only:**
  - It reads `ledger`, `statements` (top-level fields), `brokers`, `policies` and `settings/app` through a reader that
    only calls `get()`.
  - CI (`scripts/audit-dev-ledger.test.mjs`) fails if the script contains any write, batch, transaction, Storage, Auth,
    seeding or command-running call.
  - CI also runs it against a stub database that throws on any write.
- **Refusals:** it refuses anything but pioneer-2001-dev. It checks the `.firebaserc` alias and project ID, and the
  project number Google reports for the credentials. Production (`pioneer-285cf`, `prod`) is refused, and CI tests that.
- **Output:**
  - a Markdown summary: counts, totals, one row per posting with gross / broker / agency for original, reversal and
    net, and findings
  - `ledger-audit.json`
  - the accounting CSVs of the dev ledger, which have **no email addresses**, because workflow artifacts of this
    public repository can be downloaded
- **Exit code:** 1 if any error-level finding exists.

### When it runs (`.github/workflows/deploy-dev.yml`)
1. **Every dev run, first:** after authenticating and confirming the project number, and **before** any deploy, seed or
   smoke test, it audits the **existing** ledger. If it fails, the run stops there and nothing in dev changes.
2. **After the smoke test:** it runs again, so you can see the run left every posting balanced.
3. **Audit only:** Actions → *Deploy to dev (pioneer-2001-dev)* → **Run workflow** → branch `deploy/dev`, mode
   **audit-only**. You can optionally enter posting or statement IDs (prefixes) under *focus*. The run reads only.
   Pushing a commit whose message contains `[audit-only]` to `deploy/dev` does the same for the Firebase side;
   Netlify still rebuilds the dev web app from that commit.

The audit and artifacts are in the run's **Summary** page.

## Append-only outside the disposable emulator
- The **smoke test never deletes:**
  - Each run posts to a new `SYN3B-AUTO-<timestamp>` statement and reverses what it posts.
  - Earlier statements, postings, reversals and manual tests on them are kept.
  - Each run adds about 42 ledger entries, all netting to zero.
- **`writeStatement`** (synthetic helper) refuses to replace a statement that was approved, posted or reversed, or that
  any ledger entry refers to.
- **`processStatement`** refuses to re-read a statement with posting history. Its extracted lines are the source of
  ledger entries. To read the file again, discard the statement and upload it as a new statement.
- **Cloud Functions** write the ledger only with `create()` (originals and reversal twins) and mark originals reversed
  with `update()`. Nothing deletes ledger or audit-log documents; CI checks this in
  `scripts/ledger-append-only.test.mjs`.
- Deleting is allowed only in the Firebase **emulator** used by the rules tests, which is discarded after each run.
