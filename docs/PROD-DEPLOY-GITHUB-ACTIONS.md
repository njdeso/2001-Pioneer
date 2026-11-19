# Production deploy from GitHub Actions: processStatement + setStatementPayer (PR #26)

Workflow: `.github/workflows/deploy-prod-functions.yml`. Everything below is done in a web browser: the Google
Cloud console, GitHub and Netlify. You don't need Cloud Shell or a local install.

## What the workflow does

| | |
|---|---|
| Trigger | **Manual only**: Actions → Run workflow, on `main`. It has no push, schedule, pull-request, workflow-call or other trigger. CI (`scripts/check-prod-deploy-workflow.mjs`) fails if one is added, or if any other workflow uses the `production` environment or its variables. |
| Approval | Every run waits for your approval in the protected GitHub environment `production`. |
| Dry run | Default **on**: every check and the read-only snapshot, no deploy |
| Code | Only commit `359b85784570a9a04f2a744b60b2da2ce12accb0` (the PR #26 merge). You type it to confirm, and the run checks that it is on `main`. |
| Deploys | `firebase deploy --project prod --only "functions:processStatement,functions:setStatementPayer" --non-interactive`, never `--force` |
| Never deploys | Firestore rules, Storage rules, indexes, or any other function |
| Env variables | Before deploying, it reads the variables production already uses (`OWNER_EMAILS`) and writes them into the deploy's `.env` file, so they stay exactly as they are. The values are masked in the logs. |
| Secret | The `ANTHROPIC_API_KEY` binding is kept. The run checks only that an enabled version exists; it never reads the key. |
| Data | It reads and writes no Firestore or Storage data. |
| Checks | Before and after the deploy it takes a read-only snapshot of every production function. The run **fails** if any other function changed, or if the two targets lost an env variable, the secret binding, memory, timeout, service account or browser access. It also runs a browser-style check: CORS preflight 204, and 401 for an unauthenticated call. |
| Credentials | Workload Identity Federation: a short-lived token per run. No service-account key exists anywhere. |

The repository is public, so run logs are public. Variable values never appear in them: they are masked, and the
raw snapshots stay on the runner. The uploaded report lists names and "same / changed" only.

## What the deploy account CAN do (read this)

The account's Google permissions are **project-wide**. **They cannot be limited to processStatement and setStatementPayer:**

- **The Firebase CLI requires project-level permissions.** Before any functions deploy it checks the *project* for `cloudfunctions.functions.create`, `delete`, `get`, `list` and `update`, and stops if they are missing. Granting the role on the two functions only would not pass that check.
- **IAM Conditions cannot narrow the grant.** Google's resource-name conditions are not supported for Cloud Run functions or Cloud Run.
- **Cloud Run permissions cannot be narrowed either.** **Cloud Functions Developer**, the role Firebase needs, already includes project-wide Cloud Run permissions: `run.services.create/update/delete/get/list`, `run.operations.*` and `run.revisions.*`. Granting extra Cloud Run access on just the two services would add nothing and limit nothing, so this guide grants no separate Cloud Run role.

**So, while it is enabled, the deploy account could create, update or delete any Cloud Function, and its Cloud Run service, in pioneer-285cf.** What it deploys is limited only by these controls, not by Google permissions:

1. The workflow file: two named functions, no `--force`. It is checked in CI and changes only through a reviewed pull request (step G2).
2. The Google provider condition: this repository and owner ID, `main`, this workflow file, the `production` environment, manual runs.
3. Your approval of every run.
4. The before/after comparison, which *detects* any other change after the fact. It does not prevent it.
5. **The provider is disabled except while you deploy (Part 4).** While it is disabled, nothing can use the account.

What the account **cannot** do directly, because it holds no role for it:
- deploy or change Firestore or Storage rules or indexes
- read or write Firestore, Storage or Authentication data
- read the Anthropic key
- change IAM: Cloud Functions Developer has no `setIamPolicy` permission
- create keys
- act as any service account other than the functions' runtime account

**Indirect reach:** a function it deploys runs as the runtime account, which can read and write production data. Deploying different code would therefore reach that data **indirectly**. That is why the controls above (reviewed workflow, approval, provider disabled between deploys) matter, and why the provider must not be left enabled.

---

## Order of setup

Do these in order. **Do not merge PR #27 until G1–G3 are done.** If a workflow job names an environment that does not exist, GitHub creates it automatically **without** protection rules.

1. **Google Cloud: Part 1.** The provider is created **disabled**.
2. **GitHub: Part 2.** G1 protected environment, G2 branch protection, G3 variables. Then G4: merge PR #27.
3. **Deploy: Part 3.** Enable the provider → dry run → real deploy → verify → **disable the provider**.

---

## Part 1 — Google Cloud console (project **pioneer-285cf**)

Sign in to https://console.cloud.google.com as the owner of pioneer-285cf, and select **pioneer-285cf** in the
project picker at the top. Check the picker again before each step.

**C1. Note two facts.**
- **Project number:** ☰ → Cloud overview → Dashboard → *Project info* → **Project number**.
- **Runtime account:** ☰ → Cloud Run → Services → `processstatement` → **Security** tab → *Service account*. It is usually `PROJECT_NUMBER-compute@developer.gserviceaccount.com`.

Optionally confirm the GitHub IDs at https://api.github.com/repos/njdeso/2001-Pioneer: `"id"` should be `1447842031`, and `"owner"` → `"id"` should be `347520685`.

**C2. Turn on two APIs** (skip any already enabled). ☰ → APIs & Services → Library:
- **IAM Service Account Credentials API** → Enable
- **Security Token Service API** → Enable

**C3. Create the service account.** ☰ → IAM & Admin → Service Accounts → **+ Create service account**
- ID: `pioneer-prod-deployer`
- **Create and continue** → **Done**. Never create a key.

**C3b. Create a two-permission custom role** (instead of Firebase Viewer). ☰ → IAM & Admin → Roles → **+ Create role**
- Title: `Pioneer prod deploy — project read`
- ID: `pioneerProdDeployProjectRead`
- **+ Add permissions**: `firebase.projects.get` and `resourcemanager.projects.get`
- **Create**

**C4. Grant its project roles.** ☰ → IAM & Admin → IAM → **Grant access**
- Principal: `pioneer-prod-deployer@pioneer-285cf.iam.gserviceaccount.com`
- Roles (use **+ Add another role** for each):
  - **Cloud Functions Developer**
  - **Service Usage Consumer**
  - **Pioneer prod deploy — project read** (the custom role from C3b)
- **Save**

Add **nothing else**: no Owner, Editor, any Admin role, **Firebase Viewer**, Firebase Rules Admin, Datastore, Storage, or IAM roles. Firebase Viewer is read-only to *all* Firebase services, including Authentication users and Storage, so it would expose production data.

If a run reports a missing permission, the error names it. **Stop and review it before adding anything.** Never fix it with a broad role.

**C5. Let it deploy as the runtime account.** ☰ → IAM & Admin → Service Accounts → the runtime account from C1 → **Permissions** → **Grant access**
- Principal: `pioneer-prod-deployer@…`
- Role: **Service Account User**
- **Save**

If the list also shows `pioneer-285cf@appspot.gserviceaccount.com`, do the same there. Firebase checks it before deploying functions.

**C6. Let it see the secret's metadata (not its value).** ☰ → Security → Secret Manager → `ANTHROPIC_API_KEY` → **Permissions** → **Grant access**
- Principal: `pioneer-prod-deployer@…`
- Role: **Secret Manager Viewer**. Not "Secret Accessor".
- **Save**

**C7. Create the Workload Identity pool and provider.** ☰ → IAM & Admin → Workload Identity Federation → **Create pool**
- Pool name and ID: `pioneer-prod-github`
- Provider type: **OpenID Connect (OIDC)**
- Provider name and ID: `deploy-prod`
- Issuer (URL): `https://token.actions.githubusercontent.com`
- Audiences: **Default audience**
- Attribute mapping (use **Add mapping** for each line):

  | Google | OIDC |
  |---|---|
  | `google.subject` | `assertion.sub` |
  | `attribute.repository_id` | `assertion.repository_id` |
  | `attribute.repository_owner_id` | `assertion.repository_owner_id` |
  | `attribute.ref` | `assertion.ref` |
  | `attribute.workflow_ref` | `assertion.workflow_ref` |
  | `attribute.environment` | `assertion.environment` |
  | `attribute.event_name` | `assertion.event_name` |

- Attribute condition. Paste this as **one line**:
  ```
  assertion.repository_id == '1447842031' && assertion.repository_owner_id == '347520685' && assertion.ref == 'refs/heads/main' && assertion.workflow_ref.endsWith('/.github/workflows/deploy-prod-functions.yml@refs/heads/main') && assertion.environment == 'production' && assertion.event_name == 'workflow_dispatch'
  ```
- **Save**

**C8. Connect the pool to the account.** Pool page → **Grant access** → **Grant access using service account impersonation**
- Service account: `pioneer-prod-deployer`
- Principals: **Only identities matching the filter** → `repository_id` = `1447842031`
- **Save** → **Dismiss**: no configuration file is needed.

**C9. Copy the provider name, then disable the provider.**
- Copy the `deploy-prod` provider's full name: `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/pioneer-prod-github/providers/deploy-prod`.
- On the provider's page, click **Disable**. It stays disabled until you deploy (Part 3).

---

## Part 2 — GitHub (https://github.com/njdeso/2001-Pioneer). Do it before merging PR #27.

**G1. Create the protected environment.** Settings → Environments → **New environment** → `production` → Configure:
- **Required reviewers:** tick it and add `njdeso`. Leave *Prevent self-review* unticked: you are the only reviewer, so GitHub would block every approval.
- **Allow administrators to bypass configured protection rules:** **untick**.
- **Deployment branches and tags:** *Selected branches and tags* → add `main`.
- **Save protection rules**

**G2. Protect `main`.** Settings → Branches → **Add classic branch protection rule** (or Rules → Rulesets → New branch ruleset with the same options):
- Branch name pattern: `main`
- Tick **Require a pull request before merging**. Set *Required approvals* to **0**: GitHub does not let a PR's author approve their own PR, so 1 would block you.
- Tick **Require status checks to pass before merging** and **Require branches to be up to date before merging**. Add the checks **`verify`** and **`windows-deploy-checks`**.
- Tick **Do not allow bypassing the above settings**.
- Leave force pushes and deletions **blocked** (the default).
- **Create**

**G3. Add the environment variables.** Environments → `production` → **Environment variables** → **Add variable**. These are identifiers, not credentials:

| Name | Value |
|---|---|
| `GCP_PROD_WIF_PROVIDER` | the provider name from C9 |
| `GCP_PROD_SERVICE_ACCOUNT` | `pioneer-prod-deployer@pioneer-285cf.iam.gserviceaccount.com` |
| `GCP_PROD_PROJECT_NUMBER` | the project number from C1 |

**G4. Merge PR #27**, once its checks are green. Merging deploys nothing.

---

## Part 3 — Deploy (only after you approve the release)

**D1. Enable the provider.** Google Cloud → Workload Identity Federation → `pioneer-prod-github` → `deploy-prod` → **Enable**.

**D2. Dry run.** It also runs read-only Firebase CLI checks (`functions:list`, and secret metadata), so a missing permission shows up here, before any real deploy. Actions → **Deploy to PRODUCTION — processStatement + setStatementPayer (manual)** → **Run workflow**
- Branch: `main`
- commit: `359b85784570a9a04f2a744b60b2da2ce12accb0`
- confirm: `pioneer-285cf`
- Dry run: **ticked**
- **Run** → open the run → **Review deployments** → **Approve and deploy**

When it finishes, the Summary should show:
- both functions' last-deployed dates
- *All checks passed*, with every function *unchanged*
- both browser checks passing

**D3. Real deploy.** Same as D2 with **Dry run unticked**, then approve. The Summary should show:
- the two functions *redeployed*, with every setting *same* or *kept*
- every other function *unchanged*
- both browser checks passing

**D4. Website.** Netlify → 2001-pioneer → Deploys:
- note the deploy that is **Published** now (your rollback point)
- open the `359b857` deploy → **Publish deploy**

**D5. Verify in the app.**
- Open `SMIC Nov 26.pdf` → **Retry with AI**. Expect *Suggested: Security Mutual Ins Co* and no lines for the page-2 totals.
- Check the lines against **View original**, then confirm the carrier and approve.

**D6. Disable the provider immediately.** Google Cloud → Workload Identity Federation → `pioneer-prod-github` → `deploy-prod` → **Disable**. Check that its status shows *Disabled*.

Also disable it if a run fails, so it is never left enabled while you investigate.

If the run stops with a message about an Artifact Registry **cleanup policy**, the functions are already deployed; the comparison step shows this. Set the policy from the console later. Never add `--force`.

---

## Rollback (browser)

| What | How | Data |
|---|---|---|
| Functions | Cloud Run → `processstatement` (and `setstatementpayer`) → **Revisions** → **Manage traffic** → 100% to the previous revision → Save | None |
| Website | Netlify → Deploys → the deploy noted in D4 → **Publish deploy** | None |
| Statements processed in between | They stay in *Needs review*. Re-run or **Discard** them (Discard keeps the record and PDF). | Not deleted |

A later Firebase deploy of a rolled-back function sends traffic to its newest revision again.

## Removing the access entirely
When the app is retired, or whenever you prefer:
- Google Cloud: delete the `deploy-prod` provider, the `pioneer-prod-github` pool, the `pioneer-prod-deployer` service account, and the custom role `pioneerProdDeployProjectRead`.
- GitHub: delete the `production` environment's three variables, or the whole environment.
