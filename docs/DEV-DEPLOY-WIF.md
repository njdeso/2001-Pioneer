# Dev deploys from GitHub Actions with Workload Identity Federation

`.github/workflows/deploy-dev.yml` deploys to **pioneer-2001-dev** and runs the live smoke test.

- **No permanent credentials.** No service-account key exists, and GitHub stores no Google credential.
- **One trigger only.** It runs when a commit is pushed to the `deploy/dev` branch, in the `development` environment.
- **Production is outside it.** It cannot reach **pioneer-285cf**: the service account belongs to the dev project and holds roles only there.

## How a run authenticates

```
GitHub run: deploy-dev.yml on refs/heads/deploy/dev, environment "development", permissions id-token: write
   │  short-lived OIDC token signed by GitHub
   ▼
Google STS — dedicated pool "pioneer-dev-github", provider "deploy-dev" (pioneer-2001-dev)
   │  accepted only if: repository_id       == 1447842031  (njdeso/2001-Pioneer)
   │                    repository_owner_id == 347520685   (njdeso)
   │                    ref                 == refs/heads/deploy/dev
   │                    workflow_ref ends with /.github/workflows/deploy-dev.yml@refs/heads/deploy/dev
   │                    environment         == development
   ▼
pioneer-dev-deployer@pioneer-2001-dev.iam.gserviceaccount.com — token valid about 1 hour
```

The workflow also refuses to start on any other branch, and only accepts a service account ending in
`@pioneer-2001-dev.iam.gserviceaccount.com`. These deny access:
- a fork
- another repository, including a re-created repository with the same name, because IDs are numeric
- another branch
- another workflow file
- another environment

The pool holds only this provider, so no other identity source can match the service-account binding.

## What `scripts/setup-dev-wif.sh` creates (Cloud Shell, once)

| Item | Name |
|---|---|
| Workload Identity pool | `pioneer-dev-github` (global, dedicated) |
| OIDC provider | `deploy-dev`, issuer `https://token.actions.githubusercontent.com`, condition above |
| Service account | `pioneer-dev-deployer@pioneer-2001-dev.iam.gserviceaccount.com`, **no keys** |
| Custom role | `projects/pioneer-2001-dev/roles/pioneerDevDeployer` |
| Federation binding | `roles/iam.workloadIdentityUser` for `principalSet://…/pioneer-dev-github/attribute.repository_id/1447842031` |
| Secret | `ANTHROPIC_API_KEY` in pioneer-2001-dev Secret Manager: your **separate development** key, typed at a hidden prompt |
| GitHub variables | `GCP_WIF_PROVIDER`, `GCP_DEV_SERVICE_ACCOUNT` (identifiers, not secrets), optional `DEV_OWNER_EMAILS` |

**Safety**
- **Production cannot be reached.**
  - Every `gcloud` command names `--project pioneer-2001-dev` or a resource that belongs to it.
  - The script also forces `CLOUDSDK_CORE_PROJECT=pioneer-2001-dev` for its own process. Your Cloud Shell default project (even `pioneer-285cf`) is ignored and left unchanged.
- **Existing resources are never modified.**
  - The pool, provider, service account and custom role are tagged `managed-by=2001-pioneer/setup-dev-wif`.
  - If one of those IDs already exists **without** that tag, the script stops without changing it.
  - The provider is updated only if it is tagged and its issuer is GitHub's.
- **The repository and owner IDs are re-verified** against api.github.com before anything is created.
- **No keys.**
  - The script stops if the deployer has a downloaded key.
  - It removes Owner, Editor, Cloud Run Admin, Artifact Registry Admin and Cloud Functions Admin from the deployer if any were granted earlier.
  - It warns about the unused `github-dev-deployer` account if the earlier key-based instructions were followed.
- **Safe to run again.** Use `ROTATE_KEY=1 bash setup-dev-wif.sh` to replace the dev key.

`scripts/check-dev-wif-config.mjs` runs in CI on every pull request. It fails if the workflow, the setup script and
`.firebaserc` disagree on any of these:
- project IDs
- branch
- workflow file
- environment
- variable names
- repository ID
- service-account domain
- `id-token: write`

## Permissions (no Owner, Editor or product Admin roles)

All roles are granted in **pioneer-2001-dev** only.

| Role | Scope | Why |
|---|---|---|
| custom `pioneerDevDeployer` | project | Exactly: `run.services.get/list/update/getIamPolicy/setIamPolicy`, `run.operations.get`, `artifactregistry.repositories.get/list/update`. These cover applying each 2nd-gen function's Cloud Run settings, making callables publicly invokable, and setting the image cleanup policy. It cannot create or delete Cloud Run services, and it has no access to images. Replaces Cloud Run Admin and Artifact Registry Admin. |
| `cloudfunctions.developer` | project | Create, update and delete functions. Replaces Cloud Functions Admin; it cannot change function IAM. |
| `firebaserules.admin` | project | Deploy Firestore and Storage rules |
| `datastore.indexAdmin` | project | Deploy Firestore indexes |
| `datastore.user` | project | Synthetic seed data; turn on the AI reader in dev settings |
| `firebase.viewer` | project | Read-only: project, web-app config, billing status |
| `serviceusage.serviceUsageConsumer` | project | Call the enabled APIs. It cannot enable or disable APIs; the setup script does that. |
| `iam.serviceAccountUser` | the functions runtime account only | Deploy functions that run as it |
| `iam.serviceAccountTokenCreator` | itself only | Sign the smoke-test user's sign-in token through IAM (no private key) |
| `storage.objectCreator` | the dev Storage bucket only | Upload synthetic test PDFs. It cannot read or delete files. |
| `secretmanager.viewer` | the `ANTHROPIC_API_KEY` secret only | Confirm the secret exists. It **cannot read the key**. |

**Functions runtime account.** 2nd-gen functions run as `PROJECT_NUMBER-compute@developer.gserviceaccount.com`, the
default compute account, because the 2001-Pioneer code does not set `serviceAccount`. The script waits for that
account to exist and grants it:
- `secretmanager.secretAccessor` on `ANTHROPIC_API_KEY`, which is the account the deploy binds the secret to
- `cloudbuild.builds.builder` and `logging.logWriter`, because newer projects build with this account

If a deploy reports a missing permission, the error names it. Only that permission needs adding.

## The Anthropic development key

- It is typed into Cloud Shell at a hidden prompt (`read -s`), piped straight into Secret Manager, and then cleared from the shell.
- It is never in the repository, in GitHub secrets, in workflow logs or in a file.
- The deployer can see that the secret exists but cannot read it. Only the deployed functions can.
- Use a key separate from production's, so it can be limited or revoked without affecting production.

## Running it

- **Automatic:** with `gh auth login` done in Cloud Shell, the script sets the GitHub variables, waits 60 seconds for IAM to propagate, and re-runs the latest dev deploy.
- **Manual:** Actions → "Deploy to dev (pioneer-2001-dev)" → latest run → Re-run all jobs, or push the commit to test to `deploy/dev`.

## Removing access

```bash
gcloud iam workload-identity-pools delete pioneer-dev-github --location=global --project pioneer-2001-dev
gcloud iam service-accounts delete pioneer-dev-deployer@pioneer-2001-dev.iam.gserviceaccount.com --project pioneer-2001-dev
gcloud iam roles delete pioneerDevDeployer --project pioneer-2001-dev
```
