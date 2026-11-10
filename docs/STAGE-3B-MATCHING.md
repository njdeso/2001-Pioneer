# Stage 3B — Commission matching

Connects each extracted statement line to a client, policy, carrier and broker, and shows the broker and agency share of
the commission. **Nothing is posted** (posting is Stage 3C), and **no client, policy, carrier, broker or commission
record is created or changed**.

## How a line is matched (automatic)

Matching runs from the statement's review screen ("Run automatic matching"). It needs the statement's carrier, the
*payer*, which is either the carrier or the wholesaler that paid.

1. **Policy number, normalized.** Spaces, dashes, slashes and case are ignored: `AB-123 456` = `AB123456`. Each
   policy's *alternate numbers* are checked too.
2. **Only the payer's policies.** A number matches a policy whose carrier is the payer, or whose wholesaler is the payer
   (for J&J, Jimcor, RTS and CRC statements). The same number under another carrier is never matched
   automatically; the line becomes *Ambiguous*, with the other carrier's policy shown as a suggestion.
3. **The insured name is supporting evidence only.** Comparisons ignore word order, punctuation, legal suffixes and DBA
   names, so "SMITH JOHN" = "John Smith".
   - **Name agrees:** *Matched*, high confidence.
   - **Name partly agrees, or none printed:** *Matched — check*, medium confidence.
   - **Name clearly differs:** *Ambiguous*, needs your confirmation.
   - **Name alone:** never creates a match. It only produces suggestions.
4. **Excel damage.**
   - `617738486.0` → `617738486`.
   - `6.17738486E+08` is expanded only because every digit is present.
   - `6.17738E+08` or `6E+08` have lost digits. The line stays *Unmatched* with the reason shown. Digits are never
     padded or guessed.
   - Leading zeros lost by Excel (`45678` vs `0045678`) match only together with an agreeing name. Otherwise the line is
     *Ambiguous*.
5. **Several policies of the payer share the number:** the line is matched only if exactly one of them has an agreeing
   name. Otherwise it is *Ambiguous*.

Every line records its reasons, its candidates (up to 5) and the policy-number key that was used. A manual match is
never overwritten by re-running automatic matching unless you choose "Re-run including manual".

## Manual matching

**Match… / Review** on a line opens a dialog:
- **Left side:** the line exactly as extracted. It is read-only, and the source PDF and extraction are never changed.
- **Suggestions:** each one shows its number and name evidence, and whether it is under another carrier.
- **Search:** across all clients and policies, by policy number, client or insured name, or client ID. It is limited
  to the statement's carrier by default, or covers all carriers.
- **Preview:** the broker, the broker's percentage, and the broker and agency cents before saving.
- **Actions:** match to the selected policy, mark unmatched, or return the line to automatic matching. An optional
  note is kept in the audit log.

A manual match to a policy of a different carrier is allowed, for corrections, and is flagged "Policy belongs to a
different carrier than the statement".

## Broker commission

- **Broker:** the policy's broker, the same rule the revenue dashboard uses.
- **Percentage**, the *applicable* share:
  - the policy's own **broker share** if one is set (new optional field on the policy form)
  - otherwise the broker's standard share, normally 50%
  - *Unassigned* is always 0%: the agency keeps the whole commission

  This follows the Phase 3 decision "per-policy broker % (default broker %)". Existing policies have no per-policy share,
  so they use the broker's standard share. Nothing is migrated.
- **Broker cents** = commission × share, rounded once, half-even. **Agency cents** = commission − broker cents. Both are
  integers, and they always sum exactly to the line's commission.
- **Negative commissions and chargebacks** split the same way, so both shares go down. Payment-only lines have no
  commission, so both shares are 0.
- **Statement-level adjustments** (fees, shared costs, bonuses) are agency-only and are shown separately, never split.
- The share used is stored with the match, so a later change to a broker's percentage does not silently change an
  existing match. Re-run matching to apply it.

## Review screen

- **Matching card:**
  - progress (matched commission lines / commission lines)
  - matched, ambiguous and unmatched amounts
  - broker and agency totals, with a per-broker table
  - statement adjustments
  - a balance check: commission = matched + ambiguous + unmatched, and broker + agency = matched, both to the cent
- **Filters:** match status (matched, ambiguous, unmatched, manual, not matched yet) and broker, plus the existing
  transaction filters. Search also covers the matched client and policy number.
- **Columns:** match status, matched client, policy and carrier, broker and percentage, broker and agency commission.

## Data protection

| Rule | How it is enforced |
|---|---|
| Extracted values and the PDF are never changed | Matches are stored in a separate `match` field on each line. The engine never mutates its input (tested). |
| Clients, policies and commissions are never created, edited or overwritten | The matching functions write only `lines/*.match`, `statements/*.matching` and `auditLog`. |
| Nothing is posted | No ledger writes. Statements with posted lines are locked for matching. |
| Audit trail | Every automatic run and every manual assign, unmatch or revert writes an audit entry with before and after status, policy, broker and broker cents, plus your note. The line also keeps its previous match and who made the change. |
| Browser cannot write matches | Firestore rules deny all browser writes. A rules test covers match and summary writes, even for admin. |
| Stale results are visible | Changing the statement's carrier flags matching "Carrier changed — re-run". Re-extracting a statement resets matching. |

## Code

| File | Purpose |
|---|---|
| `packages/shared/src/statements/match.ts` | The matching engine: number keys, names, decisions, split, summary. Pure and shared by server and browser. |
| `packages/shared/test/statements-match.test.ts` | 21 tests: normalization, carriers and wholesalers, name evidence, scientific notation, leading zeros, ambiguity, negative splits, summary balance, input immutability |
| `functions/src/callables/matching.ts` | `runStatementMatching` and `setLineMatch` (assign / unmatch / auto) |
| `apps/admin/src/pages/StatementMatching.tsx` | Matching card, match cells and the manual-match dialog |
| `packages/shared/src/schemas.ts`, `apps/admin/src/forms.tsx` | Optional per-policy broker share (`brokerShareBps`, blank = broker standard) |
| `tests/rules/firestore.rules.test.ts` | Browser cannot write matches, the summary, policies or the ledger |

## Not in Stage 3B
- The revenue dashboard's broker-share total still uses each broker's standard share. The ledger is empty until
  posting, so this has no effect yet. Stage 3C posting will use the share stored with each match.
- Approving and posting matched lines to the ledger (Stage 3C).
- Creating missing clients or policies from a line. Add them on the Clients page, then match.
- Revised or duplicate statement handling (Stage 3E).
