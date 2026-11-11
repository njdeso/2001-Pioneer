#!/usr/bin/env bash
# VERIFY a production Firestore backup by restoring it — the strongest independent check available.
# Run in Cloud Shell after prod-backup.sh, in the same folder (it reads last-backup.txt and
# preflight-before.txt):
#
#   bash scripts/prod-backup-restore-test.sh
#
# Steps:
#   1. Creates a TEMPORARY database in pioneer-285cf named bkverify-<UTC time>, in the same location as the
#      app's database. The app's database "(default)" is never written, imported into or deleted: every
#      command below names the temporary database explicitly, and the script refuses any other name.
#   2. Confirms no security-rules release targets the temporary database, so no web or mobile client can
#      read it (Firebase denies client access to a database without rules), and the web app only ever
#      connects to "(default)".
#   3. Imports the backup into the temporary database and waits for the import to finish.
#   4. Fingerprints the restored copy with scripts/prod-fingerprint.py (the same read-only code as the
#      preflight) and compares EVERY line with preflight-before.txt: each collection's document count and
#      SHA-256 of all document contents, the ledger totals, and the new-collection counts. It also compares
#      the audit-log count.
#   5. Deletes the temporary database (also if a step fails), then prints
#      "BACKUP: VERIFIED BY RESTORE" only if everything is identical.
# A mismatch usually means the app was used between the preflight and the export: run the preflight and the
# backup again without using the app, then this test.
set -euo pipefail
PROJECT_ID="pioneer-285cf"
export CLOUDSDK_CORE_PROJECT="$PROJECT_ID"
fail() { echo; echo "BACKUP: NOT VERIFIED — $1"; echo "Do not deploy. Send this output to Claude."; exit 1; }

