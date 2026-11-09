# Release: Stage 3A + AI statement-reader repair

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

**Preconditions:**
- CI is green on PR #1 and PR #2.
- The dev smoke test shows every check ✅.

### 1. Merge (GitHub)
1. Merge **PR #1** first.
2. Then merge **PR #2**. GitHub retargets it to `main` automatically when #1 merges.

Merging to `main` makes Netlify build the production site. The new site works with the old functions and the new
functions work with the old site, so the order of steps 1 and 2 cannot break anything. Until step 2 is done,
**Test AI connection** simply reports that it is unavailable.

### 2. Deploy functions and rules to pioneer-285cf (Cloud Shell)
```bash
git clone https://github.com/njdeso/2001-Pioneer.git 2001-Pioneer-release && cd 2001-Pioneer-release
npm install
cp functions/.env.pioneer-285cf.example functions/.env.pioneer-285cf
nano functions/.env.pioneer-285cf          # OWNER_EMAILS = the same owner email production uses today
firebase functions:secrets:get ANTHROPIC_API_KEY --project prod   # shows versions only; confirm version 3 is ENABLED
CONFIRM_PRODUCTION_DEPLOY=pioneer-285cf npm run deploy:prod
```
`deploy:prod` refuses to run unless:
- the target is the `prod` alias (pioneer-285cf)
- the working tree is clean
- the commit is already on `origin/main`
- the confirmation variable is set

It deploys `firestore` (rules and indexes), `storage` (rules) and `functions`. It never uses `--force`. If the CLI
asks whether to **delete** a function that is not in the source, answer **No**.

Optional extra safety before deploying (the deploy does not touch data):
`gcloud firestore export gs://BUCKET/backups/$(date +%F) --project pioneer-285cf`, where BUCKET is the name shown in Firebase console → Storage.

### 3. Verify and process (https://2001-pioneer.netlify.app)
1. **Settings:** set Model to `claude-sonnet-5-5` → **Save** → **Test AI connection**. Expect four ✓. If one fails, it
   says which and what to do:
   - key → replace the secret version and redeploy functions
   - model → pick a listed model
   - billing → add credits in the Anthropic Console
2. **October 2026:** open the statement → **Retry with AI** → expect *Needs review* with "reconciled exactly".
3. **April 2026:** upload the same PDF again. The row reads "Completing an earlier upload…" and the statement
   processes in its existing record. There is no duplicate warning.
4. Spot check: Clients = 157, Policies = 233.

---

## Rollback

Nothing in the data needs rolling back. The release adds fields:
- `failure.httpStatus`
- `failure.errorType`
- `failure.apiMessage`
- `failure.requestId`
- `resume_upload` audit entries

Older code ignores them. Never restore a backup over production to roll back code.

| What | How |
|---|---|
| Functions | From the release clone: `git checkout <commit production ran before>` (Stage 3A: `e0740e0`, unless you deployed another), `npm install`, `firebase deploy --project pioneer-285cf --only functions`. Use the project ID, not the alias: older commits have no `.firebaserc`. |
| Firestore / Storage rules | Firebase console → Firestore → Rules → history, and Storage → Rules → history → pick the previous version → **Publish**. |
| Web app | Netlify → 2001-pioneer → Deploys → the previous production deploy → **Publish deploy**. |
| Anthropic key | Not changed by this release. |

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
