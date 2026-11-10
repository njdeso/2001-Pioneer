# Production release: coverage terms, policy-number search and broker buyout (PR #6)

| | |
|---|---|
| Production | Firebase `pioneer-285cf` (functions us-central1) · web app https://2001-pioneer.netlify.app |
| Production baseline (verified 2026-11-10, read-only probe) | Stage 3C is live: all **25** callables on `main` (`48d725f`) answer from production; none of PR #6's 13 new callables exist. Netlify production commit: confirm in the Netlify UI (the site is password-protected to automated checks) |
| This release adds (PR #6) | Coverage terms, past-policy attribution on unmatched lines, person-name matching evidence, policy-number search, broker advance records, buyout settlements and statements. **13 new callables**, 4 existing ones updated (runStatementMatching, setLineMatch, savePolicy message, posting plan fields only when used) |
| Who runs production commands | You, in Google Cloud Shell. Claude has no production credentials (by design) |

## What changes in production, and what never changes

| Area | Change | Existing records |
|---|---|---|
| Cloud Functions | The 25 existing functions are redeployed in place (same names and region, so no URL change), plus 13 new callables (terms, advances, buyout) | Not touched |
| Firestore rules | Additive: read rules for terms, ledger, advances and buyout collections. **No browser can write anything**, as before | Rules are not data |
| Indexes / Storage rules | No change required by this release | — |
| Data migrations | **None.** No record is rewritten, recalculated or deleted on deploy | — |
| Stored matching decisions and posting fingerprints | Unchanged. New fields (`term`, `historical`) are only added when you use those features; fingerprints of existing approved plans are identical | — |
| Policies without term history | Work as before: the policy's own dates are its current term ("No term history recorded"). Nothing is required | — |
| Broker buyout | **Nothing is created automatically.** No settlement, snapshot, advance or config record exists until an owner creates one; nothing is ever paid by the app | — |
| Dev test data | **Never copied.** Production only gets code; Karen Cross / synthetic records exist only in `pioneer-2001-dev` | — |

## Step 1. Preflight, backup and restore test — then send the output to Claude
**Do not use the production app (no matching, posting or edits) from here until Step 4 has passed.** The checks require every record to be identical.

Run each command on its own, in the `pioneer-release` folder:

```bash
bash scripts/prod-preflight.sh before
```
Read-only snapshot, saved to `preflight-before.txt`.

```bash
bash scripts/prod-backup.sh
```
- Exports the database to the dedicated private bucket `gs://pioneer-285cf-firestore-backups`. The first run asks before creating the bucket: location US, uniform bucket-level access, public access prevention enforced, and no Firebase link.
- Waits for the export, then requires done, no error, `SUCCESSFUL`, the metadata file and the data files.
- Shows Google's document count as an estimate only.
- Ends with `EXPORT COMPLETE — NOT YET VERIFIED`.

```bash
bash scripts/prod-backup-restore-test.sh
```
- Restores the backup into a temporary database (`bkverify-…`). The app's database is never written.
- Compares every collection's fingerprint, the ledger totals and the audit-log count with `preflight-before.txt`, then deletes the temporary database.
- Must end with **`BACKUP: VERIFIED BY RESTORE`**.

Stop and send the output if any of these is not true:
- every function is in **us-central1**
- the counts are what you expect
- every **`NEW … 0`** line is 0
- every existing function shows **204**, and the 13 new ones show **404**
- the restore test ends with **`BACKUP: VERIFIED BY RESTORE`**

## Step 2. Claude merges PR #6 (after reviewing your Step 1 output)
Merge commit, no squash. CI must pass on `main`. Netlify builds `main` but, with auto publishing stopped, does not publish it.

## Step 3. Deploy functions and rules (Cloud Shell)
```bash
git checkout main && git pull --ff-only && npm install
cp functions/.env.pioneer-285cf.example functions/.env.pioneer-285cf   # OWNER_EMAILS = production owner email
CONFIRM_PRODUCTION_DEPLOY=pioneer-285cf npm run deploy:prod
```
- Answer **No** to any prompt that offers to delete functions or indexes.
- Wait 3 minutes for new functions to accept calls.

## Step 4. After-snapshot: must be IDENTICAL (read-only)
```bash
bash scripts/prod-preflight.sh after
```
It must end with **`RESULT: OK - production records and financial totals are unchanged; nothing was created automatically.`**
- Every content fingerprint must be identical (customers, policies, statements, statement lines with their matching decisions, ledger, settings…), as must the ledger totals.
- Every `NEW …` line must be 0, so no terms, advances or settlements were created.
- *Browser access* must show **204** for every function. A **403** on a new function needs public invocation; do that only with your authorization: `gcloud run services add-iam-policy-binding <name-lowercase> --project pioneer-285cf --region us-central1 --member=allUsers --role=roles/run.invoker`.

**`RESULT: STOP`** means do not publish the web app. Send the output to Claude. The old web app keeps working with the new functions.

## Step 5. Publish the web app
Netlify → Deploys → the `main` deploy for the merge commit → **Publish deploy**, then **Start auto publishing**.

## Step 6. Verify in production (view-only first)
1. **Settings → Server connection** shows project `pioneer-285cf`, region `us-central1`. *Check statement functions* is safe to run: each function refuses deliberately invalid input before reading or changing anything.
2. **Statements:** the Travelers statements are listed with the same statuses. Open one and view its PDF and lines. **Do not re-run matching yet.**
3. **Clients & Policies:** search a customer name, then a policy number. Open a policy and confirm **Coverage terms** shows *No term history recorded*. Don't add one yet.
4. **Broker Buyout** (sidebar, owner only) opens on *Settlement*; the *Settlement versions* list is empty. Sign in as a staff user (if there is one) and confirm the menu item is absent and the page says *Owners only*.
5. Run `bash scripts/prod-preflight.sh after` once more. It must still be `RESULT: OK`, which proves the checks above were read-only.

Real work (matching, posting, adding terms or advances) starts only after that. Each of those actions is audit-logged.

## Rollback
| What | How | Data |
|---|---|---|
| Web app | Netlify → Deploys → the deploy noted in Step 1 → **Publish deploy** | None |
| Functions | `git checkout 48d725f && npm install && npx firebase deploy --project pioneer-285cf --only functions` (the current Stage 3C baseline). It will offer to delete the 13 new functions: answer **No** if any terms, advances or settlements were created; otherwise either answer is safe | None |
| Firestore rules | Firebase console → Firestore → Rules → history → previous version → **Publish** | None |
| Data | No restore is part of a code rollback. The backup from Step 1 is for disaster recovery only | — |
