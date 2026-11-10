# Stage 3C — Statement approval and commission posting

Approved statements are posted to the **ledger**. The ledger is the only source of every financial report: Dashboard,
Carriers, Brokers and Clients/Policies. Posting is the **only** way commission enters the ledger. Clients, policies,
extracted lines and source PDFs are never changed.

## Workflow (Statements → open a statement)

1. **Extract and reconcile** (Stage 3A). Only *Reconciled — review* statements can be posted. A *Discrepancy*
   statement cannot.
2. **Match** (Stage 3B). Every commission line must end up in one of two states:
   - **Matched** to a policy, automatically or manually.
   - **Marked unmatched by a person.** It is then posted to *suspense*: no policy, 100% agency.

   *Ambiguous* lines, lines never matched, and lines left *Unmatched* only by the automatic run all block approval.
3. **Approve** (admin). The server re-checks readiness and builds the exact posting plan. It stores the plan's
   fingerprint, totals and warnings, plus who approved and any note.
   - Matching, carrier, re-extraction and discard are locked while approved.
   - A possible duplicate (same carrier and month as another statement) needs the explicit confirmation "this is a
     separate statement".
   - *Return to review* (reason required) withdraws the approval.
4. **Post** (admin). It creates every ledger entry in **one transaction**, so it either posts completely or not at
   all.
   - Each entry has a fixed ID, `<statement>__p<posting#>__<line>`, and is created with "create, fail if exists".
     The same line can never be posted twice, even with two clicks at once. This was tested with concurrent calls:
     exactly one succeeded.
   - Posting is refused if the plan no longer matches the fingerprint taken at approval.
5. **Reverse** (admin, reason required) if something was wrong.
   - Every posted entry gets an exact negative twin (`…__rev`: amount, broker and agency negated, same month), and
     the original is marked *reversed*. Nothing is deleted, and the reports net to zero.
   - The statement returns to review, can be corrected, and is posted again as posting #2 with new entry IDs.
   - Reversing twice is refused.

## What gets posted
| Statement item | Ledger entry | Broker / agency |
|---|---|---|
| Matched commission line | `level: policy`, with client, policy and carrier | Broker share captured in the match: the **policy's own broker %** if set, otherwise the **broker's %**. *Unassigned* = 0%. |
| Line marked unmatched by a person | `level: suspense`, no policy | 0 / 100% agency |
| Statement adjustment (fee, shared cost, bonus) | `level: carrier`, no policy | 0 / 100% agency |
| Payment-only line (no paid commission) | not posted | — |

- **Amounts:**
  - integer cents throughout
  - broker = amount × share, rounded once, half-even; agency = amount − broker
  - every entry has broker + agency = amount
  - plan total = statement commission + adjustments = the statement's month payable
- **Negative commissions and chargebacks** post as negative entries, and both shares go down.
- **Revenue month** = the statement month (the decided basis, statement period).
- **Classification:**

  | Transaction type | Classification |
  |---|---|
  | new business | new business |
  | continuation | renewal |
  | endorsement | endorsement |
  | cancellation | cancellation |
  | reinstatement | reinstatement |
  | reversal | chargeback |
  | installment / other | other adjustment |
  | positive adjustment | bonus |
  | negative adjustment | other adjustment |

## Retained commission (Clients → policy → Record retained commission)
- **What it is for:** commission the agency kept out of premium, such as Lancer, per the bind document.
- **What you enter:** the month, the amount (negative for a return), the type and a note. It is posted at once as
  `sourceType: retained`, split by the policy's applicable broker share.
- **Duplicate protection:** each form has its own request ID, so a double click or retry can never post twice.
- **Reversal:** *Reverse…* on the entry, with a reason.
- **Not automated:** calculating retained commission from bind documents, or proportional down-payment rules, needs
  your rules. See "Open decisions".

## Reports
- **Ledger** (left menu): every posted transaction and reversal, read-only, with filters, posting history, net
  gross / broker / agency totals and CSV export for accounting and due diligence. See `docs/LEDGER-REPORT-AND-AUDIT.md`.
  Reports & Analytics (formatted PDF/Excel reports) is still a later phase; its page now points to the Dashboard and
  the Ledger.
- **One calculation:** the Dashboard's trailing-12-month commission, broker share and agency net, the Ledger report
  and the dev ledger audit all use `ledgerTotals()` in `packages/shared/src/reports/ledger.ts` over the same posted
  entries. With the snapshot window selected, the Ledger page shows a tie-out line confirming it equals the Dashboard.
- **Dashboard, Carriers, Brokers and the policy history** read posted ledger entries in the **snapshot window**
  (Settings). Posted and reversed entries both count, and a reversal is its own negative entry, so the reports always
  tie to the ledger.
- **Broker share and agency net** on the Dashboard are now the **sum of the allocations stored on each entry**, with
  policy-specific percentages, chargebacks and reversals included. Previously they were each broker's standard % of
  the gross. "By broker" still groups by each policy's current broker, which is the decided snapshot attribution.
- **Outside the window:** a posting outside the snapshot window is in the ledger but not on the Dashboard until the
  window includes that month.

## Authorization and audit
- **Who can do what:**
  - *Approve, return to review, post, reverse, and record or reverse retained commission:* **admin only**, checked on
    the server.
  - *View:* staff.
  - *The browser:* cannot write the ledger or statement status at all (Firestore rules, rules-tested).
- **Audit log:** every action writes an entry:
  - `statement_approve`
  - `statement_unapprove`
  - `statement_post` (totals)
  - `statement_reverse` (reason, totals)
  - `retained_record`
  - `ledger_reverse`
- **Ledger entries record:** who approved and who posted, plus the reversal reason and who reversed.

## Code
| File | Purpose |
|---|---|
| `packages/shared/src/statements/posting.ts` | Readiness, posting plan, fingerprint, reversal, retained entry, stored broker share (pure) |
| `packages/shared/test/statements-posting.test.ts` | 14 tests |
| `functions/src/callables/posting.ts` | `approveStatement`, `unapproveStatement`, `postStatement`, `reverseStatementPosting`, `recordRetainedCommission`, `reverseLedgerEntry` |
| `apps/admin/src/pages/StatementPosting.tsx` | Approval & posting panel |
| `apps/admin/src/pages/Clients.tsx` | Retained commission; ledger history with broker/agency and reversal |
| `apps/admin/src/data.tsx` | Broker share from stored allocations |
| `scripts/smoke-dev.mjs` | Live end-to-end test: matching → approval → posting → report → reversal → re-post → retained |

## Open decisions (not built, by design)
1. **Retained commission calculation.** It is entered manually. Automatic calculation, including the proportional
   down-payment rule for carriers paying on down payment plus 9 installments, needs the exact rule and the bind
   document format.
2. **Discrepancy statements.** They cannot be posted. Correcting or overriding a statement that does not reconcile
   (Stage 3E) needs a rule for who may accept a difference, and how.
3. **Separation of duties.** One admin can both approve and post. A "different person must post" setting is possible
   if you want it.
4. **Single-line reversal.** Corrections are made by reversing the statement and posting it again. Line-level
   reversal is possible later.
5. **Broker statements and payments** (Stage 3D) and **Lancer** (Stage 3F) are not built yet.
