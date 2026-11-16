# Statement discrepancy investigation — November 2026

Four statements flagged by the Sales Manager (Main Street America, two months; a Safeco / Liberty Mutual
statement; a Utica National direct-bill statement) were re-checked page by page against the original scans.
All four are image scans read by the AI path (`statements/ai.ts`) and, for Utica, the Utica reading rules
(`statements/uticaDirectBill.ts`). Statement figures are kept out of this public repository; the regression
tests and the dev smoke test use synthetic data with the same structure.

## Findings

| Statement | Cause | Kind |
|---|---|---|
| Main Street America (one month) — "carrier total not found" | The statement prints a "Month Total" per writing company and one final "Net Commission". The app required a separately printed commission-column total. | **App error — fixed.** Reconciles exactly to the printed Net Commission; negative company subtotals included. |
| Main Street America (other month) — "carrier total not found" | Same app error — fixed. Every company subtotal then matches its rows, but the printed Net Commission is higher than all printed company subtotals together. | App error (fixed) **and** an amount not itemized anywhere in the document (possibly a missing writing-company page). Carrier to confirm. |
| Safeco / Liberty Mutual — extracted total below the carrier total | Every printed row was extracted and both product subtotals match their rows. The printed "Total Compensation" is higher than the printed product sections together. | **Carrier / document:** an amount not itemized in the file (a product detail page appears missing). Carrier to confirm. |
| Utica National — extracted total above the carrier total; a row named "outside Utica's totals" | A group-printed return-premium endorsement row (gross with a trailing minus, commission charged back, net with a trailing minus) was read with the minus moved from the gross onto the commission. The "row outside the carrier's totals" rule then named another row whose figures happen to equal the resulting difference. Utica's own company breakdown confirms the printed reading; read as printed, the rows add up exactly to Utica's total. | **App error — fixed.** Not a Utica discrepancy. |

## Changes

1. **Multi-section statements** (`ai.ts`, `reconcile.ts`, `types.ts`; prompt `statement-extract-v3`)
   - The AI records every printed section subtotal (`sections`) and tags each row with its section; it is told
     where the final total is (e.g. "Net Commission", "Total Compensation"), that it may be on the last page,
     never to copy one section's subtotal as the statement total, and that a trailing minus belongs only to
     the amount it follows.
   - An AI-read statement that prints only a final figure is reconciled by that printed figure (lines +
     adjustments = final total, exactly). Deterministic readers keep their rule (a missing column total blocks).
     A statement with no printed total at all is still blocked.
   - Each printed section subtotal is checked exactly against its rows (negative subtotals included). A row
     with no printed section is a line error; duplicate section labels skip section checks rather than guess.
   - When every section subtotal matches but the final total does not, a finding says the difference is not
     in any printed section (missing page or un-itemized carrier amount) — separating carrier/document
     differences from reading errors. Nothing is added, removed or balanced; carrier totals are never changed.
2. **Utica reading rules** (`uticaDirectBill.ts`)
   - Rule 6: a row whose gross and commission were read with reversed signs is corrected only when its own
     arithmetic holds reversed, the printed rate confirms it, and the gross, commission and net columns all
     then equal Utica's printed totals (all three must be printed). Both corrected figures go to the
     append-only audit log (value read, value used, reason, arithmetic). Otherwise nothing changes and the row
     is named with both readings.
   - Rule 3 ("row outside the carrier's totals") is no longer concluded when a reversed-sign reading of another
     row explains the same difference; both rows are named and the statement stays blocked.
   - Printed section subtotals are reversed into the agency's sign with every other commission figure (only
     after the sign convention is verified); a moved MVR/CLUE row is taken out of its section's subtotal.

## Verification

- Unit tests: `packages/shared/test/statements-sections.test.ts` (synthetic), `utica-direct-bill.test.ts`.
- Dev smoke test (`scripts/smoke-dev.mjs`, "Carrier layouts"): four synthetic statements in these layouts go
  through the real upload → AI → reconcile pipeline; the two with un-itemized amounts must refuse approval
  and posting with nothing in the ledger.
