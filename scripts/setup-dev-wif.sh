#!/usr/bin/env bash
# One-time setup, in Google Cloud Shell, so GitHub Actions can deploy 2001-Pioneer to the
# DEVELOPMENT project pioneer-2001-dev with Workload Identity Federation: no service-account keys,
# no Owner/Editor, least privilege.
#
#   bash setup-dev-wif.sh
#
# Production safety: every gcloud command names --project pioneer-2001-dev (or a resource that
# belongs to it). CLOUDSDK_CORE_PROJECT is also forced to pioneer-2001-dev for this process only, so
# your Cloud Shell default project (even pioneer-285cf) is never used and never changed.
#
# Ownership safety: the script creates its own pool, provider, service account and custom role,
# each tagged with the marker below. If one of those IDs already exists WITHOUT the marker, the
# script stops instead of modifying it. Safe to run again.
set -euo pipefail

# ---- Must match .github/workflows/deploy-dev.yml (checked in CI by scripts/check-dev-wif-config.mjs)
PROJECT_ID="pioneer-2001-dev"
PROD_PROJECT_ID="pioneer-285cf"
GITHUB_REPO="njdeso/2001-Pioneer"
GITHUB_REPO_ID="1447842031"            # permanent numeric repository ID (verified below)
GITHUB_OWNER_ID="347520685"            # permanent numeric owner ID (verified below)
DEPLOY_BRANCH="deploy/dev"
WORKFLOW_PATH=".github/workflows/deploy-dev.yml"
GITHUB_ENVIRONMENT="development"
POOL_ID="pioneer-dev-github"           # dedicated pool: no other provider can share its principals
PROVIDER_ID="deploy-dev"
SA_NAME="pioneer-dev-deployer"
CUSTOM_ROLE_ID="pioneerDevDeployer"
SECRET_NAME="ANTHROPIC_API_KEY"
VAR_PROVIDER="GCP_WIF_PROVIDER"
VAR_SA="GCP_DEV_SERVICE_ACCOUNT"
MARKER="managed-by=2001-pioneer/setup-dev-wif"
# ----

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$PROJECT_ID" != "$PROD_PROJECT_ID" ] || die "Refusing: this script is for the development project only."
command -v gcloud >/dev/null || die "Run this in Google Cloud Shell (gcloud not found)."

# Never use the Cloud Shell default project, whatever it is. This affects only this script's process.
DEFAULT_PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
export CLOUDSDK_CORE_PROJECT="$PROJECT_ID"
unset CLOUDSDK_CORE_PROJECT_NUMBER GOOGLE_CLOUD_PROJECT 2>/dev/null || true

step "0. Checks"
[ -n "$DEFAULT_PROJECT" ] && echo "    Cloud Shell default project is \"${DEFAULT_PROJECT}\"; it is ignored and left unchanged."
FOUND="$(gcloud projects describe "$PROJECT_ID" --format='value(projectId)' 2>/dev/null || true)"
[ "$FOUND" = "$PROJECT_ID" ] || die "Cannot see project ${PROJECT_ID}. Sign in to Cloud Shell with the account that owns it."
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
# 2nd-gen Cloud Functions run as the default compute account unless the code sets serviceAccount
# (2001-Pioneer does not). The Anthropic secret is granted to exactly this account below.
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
CUSTOM_ROLE="projects/${PROJECT_ID}/roles/${CUSTOM_ROLE_ID}"
case "$SA_EMAIL" in *"@${PROD_PROJECT_ID}."*) die "Refusing: service account would be in production." ;; esac
ok "project ${PROJECT_ID} (number ${PROJECT_NUMBER})"

GH_JSON="$(curl -fsS "https://api.github.com/repos/${GITHUB_REPO}" 2>/dev/null || true)"
if [ -n "$GH_JSON" ]; then
  GOT_ID="$(printf '%s' "$GH_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')"
  GOT_OWNER="$(printf '%s' "$GH_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)["owner"]["id"])')"
  [ "$GOT_ID" = "$GITHUB_REPO_ID" ] && [ "$GOT_OWNER" = "$GITHUB_OWNER_ID" ] \
    || die "GitHub reports ${GITHUB_REPO} as repo ${GOT_ID} / owner ${GOT_OWNER}, expected ${GITHUB_REPO_ID} / ${GITHUB_OWNER_ID}. Stopping."
  ok "GitHub repository ${GITHUB_REPO} = id ${GITHUB_REPO_ID}, owner id ${GITHUB_OWNER_ID}"
