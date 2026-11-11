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

Never hangs: every request has a 60-second timeout, temporary failures (timeouts, connection errors,
HTTP 429/500/502/503/504) are retried up to 4 times with backoff, and the whole run is limited to
FP_DEADLINE_SECONDS (default 1200). Any failure prints "FINGERPRINT FAILED: <reason>" and exits 2.

Authentication: the access token is refreshed with `gcloud auth print-access-token` when a request gets
HTTP 401 (expired or invalid token) and proactively every 30 minutes; the request is then repeated. If a
freshly issued token is still refused, the run fails.

Pages hold 100 documents, so each request stays small and quick even on a just-imported database; a page
that times out is read again from the same position (reads only).
"""
import hashlib, json, os, socket, subprocess, sys, time, urllib.error, urllib.parse, urllib.request

project, token = sys.argv[1], sys.argv[2]
database = sys.argv[3] if len(sys.argv) > 3 else "(default)"
# FP_FIRESTORE_BASE is for the automated tests only and must point at this machine.
ROOT = os.environ.get("FP_FIRESTORE_BASE", "https://firestore.googleapis.com")
if ROOT != "https://firestore.googleapis.com" and not ROOT.startswith(("http://127.0.0.1:", "http://localhost:")):
    print("FINGERPRINT FAILED: FP_FIRESTORE_BASE may only point at localhost (tests).", file=sys.stderr)
    sys.exit(2)
BASE = f"{ROOT}/v1/projects/{project}/databases/{database}/documents"
REQUEST_TIMEOUT = int(os.environ.get("FP_REQUEST_TIMEOUT", "60"))
RETRIES = 4
PAGE_SIZE = 100
TOKEN_MAX_AGE = 30 * 60
TOKEN_AT = time.monotonic()
REFRESHES = 0
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


def refresh_token(why):
    """Get a new access token from gcloud (Cloud Shell / CI). Fails the run if gcloud cannot issue one."""
    global token, TOKEN_AT, REFRESHES
    try:
        r = subprocess.run(["gcloud", "auth", "print-access-token"], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as e:
        fail(f"could not refresh the access token ({why}): {e}")
    new = r.stdout.strip()
    if r.returncode != 0 or not new:
        fail(f"could not refresh the access token ({why}): {r.stderr.strip()[:200]}")
    token, TOKEN_AT, REFRESHES = new, time.monotonic(), REFRESHES + 1
    progress(f"access token refreshed ({why})")


def headers():
    return {"Authorization": f"Bearer {token}", "x-goog-user-project": project, "Content-Type": "application/json"}


def request(url, body=None):
    """One HTTP request with a timeout, token refresh, retries for temporary failures, and the overall deadline."""
    global REQUESTS
    data = json.dumps(body).encode() if body is not None else None
    refreshed_for_this_request = False
    attempt = 0
    while True:
        attempt += 1
        if time.monotonic() > DEADLINE:
            fail(f"time limit reached after {REQUESTS} requests (FP_DEADLINE_SECONDS). Nothing was changed.")
        if time.monotonic() - TOKEN_AT > TOKEN_MAX_AGE:
            refresh_token("token older than 30 minutes")
        REQUESTS += 1
        try:
            req = urllib.request.Request(url, data=data, headers=headers(), method="POST" if data else "GET")
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:300].replace("\n", " ")
            if e.code == 401 and not refreshed_for_this_request:
                # Expired or invalid token: get a fresh one and repeat this same read (does not use a retry).
                refresh_token("HTTP 401 from Firestore")
                refreshed_for_this_request = True
                attempt -= 1
                continue
            if e.code in (429, 500, 502, 503, 504) and attempt <= RETRIES:
                reason = f"HTTP {e.code}"
            else:
                hint = " (refused even with a freshly issued token: check gcloud is signed in as the project owner)" if e.code == 401 else " (permission denied: check gcloud is signed in as the project owner)" if e.code == 403 else ""
                fail(f"HTTP {e.code} from Firestore{hint}: {detail}")
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError) as e:
            if attempt > RETRIES:
                fail(f"no answer from Firestore after {attempt} tries: {getattr(e, 'reason', e)}")
            reason = f"{type(e).__name__}: {getattr(e, 'reason', e)}"
        if attempt > RETRIES:
            fail(f"gave up after {attempt} tries: {reason}")
        wait = min(2 ** attempt, 20)
        progress(f"temporary problem ({reason}); retrying in {wait}s (try {attempt + 1} of {RETRIES + 1})")
        time.sleep(wait)


def list_docs(path, show=False):
    """All documents directly under a collection path (e.g. 'clients' or 'statements/ID/lines')."""
    docs, page = [], None
    while True:
        q = {"pageSize": str(PAGE_SIZE)}
        if page:
            q["pageToken"] = page
        j = request(f"{BASE}/{path}?{urllib.parse.urlencode(q)}")
        docs += j.get("documents", [])
        page = j.get("nextPageToken")
        if show and page:
            progress(f"{path}: {len(docs)} read …")
        if not page:
            return docs


def group_docs(collection_id, parent_collection):
    """Every document of a subcollection ID across the database (collection-group query, paged by name),
    keeping only <parent_collection>/<id>/<collection_id>/<doc> — e.g. policies/*/terms/*."""
    docs, last = [], None
    while True:
        q = {"from": [{"collectionId": collection_id, "allDescendants": True}], "orderBy": [{"field": {"fieldPath": "__name__"}, "direction": "ASCENDING"}], "limit": PAGE_SIZE}
        if last:
            q["startAt"] = {"values": [{"referenceValue": last}], "before": False}
        rows = [r["document"] for r in request(f"{BASE}:runQuery", {"structuredQuery": q}) if "document" in r]
        for d in rows:
            parts = d["name"].split("/documents/", 1)[1].split("/")
            if len(parts) == 4 and parts[0] == parent_collection and parts[2] == collection_id:
                docs.append(d)
        if len(rows) < PAGE_SIZE:
            return docs
        last = rows[-1]["name"]


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
    stores[c] = list_docs(c, show=True)
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

# Coverage terms (content fingerprint + count) and the broker-buyout collections. The preflight's
# after-check requires each to equal the baseline: a release must not create, change or delete any.
progress("reading coverage terms (policies/*/terms) and counting the broker-buyout collections …")
terms = group_docs("terms", "policies")
fp("policy terms", terms)
n_terms = count("terms", all_descendants=True)
if n_terms != len(terms):
    fail(f"coverage terms: the server count ({n_terms}) differs from the documents read ({len(terms)}).")
out(f"  NEW policy terms              {n_terms}")
for c in ["brokerAdvances", "advanceImports", "buyoutSettlements", "buyoutCounters", "buyoutConfig"]:
    out(f"  NEW {c:<25} {count(c)}")

out(f"  FP-COMPLETE {len(COLLECTIONS) + 2} collections fingerprinted, {REQUESTS} requests, {REFRESHES} token refreshes, {time.monotonic() - STARTED:.0f}s")
progress("done")
