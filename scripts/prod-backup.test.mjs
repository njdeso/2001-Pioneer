// Tests for scripts/prod-backup.sh against a FAKE gcloud (no Google access, no network). Each scenario
// scripts the bucket, IAM and export-operation responses and checks that the script only reports
// "EXPORT COMPLETE" when every required condition holds, and never treats an estimate or an unknown
// document count as verification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve('scripts/prod-backup.sh');
const PREFLIGHT = [
  '2001-Pioneer production snapshot (before) — 2026-11-10T21:00:00Z — project pioneer-285cf',
  '  auditLog         40',
  '  FP clients                   157 aaa',
  '  FP policies                  233 bbb',
  '  TOTAL amountCents          123456',
  '  FP-COMPLETE 11 collections fingerprinted, 30 requests, 12s',
].join('\n');

// The fake gcloud reads its behaviour from env vars and logs every call.
const FAKE = `#!/usr/bin/env bash
echo "$*" >> "$WORK/calls.log"
case "$*" in
  "storage buckets describe"*) { [ "$FAKE_BUCKET_EXISTS" = 1 ] || [ -f "$WORK/created" ]; } || exit 1; echo "$FAKE_BUCKET_JSON";;
  "storage buckets create"*) touch "$WORK/created"; echo created;;
  "storage buckets get-iam-policy"*) echo "$FAKE_IAM_JSON";;
  "firestore databases describe"*) echo "$FAKE_PITR";;
  "firestore export"*) echo '{"name":"projects/pioneer-285cf/databases/(default)/operations/OP1"}';;
  "firestore operations describe"*)
    n=$(cat "$WORK/polls" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$WORK/polls"
    if [ "$n" -lt "\${FAKE_DONE_AFTER:-2}" ]; then echo '{"done":false,"metadata":{"operationState":"PROCESSING"}}'; else echo "$FAKE_OP_JSON" | sed "s#DEST#$FAKE_DEST_PREFIX#"; fi;;
  "storage ls -l"*) [ "$FAKE_META" = 1 ] && echo "      512  2026-11-10T21:05:00Z  gs://x/meta" && echo "TOTAL: 1 objects, 512 bytes";;
  "storage ls -r"*) [ "$FAKE_DATA" = 1 ] && echo "gs://x/all_namespaces/all_kinds/output-0" && echo "gs://x/all_namespaces/all_kinds/output-1";;
  "storage du -s"*) echo "123456  gs://x";;
  *) echo "unexpected gcloud $*" >&2; exit 9;;
esac
`;

const good = {
  FAKE_BUCKET_EXISTS: '1',
  FAKE_BUCKET_JSON: JSON.stringify({ location: 'US', uniform_bucket_level_access: true, public_access_prevention: 'enforced' }),
  FAKE_IAM_JSON: JSON.stringify({ bindings: [{ role: 'roles/storage.legacyBucketOwner', members: ['projectOwner:pioneer-285cf'] }] }),
  FAKE_PITR: 'POINT_IN_TIME_RECOVERY_DISABLED',
  FAKE_OP_JSON: JSON.stringify({ done: true, metadata: { operationState: 'SUCCESSFUL', outputUriPrefix: 'DEST', progressDocuments: { completedWork: '1500' } } }),
  FAKE_META: '1', FAKE_DATA: '1', FAKE_DONE_AFTER: '2',
};

function run(over = {}, { preflight = true, input = '', preflightText = PREFLIGHT } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'bk-'));
  const bin = join(work, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'gcloud'), FAKE); chmodSync(join(bin, 'gcloud'), 0o755);
  if (preflight) writeFileSync(join(work, 'preflight-before.txt'), preflightText);
  const env = { ...process.env, ...good, ...over, WORK: work, PATH: `${bin}:${process.env.PATH}`, POLL_SECONDS: '0', TIMEOUT_SECONDS: over.TIMEOUT_SECONDS ?? '60' };
  // The operation must report the destination the script chose; the fake substitutes it from the export call.
  env.FAKE_DEST_PREFIX = 'gs://pioneer-285cf-firestore-backups-us/firestore-backups/STAMP';
  const r = spawnSync('bash', ['-c', `
    set -e
    # Pin the timestamp so the expected destination is known.
    date() { if [ "$1" = "-u" ] && [ "$2" = "+%Y%m%dT%H%M%SZ" ]; then echo 20261110T210000Z; else command date "$@"; fi; }
    export -f date
    FAKE_DEST_PREFIX=gs://pioneer-285cf-firestore-backups-us/firestore-backups/20261110T210000Z bash "${SCRIPT}"
  `], { cwd: work, env, encoding: 'utf8', input });
  const calls = existsSync(join(work, 'calls.log')) ? readFileSync(join(work, 'calls.log'), 'utf8') : '';
  return { code: r.status, out: `${r.stdout}${r.stderr}`, calls, work };
}