else
  warn "Could not reach api.github.com to re-verify the repository ID; using ${GITHUB_REPO_ID} (verified when this script was written)."
fi

BILLING="$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null || echo unknown)"
[ "$BILLING" = "True" ] && ok "billing enabled (Blaze)" || warn "Could not confirm billing. Cloud Functions needs the Blaze plan on ${PROJECT_ID}."

step "1. Enabling APIs (${PROJECT_ID} only)"
gcloud services enable --project "$PROJECT_ID" \
  iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com cloudresourcemanager.googleapis.com \
  serviceusage.googleapis.com cloudbilling.googleapis.com compute.googleapis.com firebase.googleapis.com \
  firebaserules.googleapis.com firestore.googleapis.com firebasestorage.googleapis.com storage.googleapis.com \
  identitytoolkit.googleapis.com cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com eventarc.googleapis.com pubsub.googleapis.com secretmanager.googleapis.com \
  logging.googleapis.com
ok "APIs enabled"
for i in $(seq 1 24); do
  gcloud iam service-accounts describe "$RUNTIME_SA" --project "$PROJECT_ID" >/dev/null 2>&1 && break
  [ "$i" = 24 ] && die "The default compute account ${RUNTIME_SA} does not exist (Compute Engine API just enabled?). Wait a minute and run again."
  sleep 5
done
ok "functions runtime account ${RUNTIME_SA}"

step "2. Firebase basics in ${PROJECT_ID}"
gcloud firestore databases describe --database='(default)' --project "$PROJECT_ID" >/dev/null 2>&1 \
  && ok "Firestore database exists" \
  || die "No Firestore database in ${PROJECT_ID}. Firebase console → Firestore → Create database, then run this again."
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

step "3. Deployer service account ${SA_EMAIL} (no keys)"
if gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT_ID" >/dev/null 2>&1; then
  DESC="$(gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT_ID" --format='value(description)')"
  case "$DESC" in *"$MARKER"*) ok "exists (created by this script)" ;;
    *) die "${SA_EMAIL} already exists but was not created by this script. Not modifying it." ;; esac
else
  gcloud iam service-accounts create "$SA_NAME" --project "$PROJECT_ID" \
    --display-name="2001-Pioneer dev deployer (GitHub Actions)" \
    --description="Deploys 2001-Pioneer to ${PROJECT_ID} from GitHub Actions via Workload Identity Federation. No keys. ${MARKER}" >/dev/null
  ok "created"
fi
KEYS="$(gcloud iam service-accounts keys list --iam-account "$SA_EMAIL" --project "$PROJECT_ID" --managed-by=user --format='value(name)' | wc -l)"
[ "$KEYS" -eq 0 ] && ok "no downloaded keys" || die "${SA_EMAIL} has ${KEYS} downloaded key(s). Delete them (IAM → Service accounts → Keys) and run again."
if gcloud iam service-accounts describe "github-dev-deployer@${PROJECT_ID}.iam.gserviceaccount.com" --project "$PROJECT_ID" >/dev/null 2>&1; then
  warn "github-dev-deployer@${PROJECT_ID} (from the earlier key-based instructions) exists and is NOT used. Delete it and its keys:"
  echo "      gcloud iam service-accounts delete github-dev-deployer@${PROJECT_ID}.iam.gserviceaccount.com --project ${PROJECT_ID}"
fi

