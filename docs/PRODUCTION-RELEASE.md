# Release: Stage 3A + AI statement-reader repair (DONE — deployed)

> Stage 3A is in production. The next release (Stage 3B + 3C) is described in [RELEASE-3B-3C.md](RELEASE-3B-3C.md).

Goal: process the **October 2026** statement and recover the **April 2026** statement in production.

| | Where | Who |
|---|---|---|
| Code, tests, CI | GitHub PR #1 (Stage 3A) → PR #2 (AI repair) | done |
| Dev deploy + live test | GitHub Actions → `pioneer-2001-dev` only | automated once step 0 is done |
| Production deploy | Cloud Shell → `pioneer-285cf` | you, after approval |

Production data is never migrated, reset or copied. The release changes code and security rules only; every new
stored field is additive.

---

## Step 0 — One-time dev access for GitHub Actions (≈5 minutes, dev project only)

The dev deploy uses **Workload Identity Federation**: no downloaded keys, no Owner role, nothing stored in GitHub except two
non-secret identifiers. Full explanation: [DEV-DEPLOY-WIF.md](DEV-DEPLOY-WIF.md).

1. In the Anthropic Console, create a **separate development API key** (ideally in its own workspace, with a low spend limit).
2. Open Google Cloud Shell signed in as the owner of pioneer-2001-dev and paste:
   ```bash
   gh auth login        # optional: lets the script set the GitHub variables and start the dev run itself
   curl -fsSL https://raw.githubusercontent.com/njdeso/2001-Pioneer/fix/ai-statement-reader/scripts/setup-dev-wif.sh -o setup-dev-wif.sh
   less setup-dev-wif.sh  # review it (q to quit)
   bash setup-dev-wif.sh
   ```
   Paste the development key when asked. It is not shown, not logged and not saved to a file.

Then the **Deploy to dev** workflow:
- deploys rules, indexes and functions to pioneer-2001-dev
- seeds synthetic reference data
- runs the live smoke test (`scripts/smoke-dev.mjs`):
  - Test AI connection
  - the AI reads a synthetic PDF and reconciles it exactly
  - a statement whose upload never arrived is recovered into the same record
  - a stored file is still blocked as a duplicate

Trigger it by pushing a commit to the `deploy/dev` branch, or from the Actions tab once the workflow is on `main`.

---

## Production release (only after your approval)

