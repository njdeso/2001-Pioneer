#!/usr/bin/env python3
"""READ-ONLY content fingerprint of production Firestore (used by prod-preflight.sh and the backup restore test).

Reads every document of the business collections through the Firestore REST API (GET/list and count
queries only) and prints, per collection, the document count and a SHA-256 of the documents' names and
field values. If any customer, policy, statement, statement line (including its matching decision),
ledger entry or setting is added, changed or deleted, its hash changes. Also prints ledger financial
totals and the counts of the new collections this release adds (all must be 0 right after the deploy).

Usage: python3 scripts/prod-fingerprint.py <project-id> <access-token> [database-id]
       database-id defaults to "(default)" (the app's database); the backup restore test passes its
       temporary database so a restored copy can be compared with the live one.

Output (stdout): "  FP <name> <count> <sha256>", "  TOTAL <name> <value>", "  NEW <name> <count>", and a
final "  FP-COMPLETE ..." line. The FP-COMPLETE line is printed only when every read succeeded; the
preflight, the backup and the restore test refuse a snapshot without it.
Progress (stderr): one line per collection, so a slow run is visibly working.

Never hangs: every request has a 30-second timeout, temporary failures (timeouts, connection errors,
HTTP 429/500/502/503/504) are retried up to 4 times with backoff, and the whole run is limited to
FP_DEADLINE_SECONDS (default 1200). Any failure prints "FINGERPRINT FAILED: <reason>" and exits 2.
"""
import hashlib, json, os, socket, sys, time, urllib.error, urllib.parse, urllib.request

project, token = sys.argv[1], sys.argv[2]
database = sys.argv[3] if len(sys.argv) > 3 else "(default)"
BASE = f"https://firestore.googleapis.com/v1/projects/{project}/databases/{database}/documents"
HEAD = {"Authorization": f"Bearer {token}", "x-goog-user-project": project, "Content-Type": "application/json"}
REQUEST_TIMEOUT = 30
RETRIES = 4
DEADLINE = time.monotonic() + int(os.environ.get("FP_DEADLINE_SECONDS", "1200"))
STARTED = time.monotonic()
REQUESTS = 0


def progress(msg):
    print(f"    [fingerprint {time.monotonic() - STARTED:5.0f}s] {msg}", file=sys.stderr, flush=True)


def out(line):
    print(line, flush=True)


def fail(reason):
    print(f"FINGERPRINT FAILED: {reason}", file=sys.stderr, flush=True)
    out(f"  FINGERPRINT FAILED: {reason}")
    sys.exit(2)


def request(url, body=None):
    """One HTTP request with a timeout, retries for temporary failures, and the overall deadline."""
    global REQUESTS
    data = json.dumps(body).encode() if body is not None else None
    for attempt in range(1, RETRIES + 2):
        if time.monotonic() > DEADLINE:
            fail(f"time limit reached after {REQUESTS} requests (FP_DEADLINE_SECONDS). Nothing was changed.")
        REQUESTS += 1
        try:
            req = urllib.request.Request(url, data=data, headers=HEAD, method="POST" if data else "GET")
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:300].replace("\n", " ")
            if e.code in (429, 500, 502, 503, 504) and attempt <= RETRIES:
                reason = f"HTTP {e.code}"
            else:
                hint = " (permission denied or the access token expired: check gcloud is signed in as the project owner, then run the command again)" if e.code in (401, 403) else ""
                fail(f"HTTP {e.code} from Firestore{hint}: {detail}")
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError) as e:
            if attempt > RETRIES:
                fail(f"no answer from Firestore after {attempt} tries: {getattr(e, 'reason', e)}")
            reason = f"{type(e).__name__}: {getattr(e, 'reason', e)}"
        wait = min(2 ** attempt, 20)
        progress(f"temporary problem ({reason}); retrying in {wait}s (try {attempt + 1} of {RETRIES + 1})")
        time.sleep(wait)
    fail("unreachable")


def list_docs(path):
    """All documents directly under a collection path (e.g. 'clients' or 'statements/ID/lines')."""
    docs, page = [], None
    while True:
        q = {"pageSize": "300"}
        if page:
            q["pageToken"] = page
        j = request(f"{BASE}/{path}?{urllib.parse.urlencode(q)}")
        docs += j.get("documents", [])
        page = j.get("nextPageToken")
        if not page:
            return docs


def count(collection_id, all_descendants=False):
    """Server-side count of a collection (or, with all_descendants, every subcollection with that ID)."""
    frm = {"collectionId": collection_id}
    if all_descendants:
        frm["allDescendants"] = True
    j = request(f"{BASE}:runAggregationQuery", {"structuredAggregationQuery": {"structuredQuery": {"from": [frm]}, "aggregations": [{"alias": "n", "count": {}}]}})
    try:
        return int(j[0]["result"]["aggregateFields"]["n"]["integerValue"])
    except (KeyError, IndexError, TypeError, ValueError):
        fail(f"unexpected count response for {collection_id}: {str(j)[:200]}")


def fp(name, docs):
    h = hashlib.sha256()
    for d in sorted(docs, key=lambda d: d["name"]):
        h.update(d["name"].split("/documents/", 1)[1].encode())
        h.update(json.dumps(d.get("fields", {}), sort_keys=True, separators=(",", ":")).encode())
        h.update(b"\n")
    out(f"  FP {name:<22} {len(docs):>6} {h.hexdigest()}")


def num(f, k):
    v = f.get(k, {})
    return int(v.get("integerValue", 0)) if "integerValue" in v else int(float(v.get("doubleValue", 0)))


progress(f"project {project}, database {database}")
COLLECTIONS = ["clients", "policies", "policyKeys", "carriers", "brokers", "statements", "statementKeys", "ledger", "settings", "users"]
stores = {}
for c in COLLECTIONS:
    progress(f"reading {c} …")
    stores[c] = list_docs(c)
    fp(c, stores[c])
    progress(f"{c}: {len(stores[c])} documents")

# Statement lines (extracted values + matching decisions), statement by statement.
lines = []
for i, s in enumerate(stores["statements"], 1):
    sid = s["name"].rsplit("/", 1)[1]
    lines += list_docs(f"statements/{sid}/lines")
    if i % 5 == 0 or i == len(stores["statements"]):
        progress(f"statement lines: {i} of {len(stores['statements'])} statements read ({len(lines)} lines)")
fp("statement lines", lines)

# Ledger financial totals (every entry, originals and reversals; the net is what the reports show).
led = [d.get("fields", {}) for d in stores["ledger"]]
for k in ["amountCents", "brokerCents", "agencyCents"]:
    out(f"  TOTAL {k:<20} {sum(num(f, k) for f in led)}")
status = {}
for f in led:
    s = f.get("postingStatus", {}).get("stringValue", "-")
    status[s] = status.get(s, 0) + 1
out("  TOTAL by-postingStatus       " + json.dumps(dict(sorted(status.items()))))

# New in this release: must all be empty right after the deploy (nothing is created automatically).
# Coverage terms: one server-side count over every 'terms' subcollection (policies/*/terms), instead of
# one request per policy. It counts terms anywhere in the database, so it is at least as strict.
progress("counting coverage terms and the new broker-buyout collections …")
out(f"  NEW policy terms              {count('terms', all_descendants=True)}")
for c in ["brokerAdvances", "advanceImports", "buyoutSettlements", "buyoutCounters", "buyoutConfig"]:
    out(f"  NEW {c:<25} {count(c)}")

out(f"  FP-COMPLETE {len(COLLECTIONS) + 1} collections fingerprinted, {REQUESTS} requests, {time.monotonic() - STARTED:.0f}s")
progress("done")