step "4. Custom role ${CUSTOM_ROLE_ID} (replaces Cloud Run Admin and Artifact Registry Admin)"
# Cloud Run: read the service behind each 2nd-gen function, apply its settings, and set the public
#   invoker policy that callable functions need. No create/delete of Cloud Run services.
# Artifact Registry: read and set the image cleanup policy on the functions' repository. No image access.
ROLE_PERMS="run.services.get,run.services.list,run.services.update,run.services.getIamPolicy,run.services.setIamPolicy,run.operations.get,artifactregistry.repositories.get,artifactregistry.repositories.list,artifactregistry.repositories.update"
if gcloud iam roles describe "$CUSTOM_ROLE_ID" --project "$PROJECT_ID" >/dev/null 2>&1; then
  RDESC="$(gcloud iam roles describe "$CUSTOM_ROLE_ID" --project "$PROJECT_ID" --format='value(description)')"
  case "$RDESC" in *"$MARKER"*) ;; *) die "Custom role ${CUSTOM_ROLE_ID} exists but was not created by this script. Not modifying it." ;; esac
  [ "$(gcloud iam roles describe "$CUSTOM_ROLE_ID" --project "$PROJECT_ID" --format='value(deleted)')" = "True" ] \
    && gcloud iam roles undelete "$CUSTOM_ROLE_ID" --project "$PROJECT_ID" >/dev/null
  gcloud iam roles update "$CUSTOM_ROLE_ID" --project "$PROJECT_ID" --permissions="$ROLE_PERMS" --stage=GA --quiet >/dev/null
  ok "updated"
else
  gcloud iam roles create "$CUSTOM_ROLE_ID" --project "$PROJECT_ID" --title="2001-Pioneer dev deployer" \
    --description="Minimum Cloud Run and Artifact Registry permissions for deploying 2nd-gen functions. ${MARKER}" \
    --permissions="$ROLE_PERMS" --stage=GA >/dev/null
  ok "created"
fi

grant_project() { gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$1" --role="$2" --condition=None --quiet >/dev/null && ok "$2 → ${1%%@*}"; }

step "5. Deployer roles (all in ${PROJECT_ID}; no Owner, no Editor)"
grant_project "$SA_EMAIL" "$CUSTOM_ROLE"                         # Cloud Run settings/invoker + image cleanup policy
grant_project "$SA_EMAIL" roles/cloudfunctions.developer         # create/update/delete functions (no IAM changes)
grant_project "$SA_EMAIL" roles/firebaserules.admin              # Firestore + Storage security rules
grant_project "$SA_EMAIL" roles/datastore.indexAdmin             # Firestore indexes
grant_project "$SA_EMAIL" roles/datastore.user                   # synthetic seed data + dev AI settings for the smoke test
grant_project "$SA_EMAIL" roles/firebase.viewer                  # read-only: project, web-app config, billing status
grant_project "$SA_EMAIL" roles/serviceusage.serviceUsageConsumer # use the enabled APIs (cannot enable/disable APIs)
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" --project "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" --role=roles/iam.serviceAccountUser --quiet >/dev/null \
  && ok "iam.serviceAccountUser on ${RUNTIME_SA} only (deploy functions that run as it)"
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" --project "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" --role=roles/iam.serviceAccountTokenCreator --quiet >/dev/null \
  && ok "iam.serviceAccountTokenCreator on itself only (sign the smoke-test sign-in token; no private key)"
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${SA_EMAIL}" --role=roles/storage.objectCreator --quiet >/dev/null \
  && ok "storage.objectCreator on gs://${BUCKET} only (upload synthetic test PDFs; cannot read or delete)"
# Remove broad roles this account must never hold (no-op if absent).
for r in roles/owner roles/editor roles/run.admin roles/artifactregistry.admin roles/cloudfunctions.admin; do
  gcloud projects remove-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${SA_EMAIL}" --role="$r" --all --quiet >/dev/null 2>&1 || true
done

step "6. Functions runtime account ${RUNTIME_SA}"
# Newer projects build 2nd-gen functions with this account and no longer give it Editor automatically.
grant_project "$RUNTIME_SA" roles/cloudbuild.builds.builder
grant_project "$RUNTIME_SA" roles/logging.logWriter

step "7. Anthropic DEVELOPMENT key → Secret Manager in ${PROJECT_ID}"
if gcloud secrets describe "$SECRET_NAME" --project "$PROJECT_ID" >/dev/null 2>&1 && [ "${ROTATE_KEY:-0}" != "1" ]; then
  ok "secret ${SECRET_NAME} already exists; left unchanged (ROTATE_KEY=1 to add a new version)"
else
  echo "    Paste the separate Anthropic DEVELOPMENT API key. Nothing is shown while you paste. Then press Enter."
  IFS= read -rs -p "    Key: " ANTHROPIC_DEV_KEY; echo
  ANTHROPIC_DEV_KEY="$(printf '%s' "$ANTHROPIC_DEV_KEY" | tr -d '[:space:]')"
  case "$ANTHROPIC_DEV_KEY" in sk-ant-*) ;; *) unset ANTHROPIC_DEV_KEY; die "That does not look like an Anthropic key (it should start with sk-ant-)." ;; esac
  if gcloud secrets describe "$SECRET_NAME" --project "$PROJECT_ID" >/dev/null 2>&1; then
    printf '%s' "$ANTHROPIC_DEV_KEY" | gcloud secrets versions add "$SECRET_NAME" --project "$PROJECT_ID" --data-file=- >/dev/null
    ok "added a new version"
  else
    printf '%s' "$ANTHROPIC_DEV_KEY" | gcloud secrets create "$SECRET_NAME" --project "$PROJECT_ID" --replication-policy=automatic --data-file=- >/dev/null
    ok "created ${SECRET_NAME}"
  fi
  unset ANTHROPIC_DEV_KEY
