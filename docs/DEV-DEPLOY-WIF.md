# Dev deploys from GitHub Actions with Workload Identity Federation

`.github/workflows/deploy-dev.yml` deploys to **pioneer-2001-dev** and runs the live smoke test.

- **No permanent credentials.** No service-account key exists, and GitHub stores no Google credential.
- **One trigger only.** It runs when a commit is pushed to the `deploy/dev` branch.
- **Production is outside it.** It cannot reach **pioneer-285cf**: the service account belongs to the dev project and holds roles only there.

## How a run authenticates

```
GitHub run (deploy-dev.yml on deploy/dev, environment "development")
   │  short-lived OIDC token signed by GitHub, describing repo, branch, workflow, environment
   ▼
Google STS — Workload Identity pool "github", provider "github-2001-pioneer" (pioneer-2001-dev)
   │  accepted only if: repository_id == 1447842031 (njdeso/2001-Pioneer)
   │                    ref == refs/heads/deploy/dev
   │                    workflow_ref == njdeso/2001-Pioneer/.github/workflows/deploy-dev.yml@refs/heads/deploy/dev
   │                    environment == development
   ▼
github-dev-deployer@pioneer-2001-dev.iam.gserviceaccount.com — token valid about 1 hour
```

A fork, another repository, another branch, another workflow file or another environment gets no Google access. The
repository is matched by its numeric ID, so a renamed or re-created repository with the same name does not inherit
access.

## What `scripts/setup-dev-wif.sh` creates (Cloud Shell, once)

| Item | Name |
|---|---|
| Workload Identity pool | `github` (global) |
| OIDC provider | `github-2001-pioneer`, issuer `https://token.actions.githubusercontent.com`, condition above |
| Service account | `github-dev-deployer@pioneer-2001-dev.iam.gserviceaccount.com`, **no keys** |
| Federation binding | `roles/iam.workloadIdentityUser` for `principalSet://…/attribute.repository_id/1447842031` |
| Secret | `ANTHROPIC_API_KEY` in pioneer-2001-dev Secret Manager: your **separate development** key, typed at a hidden prompt |
| GitHub variables | `GCP_WIF_PROVIDER`, `GCP_DEV_SERVICE_ACCOUNT` (identifiers, not secrets), optional `DEV_OWNER_EMAILS` |

The script is safe to run again. Use `ROTATE_KEY=1 bash setup-dev-wif.sh` to replace the dev key.

## Permissions (no Owner, no Editor)

All roles are granted in **pioneer-2001-dev** only.

| Role | Scope | Why |
|---|---|---|
| `firebaserules.admin` | project | deploy Firestore and Storage rules |
| `datastore.indexAdmin` | project | deploy Firestore indexes |
| `datastore.user` | project | seed synthetic reference data; turn on the AI reader in dev settings |
| `cloudfunctions.admin` | project | deploy 2nd-gen functions and set their invoker policy |
| `run.admin` | project | 2nd-gen functions are Cloud Run services; callables need public invoke |
| `artifactregistry.admin` | project | function images; the deploy sets the image cleanup policy |
| `firebase.viewer` | project | read project, web-app config and billing status |
| `serviceusage.serviceUsageConsumer` | project | call the enabled APIs. It cannot enable or disable APIs; the setup script does that. |
| `iam.serviceAccountUser` | the default compute account only | deploy functions that run as that account |
| `iam.serviceAccountTokenCreator` | itself only | sign the smoke-test user's sign-in token through IAM (no private key) |
| `storage.objectAdmin` | the dev Storage bucket only | upload the synthetic smoke-test PDFs |
| `secretmanager.viewer` | the `ANTHROPIC_API_KEY` secret only | confirm the secret exists. It **cannot read the key**. |

The functions' runtime account (`PROJECT_NUMBER-compute@developer.gserviceaccount.com`) gets:
- `secretmanager.secretAccessor` on `ANTHROPIC_API_KEY`, so the functions can read the key
- `cloudbuild.builds.builder` and `logging.logWriter`, which 2nd-gen builds need on newer projects

## The Anthropic development key

- It is typed into Cloud Shell at a hidden prompt (`read -s`), piped straight into Secret Manager, and then cleared from the shell.
- It is never in the repository, in GitHub secrets, in workflow logs or in a file.
- The deployer can see that the secret exists but has no permission to read it. Only the deployed functions can.
- Use a key separate from production's, so it can be limited or revoked without affecting production.

## Running it

- **Automatic:** `setup-dev-wif.sh` sets the variables with `gh` (if you ran `gh auth login`) and re-runs the latest dev deploy.
- **Manual:** push the commit to test to `deploy/dev`, or Actions → "Deploy to dev (pioneer-2001-dev)" → Re-run.

Each run:
1. installs, guards the target and runs the unit tests
2. authenticates through federation
3. confirms the dev key exists
4. deploys rules, indexes and functions
5. seeds synthetic reference data
6. runs `scripts/smoke-dev.mjs`, whose results appear in the run summary

If a permission is missing, the step's error names it. Add exactly that role, or tell Claude, and re-run.

## Removing access

```bash
gcloud iam workload-identity-pools providers delete github-2001-pioneer --workload-identity-pool=github --location=global --project pioneer-2001-dev
gcloud iam service-accounts delete github-dev-deployer@pioneer-2001-dev.iam.gserviceaccount.com --project pioneer-2001-dev
```
