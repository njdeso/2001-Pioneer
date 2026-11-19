#!/usr/bin/env python3
"""
One-time correction: clients imported with the default classification "commercial" -> "personal".

Run in Cloud Shell, signed in to production with gcloud (Firestore REST with your own access token).
Only the `classification` field of client records is changed (plus `updatedAt`). Policies, policy lines,
premiums, carriers, commissions, statements, matching and the ledger are never read for writing or changed.

  python3 scripts/prod-client-classification-fix.py count                 # read-only: how many clients
  python3 scripts/prod-client-classification-fix.py snapshot              # read-only: writes the snapshot files
  python3 scripts/prod-client-classification-fix.py apply SNAPSHOT.json   # the change (asks you to confirm)
  python3 scripts/prod-client-classification-fix.py undo RESULT.json      # reverts only untouched clients

Safety:
  - snapshot: every affected client's ID, name, classification and the record's update time, saved as JSON
    and CSV in the current folder (Cloud Shell only; customer names never go to GitHub).
  - apply runs ONCE: it first creates maintenance/client-classification-2026-11 with "must not exist", so a
    second apply is refused. It changes only the clients in the snapshot, each with a precondition that the
    record has not changed since the snapshot: a client edited in between is skipped and reported, never
    overwritten. Clients you correct back to Commercial afterwards are never touched again.
  - one audit-log entry per changed client (action "update", changes.classification before/after), the
    marker record with the counts, and a result report (JSON + CSV: ID, name, original, new, result).
  - verification after apply: client count unchanged; every snapshot client now Personal or reported.
  - undo: sets back "commercial" only for clients whose record is still exactly as apply left it.
"""
import csv, datetime, json, os, secrets, subprocess, sys, urllib.error, urllib.request

PROJECT = 'pioneer-285cf'
MARKER = 'maintenance/client-classification-2026-11'
ACTOR = 'maintenance:client-classification-2026-11'
ROOT = f'projects/{PROJECT}/databases/(default)/documents'
BASE = f'https://firestore.googleapis.com/v1/{ROOT}'
CHUNK = 400

_token = None
def token():
    global _token
    if _token is None:
        _token = subprocess.check_output(['gcloud', 'auth', 'print-access-token'], text=True).strip()
    return _token

