#!/usr/bin/env python3
"""READ-ONLY content fingerprint of production Firestore (used by prod-preflight.sh).

Reads every document of the business collections through the Firestore REST API (GET/list only) and
prints, per collection, the document count and a SHA-256 of the documents' names and field values.
If any customer, policy, statement, statement line (including its matching decision), ledger entry or
setting is added, changed or deleted, its hash changes. Also prints ledger financial totals and the
counts of the new collections this release adds (all must be 0 right after the deploy).

Usage: python3 scripts/prod-fingerprint.py <project-id> <access-token> [database-id]
       database-id defaults to "(default)" (the app's database); the backup restore test passes its
       temporary database so a restored copy can be compared with the live one.
Prints lines of the form "  FP <name> <count> <sha256>" and "  TOTAL <name> <cents>". Changes nothing.
"""
import hashlib, json, sys, urllib.parse, urllib.request

project, token = sys.argv[1], sys.argv[2]
database = sys.argv[3] if len(sys.argv) > 3 else "(default)"
BASE = f"https://firestore.googleapis.com/v1/projects/{project}/databases/{database}/documents"
HEAD = {"Authorization": f"Bearer {token}", "x-goog-user-project": project}


def get(url):
    req = urllib.request.Request(url, headers=HEAD)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def list_docs(path):
    """All documents directly under a collection path (e.g. 'clients' or 'statements/ID/lines')."""
    docs, token_ = [], None
    while True:
        q = {"pageSize": "300"}
        if token_:
            q["pageToken"] = token_
        j = get(f"{BASE}/{path}?{urllib.parse.urlencode(q)}")
        docs += j.get("documents", [])
        token_ = j.get("nextPageToken")
        if not token_:
            return docs


def fp(name, docs):
    h = hashlib.sha256()
    for d in sorted(docs, key=lambda d: d["name"]):
        h.update(d["name"].split("/documents/", 1)[1].encode())
        h.update(json.dumps(d.get("fields", {}), sort_keys=True, separators=(",", ":")).encode())
        h.update(b"\n")
    print(f"  FP {name:<22} {len(docs):>6} {h.hexdigest()}")


def num(f, k):
    v = f.get(k, {})
    return int(v.get("integerValue", 0)) if "integerValue" in v else int(float(v.get("doubleValue", 0)))


stores = {}
for c in ["clients", "policies", "policyKeys", "carriers", "brokers", "statements", "statementKeys", "ledger", "settings", "users"]:
    stores[c] = list_docs(c)
    fp(c, stores[c])

# Statement lines (extracted values + matching decisions) and any other statement subcollections that exist.
lines = []
for s in stores["statements"]:
    sid = s["name"].rsplit("/", 1)[1]
    lines += list_docs(f"statements/{sid}/lines")
fp("statement lines", lines)

# Ledger financial totals (every entry, originals and reversals; the net is what the reports show).
led = [d.get("fields", {}) for d in stores["ledger"]]
for k in ["amountCents", "brokerCents", "agencyCents"]:
    print(f"  TOTAL {k:<20} {sum(num(f, k) for f in led)}")
status = {}
for f in led:
    s = f.get("postingStatus", {}).get("stringValue", "-")
    status[s] = status.get(s, 0) + 1
print("  TOTAL by-postingStatus       " + json.dumps(dict(sorted(status.items()))))

# New in this release: must all be empty right after the deploy (nothing is created automatically).
terms = 0
for p in stores["policies"]:
    terms += len(list_docs(f"policies/{p['name'].rsplit('/', 1)[1]}/terms"))
print(f"  NEW policy terms              {terms}")
for c in ["brokerAdvances", "advanceImports", "buyoutSettlements", "buyoutCounters", "buyoutConfig"]:
    print(f"  NEW {c:<25} {len(list_docs(c))}")
