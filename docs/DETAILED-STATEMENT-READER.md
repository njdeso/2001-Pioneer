# DetailedStatement Excel reader (PR #9)

The carrier **DetailedStatement** export is an Excel workbook with a **Detailed** sheet (one row per
transaction) and a **Summary** sheet (totals). It is read by a deterministic reader,
`packages/shared/src/statements/detailedStatement.ts` (method `detailed-statement-v1`). No AI is used
for this layout, even when someone chooses "read again with AI". Other layouts still go to the AI
reader.

## How the workbook is recognized

The reader goes by the workbook's sheets and column headers. It never looks at the file name.

- A sheet has a **Gross Comm** or a **Net Due Agent** header, and the workbook has a **Summary**
  sheet.
- These columns must be present, and each must match exactly one header:
  - Gross Comm
  - Net Due Agent
  - Month End
  - Policy number
- If a required column or the Summary sheet is missing, or two columns match the same role, the
  file is refused with a message listing the headers. It is not passed to the AI.
- These columns are optional: Insured, Trans Type, Eff Date, Premium, Company, Agency and MVR.
- The plain **Comm** column is never used as commission, because the carrier does not define what it
  means.

## Accounting: Option B, the agency absorbs MVR charges

The owner confirmed this business rule.

| Source | Recorded as |
|---|---|
| Each transaction row | One statement line. Its paid commission is **Gross Comm**. Broker splits are worked out from it. |
| Net Due Agent below Gross Comm on a row, identified as MVR (MVR column, or "MVR" on the row) | **One** statement adjustment for the difference. It is carrier level and 100 % agency: broker 0, no policy. |
| A row that is only an MVR charge (no Gross Comm) | Only that adjustment. No policy line is created. |
| **The carrier's actual export:** a row with Gross Comm 0.00, a negative Net Due Agent and no "MVR" on it, plus a Summary **MVRChargeback** total | Treated as the MVR charge **only if** it is the only unexplained deduction on the sheet, has no commission, and equals the Summary MVR amount not already covered by rows labelled MVR. It then becomes one agency-only adjustment, with no policy line. |
| A carrier total or subtotal row | Checked against the rows above it. Not counted again. |

These rules always hold:

- The policy line affected by an MVR charge keeps its full gross commission.
- The MVR charge is never posted as a negative policy commission.
- The MVR charge never reduces the broker's commission.
- The broker buyout engine never reads the ledger or statements (a test checks this), so MVR charges
  cannot affect buyouts.

## Reconciliation

All amounts are integer cents and must match exactly. If any check fails, the statement is stored
as a **discrepancy**, and approval and posting are blocked.

1. Σ Gross Comm = Summary **Commissions - Current**
2. Σ Gross Comm + MVR adjustments = Summary **Net Amount Due Agent**
3. Σ Net Due Agent column = Summary Net Amount Due Agent. This catches a charge counted twice.
4. Every data row is used exactly once: as a line, as an MVR-only adjustment, or as a verified total
   row.
5. Each MVR charge is recorded once. If the Summary prints an MVR total, it must match.

The reader rejects the following rather than guessing. Totals that reconcile are never evidence on their own:

- two or more unexplained deductions, which produce one statement-level "manual review" message with each row flagged
- an unlabelled deduction that differs from the Summary MVR amount
- an unlabelled deduction on a row that has commission
- an unlabelled deduction when the Summary prints no MVR total

- a Net/Gross difference that is not identified as MVR
- a positive MVR amount (a refund or reversal)
- "MVR" on a row whose Net Due Agent equals Gross Comm
- mixed or invalid Month End values
- an unreadable amount
- a missing or contradictory Summary total

Exact duplicate rows are all kept and flagged as a warning.

Other notes:

- Dates: 01/01/0001 means "no date". An invalid date is a warning only, because dates do not affect
  money.
- Policy numbers are kept as text, so leading zeros are preserved.
- Month End 202511 becomes 2025-11.
- Row numbers in messages and adjustment labels count the sheet's non-blank rows, with the header as
  row 1.

## Read-only check of the real workbook (Cloud Shell)

Run these in the repository folder on the PR #9 branch. They make no Firebase, network or AI calls
and write nothing. Insured names and policy numbers are not printed.

```
git fetch origin
```

```
git checkout fix/xlsx-statement-import
```

```
git pull --ff-only
```

```
npm install --no-audit --no-fund
```

```
npx tsx scripts/inspect-statement-xlsx.mts ~/DetailedStatement20261110.xlsx
```

The report:

- **Check 8a**: which column was used for each role.
- **Check 8b**: what happened to every row.
- **Check 8c**: totals and MVR charges.
- **Check 8d**: the reconciliation results, with errors grouped as one line per distinct problem. Checks that fail only because of a row problem are marked "consequence" and are not counted as separate problems.
- **Check 8e**: a simulated broker/agency split using a made-up 50 % share.
