#!/usr/bin/env bash
# Verified Firestore BACKUP of production (pioneer-285cf), run in Cloud Shell before the release.
#
#   bash scripts/prod-backup.sh
#
# Exports the whole database to gs://pioneer-285cf.firebasestorage.app/firestore-backups/<UTC time>/
# (a managed export: it reads the database and writes files to Storage; it changes no Firestore data).
# The storage rules deny every browser read/write outside incoming/, so the backup is not reachable
# from the web app. Then it VERIFIES the backup:
#   - the export operation finished with state SUCCESSFUL,
#   - the overall_export_metadata file exists,
#   - the number of documents exported is at least the number counted by the preflight.
# Prints the backup path; keep it with preflight-before.txt. Restoring is never part of the release.
set -euo pipefail
PROJECT_ID="pioneer-285cf"
BUCKET="gs://${PROJECT_ID}.firebasestorage.app"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${BUCKET}/firestore-backups/${STAMP}"
export CLOUDSDK_CORE_PROJECT="$PROJECT_ID"

echo "Exporting Firestore (${PROJECT_ID}) to ${DEST} …"
gcloud firestore export "$DEST" --project "$PROJECT_ID" --format=json > "backup-${STAMP}.json"

STATE="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("metadata",{}).get("operationState") or ("SUCCESSFUL" if d.get("done") and not d.get("error") else "UNKNOWN"))' "backup-${STAMP}.json")"
DOCS="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("metadata",{}).get("progressDocuments",{}).get("completedWork","?"))' "backup-${STAMP}.json")"
META="$(gcloud storage ls "${DEST}/*.overall_export_metadata" 2>/dev/null | head -1 || true)"
FILES="$(gcloud storage ls -r "${DEST}/**" 2>/dev/null | grep -c . || echo 0)"

echo "  operation state:     ${STATE}"
echo "  documents exported:  ${DOCS}"
echo "  metadata file:       ${META:-MISSING}"
echo "  files in backup:     ${FILES}"
EXPECTED=""
if [ -f preflight-before.txt ]; then
  EXPECTED="$(grep -E '^  FP ' preflight-before.txt | awk '{s+=$3} END {print s+0}')"
  echo "  documents counted by the preflight (business collections): ${EXPECTED}"
fi
if [ "$STATE" = "SUCCESSFUL" ] && [ -n "$META" ] && { [ -z "$EXPECTED" ] || [ "$DOCS" = "?" ] || [ "$DOCS" -ge "$EXPECTED" ]; }; then
  echo "BACKUP: VERIFIED — ${DEST}"
else
  echo "BACKUP: NOT VERIFIED — do not deploy; send this output to Claude."
  exit 1
fi
