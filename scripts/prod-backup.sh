#!/usr/bin/env bash
# Firestore BACKUP of production (pioneer-285cf), run in Cloud Shell AFTER `prod-preflight.sh before`.
#
#   bash scripts/prod-backup.sh
#
# What it does (it changes no Firestore records):
#   1. Backup bucket: uses a DEDICATED private bucket, gs://pioneer-285cf-firestore-backups-us. If it does not
#      exist it asks before creating it (location US = the multi-region that holds nam5, uniform
#      bucket-level access, public access prevention enforced). It is not a Firebase Storage bucket, so the
#      web app and its storage rules can never reach it. Existing settings and IAM are checked every run:
#      public access prevention, uniform access, and no allUsers / allAuthenticatedUsers members.
#   2. Starts a managed export of the whole database to firestore-backups/<UTC time>/ in that bucket. If
#      point-in-time recovery is on, the export is taken at one consistent snapshot time; if not, that
#      limitation is reported (Google: an export is otherwise not an exact snapshot), and you must not use
#      the app while it runs.
#   3. WAITS for the export operation to finish (polls; up to 60 minutes), then requires:
#        done = true, no error, operationState = SUCCESSFUL,
#        the .overall_export_metadata file present and non-empty, and export data files present.
#   4. Document count: the operation's progressDocuments is documented by Google as an ESTIMATE. It is shown
#      next to the preflight baseline for information only; it never counts as verification, and an
#      unknown count never passes anything.
#   5. Result: "EXPORT COMPLETE — NOT YET VERIFIED". The backup is verified only by
#      `bash scripts/prod-backup-restore-test.sh`, which restores it into a temporary database and compares
#      every record with preflight-before.txt.
# The backup path is saved to ./last-backup.txt (Cloud Shell only).
set -euo pipefail
PROJECT_ID="pioneer-285cf"
# Location US (multi-region): the nam5 database can only export to "us" or us-central1…6 buckets.
# (An earlier bucket, gs://pioneer-285cf-firestore-backups, is in us-east1 and cannot be used; it is left
# untouched — delete it yourself in the console if it is empty and you no longer need it.)
BUCKET="gs://${PROJECT_ID}-firestore-backups-us"
REQUIRED_LOCATION="US"
POLL_SECONDS="${POLL_SECONDS:-15}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-3600}"
export CLOUDSDK_CORE_PROJECT="$PROJECT_ID"

fail() { echo; echo "BACKUP: FAILED — $1"; echo "Do not deploy. Send this output to Claude."; exit 1; }
json() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); v=eval(sys.argv[2], {'d': d}); print('' if v is None else v)" "$@"; }

[ -f preflight-before.txt ] || fail "preflight-before.txt not found. Run 'bash scripts/prod-preflight.sh before' first, in this folder."
grep -q "project ${PROJECT_ID}" preflight-before.txt || fail "preflight-before.txt is not a ${PROJECT_ID} snapshot."
grep -q '^  FP-COMPLETE ' preflight-before.txt || fail "preflight-before.txt is incomplete (no FP-COMPLETE line): the preflight did not finish. Run it again."

# ---------------------------------------------------------------- 1. dedicated private backup bucket
echo "== Backup bucket ${BUCKET}"
if ! gcloud storage buckets describe "$BUCKET" --project "$PROJECT_ID" --format=json > bucket.json 2>/dev/null; then
  echo "  The bucket does not exist yet. Creating it changes no app data: location US, uniform bucket-level"
  echo "  access, public access prevention enforced, not linked to Firebase Storage (the app cannot reach it)."
  read -r -p "  Create ${BUCKET}? Type yes to continue: " ok || ok=""
  [ "$ok" = "yes" ] || fail "bucket not created (you did not type yes)."
  gcloud storage buckets create "$BUCKET" --project "$PROJECT_ID" --location=US \
    --uniform-bucket-level-access --public-access-prevention --default-storage-class=STANDARD
  gcloud storage buckets describe "$BUCKET" --project "$PROJECT_ID" --format=json > bucket.json
fi
# gcloud storage prints snake_case keys; the JSON API uses iamConfiguration. Accept either; anything else fails.
UBLA="$(json bucket.json "d.get('uniform_bucket_level_access', ((d.get('iamConfiguration') or {}).get('uniformBucketLevelAccess') or {}).get('enabled'))")"
PAP="$(json bucket.json "d.get('public_access_prevention', (d.get('iamConfiguration') or {}).get('publicAccessPrevention'))")"
LOC="$(json bucket.json "d.get('location')")"
echo "  location: ${LOC}   uniform bucket-level access: ${UBLA}   public access prevention: ${PAP}"
[ "$(echo "$LOC" | tr '[:lower:]' '[:upper:]')" = "$REQUIRED_LOCATION" ] || fail "${BUCKET} is in location ${LOC:-unknown}, not ${REQUIRED_LOCATION}. The nam5 database cannot export there. Nothing was exported."
[ "$UBLA" = "True" ] || fail "uniform bucket-level access is not enabled on ${BUCKET}."
[ "$PAP" = "enforced" ] || fail "public access prevention is not enforced on ${BUCKET}."
gcloud storage buckets get-iam-policy "$BUCKET" --project "$PROJECT_ID" --format=json > bucket-iam.json
python3 - bucket-iam.json <<'PY' || fail "the bucket grants access to allUsers or allAuthenticatedUsers."
import json, sys
p = json.load(open(sys.argv[1]))
bad = False
for b in p.get("bindings", []):
    print(f"  IAM {b['role']}: {', '.join(b.get('members', []))}")
    if any(m in ("allUsers", "allAuthenticatedUsers") for m in b.get("members", [])): bad = True