fi
gcloud secrets add-iam-policy-binding "$SECRET_NAME" --project "$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor --quiet >/dev/null \
  && ok "runtime account ${RUNTIME_SA}: secretAccessor (the functions read the key)"
gcloud secrets add-iam-policy-binding "$SECRET_NAME" --project "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" --role=roles/secretmanager.viewer --quiet >/dev/null \
  && ok "deployer: secretmanager.viewer on this secret only (sees it exists; cannot read the value)"

step "8. Workload Identity Federation"
POOL_NAME="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}"
PROVIDER_NAME="${POOL_NAME}/providers/${PROVIDER_ID}"
if gcloud iam workload-identity-pools describe "$POOL_ID" --location=global --project "$PROJECT_ID" >/dev/null 2>&1; then
  PDESC="$(gcloud iam workload-identity-pools describe "$POOL_ID" --location=global --project "$PROJECT_ID" --format='value(description)')"
  case "$PDESC" in *"$MARKER"*) ;; *) die "Workload Identity pool ${POOL_ID} exists but was not created by this script. Not modifying it." ;; esac
  [ "$(gcloud iam workload-identity-pools describe "$POOL_ID" --location=global --project "$PROJECT_ID" --format='value(state)')" = "DELETED" ] \
    && gcloud iam workload-identity-pools undelete "$POOL_ID" --location=global --project "$PROJECT_ID" >/dev/null
  ok "pool ${POOL_ID} (ours)"
else
  gcloud iam workload-identity-pools create "$POOL_ID" --location=global --project "$PROJECT_ID" \
    --display-name="2001-Pioneer GitHub (dev)" --description="GitHub Actions OIDC for 2001-Pioneer dev deploys only. ${MARKER}" >/dev/null
  ok "created pool ${POOL_ID}"
