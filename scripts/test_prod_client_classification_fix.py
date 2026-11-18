#!/usr/bin/env python3
"""Offline test of scripts/prod-client-classification-fix.py against an in-memory Firestore (no network)."""
import importlib.util, io, json, os, tempfile, unittest, contextlib, builtins, itertools

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('fix', os.path.join(HERE, 'prod-client-classification-fix.py'))
fix = importlib.util.module_from_spec(spec); spec.loader.exec_module(fix)
ROOT = fix.ROOT
clock = itertools.count(1)
ts = lambda: f'2026-11-18T05:{next(clock) // 60:02d}:{next(clock) % 60:02d}.{next(clock):06d}Z'


class FakeFirestore:
    """Just enough of runQuery / batchWrite: update masks, transforms, exists/updateTime preconditions."""
    def __init__(self, clients, policies):
        self.docs = {}
        for c in clients: self.docs[f'clients/{c["id"]}'] = ({'name': {'stringValue': c['name']}, 'classification': {'stringValue': c['classification']}}, ts())
        for p in policies: self.docs[f'policies/{p["id"]}'] = ({'line': {'stringValue': p['line']}, 'clientId': {'stringValue': p['clientId']}}, ts())

    def http(self, method, url, body=None):
        if url.endswith(':runQuery'):
            coll = body['structuredQuery']['from'][0]['collectionId']
            return [{'document': {'name': f'{ROOT}/{k}', 'fields': f, 'updateTime': t}} for k, (f, t) in sorted(self.docs.items()) if k.startswith(coll + '/')]
        if url.endswith(':batchWrite'):
            res, st = [], []
            for w in body['writes']:
                key = w['update']['name'].replace(ROOT + '/', '')
                cur = self.docs.get(key)
                pre = w.get('currentDocument', {})
                if ('exists' in pre and pre['exists'] != (cur is not None)) or ('updateTime' in pre and (cur is None or cur[1] != pre['updateTime'])):
                    st.append({'code': 9, 'message': 'FAILED_PRECONDITION'}); res.append({}); continue
                fields = dict(cur[0]) if cur and 'updateMask' in w else {}
                for k in (w['updateMask']['fieldPaths'] if 'updateMask' in w else w['update']['fields'].keys()): fields[k] = w['update']['fields'][k]
                for t in w.get('updateTransforms', []): fields[t['fieldPath']] = {'timestampValue': 'REQUEST_TIME'}
                t = ts(); self.docs[key] = (fields, t); st.append({'code': 0}); res.append({'updateTime': t})
            return {'writeResults': res, 'status': st}
        raise AssertionError(url)

    def cls(self, cid): return self.docs[f'clients/{cid}'][0]['classification']['stringValue']
    def edit(self, cid, value): f, _ = self.docs[f'clients/{cid}']; f = dict(f); f['classification'] = {'stringValue': value}; self.docs[f'clients/{cid}'] = (f, ts())
    def coll(self, c): return {k: v for k, v in self.docs.items() if k.startswith(c + '/')}


