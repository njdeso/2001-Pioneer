# Production deploy from GitHub Actions: processStatement + setStatementPayer (PR #26)

Workflow: `.github/workflows/deploy-prod-functions.yml`. Everything below is done in a web browser: the Google
Cloud console, GitHub and Netlify. You don't need Cloud Shell or a local install.

## What the workflow does

| | |
|---|---|
| Trigger | **Manual only**: Actions → Run workflow, on `main`. It has no push, schedule or pull-request trigger. |
| Approval | Every run waits for your approval in the protected GitHub environment `production`. |
| Code | Only commit `359b85784570a9a04f2a744b60b2da2ce12accb0` (the PR #26 merge). You type it to confirm, and the run checks that it is on `main`. |
| Deploys | `firebase deploy --project prod --only "functions:processStatement,functions:setStatementPayer" --non-interactive`, never `--force` |
| Never deploys | Firestore rules, Storage rules, indexes, or any of the other functions. The deploy account has no permission for them either. |
| Env variables | Before deploying, it reads the variables production already uses (`OWNER_EMAILS`) and writes them into the deploy's `.env` file, so they stay exactly as they are. The values are masked in the logs. |
| Secret | The `ANTHROPIC_API_KEY` binding is kept. The run checks only that an enabled version exists; it never reads the key. |
| Data | It reads and writes no Firestore or Storage data. |
| Checks | Before and after the deploy it takes a read-only snapshot of every production function. The run **fails** if any other function changed, or if the two targets lost an env variable, the secret binding, memory, timeout, service account or browser access. It also runs a browser-style check: CORS preflight 204, and 401 for an unauthenticated call. |
| Dry run | Default **on**: every check and the snapshot, no deploy |
| Credentials | Workload Identity Federation: a short-lived token per run. No service-account key exists anywhere. |

The repository is public, so run logs are public. Variable values never appear in them: they are masked, and the
raw snapshots stay on the runner. The uploaded report lists names and "same / changed" only.

---

## Part 1 — Google Cloud console (project **pioneer-285cf**), about 25 minutes

Sign in to https://console.cloud.google.com as the owner of pioneer-285cf, and select **pioneer-285cf** in the
project picker at the top. Check the picker again before each step.

### 1.0 Note two facts
- **Project number:** Dashboard (☰ → Cloud overview → Dashboard) → *Project info* → **Project number**. Write it down: it is `PROJECT_NUMBER` below.
- **Functions runtime account:** ☰ → Cloud Run → Services → `processstatement` → **Security** tab (or a revision's details) → *Service account*. It is usually `PROJECT_NUMBER-compute@developer.gserviceaccount.com`. Write it down: it is `RUNTIME_SA` below.

Optionally confirm the GitHub IDs: open https://api.github.com/repos/njdeso/2001-Pioneer. `"id"` should be **1447842031**, and `"owner"` → `"id"` should be **347520685**.

### 1.1 Turn on two APIs (skip any already enabled)
☰ → APIs & Services → Library:
- **IAM Service Account Credentials API** → Enable
- **Security Token Service API** → Enable

### 1.2 Create the deploy service account (no key)
☰ → IAM & Admin → Service Accounts → **+ Create service account**
- Name: `pioneer-prod-deployer`
- ID: `pioneer-prod-deployer`
- Description: `GitHub Actions: deploys processStatement + setStatementPayer only. No keys.`
- **Create and continue.** Skip the optional role and user steps → **Done**.
- **Do not** open the Keys tab or create a key.

The account is `pioneer-prod-deployer@pioneer-285cf.iam.gserviceaccount.com`.

### 1.3 Create a small custom role (Cloud Run settings of a deployed function)
☰ → IAM & Admin → Roles → **+ Create role**
- Title: `Pioneer prod functions deployer`
- ID: `pioneerProdFunctionsDeployer`
- Launch stage: General Availability
- **+ Add permissions**. Filter by each name and tick it:
  `run.services.get`, `run.services.list`, `run.services.update`, `run.services.getIamPolicy`, `run.operations.get`,
  `artifactregistry.repositories.get`, `artifactregistry.repositories.list`
- **Create**

This role cannot create or delete Cloud Run services, cannot change who may call them, and has no access to images.

### 1.4 Give the deploy account its project roles
☰ → IAM & Admin → IAM → **Grant access**
- New principals: `pioneer-prod-deployer@pioneer-285cf.iam.gserviceaccount.com`
- Roles (use **+ Add another role** for each):
  - **Cloud Functions Developer**
  - **Firebase Viewer**
  - **Service Usage Consumer**
  - **Pioneer prod functions deployer** (the custom role from 1.3)
- **Save**

Do **not** add Owner, Editor, any Admin role, Firebase Rules Admin, Datastore, or Storage roles.

### 1.5 Let it deploy functions that run as the runtime account
☰ → IAM & Admin → Service Accounts → click `RUNTIME_SA` → **Permissions** tab (or *Principals with access*) → **Grant access**
- Principal: `pioneer-prod-deployer@pioneer-285cf.iam.gserviceaccount.com`
- Role: **Service Account User**
- **Save**

If the list also shows `pioneer-285cf@appspot.gserviceaccount.com` (App Engine default), repeat this step for it. Firebase checks that account before deploying functions.

### 1.6 Let it see that the secret exists (not its value)
☰ → Security → Secret Manager → `ANTHROPIC_API_KEY` → **Permissions** tab → **Grant access**
- Principal: `pioneer-prod-deployer@pioneer-285cf.iam.gserviceaccount.com`
- Role: **Secret Manager Viewer**. Not "Secret Manager Secret Accessor".
- **Save**

### 1.7 Create the Workload Identity pool and GitHub provider
☰ → IAM & Admin → Workload Identity Federation → **Create pool** (or **Get started**)
1. **Pool:** name `pioneer-prod-github`, pool ID `pioneer-prod-github` → Continue
2. **Provider:**
   - Type: **OpenID Connect (OIDC)**
   - Name: `deploy-prod`, provider ID `deploy-prod`
   - Issuer (URL): `https://token.actions.githubusercontent.com`
   - Audiences: **Default audience**
   - Continue
3. **Attribute mapping** (use **Add mapping** for each line):

   | Google | OIDC |
   |---|---|
   | `google.subject` | `assertion.sub` |
   | `attribute.repository_id` | `assertion.repository_id` |
   | `attribute.repository_owner_id` | `assertion.repository_owner_id` |
   | `attribute.ref` | `assertion.ref` |
   | `attribute.workflow_ref` | `assertion.workflow_ref` |
   | `attribute.environment` | `assertion.environment` |
   | `attribute.event_name` | `assertion.event_name` |

4. **Attribute conditions** → Add condition. Paste this as **one line**:
   ```
   assertion.repository_id == '1447842031' && assertion.repository_owner_id == '347520685' && assertion.ref == 'refs/heads/main' && assertion.workflow_ref.endsWith('/.github/workflows/deploy-prod-functions.yml@refs/heads/main') && assertion.environment == 'production' && assertion.event_name == 'workflow_dispatch'
   ```
5. **Save**

Google now refuses tokens from a fork, from another repository (even a re-created one with the same name), from another branch or workflow file, from another environment, and from any trigger other than a manual run.

### 1.8 Connect the pool to the deploy account
On the pool page (`pioneer-prod-github`) → **Grant access** → **Grant access using service account impersonation**
- Service account: `pioneer-prod-deployer`
- Principals: **Only identities matching the filter** → attribute name `repository_id`, value `1447842031`
- **Save**. When it offers a configuration file, click **Dismiss**: none is needed.

### 1.9 Copy the provider name
Pool page → the `deploy-prod` provider → copy its full resource name. It looks like
`projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/pioneer-prod-github/providers/deploy-prod`

---

## Part 2 — GitHub (https://github.com/njdeso/2001-Pioneer), about 5 minutes

### 2.1 Merge the pull request that adds the workflow
Merging deploys nothing. The workflow has no automatic trigger, and GitHub only shows **Run workflow** for workflows on `main`.

### 2.2 Create the protected `production` environment
Settings → Environments → **New environment** → name `production` → Configure:
- **Required reviewers:** tick it and add `njdeso`. Leave *Prevent self-review* **unticked**: you are the only reviewer.
- **Allow administrators to bypass configured protection rules:** **untick**, so every run waits for approval.
- **Deployment branches and tags:** *Selected branches and tags* → **Add deployment branch or tag rule** → `main`.
- **Save protection rules**

### 2.3 Add three environment variables (Variables, not Secrets: these are identifiers, not credentials)
Still in Environments → `production` → **Environment variables** → **Add variable**:

| Name | Value |
|---|---|
| `GCP_PROD_WIF_PROVIDER` | the provider name from 1.9 |
| `GCP_PROD_SERVICE_ACCOUNT` | `pioneer-prod-deployer@pioneer-285cf.iam.gserviceaccount.com` |
| `GCP_PROD_PROJECT_NUMBER` | the project number from 1.0 |

---

## Part 3 — Run it (only after you approve the release)

### 3.1 Dry run first (deploys nothing)
Actions → **Deploy to PRODUCTION — processStatement + setStatementPayer (manual)** → **Run workflow**
- Branch: `main`
- commit: `359b85784570a9a04f2a744b60b2da2ce12accb0`
- confirm: `pioneer-285cf`
- Dry run: **ticked**
- **Run workflow** → open the run → **Review deployments** → tick `production` → **Approve and deploy**

When it finishes, open the run's **Summary**. Expect:
- The snapshot of both functions, including their **last deployed** dates
- *All checks passed*, with every function *unchanged*
- `preflight 204`, `unauthenticated POST 401` for both functions

If a permission is missing, the error names it. Add only that permission.

### 3.2 The real deploy
Same as 3.1, but **untick Dry run**, then approve. Expect:
- `processStatement` and `setStatementPayer`: *redeployed*, with env variables, secret binding, memory, timeout, service account and public invoker all *same* or *kept*
- Every other function: *unchanged*
- Both browser checks pass

If the run stops with a message about an Artifact Registry **cleanup policy**, the functions are already deployed; the comparison step shows this. Set the policy from the console later, or ignore it.

### 3.3 Website, then the statement
1. Netlify → 2001-pioneer → Deploys: note the currently **Published** deploy (your website rollback point). Then open the `359b857` deploy → **Publish deploy**.
2. In the app, open `SMIC Nov 26.pdf` → **Retry with AI**. Expect *Suggested: Security Mutual Ins Co* and no lines for the page-2 totals.
3. Check the lines against **View original**, then confirm the carrier and approve.

---

## Rollback (browser)

| What | How | Data |
|---|---|---|
| Functions | Cloud Run → `processstatement` (and `setstatementpayer`) → **Revisions** → **Manage traffic** → 100% to the previous revision → Save | None |
| Website | Netlify → Deploys → the deploy noted in 3.3 → **Publish deploy** | None |
| Statements processed in between | They stay in *Needs review*. Re-run or **Discard** them (Discard keeps the record and PDF). | Not deleted |

A later Firebase deploy of a rolled-back function sends traffic to its newest revision again.

## Removing the access later
Do this when the app is retired, or right after this release if you prefer:
- Google Cloud: delete the provider and the pool (Workload Identity Federation), the service account `pioneer-prod-deployer`, and the custom role `pioneerProdFunctionsDeployer`.
- GitHub: delete the `production` environment.
