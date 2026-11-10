#!/usr/bin/env bash
# READ-ONLY production snapshot for the 2001-Pioneer release (Cloud Shell).
#
#   bash scripts/prod-preflight.sh before     # just before deploying
#   bash scripts/prod-preflight.sh after      # right after deploying; prints a comparison with "before"
#
# Changes nothing. Only GET requests, Firestore count/list queries and gcloud list/describe
# commands. It never prints the Anthropic key; it checks only the key's first 7 characters and its
# length. Output is saved to ./preflight-<label>.txt in Cloud Shell only.
#
# Reports:
#   - deployed functions and their regions (expected: all us-central1)
#   - the Anthropic secret's enabled versions, and whether the latest looks like an Anthropic key
#   - AI settings: aiEnabled, aiModel
#   - record counts: clients, policies, statements, statement lines (collection group),
#     statement fingerprints, audit log
#   - stored statement PDFs (objects under statements/ in the default bucket)
#   - every statement's status, month, failure code and whether its original PDF is stored,
#     so the October and April records can be found
set -euo pipefail
PROJECT_ID="pioneer-285cf"
LABEL="${1:-before}"
case "$LABEL" in before|after) ;; *) echo "usage: $0 before|after" >&2; exit 2 ;; esac
export CLOUDSDK_CORE_PROJECT="$PROJECT_ID"
OUT="preflight-${LABEL}.txt"
TOKEN="$(gcloud auth print-access-token)"
H=(-H "Authorization: Bearer ${TOKEN}" -H "x-goog-user-project: ${PROJECT_ID}" -H "Content-Type: application/json")
FS="https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents"

count() { # $1 collection id, $2 "true" for collection group
  local scope=""; [ "${2:-}" = "true" ] && scope=',"allDescendants":true'
  curl -fsS "${H[@]}" -X POST "${FS}:runAggregationQuery" \
    -d "{\"structuredAggregationQuery\":{\"structuredQuery\":{\"from\":[{\"collectionId\":\"$1\"${scope}}]},\"aggregations\":[{\"alias\":\"n\",\"count\":{}}]}}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["result"]["aggregateFields"]["n"]["integerValue"])'
}