test('success: waits for the operation, checks error/state/metadata/files, saves the path, and does NOT claim verification', () => {
  const r = run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PROCESSING/, 'polled while the export was running');
  assert.match(r.out, /EXPORT COMPLETE — NOT YET VERIFIED: gs:\/\/pioneer-285cf-firestore-backups-us\/firestore-backups\/20261110T210000Z/);
  assert.match(r.out, /ESTIMATE, not proof\): 1500/);
  assert.doesNotMatch(r.out, /BACKUP: VERIFIED/);
  assert.match(r.out, /prod-backup-restore-test\.sh/);
  assert.equal(readFileSync(join(r.work, 'last-backup.txt'), 'utf8').trim(), 'gs://pioneer-285cf-firestore-backups-us/firestore-backups/20261110T210000Z');
  assert.match(r.calls, /firestore export gs:\/\/pioneer-285cf-firestore-backups-us\/firestore-backups\/20261110T210000Z --project pioneer-285cf --database=\(default\) --async/);
  assert.match(r.out, /LIMITATION: point-in-time recovery is off/);
});

test('an unknown document count is reported as unknown and never satisfies anything', () => {
  const r = run({ FAKE_OP_JSON: JSON.stringify({ done: true, metadata: { operationState: 'SUCCESSFUL', outputUriPrefix: 'DEST' } }) });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ESTIMATE, not proof\): not reported/);
  assert.match(r.out, /NOT YET VERIFIED/);
  assert.doesNotMatch(r.out, /BACKUP: VERIFIED/);
});

for (const [name, over, why] of [
  ['operation error', { FAKE_OP_JSON: JSON.stringify({ done: true, error: { code: 7, message: 'denied' }, metadata: { operationState: 'FAILED', outputUriPrefix: 'DEST' } }) }, /reported an error/],
  ['state not SUCCESSFUL', { FAKE_OP_JSON: JSON.stringify({ done: true, metadata: { operationState: 'CANCELLED', outputUriPrefix: 'DEST' } }) }, /state is CANCELLED/],
  ['wrong output location', { FAKE_OP_JSON: JSON.stringify({ done: true, metadata: { operationState: 'SUCCESSFUL', outputUriPrefix: 'gs://elsewhere/x' } }) }, /wrote to gs:\/\/elsewhere/],
  ['metadata file missing', { FAKE_META: '0' }, /overall_export_metadata file is missing/],
  ['no data files', { FAKE_DATA: '0' }, /no export data files/],
  ['never finishes', { FAKE_DONE_AFTER: '999', TIMEOUT_SECONDS: '0' }, /did not finish/],
  ['public bucket member', { FAKE_IAM_JSON: JSON.stringify({ bindings: [{ role: 'roles/storage.objectViewer', members: ['allUsers'] }] }) }, /allUsers or allAuthenticatedUsers/],
  ['public access prevention off', { FAKE_BUCKET_JSON: JSON.stringify({ location: 'US', uniform_bucket_level_access: true, public_access_prevention: 'inherited' }) }, /public access prevention is not enforced/],
  ['existing bucket in the wrong region (us-east1)', { FAKE_BUCKET_JSON: JSON.stringify({ location: 'US-EAST1', uniform_bucket_level_access: true, public_access_prevention: 'enforced' }) }, /is in location US-EAST1, not US/],
  ['uniform access off', { FAKE_BUCKET_JSON: JSON.stringify({ location: 'US', uniform_bucket_level_access: false, public_access_prevention: 'enforced' }) }, /uniform bucket-level access is not enabled/],
  ['bucket missing and creation not confirmed', { FAKE_BUCKET_EXISTS: '0' }, /bucket not created/],
]) {
  test(`fails closed: ${name}`, () => {
    const r = run(over);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /BACKUP: FAILED/);
    assert.match(r.out, why);
    assert.doesNotMatch(r.out, /EXPORT COMPLETE/);
    assert.ok(!existsSync(join(r.work, 'last-backup.txt')), 'no backup path saved on failure');
  });
}

test('refuses to run without a preflight baseline', () => {
  const r = run({}, { preflight: false });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /preflight-before\.txt not found/);
  assert.equal(r.calls, '', 'no gcloud call at all');
});

test('point-in-time recovery on: exports one consistent snapshot', () => {
  const r = run({ FAKE_PITR: 'POINT_IN_TIME_RECOVERY_ENABLED' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.calls, /--snapshot-time=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z/);
  assert.match(r.out, /consistent snapshot/);
});

test('the bucket accepts the JSON-API (iamConfiguration) format too', () => {
  const r = run({ FAKE_BUCKET_JSON: JSON.stringify({ location: 'US', iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'enforced' } }) });
  assert.equal(r.code, 0, r.out);
});

test('creating the bucket after "yes": US, uniform access, public access prevention — then checked like any other', () => {
  // The fake keeps reporting "missing" on the first describe; after create, describe succeeds.
  const r = run({ FAKE_BUCKET_EXISTS: 'after-create' }, { input: 'yes\n' });
  assert.match(r.calls, /storage buckets create gs:\/\/pioneer-285cf-firestore-backups-us --project pioneer-285cf --location=US --uniform-bucket-level-access --public-access-prevention --default-storage-class=STANDARD/);
  assert.equal(r.code, 0, r.out);
});

test('refuses a preflight that did not finish (no FP-COMPLETE line), before any gcloud call', () => {
  const r = run({}, { preflightText: PREFLIGHT.split('\n').filter((l) => !l.includes('FP-COMPLETE')).join('\n') });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /incomplete \(no FP-COMPLETE line\)/);
  assert.equal(r.calls, '');
});