sys.exit(1 if bad else 0)
PY
echo "  CHECK: OK - private bucket, no public members"

# ---------------------------------------------------------------- 2. start the export
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${BUCKET}/firestore-backups/${STAMP}"
PITR="$(gcloud firestore databases describe --database='(default)' --project "$PROJECT_ID" --format='value(pointInTimeRecoveryEnablement)' 2>/dev/null || true)"
SNAP_ARGS=()
if [ "$PITR" = "POINT_IN_TIME_RECOVERY_ENABLED" ]; then
  SNAP="$(date -u -d '1 minute ago' +%Y-%m-%dT%H:%M:00Z)"
  SNAP_ARGS=(--snapshot-time="$SNAP")
  echo "== Exporting a consistent snapshot as of ${SNAP} (point-in-time recovery is on) to ${DEST}"
else
  echo "== Exporting to ${DEST}"
  echo "  LIMITATION: point-in-time recovery is off, so Google does not guarantee the export is an exact"
  echo "  snapshot. Do not use the app until this finishes; the restore test will detect any difference."
fi
gcloud firestore export "$DEST" --project "$PROJECT_ID" --database='(default)' "${SNAP_ARGS[@]}" --async --format=json > export-start.json
OP="$(json export-start.json "d.get('name')")"
[ -n "$OP" ] || fail "the export did not return an operation name."
echo "  operation: ${OP}"

# ---------------------------------------------------------------- 3. wait for completion
waited=0
while :; do
  gcloud firestore operations describe "$OP" --project "$PROJECT_ID" --format=json > export-op.json
  DONE="$(json export-op.json "d.get('done')")"
  STATE="$(json export-op.json "d.get('metadata', {}).get('operationState')")"
  [ "$DONE" = "True" ] && break
  [ "$waited" -ge "$TIMEOUT_SECONDS" ] && fail "the export did not finish within ${TIMEOUT_SECONDS} s (last state ${STATE:-unknown}). It may still be running: check 'gcloud firestore operations list'."
  echo "  … ${STATE:-PENDING} (${waited} s)"
  sleep "$POLL_SECONDS"; waited=$((waited + POLL_SECONDS))
done
ERR="$(json export-op.json "d.get('error')")"
OUT="$(json export-op.json "d.get('metadata', {}).get('outputUriPrefix') or (d.get('response') or {}).get('outputUriPrefix')")"
echo "  done: ${DONE}   state: ${STATE:-missing}   error: ${ERR:-none}"
[ -z "$ERR" ] || fail "the export operation reported an error: ${ERR}"
[ "$STATE" = "SUCCESSFUL" ] || fail "the export operation state is ${STATE:-missing}, not SUCCESSFUL."
[ "${OUT%/}" = "$DEST" ] || fail "the operation wrote to ${OUT:-an unknown location}, not ${DEST}."

# ---------------------------------------------------------------- 4. files
META="${DEST}/${STAMP}.overall_export_metadata"
META_BYTES="$(gcloud storage ls -l "$META" 2>/dev/null | awk 'NR==1 {print $1}' || true)"
DATA_FILES="$(gcloud storage ls -r "${DEST}/**" 2>/dev/null | grep -c -E '/output-[0-9]+$' || true)"
TOTAL_BYTES="$(gcloud storage du -s "$DEST" 2>/dev/null | awk '{print $1}' || true)"
echo "  metadata file: ${META} (${META_BYTES:-MISSING} bytes)"
echo "  data files: ${DATA_FILES:-0}   total size: ${TOTAL_BYTES:-?} bytes"
[[ "${META_BYTES:-}" =~ ^[0-9]+$ ]] && [ "$META_BYTES" -gt 0 ] || fail "the overall_export_metadata file is missing or empty."
[ "${DATA_FILES:-0}" -gt 0 ] || fail "no export data files were written."

# ---------------------------------------------------------------- 5. document count (information only)
EST="$(json export-op.json "(d.get('metadata', {}).get('progressDocuments') or {}).get('completedWork')")"
BASE="$(grep -E '^  FP ' preflight-before.txt | awk '{s+=$3} END {print s+0}' || true)"
AUD="$(grep -E '^  auditLog +[0-9]+$' preflight-before.txt | awk '{print $2}' || true)"
echo "  documents reported by the export (Google's ESTIMATE, not proof): ${EST:-not reported}"
echo "  preflight baseline: ${BASE} documents in the fingerprinted collections + ${AUD:-?} audit-log entries"
echo "  (the export also holds collections the preflight does not fingerprint, so the numbers need not be equal)"

echo "$DEST" > last-backup.txt
echo
echo "EXPORT COMPLETE — NOT YET VERIFIED: ${DEST}"
echo "Next, verify it by restoring it into a temporary database and comparing every record:"
echo "  bash scripts/prod-backup-restore-test.sh"
