#!/usr/bin/env bash
# One-time setup, in Google Cloud Shell, so GitHub Actions can deploy to the DEVELOPMENT project
# pioneer-2001-dev with Workload Identity Federation: no service-account keys, no Owner role.
#
#   bash scripts/setup-dev-wif.sh
#
# Safe to run again: every step checks before creating and changes only pioneer-2001-dev.
# It never touches pioneer-285cf (production).
#
# What it does:
#   1. Enables the APIs the deploy needs.
#   2. Creates the deployer service account github-dev-deployer and grants only the roles listed below.
#   3. Creates Workload Identity pool "github" and provider "github-2001-pioneer". The provider accepts
#      GitHub tokens only from repository ID 1447842031 (njdeso/2001-Pioneer), branch deploy/dev,
#      workflow .github/workflows/deploy-dev.yml and environment "development".
#   4. Stores your separate Anthropic DEVELOPMENT key in pioneer-2001-dev Secret Manager. You type it
#      at a hidden prompt; it is not echoed, logged or written to disk. The deployer can see that the
#      secret exists but cannot read it; only the functions' runtime account can.
#   5. Sets the GitHub variables GCP_WIF_PROVIDER and GCP_DEV_SERVICE_ACCOUNT (with the gh CLI if you
#      are signed in, otherwise prints them) and re-runs the dev deploy.
set -euo pipefail

PROJECT_ID="pioneer-2001-dev"
PROD_PROJECT_ID="pioneer-285cf"
GITHUB_REPO="njdeso/2001-Pioneer"
GITHUB_REPO_ID="1447842031"            # permanent GitHub repository ID (survives renames)
DEPLOY_BRANCH="deploy/dev"
WORKFLOW_PATH=".github/workflows/deploy-dev.yml"
GITHUB_ENVIRONMENT="development"
POOL_ID="github"
PROVIDER_ID="github-2001-pioneer"
SA_NAME="github-dev-deployer"
SECRET_NAME="ANTHROPIC_API_KEY"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$PROJECT_ID" != "$PROD_PROJECT_ID" ] || die "Refusing: this script is for the development project only."
command -v gcloud >/dev/null || die "Run this in Google Cloud Shell (gcloud not found)."

step "0. Checking ${PROJECT_ID}"
gcloud projects describe "$PROJECT_ID" --format='value(projectId)' >/dev/null 2>&1 \
  || die "Cannot see project ${PROJECT_ID}. Sign in to Cloud Shell with the account that owns it."
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"   # default runtime + build account for 2nd-gen functions
ok "project number ${PROJECT_NUMBER}"
BILLING="$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null || echo unknown)"
[ "$BILLING" = "True" ] && ok "billing enabled (Blaze)" || warn "Could not confirm billing. Cloud Functions needs the Blaze plan on ${PROJECT_ID}."

step "1. Enabling APIs (only in ${PROJECT_ID})"
gcloud services enable --project "$PROJECT_ID" \
  iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com cloudresourcemanager.googleapis.com \
  serviceusage.googleapis.com cloudbilling.googleapis.com firebase.googleapis.com firebaserules.googleapis.com \
  firestore.googleapis.com firebasestorage.googleapis.com storage.googleapis.com identitytoolkit.googleapis.com \
  cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  eventarc.googleapis.com pubsub.googleapis.com secretmanager.googleapis.com logging.googleapis.com
ok "APIs enabled"

step "2. Checking Firebase basics"
gcloud firestore databases describe --database='(default)' --project "$PROJECT_ID" >/dev/null 2>&1 \
  && ok "Firestore database exists" \
  || die "No Firestore database in ${PROJECT_ID}. Firebase console → Firestore → Create database (same location as production), then run this again."
BUCKET=""
for b in "${PROJECT_ID}.firebasestorage.app" "${PROJECT_ID}.appspot.com"; do
  if gcloud storage buckets describe "gs://${b}" --project "$PROJECT_ID" >/dev/null 2>&1; then BUCKET="$b"; break; fi
done
[ -n "$BUCKET" ] && ok "Storage bucket gs://${BUCKET}" \
  || die "No default Storage bucket in ${PROJECT_ID}. Firebase console → Storage → Get started, then run this again."
WEBAPPS="$(curl -fsS -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "x-goog-user-project: ${PROJECT_ID}" \
  "https://firebase.googleapis.com/v1beta1/projects/${PROJECT_ID}/webApps" | grep -c '"appId"' || true)"
[ "${WEBAPPS:-0}" -gt 0 ] && ok "Firebase web app registered" \
  || die "No Firebase web app in ${PROJECT_ID}. Firebase console → Project settings → Your apps → Web (</>), then run this again."
warn "Make sure Authentication → Sign-in method → Email/Password is enabled in ${PROJECT_ID} (needed to sign in to the dev app)."