**Status: ready.** The code is ready. There are three read-only checks only you can run; they are pre-flight items A–C.
- **CI:** green on PR #1 and PR #2.
- **Dev smoke test:** 9 of 9 passed on pioneer-2001-dev ([run 42697066170](https://github.com/njdeso/2001-Pioneer/actions/runs/42697066170)).

### What this release changes in production, and what it does not

| Area | Change | Existing data |
|---|---|---|
| Cloud Functions (us-central1) | Existing functions updated in place, plus 1 new one (`checkAiConnection`). Same names and region, so no URL changes. Pre-flight A confirms production's functions are in us-central1. | Untouched |
| Firestore rules and indexes | The Stage 3A rules from PR #1, which PR #2 does not change. If production already runs the Stage 3A rules, nothing changes. No new indexes. | Untouched; rules and indexes are not data |
| Storage rules | One line: an upload to an occupied path is refused | Untouched |
| Web app (Netlify) | Test AI connection, failure details, interrupted-upload resume | n/a |
| Anthropic key | Not changed. Functions bind the latest enabled version at deploy time. | n/a |
| Data migrations | **None** | — |

**Writes the new code can make, only when you act in the app:**
- **Test AI connection** writes one audit-log entry.
- **Re-uploading a file whose earlier upload never reached Storage** updates that same statement record (status, upload path, file name and size) and writes a `resume_upload` audit entry. It also clears any leftover temporary upload for that one record (`incoming/…`). Stored originals (`statements/{id}/original.*`) are never deleted or overwritten by any code path: originals are copied only if the destination is empty.
- **A failed extraction** stores extra failure details (`httpStatus`, `errorType`, `apiMessage`, `requestId`).
- **A statement stuck in "Processing" for over 12 minutes** can be retried. As before, a retry replaces only that statement's extracted lines, and only while nothing from it has been posted.

Nothing in this release deletes or edits clients, policies, carriers, brokers or posted amounts. The client and policy delete paths (undo import, and key renames when a policy or carrier is edited) are unchanged and run only when you use those features.

### Pre-flight (read-only, about 10 minutes)

A. **Production snapshot, which also checks region, model and key.** In Cloud Shell:
```bash
git clone https://github.com/njdeso/2001-Pioneer.git 2001-Pioneer-release && cd 2001-Pioneer-release
git checkout fix/ai-statement-reader          # only to get the script before merging; it changes nothing
bash scripts/prod-preflight.sh before
```
Expect:
- Functions: `CHECK: OK - all us-central1`. **If any function is in another region, stop and tell Claude**; the deploy would otherwise create a second copy.
- Anthropic secret: `CHECK: OK - latest version starts with sk-ant-` (about 100 characters). Version 3 should be listed.
- AI settings: aiModel is shown. If it is not `claude-sonnet-5-5`, change it after the deploy (step 4).
- Counts: clients **157**, policies **233**, plus the statement and stored-PDF counts. Keep `preflight-before.txt`.
- The statements list shows October 2026 and April 2026: their status, failure code and whether the PDF is stored. April should show `stored:NO`.

B. **Netlify** (app.netlify.com → 2001-pioneer → Site configuration):
- *Environment variables:*
  - `VITE_FIREBASE_PROJECT_ID` = `pioneer-285cf`.
  - `VITE_FUNCTIONS_REGION` is **unset or `us-central1`**. If it is `us-east4`, change it to `us-central1`.
- *Build & deploy → Branches:* note the **Production branch**. If it is `main`, merging publishes the site automatically. If not, publish main manually in step 3.
- *Deploys:* note the current published production deploy. That is your web-app rollback point.

C. **Optional backup.** Nothing in the release touches data, so this is only belt and braces:
`gcloud firestore export gs://BUCKET/backups/$(date +%F) --project pioneer-285cf`, where BUCKET is the Storage bucket shown in the preflight output.

### Release steps

1. **Merge PR #1** with **"Create a merge commit"**. Do not squash or rebase: PR #2 is built on PR #1's commits, and a squash would make them conflict.
   Then click **Delete branch** on PR #1. GitHub automatically retargets PR #2 to `main`. If you keep the branch, edit PR #2's base to `main` instead.
   No rebase is needed: `main` has not moved since PR #1 was opened.
2. **Merge PR #2** with **"Create a merge commit"**. Wait for the CI run on `main` to go green.
3. **Web app:** if the Production branch is `main`, Netlify builds and publishes on its own. Wait until the new deploy is *Published*. Otherwise trigger a production deploy of `main`.
   The new web app works with the old functions, and the old web app with the new functions, so the order of steps 3 and 4 is safe.
4. **Functions and rules** (Cloud Shell, in `2001-Pioneer-release`):
   ```bash
   git checkout main && git pull --ff-only
   npm install
   cp functions/.env.pioneer-285cf.example functions/.env.pioneer-285cf
   nano functions/.env.pioneer-285cf      # OWNER_EMAILS = the owner email production already uses
   npx firebase login --no-localhost      # if not already signed in
   CONFIRM_PRODUCTION_DEPLOY=pioneer-285cf npm run deploy:prod
   ```
   `deploy:prod` refuses to run unless:
   - the target is the `prod` alias (pioneer-285cf)
   - the commit is already on `origin/main`
   - the working tree is clean
   - the confirmation variable is set

   It never uses `--force`. **Answer No to any prompt that offers to delete functions or indexes.**
5. **Snapshot again:** `bash scripts/prod-preflight.sh after`. Every count must be the same as before, and the comparison prints `OK` for each.

### Verify and process (https://2001-pioneer.netlify.app)
1. **Settings:** Model = `claude-sonnet-5-5` → **Save** → **Test AI connection**. All four checks must show ✓. The last check extracts a small made-up statement and reconciles it to the cent, using the same code as real statements.
2. **October 2026:** open it → **Retry with AI**. Expect *Needs review* and "reconciled exactly".
3. **April 2026:** upload the same PDF again. The row reads "Completing an earlier upload…" and the statement processes in its existing record.
   If it still says "duplicate", the record is in a state the resume does not cover (shown in the snapshot). Discard that April record, which keeps it with its history and frees the fingerprint, then upload again.
4. Review both statements before approving anything. AI results are never posted automatically.

## Rollback

| What | How | Effect on data |
|---|---|---|
| Functions | In `2001-Pioneer-release`: `git checkout e0740e0 && npm install && npx firebase deploy --project pioneer-285cf --only functions`. Use the project ID: that commit has no `.firebaserc`. It also deploys to us-central1, because the same region setting was ignored there. If asked to delete `checkAiConnection`, either answer is safe. | None |
| Storage / Firestore rules | Firebase console → Storage → Rules (and Firestore → Rules) → history → previous version → **Publish** | None |
| Web app | Netlify → Deploys → the production deploy noted in pre-flight B → **Publish deploy** | None |
| Statements processed after the release | They sit in *Needs review* and nothing is posted. Re-run or **Discard** them in the app; discarding keeps the record and its PDF. | No deletion |
| Anthropic key | Not changed by the release | — |

Never restore a Firestore backup over production to roll back code. The release changes no data, so there is nothing to restore.

## Impact of `maxInstances: 5`
- **What it means:** each function can now run on at most 5 instances at once. Until now the cap was never applied, because the global options were ignored.
- **Capacity:** each 2nd-gen instance handles up to 80 requests at the same time, so that is far more than a four-person office uses.
- **Upload limit:** a very large batch, such as dozens of PDFs dropped at once, shares fewer instances, and each `processStatement` instance has 1 GiB of memory. **Upload statements in batches of about 10 or fewer.** If a batch is too large, the affected files stay *Awaiting upload* or *Processing failed* and can be retried; nothing is lost.
- **Cost:** the cap limits runaway cost.
- **Unchanged:** cold starts, memory, timeouts and every other setting.

## Notes
- **Functions region.**
  - All functions are, and stay, in **us-central1**. The code said `us-east4`, but that setting was never applied: `setGlobalOptions` ran after the functions were defined.
  - The production deploy therefore updates the functions in place, with no URL change.
  - The instance cap of **5 per function** now takes effect; until now it was never applied.
  - The web app calls the region in `VITE_FUNCTIONS_REGION`, or us-central1 by default. Moving to another region would be a separate, planned migration.
- **Netlify previews:**
  - PR previews and branch deploys now build against **pioneer-2001-dev** (see `netlify.toml`), so an open pull request can never act on production data.
  - Until the dev web config is filled in, previews show "Firebase is not configured".
- **Second Netlify site:** `luminous-kringle-ebc206` also builds from this repository. If it is not in use, unlink it in Netlify.
