# Scanned / rotated statements and statements without a carrier name

Status: code and tests only. **Not deployed.** Production (`pioneer-285cf`) data and settings were not touched.

## The problem

`SMIC Nov 26.pdf` (Security Mutual Ins Co) failed with *"Claude's answer did not match the required format
(carrierName: Too small)"*. The statement is a landscape page scanned sideways: policy transactions on page 1,
monthly and year-to-date totals on page 2, and no legible carrier name. The AI reader required a non-empty
`carrierName`, so the whole answer was rejected.

## What changed

| Area | Change |
|---|---|
| Carrier name | The AI reader accepts a blank `carrierName` (the DetailedStatement reader already could). It is told never to infer one. A blank name adds the warning `no_carrier_name`. |
| Carrier suggestion | `suggestPayerFromFileName` (shared): when no name is printed and no agency code matched, a carrier is **suggested** only if a whole word or phrase of the file name equals one set-up, active carrier's name, code or alias. Several matches → no suggestion. Stored as `payerSuggestion`; `payerId` stays empty until someone clicks **Confirm** on the review screen (or chooses another carrier). The confirmation is recorded in `payerNote` and the audit log (`set_payer`). Nothing is created. |
| Scanned / rotated PDFs | `pdfToTextLines` reports each page's `/Rotate` and orientation. For an image-only or rotated/landscape PDF, a short note built only from that geometry is sent with the document so the reader turns pages upright. The PDF is sent and stored exactly as uploaded. |
| Summary totals | Prompt v4: month / year-to-date summary figures go in `totals` only, never in `lines`; YTD is never the statement total. Guard in `aiToStatement`: a row with **no digit in its policy number** that is labelled as a total (Total, YTD, Year to Date, MTD, Summary, Balance forward…) is kept out of the lines and listed as a `summary_row_excluded` warning with its printed figures. Reconciliation is unchanged, so a statement still only reconciles if its real transactions add up exactly to the printed total. |

Unchanged: original-file storage, the Travelers and DetailedStatement readers, Utica direct-bill rules, payer
matching for statements that print a name or a known agency code, reconciliation, matching and posting.

## Tests

`packages/shared/test/statements-smic.test.ts` (synthetic figures in the SMIC layout): blank carrier name,
page-1 transactions reconciling to the month total, summary rows excluded, YTD-as-total refused, no total → blocked,
file-name suggestion (alias, code, full name, separators) and every "uncertain → no guess" case, the layout note,
and a real image-only rotated PDF built with pdf-lib.

## After deploy (with approval)

Retry `SMIC Nov 26.pdf` with **Retry with AI**. Expect `needs_review` or `discrepancy`, the carrier card showing
*Suggested: Security Mutual Ins Co*, and no lines for the page-2 totals. Check the lines against **View original**
before confirming the carrier and approving.
