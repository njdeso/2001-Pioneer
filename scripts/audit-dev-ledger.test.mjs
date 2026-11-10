// The dev ledger audit must be read-only and must fail on an unbalanced reversal.
//   node --test scripts/audit-dev-ledger.test.mjs        (run from the repository root; CI does this)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = 'scripts/audit-dev-ledger.mts';
const STUB = './scripts/test-support/firebase-admin-readonly-stub/register.mjs';
const source = readFileSync(SCRIPT, 'utf8');
// Code only: strip line and block comments so the explanatory header can mention writes.
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('audit script contains no Firestore, Storage or Auth write calls, deploys or seeding', () => {
  const forbidden = [
    [/\.(set|update|delete|add|create|commit)\s*\(/, 'document write method'],
    [/\b(batch|runTransaction|bulkWriter|recursiveDelete)\s*\(/, 'batch/transaction/bulk write'],
    [/\bFieldValue\b/, 'FieldValue (only needed to write)'],
    [/getStorage|getAuth|firebase-admin\/(storage|auth)/, 'Storage or Auth access'],
    [/seedBook|writeStatement|synthetic-3b|seed-dev/, 'seeding helpers'],
    [/child_process|execSync|spawn\(|firebase\s+deploy/, 'running other commands'],
  ];
  for (const [re, what] of forbidden) assert.doesNotMatch(code, re, `${SCRIPT} must not use ${what}`);
  // All database access goes through the read-only reader: .get() on collections and documents.
  const dbUses = code.match(/\bdb\.\w+/g) ?? [];
  assert.deepEqual([...new Set(dbUses)].sort(), ['db.collection', 'db.doc']);
});

test('audit script refuses production and anything but pioneer-2001-dev', () => {
  assert.match(code, /assertDevAlias\(alias\)/);
  assert.match(code, /assertDevProjectNumber\(/);
  for (const target of ['pioneer-285cf', 'prod', 'some-other-project']) {
    const r = spawnSync(process.execPath, ['--import', STUB, '--import', 'tsx', SCRIPT, target], { encoding: 'utf8', env: { ...process.env, FIRESTORE_EMULATOR_HOST: '', STUB_DATA: 'scripts/test-support/fixtures/ledger-balanced.json' } });
    assert.equal(r.status, 2, `${target}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /Refusing/);
  }
});

function runAgainst(fixture) {
  const out = mkdtempSync(join(tmpdir(), 'ledger-audit-'));
  const r = spawnSync(process.execPath, ['--import', STUB, '--import', 'tsx', SCRIPT, 'demo-asm'], {
    encoding: 'utf8',
    env: { ...process.env, FIRESTORE_EMULATOR_HOST: 'stub', STUB_DATA: `scripts/test-support/fixtures/${fixture}`, AUDIT_OUT_DIR: out, GITHUB_STEP_SUMMARY: '' },
  });
  return { ...r, out };
}

test('balanced ledger (three reversed postings): exit 0, every posting nets to zero, reads only', () => {
  const r = runAgainst('ledger-balanced.json');
  assert.doesNotMatch(r.stderr + r.stdout, /WRITE ATTEMPTED/);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const report = JSON.parse(readFileSync(join(r.out, 'ledger-audit.json'), 'utf8'));
  assert.equal(report.ok, true);
  assert.equal(report.counts.reversedPostings, 3);
  for (const p of report.postings) assert.deepEqual([p.net.grossCents, p.net.brokerCents, p.net.agencyCents], [0, 0, 0]);
  assert.deepEqual([report.window.totals.grossCents, report.window.totals.brokerCents, report.window.totals.agencyCents], [0, 0, 0]);
  assert.ok(existsSync(join(r.out, 'ledger-transactions-accounting.csv')));
  assert.ok(existsSync(join(r.out, 'ledger-postings-accounting.csv')));
  for (const f of ['ledger-audit.json', 'ledger-transactions-accounting.csv', 'ledger-postings-accounting.csv']) {
    assert.doesNotMatch(readFileSync(join(r.out, f), 'utf8'), /@/, `${f} must not contain email addresses (artifacts of a public repository)`);
  }
});

test('a reversal one cent off in the broker share: exit 1 with reversal_amount_mismatch', () => {
  const r = runAgainst('ledger-broker-cent-off.json');
  assert.doesNotMatch(r.stderr + r.stdout, /WRITE ATTEMPTED/);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const report = JSON.parse(readFileSync(join(r.out, 'ledger-audit.json'), 'utf8'));
  const codes = report.findings.map((f) => f.code);
  assert.ok(codes.includes('reversal_amount_mismatch'));
  assert.ok(codes.includes('reversed_posting_not_zero'));
});
