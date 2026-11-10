# Stage 3B — testing in the development project

**Target:**
- Firebase **pioneer-2001-dev** only (project number 994437988131)
- web app: Netlify PR preview **https://deploy-preview-3--2001-pioneer.netlify.app**

Production (**pioneer-285cf**, https://2001-pioneer.netlify.app) is not touched. PR #3 stays unmerged.

## Safeguards
| Risk | Safeguard |
|---|---|
| Preview connects to production | Previews are built only by `scripts/netlify-dev-build.mjs`. It uses `DEV_FIREBASE_API_KEY` / `DEV_FIREBASE_APP_ID` from Netlify, and checks that the app ID belongs to project number 994437988131. It asks Firebase which project the API key belongs to; that must be pioneer-2001-dev. Missing or wrong values **fail the build with an explicit error**, and nothing is published. The production `VITE_FIREBASE_*` values are never used, because `netlify.toml` blanks them for preview contexts. The app also refuses to start if a preview build points at any other project. |
| Dev keys in the public repo | They are not in the repo. They live only in Netlify environment variables. |
| Synthetic data seeded into production | `seed-dev.mjs` and `smoke-dev.mjs` refuse unless the target is pioneer-2001-dev **by ID** (`.firebaserc` alias and requested project) **and by project number**, as reported by Google for the script's own credentials. Production credentials or a changed alias cannot pass both. Both refusal paths are tested in CI. |
| Deploy reaches production | The dev workflow authenticates as the dev-only deploy account through Workload Identity Federation. That account has no role in production. |
| Matching posts money | Stage 3B has no ledger writes. The smoke test checks that the ledger count is unchanged and that the statement's posted amount is $0. |

**Synthetic data:**
- Every document is tagged `synthetic: true`, and every ID starts with `SYN3B-`. All names say "Synthetic" or "TEST".
- **Statements:**
  - `SYN3B-MANUAL` is for your manual tests. It is created once and never reset, unless the seed is run with `SEED_RESET_3B=1`.
  - The automated test uses a fresh `SYN3B-AUTO-…` statement each run, and reverses everything it posts.
  - **Nothing is deleted.** Earlier runs' statements, postings and reversals stay in dev; the ledger is append-only.
    (Until this change the smoke test deleted earlier `SYN3B-AUTO-…` statements and their ledger entries.)
  - `SEED_RESET_3B=1` refuses to reset `SYN3B-MANUAL` once it has been approved, posted or reversed.
- **Ledger audit (read-only):** every dev run first audits the existing dev ledger, before anything is deployed,
  seeded or tested, and stops if it finds an imbalance. It runs again after the smoke test. An **audit-only** run
  changes nothing at all (`docs/LEDGER-REPORT-AND-AUDIT.md`).

## One-time setup

### A. Netlify: dev web keys for previews only
In app.netlify.com → **2001-pioneer** → Site configuration → Environment variables:
1. **Add a variable** → Key `DEV_FIREBASE_API_KEY`.
   - Value: the `apiKey` of the **pioneer-2001-dev** web app, from Firebase console → pioneer-2001-dev → Project settings → General → Your apps → SDK setup and configuration.
   - Scopes: **Builds**.
   - Deploy contexts: **Deploy Previews** and **Branch deploys** only. Not Production.
2. **Add a variable** → Key `DEV_FIREBASE_APP_ID`.
   - Value: the dev `appId`, which starts with `1:994437988131:web:`.
   - Same scope and contexts as above.
3. Do **not** change the existing `VITE_FIREBASE_*` variables. They are production's.

The second Netlify site, `luminous-kringle-ebc206`, also builds previews of this repo. Without these variables its previews now **fail** on purpose. Either add the same two variables there or unlink that site.

### B. Firebase: a dev admin login
See "Dev authentication setup" in the PR conversation. In short:
1. Enable Email/Password sign-in in pioneer-2001-dev.
2. Add a user with your email.
3. Set the GitHub variable `DEV_OWNER_EMAILS` to that email.

## Deploy, after your approval
1. Push the PR #3 head commit to the `deploy/dev` branch. Claude can do this on request. It deploys rules, indexes and functions to pioneer-2001-dev, seeds the synthetic data, then runs the smoke test (AI checks and the Stage 3B checks).
2. Re-run the Netlify preview of PR #3 so it builds with the new variables: Deploys → the PR #3 deploy → **Retry deploy**, or push any commit.
3. Open the preview. The yellow **DEV** banner must say pioneer-2001-dev. Sign in, then click **Claim owner**.

## Automated Stage 3B checks (in the "Deploy to dev" run summary)
- **Automatic matching, each of the 10 synthetic lines:**
  1. Clean match: Matched, high confidence; 50% broker → $60.00 / $60.00
  2. Same number and carrier, different name → Ambiguous (name conflicts)
  3. Number exists only at another carrier → Ambiguous
  4. `6.17738486E+08` → Matched (all digits present); 40% broker → $32.00 / $48.00
  5. `6.17738E+08` → Unmatched (digits missing, never guessed)
  6. `45678` vs `0045678` with an agreeing name → Matched (leading zeros); Unassigned → $0.00 / $25.00
  7. Chargeback −$45.00 on a policy with its own 30% share → broker −$13.50 / agency −$31.50
  8. Payment-only line → Matched, $0.00 / $0.00
  9. Unknown policy → Unmatched
  10. Cancelled policy → Matched, flagged "policy is not active"
- **Totals:** commission $415.00 = matched $195.00 + ambiguous $120.00 + unmatched $100.00. Broker $86.00 + agency $109.00. Balanced.
- **Manual changes:**
  - assign ambiguous line 2 (40% → $20.00 / $30.00)
  - mark line 1 unmatched
  - re-run automatic matching (both manual decisions kept)
  - return line 1 to automatic
  - totals then: matched 7, $245.00; broker $106.00, agency $139.00; balanced
- **Audit log:** an assign entry with before *ambiguous* and after *matched*, plus the note; the unmatch and revert entries; 2 automatic-run entries.
- **Data protection:** extracted line values unchanged, field by field; synthetic policies unchanged; ledger count unchanged; posted $0.

## Manual test checklist (in the preview, statement "Stage 3B manual test statement")
- [ ] The DEV banner shows pioneer-2001-dev. The statement list shows only synthetic or dev data.
- [ ] **Run automatic matching.** The counts are 6 matched, 2 ambiguous and 2 unmatched, and the card says the totals balance.
- [ ] **Ambiguous:** open line 2. The suggestion shows "name differs". Line 3's suggestion is marked "other carrier".
- [ ] **Unmatched:** line 5 says digits are missing. Search finds policy 617738486, and assigning it shows "Matched (manual)".
- [ ] **Broker %:** Test Broker Fifty shows 50% and Test Broker Forty 40%. The Zeta policy shows 30% (policy). Unassigned shows 0%. The per-broker table adds up.
- [ ] **Negative:** line 7's broker and agency amounts are both negative.
- [ ] **Corrections:** mark a matched line unmatched, then return it to automatic. Re-running automatic matching keeps your manual matches.
- [ ] **Original values:** the left side of the dialog never changes.
- [ ] **Audit:** Settings → Audit log lists each automatic run and manual change, with before and after values and your note.
- [ ] **No posting:** the statement shows Posted $0.00, and the Dashboard revenue is unchanged.
- [ ] **Policy form:** edit a synthetic policy. The broker share field saves, and blank = the broker's standard share.

To start over: `SEED_RESET_3B=1 node scripts/seed-dev.mjs dev`. This runs only against dev and is refused anywhere else.

## Stage 3C manual checklist (PR #4 preview: https://deploy-preview-4--2001-pioneer.netlify.app, DEV banner = pioneer-2001-dev)
- [ ] Open "Stage 3B manual test statement". **Approval & posting** shows *Not ready* and lists the ambiguous and unreviewed lines.
- [ ] Resolve them (match, or *Mark unmatched*). *Ready to approve* appears, with totals for commission, broker, agency, suspense and adjustments.
- [ ] **Approve for posting.** Status *Approved*; matching buttons are locked.
- [ ] **Return to review** (with a reason) works; approve again.
- [ ] **Post to ledger.** Status *Posted*. The Dashboard (snapshot window including Oct 2026) rises by exactly the posted amount; broker share = posted broker total.
- [ ] Open a matched policy. Its commission history shows the entry with broker and agency amounts.
- [ ] **Reverse posting…** (reason). The Dashboard returns to the earlier figures; the statement is back in review. Approve and post again.
- [ ] **Ledger** (left menu), snapshot window selected: the tie-out line says ✓ *Ties to the Dashboard*. Postings tab: the reversed posting shows *Reversed · nets $0.00* with $0.00 net gross, broker and agency; the new posting is *Posted*.
- [ ] Filter *Posting status → Reversed*: Net commission, broker share and agency net are all $0.00. Filter by the Zeta policy number: broker 30 % (policy).
- [ ] Export *Transactions — accounting* and *Transactions — due diligence*. The accounting file's amount, broker_amount and agency_amount columns total the figures on screen; the due-diligence file has no broker, split, staff or note columns.
- [ ] Policy → **Record retained commission** ($100.00 on the Zeta policy). Broker $30.00 / agency $70.00 (policy 30 %). **Reverse…** it.
- [ ] Settings → Audit log shows approve, post, reverse, retained and reversal entries.
- [ ] Signed in as a staff (non-admin) user, the approve, post and reverse buttons are not offered.