class Test(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(); self.cwd = os.getcwd(); os.chdir(self.tmp)
        self.fs = FakeFirestore(
            [{'id': f'C{i}', 'name': f'Synthetic Client {i}', 'classification': 'commercial' if i < 7 else 'personal'} for i in range(10)],
            [{'id': f'P{i}', 'line': 'commercial', 'clientId': f'C{i}'} for i in range(10)])
        fix.http = self.fs.http
        fix.operator_email = lambda: 'owner@example.test'
        fix.token = lambda: 'x'
        self.answers = []
        builtins.input = lambda prompt='': self.answers.pop(0)

    def tearDown(self): os.chdir(self.cwd)

    def run_cmd(self, f, *a):
        out = io.StringIO()
        with contextlib.redirect_stdout(out): f(*a)
        return out.getvalue()

    def snapshot(self):
        self.run_cmd(fix.cmd_snapshot)
        return os.path.join(self.tmp, next(n for n in os.listdir(self.tmp) if n.startswith('client-classification-snapshot-') and n.endswith('.json') and not n.endswith('.meta.json')))

    def test_count_is_read_only(self):
        before = json.dumps(self.fs.docs, sort_keys=True)
        out = self.run_cmd(fix.cmd_count)
        self.assertIn("Clients: 10   by classification: {'commercial': 7, 'personal': 3}", out)
        self.assertIn('Would change Commercial -> Personal: 7', out)
        self.assertEqual(json.dumps(self.fs.docs, sort_keys=True), before)

    def test_apply_once_only_classification_changes_audit_and_report(self):
        snap = self.snapshot()
        rows = json.load(open(snap)); self.assertEqual([r['id'] for r in rows], [f'C{i}' for i in range(7)])
        policies_before = json.dumps(self.fs.coll('policies'), sort_keys=True)
        names_before = {k: v[0]['name'] for k, v in self.fs.coll('clients').items()}
        self.fs.edit('C3', 'personal')  # edited by someone between snapshot and apply
        self.answers = ['CHANGE 7']
        out = self.run_cmd(fix.cmd_apply, snap)
        self.assertIn('Updated 6, skipped 1', out)
        self.assertIn('Clients before 10, after 10', out)
        self.assertIn('VERIFIED: YES', out)
        self.assertTrue(all(self.fs.cls(f'C{i}') == 'personal' for i in range(10)))
        self.assertEqual(json.dumps(self.fs.coll('policies'), sort_keys=True), policies_before, 'policies untouched')
        self.assertEqual({k: v[0]['name'] for k, v in self.fs.coll('clients').items()}, names_before, 'names untouched')
        audits = [v[0] for v in self.fs.coll('auditLog').values()]
        self.assertEqual(len(audits), 6)
        self.assertTrue(all(a['entityType']['stringValue'] == 'client' and a['changes']['mapValue']['fields']['classification']['mapValue']['fields']['after']['stringValue'] == 'personal' for a in audits))
        marker = self.fs.docs[fix.MARKER][0]
        self.assertEqual((marker['status']['stringValue'], marker['updated']['integerValue'], marker['skipped']['integerValue']), ('done', '6', '1'))
        report = json.load(open(next(n for n in os.listdir(self.tmp) if n.startswith('client-classification-result-') and n.endswith('.json'))))
        self.assertEqual({r['id']: r['result'] for r in report}['C3'], 'skipped: changed since snapshot')
        self.assertEqual(sorted(report[0].keys()), ['classification', 'id', 'name', 'new', 'original', 'result', 'updateTime', 'writeTime'])
        # Manual correction afterwards, then an accidental rerun: refused, the correction stays.
        self.fs.edit('C1', 'commercial')
        self.answers = ['CHANGE 7']
        with self.assertRaises(SystemExit) as e: self.run_cmd(fix.cmd_apply, snap)
        self.assertIn('already exists', str(e.exception))
        self.assertEqual(self.fs.cls('C1'), 'commercial')
        # Undo: reverts only clients untouched since the correction (C1 was edited; C3 was never changed).
        result = next(os.path.join(self.tmp, n) for n in os.listdir(self.tmp) if n.startswith('client-classification-result-') and n.endswith('.json'))
        self.answers = ['UNDO 6']
        out = self.run_cmd(fix.cmd_undo, result)
        self.assertIn('Reverted 5; left 1', out)
        self.assertEqual([self.fs.cls(f'C{i}') for i in range(10)], ['commercial'] * 3 + ['personal'] + ['commercial'] * 3 + ['personal'] * 3)
        self.assertEqual(json.dumps(self.fs.coll('policies'), sort_keys=True), policies_before)

    def test_not_confirmed_changes_nothing(self):
        snap = self.snapshot(); before = json.dumps(self.fs.docs, sort_keys=True)
        self.answers = ['yes']
        with self.assertRaises(SystemExit): self.run_cmd(fix.cmd_apply, snap)
        self.assertEqual(json.dumps(self.fs.docs, sort_keys=True), before)

    def test_a_tampered_snapshot_is_refused(self):
        snap = self.snapshot(); rows = json.load(open(snap)); rows[0]['original'] = 'personal'; json.dump(rows, open(snap, 'w'))
        before = json.dumps(self.fs.docs, sort_keys=True)
        with self.assertRaises(SystemExit): self.run_cmd(fix.cmd_apply, snap)
        self.assertEqual(json.dumps(self.fs.docs, sort_keys=True), before)


if __name__ == '__main__':
    unittest.main(verbosity=2)
