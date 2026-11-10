# Due-diligence exports for the buyer (Pioneer Bank)

Left menu → **Due Diligence Package**. The page is read-only. It offers two CSV files that open directly in Excel, plus
the transaction detail on the Ledger page.

| File | Contents |
|---|---|
| **Commission summary** | Status and reconciliation checks; period totals by category; monthly totals; totals by paying carrier or wholesaler (with months that have posted statements); carrier × month grid; totals by underlying insurance carrier; carriers with gaps |
| **Clients & policies** | One row per policy: insured, client type and status, named insured, carrier, wholesaler, line, policy type, policy number and alternates, effective and expiration dates, status, annual premium, agency commission rate, posted commission in the period. Plus one row per client without policies. |
| Ledger → *Transactions — due diligence* | Every posted transaction and reversal, without broker information |

## Categories (commission summary)
| Category | Ledger entries |
|---|---|
| Commission (matched to policies) | Statement lines matched to a policy |
| Commission not matched to a policy | Statement lines a person marked unmatched (suspense) |
| Statement adjustments | Carrier-level statement adjustments |
| Retained commission | Commission kept out of premium (e.g. Lancer), recorded per policy |
| Manual entries | Manual ledger entries (none are created today) |

Reversals are their own negative entries in the same category, so a reversed posting contributes $0.00.

## Never presented as complete unless it is
The status is computed every time and printed at the top of the file:

| Status | When |
|---|---|
| **NOT FOR DISTRIBUTION — reconciliation checks failed** | Any check below fails. The download is disabled. |
| **PRELIMINARY — INCOMPLETE** | Some month of the period has no posted statement (a reversed posting does not count), or a statement for the period is uploaded but not yet posted. The file says the totals are **not** a complete 12-month history and names the missing months. |
| **PRELIMINARY — REVIEW CARRIER GAPS** | Every month has posted statements, but a statement-paying carrier with active policies has months with nothing posted. Confirm those are genuinely zero. |
| **Prepared from the posted ledger — subject to review** | Every month and every statement-paying carrier with active policies has postings, and every check passed |

There is also a notice if retained-commission carriers (Lancer) have no retained commission recorded.

## Reconciliation checks
**Commission summary:**
- whole cents
- months, carriers, the carrier × month grid and the categories each add up to the period total
- the period total equals the Dashboard's trailing-12-month commission (the same calculation)
- the ledger is balanced, with every reversal exactly offsetting its original
- every policy-level commission belongs to a policy in the client export

**Clients & policies:**
- every policy and every client record is exported
- every policy has a client
- the `t12_commission` column totals the policy-level commission in the summary

## What is never included
- broker names or IDs
- broker shares or broker/agency splits
- staff emails
- notes
- audit fields
- client contact details (phone, email, street address)

Unit tests check this, and so does the read-only dev audit against the live dev data, which reports any broker ID,
broker name or email address found in either file.

## Before sending to Pioneer
- Send it only under your confidentiality / NDA terms: insured names and policy numbers are customer information.
- If the status is not *Prepared from the posted ledger*, call it a preliminary extract and give the missing months.
