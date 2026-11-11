// Tests for scripts/prod-backup-restore-test.sh with FAKE gcloud, curl and fingerprint output (no Google
// access). Checks: it never touches the app's "(default)" database, always deletes ONLY its own temporary
// database (also on failure), and prints "VERIFIED BY RESTORE" only when every line matches the preflight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve('scripts/prod-backup-restore-test.sh');
const BACKUP = 'gs://pioneer-285cf-firestore-backups-us/firestore-backups/20261110T210000Z';
const FP = ['  FP clients                   157 aaa', '  FP ledger                    310 bbb', '  TOTAL amountCents          123456', '  NEW policy terms              0'];
const DONE = '  FP-COMPLETE 11 collections fingerprinted, 30 requests, 12s';
const PREFLIGHT = ['2001-Pioneer production snapshot (before) — project pioneer-285cf', '  auditLog         40', ...FP, DONE].join('\n');

const GCLOUD = `#!/usr/bin/env bash
echo "gcloud $*" >> "$WORK/calls.log"
case "$*" in
  "firestore databases describe"*) echo nam5;;
  "storage ls"*) [ "$FAKE_META" = 1 ] || exit 1; echo ok;;
  "firestore databases create"*) [ "$FAKE_CREATE_FAILS" = 1 ] && exit 1; echo created;;
  "auth print-access-token"*) echo TOKEN;;
  "firestore import"*) echo '{"name":"projects/pioneer-285cf/databases/bkverify-x/operations/IMP1","done":null,"metadata":{"operationState":"PROCESSING"}}';;
  "firestore operations describe"*)
    n=$(cat "$WORK/polls" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$WORK/polls"
    if [ "$n" -lt 2 ]; then echo '{"done":false,"metadata":{"operationState":"PROCESSING"}}'; else echo "$FAKE_IMPORT_JSON"; fi;;
  "firestore databases delete"*) echo deleted;;
  *) echo "unexpected gcloud $*" >&2; exit 9;;
esac
`;
const CURL = `#!/usr/bin/env bash
echo "curl $*" >> "$WORK/calls.log"
case "$*" in
  *firebaserules*) echo "$FAKE_RELEASES";;
  *runAggregationQuery*) echo '[{"result":{"aggregateFields":{"n":{"integerValue":"'"$FAKE_AUDIT"'"}}}}]';;
  *) exit 7;;
esac
`;

function run(over = {}) {
  const work = mkdtempSync(join(tmpdir(), 'rt-'));
  const bin = join(work, 'bin'); mkdirSync(bin); mkdirSync(join(work, 'scripts'));
  writeFileSync(join(bin, 'gcloud'), GCLOUD); chmodSync(join(bin, 'gcloud'), 0o755);
  writeFileSync(join(bin, 'curl'), CURL); chmodSync(join(bin, 'curl'), 0o755);
  // Fake fingerprint script: prints FAKE_RESTORED (records the database it was pointed at).
  writeFileSync(join(work, 'scripts', 'prod-fingerprint.py'), 'import os,sys\nopen(os.environ["WORK"]+"/fp-args","w").write(" ".join(sys.argv[1:]))\nprint(os.environ["FAKE_RESTORED"])\nsys.exit(int(os.environ.get("FAKE_FP_EXIT","0")))\n');
  writeFileSync(join(work, 'preflight-before.txt'), PREFLIGHT);
  writeFileSync(join(work, 'last-backup.txt'), over.backup ?? BACKUP);
  const env = {
    ...process.env, WORK: work, POLL_SECONDS: '0', PATH: `${bin}:${process.env.PATH}`,
    FAKE_META: '1', FAKE_RELEASES: '{"releases":[{"name":"projects/pioneer-285cf/releases/cloud.firestore"}]}',
    FAKE_IMPORT_JSON: '{"done":true,"metadata":{"operationState":"SUCCESSFUL"}}', FAKE_AUDIT: '40', FAKE_RESTORED: [...FP, DONE].join('\n'),
    ...over,
  };
  const r = spawnSync('bash', [SCRIPT], { cwd: work, env, encoding: 'utf8' });
  const calls = existsSync(join(work, 'calls.log')) ? readFileSync(join(work, 'calls.log'), 'utf8') : '';
  return { code: r.status, out: `${r.stdout}${r.stderr}`, calls, work };
}