step "3. Deployer service account (no keys)"
if gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT_ID" >/dev/null 2>&1; then
  ok "${SA_EMAIL} exists"
else
  gcloud iam service-accounts create "$SA_NAME" --project "$PROJECT_ID" \
    --display-name="GitHub Actions dev deployer (2001-Pioneer)" \
    --description="Deploys 2001-Pioneer to pioneer-2001-dev from GitHub Actions via Workload Identity Federation. No keys."
  ok "created ${SA_EMAIL}"
fi
KEYS="$(gcloud iam service-accounts keys list --iam-account "$SA_EMAIL" --project "$PROJECT_ID" --managed-by=user --format='value(name)' | wc -l)"
[ "$KEYS" -eq 0 ] && ok "no user-managed keys" || warn "${SA_EMAIL} has ${KEYS} downloaded key(s); delete them (IAM → Service accounts → Keys)."

grant_project() { gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$1" --role="$2" --condition=None --quiet >/dev/null && ok "$2 → ${1%%@*}"; }

step "4. Least-privilege roles for the deployer (project ${PROJECT_ID} only)"
# Deploy Firestore and Storage security rules
grant_project "$SA_EMAIL" roles/firebaserules.admin
# Deploy Firestore indexes
grant_project "$SA_EMAIL" roles/datastore.indexAdmin
# Seed reference data and set dev AI settings for the smoke test
grant_project "$SA_EMAIL" roles/datastore.user
# Deploy 2nd-gen Cloud Functions
grant_project "$SA_EMAIL" roles/cloudfunctions.admin
# 2nd-gen functions are Cloud Run services; callable functions need a public invoker policy
grant_project "$SA_EMAIL" roles/run.admin
# Function build images; the deploy sets the cleanup policy on the gcf-artifacts repository
grant_project "$SA_EMAIL" roles/artifactregistry.admin
# Read project, web-app config and billing status (firebase-tools and the smoke test)
grant_project "$SA_EMAIL" roles/firebase.viewer
# Use the APIs enabled above (no right to enable or disable APIs)
grant_project "$SA_EMAIL" roles/serviceusage.serviceUsageConsumer

step "5. Resource-scoped grants"
# Deploy functions that run as the default compute account (actAs on that one account only)
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" --project "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" --role=roles/iam.serviceAccountUser --quiet >/dev/null && ok "serviceAccountUser on ${RUNTIME_SA}"
# Sign the smoke-test user's custom token with IAM signBlob (no private key)
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" --project "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" --role=roles/iam.serviceAccountTokenCreator --quiet >/dev/null && ok "serviceAccountTokenCreator on itself"
# Upload the synthetic smoke-test PDFs (this one bucket only)
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${SA_EMAIL}" --role=roles/storage.objectAdmin --quiet >/dev/null && ok "storage.objectAdmin on gs://${BUCKET}"
# 2nd-gen builds run as the compute account on newer projects
grant_project "$RUNTIME_SA" roles/cloudbuild.builds.builder
grant_project "$RUNTIME_SA" roles/logging.logWriter

step "6. Anthropic DEVELOPMENT key → Secret Manager (${PROJECT_ID})"
if gcloud secrets describe "$SECRET_NAME" --project "$PROJECT_ID" >/dev/null 2>&1; then
  ok "secret ${SECRET_NAME} already exists; left unchanged"
  echo "    (To replace it later: run this script with ROTATE_KEY=1.)"
fi
if ! gcloud secrets describe "$SECRET_NAME" --project "$PROJECT_ID" >/dev/null 2>&1 || [ "${ROTATE_KEY:-0}" = "1" ]; then
  echo "    Paste the Anthropic DEVELOPMENT API key (create a separate key for dev in the Anthropic Console)."
  echo "    It is not shown as you type or paste. Press Enter when done."
  IFS= read -rs -p "    Key: " ANTHROPIC_DEV_KEY; echo
  ANTHROPIC_DEV_KEY="$(printf '%s' "$ANTHROPIC_DEV_KEY" | tr -d '[:space:]')"
  case "$ANTHROPIC_DEV_KEY" in sk-ant-*) ;; *) unset ANTHROPIC_DEV_KEY; die "That does not look like an Anthropic key (should start with sk-ant-)." ;; esac
  if gcloud secrets describe "$SECRET_NAME" --project "$PROJECT_ID" >/dev/null 2>&1; then
    printf '%s' "$ANTHROPIC_DEV_KEY" | gcloud secrets versions add "$SECRET_NAME" --project "$PROJECT_ID" --data-file=- >/dev/null
    ok "added a new version of ${SECRET_NAME}"
  else
    printf '%s' "$ANTHROPIC_DEV_KEY" | gcloud secrets create "$SECRET_NAME" --project "$PROJECT_ID" --replication-policy=automatic --data-file=- >/dev/null
    ok "created ${SECRET_NAME}"
  fi
  unset ANTHROPIC_DEV_KEY