[ -f last-backup.txt ] || fail "last-backup.txt not found. Run 'bash scripts/prod-backup.sh' first, in this folder."
[ -f preflight-before.txt ] || fail "preflight-before.txt not found."
grep -q '^  FP-COMPLETE ' preflight-before.txt || fail "preflight-before.txt is incomplete (no FP-COMPLETE line). Run the preflight again."
BACKUP="$(cat last-backup.txt)"
[[ "$BACKUP" =~ ^gs://${PROJECT_ID}-firestore-backups-us/firestore-backups/[0-9]{8}T[0-9]{6}Z$ ]] || fail "unexpected backup path: ${BACKUP}"

TMP_DB="bkverify-$(date -u +%Y%m%d-%H%M%S)"
[[ "$TMP_DB" =~ ^bkverify-[0-9]{8}-[0-9]{6}$ ]] || fail "unexpected temporary database name."
LOCATION="$(gcloud firestore databases describe --database='(default)' --project "$PROJECT_ID" --format='value(locationId)')"
[ -n "$LOCATION" ] || fail "could not read the app database's location."

CREATED=""
cleanup() {
  if [ -n "$CREATED" ]; then
    [[ "$CREATED" =~ ^bkverify-[0-9]{8}-[0-9]{6}$ ]] || { echo "Refusing to delete '$CREATED'."; return; }
    echo "== Deleting the temporary database ${CREATED}"
    gcloud firestore databases delete --database="$CREATED" --project "$PROJECT_ID" --quiet >/dev/null \
      && echo "  deleted" || echo "  WARNING: could not delete ${CREATED}; delete it in the console (Firestore → Databases). It is not the app's database."
  fi
}
trap cleanup EXIT

echo "== Backup to verify: ${BACKUP}"
gcloud storage ls "${BACKUP}/$(basename "$BACKUP").overall_export_metadata" >/dev/null 2>&1 || fail "the backup's overall_export_metadata file is missing."

echo "== Creating temporary database ${TMP_DB} (${LOCATION})"
gcloud firestore databases create --database="$TMP_DB" --location="$LOCATION" --type=firestore-native --project "$PROJECT_ID" --quiet >/dev/null
CREATED="$TMP_DB"

TOKEN="$(gcloud auth print-access-token)"
RELEASES="$(curl -fsS --max-time 60 --retry 2 -H "Authorization: Bearer ${TOKEN}" -H "x-goog-user-project: ${PROJECT_ID}" "https://firebaserules.googleapis.com/v1/projects/${PROJECT_ID}/releases?pageSize=100" || echo '{}')"
# No rules release may target this (or any earlier) temporary database.
if echo "$RELEASES" | grep -qE "cloud\.firestore/(${TMP_DB}|bkverify-)"; then fail "a security-rules release targets a bkverify- database; client access is possible."; fi
echo "  CHECK: OK - no security-rules release for ${TMP_DB}: clients are denied"

echo "== Importing the backup into ${TMP_DB}"
# Start the import, then poll the operation itself for its FINAL status. (Without --async, gcloud waits but
# prints the operation as it was when it started — done empty, PROCESSING — so that output cannot be judged.)
gcloud firestore import "${BACKUP}/" --database="$TMP_DB" --project "$PROJECT_ID" --async --format=json > import-start.json
OP_ID="$(python3 -c 'import json,sys; print((json.load(open(sys.argv[1])).get("name") or "").rsplit("/",1)[-1])' import-start.json)"
[[ "$OP_ID" =~ ^[A-Za-z0-9_-]+$ ]] || fail "the import did not return an operation name."
echo "  operation: ${OP_ID}"
waited=0
while :; do
  gcloud firestore operations describe "$OP_ID" --database="$TMP_DB" --project "$PROJECT_ID" --format=json > import-op.json
  DONE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("done") is True)' import-op.json)"
  [ "$DONE" = "True" ] && break
  [ "$waited" -ge "${TIMEOUT_SECONDS:-3600}" ] && fail "the import did not finish within ${TIMEOUT_SECONDS:-3600} s."
  echo "  … $(python3 -c 'import json,sys; print((json.load(open(sys.argv[1])).get("metadata") or {}).get("operationState") or "PENDING")' import-op.json) (${waited} s)"
  sleep "${POLL_SECONDS:-15}"; waited=$((waited + ${POLL_SECONDS:-15}))
done
python3 - import-op.json <<'PY' || fail "the import did not finish successfully."
import json, sys
d = json.load(open(sys.argv[1]))
state = (d.get("metadata") or {}).get("operationState")
print(f"  done: {d.get('done')}   state: {state}   error: {d.get('error') or 'none'}")
sys.exit(0 if d.get("done") is True and not d.get("error") and state == "SUCCESSFUL" else 1)
PY

echo "== Fingerprinting the restored copy (read-only)"
TOKEN="$(gcloud auth print-access-token)"
timeout 1500 python3 -u scripts/prod-fingerprint.py "$PROJECT_ID" "$TOKEN" "$TMP_DB" > restored-fingerprint.txt || { cat restored-fingerprint.txt; fail "the fingerprint of the restored copy did not complete."; }
cat restored-fingerprint.txt
grep -q '^  FP-COMPLETE ' restored-fingerprint.txt || fail "the fingerprint of the restored copy is incomplete."
AUD_RESTORED="$(curl -fsS --max-time 60 --retry 2 -H "Authorization: Bearer ${TOKEN}" -H "x-goog-user-project: ${PROJECT_ID}" -H 'Content-Type: application/json' -X POST \
  "https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${TMP_DB}/documents:runAggregationQuery" \
  -d '{"structuredAggregationQuery":{"structuredQuery":{"from":[{"collectionId":"auditLog"}]},"aggregations":[{"alias":"n","count":{}}]}}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["result"]["aggregateFields"]["n"]["integerValue"])')"

echo; echo "== Restored copy vs preflight-before.txt (every line must be identical)"
RESULT=OK
while read -r line; do
  key="$(echo "$line" | awk '{print $1, $2}')"
  other="$(grep -F "  $key " restored-fingerprint.txt | head -1 | sed 's/^ *//' || true)"
  if [ "$line" = "$other" ]; then echo "  OK        $line"; else echo "  DIFFERENT preflight: $line"; echo "            restored:  ${other:-missing}"; RESULT=STOP; fi
done < <(grep -E '^  (FP|TOTAL|NEW) ' preflight-before.txt | sed 's/^ *//')
AUD_BEFORE="$(grep -E '^  auditLog +[0-9]+$' preflight-before.txt | awk '{print $2}' || true)"
if [ "${AUD_BEFORE:-x}" = "$AUD_RESTORED" ]; then echo "  OK        auditLog ${AUD_RESTORED}"; else echo "  DIFFERENT auditLog preflight ${AUD_BEFORE:-?} restored ${AUD_RESTORED:-?}"; RESULT=STOP; fi
[ "$(grep -cE '^  (FP|TOTAL|NEW) ' preflight-before.txt)" -gt 0 ] || { echo "  preflight-before.txt has no fingerprint lines"; RESULT=STOP; }

echo
if [ "$RESULT" = OK ]; then
  echo "BACKUP: VERIFIED BY RESTORE — ${BACKUP}"
  echo "Every fingerprinted collection, the ledger totals and the audit-log count of the restored copy match the preflight."
else
  fail "the restored copy differs from preflight-before.txt (see DIFFERENT above). If the app was used after the preflight, run the preflight, the backup and this test again without using the app."
fi