const deletes = (calls) => calls.split('\n').filter((l) => l.startsWith('gcloud firestore databases delete'));
const tmpName = (calls) => (calls.match(/databases create --database=(bkverify-\d{8}-\d{6})/) ?? [])[1];

test('identical restored copy: VERIFIED BY RESTORE; imports into and deletes only the temporary database', () => {
  const r = run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /BACKUP: VERIFIED BY RESTORE — gs:\/\/pioneer-285cf-firestore-backups-us/);
  const name = tmpName(r.calls);
  assert.ok(name, 'temporary database created');
  assert.match(r.calls, new RegExp(`firestore import ${BACKUP}/ --database=${name} --project pioneer-285cf --async`));
  assert.match(r.calls, new RegExp(`firestore operations describe IMP1 --database=${name} --project pioneer-285cf`), 'polls the import operation in the temporary database');
  assert.match(r.out, /PROCESSING \(0 s\)[\s\S]*done: True +state: SUCCESSFUL/, 'judges the FINAL status, not the stale start output');
  assert.equal(readFileSync(join(r.work, 'fp-args'), 'utf8'), `pioneer-285cf TOKEN ${name}`, 'fingerprint reads the restored copy');
  assert.deepEqual(deletes(r.calls), [`gcloud firestore databases delete --database=${name} --project pioneer-285cf --quiet`]);
  assert.doesNotMatch(r.calls.replace(/databases describe --database=\(default\)[^\n]*/g, ''), /\(default\)/, '"(default)" is only ever described, never written');
});

for (const [name, over, why] of [
  ['a collection differs', { FAKE_RESTORED: ['  FP clients                   157 ZZZ', ...FP.slice(1), DONE].join('\n') }, /DIFFERENT preflight: FP clients/],
  ['a ledger total differs', { FAKE_RESTORED: [...FP.slice(0, 2), '  TOTAL amountCents          999', FP[3], DONE].join('\n') }, /DIFFERENT preflight: TOTAL amountCents/],
  ['a collection is missing', { FAKE_RESTORED: [...FP.slice(1), DONE].join('\n') }, /restored:  missing/],
  ['audit-log count differs', { FAKE_AUDIT: '39' }, /DIFFERENT auditLog/],
  ['fingerprint of the restored copy fails', { FAKE_FP_EXIT: '2', FAKE_RESTORED: '  FINGERPRINT FAILED: HTTP 503' }, /fingerprint of the restored copy did not complete/],
  ['fingerprint of the restored copy is incomplete', { FAKE_RESTORED: FP.join('\n') }, /fingerprint of the restored copy is incomplete/],
  ['import never finishes', { FAKE_IMPORT_JSON: '{"done":false,"metadata":{"operationState":"PROCESSING"}}', TIMEOUT_SECONDS: '0' }, /did not finish within/],
  ['import done but not SUCCESSFUL', { FAKE_IMPORT_JSON: '{"done":true,"metadata":{"operationState":"CANCELLED"}}' }, /import did not finish successfully/],
  ['import failed', { FAKE_IMPORT_JSON: '{"done":true,"error":{"message":"x"},"metadata":{"operationState":"FAILED"}}' }, /import did not finish successfully/],
  ['rules release targets the temp database', { FAKE_RELEASES: '{"releases":[{"name":"projects/pioneer-285cf/releases/cloud.firestore/bkverify-x"}]}' }, /security-rules release/],
]) {
  test(`not verified, and the temporary database is still deleted: ${name}`, () => {
    const r = run(over);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /BACKUP: NOT VERIFIED/);
    assert.match(r.out, why);
    assert.doesNotMatch(r.out, /VERIFIED BY RESTORE/);
    const n = tmpName(r.calls);
    assert.deepEqual(deletes(r.calls), [`gcloud firestore databases delete --database=${n} --project pioneer-285cf --quiet`]);
  });
}

test('refuses an unexpected backup path before creating anything', () => {
  const r = run({ backup: 'gs://pioneer-285cf.firebasestorage.app/whatever' });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /unexpected backup path/);
  assert.equal(r.calls, '');
});

test('if creating the temporary database fails, nothing is imported or deleted', () => {
  const r = run({ FAKE_CREATE_FAILS: '1' });
  assert.notEqual(r.code, 0);
  assert.doesNotMatch(r.calls, /firestore import|databases delete/);
});