def http(method, url, body=None):
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), method=method,
                                 headers={'Authorization': f'Bearer {token()}', 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise SystemExit(f'Firestore HTTP {e.code} on {method} {url.split("/documents")[-1]}:\n{e.read().decode(errors="replace")}')

def read_clients():
    """Every client (id, name, classification, record update time), paged by document name: no index needed."""
    out, last = [], None
    while True:
        q = {'from': [{'collectionId': 'clients'}], 'select': {'fields': [{'fieldPath': 'name'}, {'fieldPath': 'classification'}]},
             'orderBy': [{'field': {'fieldPath': '__name__'}}], 'limit': 1000}
        if last: q['startAt'] = {'values': [{'referenceValue': last}], 'before': False}
        page = [d['document'] for d in http('POST', f'{BASE}:runQuery', {'structuredQuery': q}) if 'document' in d]
        for d in page:
            f = d.get('fields', {})
            out.append({'id': d['name'].rsplit('/', 1)[1], 'name': f.get('name', {}).get('stringValue', ''),
                        'classification': f.get('classification', {}).get('stringValue'), 'updateTime': d['updateTime']})
        if len(page) < 1000: return out
        last = page[-1]['name']

def affected(clients):
    return [c for c in clients if c['classification'] == 'commercial']

def tally(clients):
    t = {}
    for c in clients: t[c['classification'] or '(none)'] = t.get(c['classification'] or '(none)', 0) + 1
    return t

def write_files(stem, rows, fields):
    with open(f'{stem}.json', 'w') as f: json.dump(rows, f, indent=1)
    with open(f'{stem}.csv', 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore'); w.writeheader(); w.writerows(rows)
    os.chmod(f'{stem}.json', 0o600); os.chmod(f'{stem}.csv', 0o600)

def batch_write(writes):
    """Non-atomic batch: each write succeeds or fails on its own (per-write status)."""
    results = []
    for i in range(0, len(writes), CHUNK):
        r = http('POST', f'{BASE}:batchWrite', {'writes': writes[i:i + CHUNK]})
        st = r.get('status', [{}] * len(r.get('writeResults', [])))
        results += [(s.get('code', 0), s.get('message', ''), wr.get('updateTime')) for s, wr in zip(st, r.get('writeResults', []))]
    return results

def set_class(c, value, precondition_time):
    return {'update': {'name': f'{ROOT}/clients/{c["id"]}', 'fields': {'classification': {'stringValue': value}}},
            'updateMask': {'fieldPaths': ['classification']},
            'updateTransforms': [{'fieldPath': 'updatedAt', 'setToServerValue': 'REQUEST_TIME'}],
            'currentDocument': {'updateTime': precondition_time}}

def audit_write(c, before, after, operator, run):
    fields = {
        'actor': {'stringValue': ACTOR}, 'actorEmail': {'stringValue': operator}, 'action': {'stringValue': 'update'},
        'entityType': {'stringValue': 'client'}, 'entityId': {'stringValue': c['id']},
        'summary': {'stringValue': f'Classification corrected {before} -> {after} (bulk correction of imported default, run {run})'},
        'changes': {'mapValue': {'fields': {'classification': {'mapValue': {'fields': {'before': {'stringValue': before}, 'after': {'stringValue': after}}}}}}},
    }
    return {'update': {'name': f'{ROOT}/auditLog/{secrets.token_hex(10)}', 'fields': fields},
            'updateTransforms': [{'fieldPath': 'at', 'setToServerValue': 'REQUEST_TIME'}], 'currentDocument': {'exists': False}}

def marker_write(fields, must_exist):
    enc = {k: ({'integerValue': str(v)} if isinstance(v, int) else {'stringValue': str(v)}) for k, v in fields.items()}
    return {'update': {'name': f'{ROOT}/{MARKER}', 'fields': enc}, 'currentDocument': {'exists': must_exist}}

def operator_email():
    return subprocess.check_output(['gcloud', 'config', 'get-value', 'account'], text=True).strip()

def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')

def cmd_count():
    cl = read_clients()
    print(f'Clients: {len(cl)}   by classification: {tally(cl)}')
    print(f'Would change Commercial -> Personal: {len(affected(cl))}')

def cmd_snapshot():
    cl = read_clients(); aff = affected(cl); stem = f'client-classification-snapshot-{now()}'
    rows = [{**c, 'original': c['classification'], 'new': 'personal'} for c in aff]
    write_files(stem, rows, ['id', 'name', 'original', 'new', 'updateTime'])
    meta = {'takenAt': now(), 'project': PROJECT, 'clientCount': len(cl), 'byClassification': tally(cl), 'affected': len(aff)}
    with open(f'{stem}.meta.json', 'w') as f: json.dump(meta, f, indent=1)
    print(f'Clients: {len(cl)} {tally(cl)}; affected: {len(aff)}\nSnapshot: {stem}.json / .csv / .meta.json (this folder only)')

def cmd_apply(snapshot):
    with open(snapshot) as f: rows = json.load(f)
    with open(snapshot[:-len('.json')] + '.meta.json') as f: meta = json.load(f)
    if any(r.get('original') != 'commercial' for r in rows): raise SystemExit('Snapshot contains non-commercial rows; refusing.')
    before = read_clients()
    print(f'Clients now: {len(before)} (snapshot: {meta["clientCount"]}); snapshot rows to change: {len(rows)}')
    if input(f'Type CHANGE {len(rows)} to change these clients to Personal: ').strip() != f'CHANGE {len(rows)}': raise SystemExit('Not confirmed; nothing changed.')
    run, op = now(), operator_email()
    # 1. Single run: the marker must not exist yet (refused on a second apply).
    m = batch_write([marker_write({'status': 'started', 'run': run, 'operator': op, 'snapshot': os.path.basename(snapshot), 'planned': len(rows)}, False)])
    if m[0][0] != 0: raise SystemExit(f'Refused: {MARKER} already exists (this correction has already run). Nothing changed.\n{m[0][1]}')
    # 2. Each client only if unchanged since the snapshot.
    res = batch_write([set_class(r, 'personal', r['updateTime']) for r in rows])
    out = []
    for r, (code, msg, ut) in zip(rows, res):
        out.append({**r, 'result': 'updated' if code == 0 else ('skipped: changed since snapshot' if code == 9 else f'skipped: {code} {msg}'), 'writeTime': ut or ''})
    done = [r for r in out if r['result'] == 'updated']
    # 3. Audit entries for the changed clients; result report.
    ares = batch_write([audit_write(r, 'commercial', 'personal', op, run) for r in done])
    stem = f'client-classification-result-{run}'
    write_files(stem, out, ['id', 'name', 'original', 'new', 'result', 'updateTime', 'writeTime'])
    # 4. Verify.
    after = read_clients(); now_by_id = {c['id']: c for c in after}
    personal = sum(1 for r in done if now_by_id.get(r['id'], {}).get('classification') == 'personal')
    ok = len(after) == len(before) and personal == len(done)
    batch_write([marker_write({'status': 'done' if ok else 'done-with-differences', 'run': run, 'operator': op, 'snapshot': os.path.basename(snapshot),
                               'planned': len(rows), 'updated': len(done), 'skipped': len(out) - len(done), 'auditEntries': sum(1 for a in ares if a[0] == 0),
                               'clientsBefore': len(before), 'clientsAfter': len(after)}, True)])
    print(f'Updated {len(done)}, skipped {len(out) - len(done)} (changed since the snapshot; listed in the report).')
    print(f'Audit entries written: {sum(1 for a in ares if a[0] == 0)} of {len(done)}')
    print(f'Clients before {len(before)}, after {len(after)}; by classification now {tally(after)}')
    print(f'Report: {stem}.json / .csv\nVERIFIED: {"YES" if ok else "NO - see the report"}')

def cmd_undo(result):
    with open(result) as f: rows = [r for r in json.load(f) if r['result'] == 'updated']
    if input(f'Type UNDO {len(rows)} to set these clients back to Commercial where untouched since the correction: ').strip() != f'UNDO {len(rows)}': raise SystemExit('Not confirmed; nothing changed.')
    run, op = now(), operator_email()
    res = batch_write([set_class(r, 'commercial', r['writeTime']) for r in rows])
    reverted = [r for r, (code, _, _) in zip(rows, res) if code == 0]
    batch_write([audit_write(r, 'personal', 'commercial', op, f'undo-{run}') for r in reverted])
    batch_write([marker_write({'status': 'undone', 'run': run, 'operator': op, 'reverted': len(reverted), 'keptChanged': len(rows) - len(reverted)}, True)])
    print(f'Reverted {len(reverted)}; left {len(rows) - len(reverted)} that were edited after the correction.')

if __name__ == '__main__':
    a = sys.argv[1:]
    if a[:1] == ['count']: cmd_count()
    elif a[:1] == ['snapshot']: cmd_snapshot()
    elif a[:1] == ['apply'] and len(a) == 2: cmd_apply(a[1])
    elif a[:1] == ['undo'] and len(a) == 2: cmd_undo(a[1])
    else: raise SystemExit(__doc__)
