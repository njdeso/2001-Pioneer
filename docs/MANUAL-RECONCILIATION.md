# Manual reconciliation

Status: code and tests only. **Not deployed.** Production (`pioneer-285cf`) data and settings were not touched.

Use it for statements that automatic reading fails on or reads wrongly (scanned, sideways, unusual layouts):
you key or correct the lines and the printed totals yourself, with the original open beside them. New carriers'
unreadable statements become manageable without software changes.

## Where

Statement page (Statements → open a statement) → **Manual reconciliation** card. It is shown for statements in
*Processing failed*, *Discrepancy* or *Reconciled — review* whose original file is stored, and hidden once anything
from the statement was approved or posted.

| Button | Starts from |
|---|---|
| **Enter from the original** | A blank sheet (carrier and month pre-filled if known) |
| **Correct the extracted lines** | The lines the reader extracted, to fix them |
| **Resume saved work** | Your last saved draft |

The original opens automatically above the editor (**View original** if closed).

## What you can enter
- **Carrier or wholesaler:** existing ones only. Manual reconciliation never creates a carrier.
- **Statement fields:** month, date and agency code.
- **Printed totals, typed exactly as printed:** the commission total and/or month payable. Year-to-date is reference only and is never used as the total.
- **Adjustments:** agency-only adjustments, e.g. MVR charges.
- **Lines:** insured, policy number as printed, effective date, transaction type, commission or payment-only, premium, rate, paid commission, payment received, page and a note. You can add, edit and remove lines.
- **CSV import:** the **CSV template** link gives the columns. Import is all-or-nothing: a file with any bad row, or an unknown column, imports nothing. Imported lines only fill the editor.
- **Reason:** required to apply. It is kept in the audit log.

## What happens

| Action | Effect |
|---|---|
| **Save and continue later** | Stores the draft on the statement (`manualDraft`). Lines are unchanged. Audit: `manual_draft_saved`. |
| **Apply manual lines** | Replaces the statement's *unposted* lines with yours, then runs the same code as an AI read: exact-to-the-cent reconciliation, duplicate check, carrier set, matching reset. Method shows *Manual reconciliation*, with a banner naming who did it and why. Audit: `manual_reconcile`, with the reason and a line-by-line list of what changed. |

After applying, the statement continues through the normal steps: Run matching → Approve → Post. Nothing is balanced
for you: if your lines do not add up to the totals you typed, the statement stays in *Discrepancy* and cannot be approved.

## Safety rules (enforced on the server)
- **Posted records are never changed.** The feature is refused when a statement is approved or posted, has posted cents, or has any posting history (including reversals). This is the same rule as a re-read.
- **Original files are never changed.** Applying is refused if the original was never stored, because every keyed figure must be checkable against it.
- **No broker data can be entered.** The draft is a closed list of fields; anything else, such as broker IDs or shares, is refused. Broker splits come only from matching, as for any statement. Pioneer and diligence reviewers see statements only through their field-by-field allowlisted views, which do not include the draft or the manual details.
- **Same deployment footprint.** Manual reconciliation runs inside the existing `processStatement` function (`method: "manual"`), so no new Cloud Function, permission or IAM change is needed. Rules and indexes are unchanged.

## SMIC Nov 26.pdf
1. After the deploy, try **Retry with AI** first. PR #26 fixed the reading of this layout.
2. If that fails or reads it wrongly, open **Manual reconciliation** → **Enter from the original** (or **Correct the extracted lines**).
3. Choose *Security Mutual Ins Co*. Key the page-1 transactions, and type the page-2 month total as printed.
4. Apply, check the reconciliation shows *Exact*, then run matching, approve and post as usual.