fi
# repository_id and repository_owner_id are numeric and survive renames; workflow_ref pins the file and branch.
CONDITION="assertion.repository_id == '${GITHUB_REPO_ID}' && assertion.repository_owner_id == '${GITHUB_OWNER_ID}' && assertion.ref == 'refs/heads/${DEPLOY_BRANCH}' && assertion.workflow_ref.endsWith('/${WORKFLOW_PATH}@refs/heads/${DEPLOY_BRANCH}') && assertion.environment == '${GITHUB_ENVIRONMENT}'"
MAPPING="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.workflow_ref=assertion.workflow_ref,attribute.environment=assertion.environment"
ISSUER="https://token.actions.githubusercontent.com"
if gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" --workload-identity-pool="$POOL_ID" --location=global --project "$PROJECT_ID" >/dev/null 2>&1; then
  VDESC="$(gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" --workload-identity-pool="$POOL_ID" --location=global --project "$PROJECT_ID" --format='value(description)')"
  VISS="$(gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" --workload-identity-pool="$POOL_ID" --location=global --project "$PROJECT_ID" --format='value(oidc.issuerUri)')"
  case "$VDESC" in *"$MARKER"*) ;; *) die "Provider ${PROVIDER_ID} exists but was not created by this script. Not modifying it." ;; esac
  [ "$VISS" = "$ISSUER" ] || die "Provider ${PROVIDER_ID} has issuer ${VISS}, expected ${ISSUER}. Not modifying it."
  [ "$(gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" --workload-identity-pool="$POOL_ID" --location=global --project "$PROJECT_ID" --format='value(state)')" = "DELETED" ] \
    && gcloud iam workload-identity-pools providers undelete "$PROVIDER_ID" --workload-identity-pool="$POOL_ID" --location=global --project "$PROJECT_ID" >/dev/null
  gcloud iam workload-identity-pools providers update-oidc "$PROVIDER_ID" --workload-identity-pool="$POOL_ID" --location=global --project "$PROJECT_ID" \
    --attribute-mapping="$MAPPING" --attribute-condition="$CONDITION" >/dev/null
  ok "provider ${PROVIDER_ID} (ours) — condition refreshed"
else
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" --workload-identity-pool="$POOL_ID" --location=global --project "$PROJECT_ID" \
    --display-name="deploy-dev.yml on deploy/dev" --description="Accepts only ${GITHUB_REPO} deploy-dev.yml on ${DEPLOY_BRANCH}, environment ${GITHUB_ENVIRONMENT}. ${MARKER}" \
    --issuer-uri="$ISSUER" --attribute-mapping="$MAPPING" --attribute-condition="$CONDITION" >/dev/null
  ok "created provider ${PROVIDER_ID}"
fi
echo "    accepts only: repo id ${GITHUB_REPO_ID} (owner ${GITHUB_OWNER_ID}), ref refs/heads/${DEPLOY_BRANCH}, ${WORKFLOW_PATH}, environment ${GITHUB_ENVIRONMENT}"
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" --project "$PROJECT_ID" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/${POOL_NAME}/attribute.repository_id/${GITHUB_REPO_ID}" --quiet >/dev/null
ok "only identities from that provider may act as ${SA_EMAIL}"

step "9. GitHub variables (identifiers, not secrets)"
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  gh variable set "$VAR_PROVIDER" --repo "$GITHUB_REPO" --body "$PROVIDER_NAME" && ok "${VAR_PROVIDER} set"
  gh variable set "$VAR_SA" --repo "$GITHUB_REPO" --body "$SA_EMAIL" && ok "${VAR_SA} set"
  if [ -n "${DEV_OWNER_EMAILS:-}" ]; then gh variable set DEV_OWNER_EMAILS --repo "$GITHUB_REPO" --body "$DEV_OWNER_EMAILS" && ok "DEV_OWNER_EMAILS set"; fi
  RUN_ID="$(gh run list --repo "$GITHUB_REPO" --workflow deploy-dev.yml --branch "$DEPLOY_BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)"
  if [ -n "$RUN_ID" ]; then
    echo "    Waiting 60 s for the IAM changes to take effect before starting the dev deploy…"; sleep 60
    gh run rerun "$RUN_ID" --repo "$GITHUB_REPO" && ok "dev deploy started: https://github.com/${GITHUB_REPO}/actions/runs/${RUN_ID}"
  fi
else
  warn "gh is not signed in. Add these at github.com/${GITHUB_REPO} → Settings → Secrets and variables → Actions → Variables:"
  echo "      ${VAR_PROVIDER} = ${PROVIDER_NAME}"
  echo "      ${VAR_SA} = ${SA_EMAIL}"
  echo "    Then Actions → \"Deploy to dev (pioneer-2001-dev)\" → latest run → Re-run all jobs."
fi

printf '\n\033[32mDone.\033[0m Nothing was changed outside %s. Your Cloud Shell default project was not changed.\n' "$PROJECT_ID"