{
  echo "2001-Pioneer production snapshot (${LABEL}) — $(date -u +%FT%TZ) — project ${PROJECT_ID}"
  echo
  echo "== Functions (name, region, state)"
  curl -fsS "${H[@]}" "https://cloudfunctions.googleapis.com/v2/projects/${PROJECT_ID}/locations/-/functions?pageSize=200" | python3 -c '
import json,sys,collections
fs=json.load(sys.stdin).get("functions",[])
regions=collections.Counter()
for f in sorted(fs,key=lambda f:f["name"]):
    p=f["name"].split("/"); regions[p[3]]+=1
    print("  {:<26} {:<12} {}".format(p[5], p[3], f.get("state", "?")))
print("  regions:", dict(regions) or "none")
bad=[r for r in regions if r!="us-central1"]
print("  CHECK:", "OK - all us-central1" if fs and not bad else ("WARNING - functions outside us-central1: "+", ".join(bad) if bad else "WARNING - no functions found"))'
  echo
  echo "== Anthropic secret ANTHROPIC_API_KEY (value never shown)"
  gcloud secrets versions list ANTHROPIC_API_KEY --project "$PROJECT_ID" --filter="state=ENABLED" --format="value(name)" 2>/dev/null \
    | sed 's#.*/##' | tr '\n' ' ' | sed 's/^/  enabled versions: /'; echo
  PFX="$(gcloud secrets versions access latest --secret ANTHROPIC_API_KEY --project "$PROJECT_ID" 2>/dev/null | cut -c1-7 | head -n1 || true)"
  LEN="$(gcloud secrets versions access latest --secret ANTHROPIC_API_KEY --project "$PROJECT_ID" 2>/dev/null | tr -d '\n' | wc -c || echo 0)"
  [ "$PFX" = "sk-ant-" ] && echo "  CHECK: OK - latest version starts with sk-ant- (${LEN} characters)" || echo "  CHECK: WARNING - latest version does not look like an Anthropic key"
  unset PFX
  echo
  echo "== AI settings (settings/app)"
  curl -fsS "${H[@]}" "${FS}/settings/app" | python3 -c '
import json,sys
f=json.load(sys.stdin).get("fields",{})
v=lambda k: list(f.get(k,{}).values())[0] if k in f else None
print("  aiEnabled: {}   aiModel: {}   aiMonthlyCallLimit: {}".format(v("aiEnabled"), v("aiModel"), v("aiMonthlyCallLimit")))
print("  CHECK:", "OK - claude-sonnet-5-5" if v("aiModel")=="claude-sonnet-5-5" else "ACTION - set Model to claude-sonnet-5-5 in Settings after the deploy")
start=v("snapshotStartMonth"); months=int(v("snapshotMonths") or 12)
if start:
    y,m=map(int,start.split("-")); e=(y*12+m-1)+months-1; end="%04d-%02d"%(e//12, e%12+1)
    print("  snapshot window: {} to {} ({} months)".format(start, end, months))
    print("  CHECK:", "OK - October 2026 is inside the window" if start<="2026-10"<=end else "ACTION - October 2026 is OUTSIDE the window: postings for it will not show on the Dashboard until the window (Settings) includes 2026-10")
else:
    print("  CHECK: ACTION - no snapshot window set (Settings)")'
  echo
  echo "== Record counts"
  for c in clients policies statements statementKeys carriers brokers ledger auditLog; do printf '  %-16s %s\n' "$c" "$(count "$c")"; done
  printf '  %-16s %s\n' "statement lines" "$(count lines true)"
  echo
  echo "== Stored statement PDFs"
  for b in "${PROJECT_ID}.firebasestorage.app" "${PROJECT_ID}.appspot.com"; do
    if gcloud storage buckets describe "gs://${b}" --project "$PROJECT_ID" >/dev/null 2>&1; then
      N="$(gcloud storage ls "gs://${b}/statements/**" --project "$PROJECT_ID" 2>/dev/null | wc -l || echo 0)"
      echo "  gs://${b}/statements/: ${N} objects"
    fi
  done
  echo
  echo "== Statements (month, status, failure, original stored, file)"
  curl -fsS "${H[@]}" -X POST "${FS}:runQuery" \
    -d '{"structuredQuery":{"from":[{"collectionId":"statements"}],"select":{"fields":[{"fieldPath":"statementMonth"},{"fieldPath":"status"},{"fieldPath":"failure"},{"fieldPath":"originalPath"},{"fieldPath":"fileName"}]},"limit":500}}' \
    | python3 -c '
import json,sys
rows=[]
for r in json.load(sys.stdin):
    d=r.get("document")
    if not d: continue
    f=d.get("fields",{}); g=lambda k:(list(f[k].values())[0] if k in f else None)
    fail=(f.get("failure",{}).get("mapValue",{}).get("fields",{}).get("code",{}).get("stringValue")) or ""
    rows.append((g("statementMonth") or "-", g("status") or "-", fail, "yes" if g("originalPath") else "NO", g("fileName") or "-", d["name"].split("/")[-1]))
for m,s,fl,o,fn,i in sorted(rows):
    print("  {:<8} {:<18} {:<16} stored:{:<4} {}  [{}]".format(m, s, fl, o, fn, i))
print("  total: {}".format(len(rows)))'
} | tee "$OUT"

if [ "$LABEL" = "after" ] && [ -f preflight-before.txt ]; then
  echo; echo "== Comparison with preflight-before.txt (counts must not go down)"
  for k in clients policies statements statementKeys carriers brokers ledger "statement lines"; do
    b="$(grep -E "^  ${k} +[0-9]+$" preflight-before.txt | awk '{print $NF}')"; a="$(grep -E "^  ${k} +[0-9]+$" preflight-after.txt | awk '{print $NF}')"
    flag="OK"; [ -n "$b" ] && [ -n "$a" ] && [ "$a" -lt "$b" ] && flag="DECREASED — stop and investigate"
    printf '  %-16s before %-6s after %-6s %s\n' "$k" "${b:-?}" "${a:-?}" "$flag"
  done
  b="$(grep -E 'statements/: [0-9]+ objects' preflight-before.txt | grep -oE '[0-9]+ objects' | head -1)"; a="$(grep -E 'statements/: [0-9]+ objects' preflight-after.txt | grep -oE '[0-9]+ objects' | head -1)"
  echo "  stored PDFs      before ${b:-?}  after ${a:-?}"
fi
echo; echo "Saved to ${OUT}. Nothing in ${PROJECT_ID} was changed."