fi
# Deployer: see the secret and its versions; cannot read the value
gcloud secrets add-iam-policy-binding "$SECRET_NAME" --project "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" --role=roles/secretmanager.viewer --quiet >/dev/null && ok "deployer: secretmanager.viewer on ${SECRET_NAME} (cannot read the value)"
# Functions' runtime account: read the value at run time
gcloud secrets add-iam-policy-binding "$SECRET_NAME" --project "$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor --quiet >/dev/null && ok "runtime: secretAccessor on ${SECRET_NAME}"

step "7. Workload Identity Federation (GitHub → ${SA_NAME})"
if gcloud iam workload-identity-pools describe "$POOL_ID" --location=global --project "$PROJECT_ID" >/dev/null 2>&1; then
  ok "pool ${POOL_ID} exists"
else
  gcloud iam workload-identity-pools create "$POOL_ID" --location=global --project "$PROJECT_ID" \
    --display-name="GitHub Actions" --description="GitHub Actions OIDC for 2001-Pioneer dev deploys"
  ok "created pool ${POOL_ID}"
fi
CONDITION="assertion.repository_id == '${GITHUB_REPO_ID}' && assertion.ref == 'refs/heads/${DEPLOY_BRANCH}' && assertion.workflow_ref == '${GITHUB_REPO}/${WORKFLOW_PATH}@refs/heads/${DEPLOY_BRANCH}' && assertion.environment == '${GITHUB_ENVIRONMENT}'"
MAPPING="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.workflow_ref=assertion.workflow_ref,attribute.environment=assertion.environment"
if gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" --workload-identity-pool="$POOL_ID" --location=global --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers update-oidc "$PROVIDER_ID" --workload-identity-pool="$POOL_ID" --location=global --project "$PROJECT_ID" \
    --attribute-mapping="$MAPPING" --attribute-condition="$CONDITION" >/dev/null
  ok "provider ${PROVIDER_ID} updated"
else
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" --workload-identity-pool="$POOL_ID" --location=global --project "$PROJECT_ID" \
    --display-name="2001-Pioneer deploy-dev" --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="$MAPPING" --attribute-condition="$CONDITION" >/dev/null
  ok "created provider ${PROVIDER_ID}"
fi
echo "    accepts only: repo ${GITHUB_REPO} (id ${GITHUB_REPO_ID}), ${DEPLOY_BRANCH}, ${WORKFLOW_PATH}, environment ${GITHUB_ENVIRONMENT}"
POOL_NAME="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}"
PROVIDER_NAME="${POOL_NAME}/providers/${PROVIDER_ID}"
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" --project "$PROJECT_ID" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/${POOL_NAME}/attribute.repository_id/${GITHUB_REPO_ID}" --quiet >/dev/null
ok "the repository's federated identity may act as ${SA_EMAIL} (provider condition still applies)"

step "8. GitHub variables (not secrets: these values identify, they do not authenticate)"
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  gh variable set GCP_WIF_PROVIDER --repo "$GITHUB_REPO" --body "$PROVIDER_NAME" && ok "GCP_WIF_PROVIDER set"
  gh variable set GCP_DEV_SERVICE_ACCOUNT --repo "$GITHUB_REPO" --body "$SA_EMAIL" && ok "GCP_DEV_SERVICE_ACCOUNT set"
  if [ -n "${DEV_OWNER_EMAILS:-}" ]; then gh variable set DEV_OWNER_EMAILS --repo "$GITHUB_REPO" --body "$DEV_OWNER_EMAILS" && ok "DEV_OWNER_EMAILS set"; fi
  RUN_ID="$(gh run list --repo "$GITHUB_REPO" --workflow deploy-dev.yml --branch "$DEPLOY_BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)"
  if [ -n "$RUN_ID" ]; then
    gh run rerun "$RUN_ID" --repo "$GITHUB_REPO" && ok "re-running the dev deploy: https://github.com/${GITHUB_REPO}/actions/runs/${RUN_ID}"
  fi
else
  warn "gh is not signed in. Add these at github.com/${GITHUB_REPO} → Settings → Secrets and variables → Actions → Variables:"
  echo "      GCP_WIF_PROVIDER         = ${PROVIDER_NAME}"
  echo "      GCP_DEV_SERVICE_ACCOUNT  = ${SA_EMAIL}"
  echo "      DEV_OWNER_EMAILS         = (optional) your email, to claim the owner role in the dev app"
  echo "    Then Actions → \"Deploy to dev (pioneer-2001-dev)\" → latest run → Re-run all jobs."
fi

printf '\n\033[32mDone.\033[0m Nothing was changed outside %s.\n' "$PROJECT_ID"
