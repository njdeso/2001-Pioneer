// The local Excel inspection script: read-only by construction, and correct on synthetic workbooks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detailedStatementWorkbook, mvrStatement } from './lib/synthetic-xlsx.mjs';

const SCRIPT = 'scripts/inspect-statement-xlsx.mts';
const run = (file) => spawnSync('node', ['--import', 'tsx', SCRIPT, file], { encoding: 'utf8' });

test('the inspection script cannot reach Firebase, the network or write files', () => {
  const src = readFileSync(SCRIPT, 'utf8').replace(/^\s*\/\/.*$/gm, ''); // code only, not the explanatory comments
  for (const bad of [/firebase/i, /\bfetch\s*\(/, /node:https?\b/, /\bwriteFile|appendFile|createWriteStream|unlink|rmSync|mkdir/, /googleapis/, /process\.env/]) assert.doesNotMatch(src, bad, `must not contain ${bad}`);
  const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
  for (const i of imports) assert.ok(['node:fs', 'node:path', 'node:module'].includes(i) || i.startsWith('../packages/shared/src/'), `unexpected import ${i}`);
});

test('a DetailedStatement-like workbook (Excel and .NET formats) passes every read check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'insp-'));
  for (const [name, opts] of [['DetailedStatement20261110.xlsx', { prefix: 'x', refs: false, inline: true }], ['excel.xlsx', {}]]) {
    const f = join(dir, name); writeFileSync(f, detailedStatementWorkbook(opts).bytes);
    const r = run(f);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    for (const line of [/PASS  1\. Workbook opens/, /PASS  2\. Detailed worksheet/, /data rows below the header: 94/, /20 header columns — matches/, /PASS  4\. 01\/01\/0001/, /"Month End": 202511 × 94 → 2025-11/, /PASS  6d\. Column that reconciles to the net payment to the agency/, /INFO  7\. NOT TESTED here: the AI extraction step/, /INFO  8\. Deterministic DetailedStatement reader\n.*not the DetailedStatement layout/]) assert.match(r.stdout, line);
    if (name.startsWith('Detailed')) assert.match(r.stdout, /file name suggests 2026-11, but Month End says 2025-11/);
  }
});

test('a workbook whose statement sheets are hidden fails, with the reason', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'insp-')), 'hidden.xlsx');
  writeFileSync(f, detailedStatementWorkbook({ hiddenDetailed: true }).bytes);
  const r = run(f);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL  1\. Workbook opens .*\n.*xlsx_no_data: .*"Detailed" \(hidden\)/);
});

test('three commission columns with an UNEXPLAINED deduction on every row: read checks pass, the deterministic reader refuses it', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'insp-')), 'DetailedStatement20261110.xlsx');
  const wb = detailedStatementWorkbook({ prefix: 'x', refs: false, inline: true, threeCommission: true });
  writeFileSync(f, wb.bytes);
  const r = run(f);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL  8b\. Every transaction accounted for/);
  assert.match(r.stdout, /net_differs: .*nothing on the row identifies the difference as an MVR charge/);
  assert.match(r.stdout, /FAIL  8d\. Reconciliation/);
  assert.match(r.stdout, /"Comm": total .* = Summary "Gross Commission"/);
  assert.match(r.stdout, /"Gross Comm": total .* = Summary "Gross Commission"/);
  assert.match(r.stdout, /"Net Due Agent": total .* = Summary "Net Due Agent"/);
  assert.match(r.stdout, /"Comm" vs "Gross Comm": equal on 94 of 94 rows/);
  assert.match(r.stdout, /PASS  6d\. Column that reconciles to the net payment to the agency\n {6}"Net Due Agent" — its Detailed total/);
  assert.match(r.stdout, /PASS  6c\. Every commission row is present and readable\n {6}94 data rows/);
  assert.match(r.stdout, /"Trans Date": 2025-11-03 … 2025-11-03 \(94 dates; 94 in 2025-11\)/);
});

test('the real workbook layout with one MVR chargeback: deterministic reader, gross lines, agency-only MVR, both reconciliations, no names or policy numbers printed', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'insp-')), 'DetailedStatement20261110.xlsx');
  writeFileSync(f, mvrStatement({ mvr: [{ row: 57, cents: 18480 }], prefix: 'x', inline: true }).bytes);
  const r = run(f);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const line of [
    /INFO  8a\. Layout recognized: DetailedStatement \(deterministic reader, no AI\)/,
    /gross commission \(paid on each line, split with brokers\): "Gross Comm"/,
    /ignored, never used as commission: "Comm"/,
    /PASS  8b\. Every transaction accounted for\n {6}transactions read \(data rows\): 94\n {6}policy commission lines: 94 \(2 negative, 2 cancellations\)/,
    /94 = 94 \+ 0 \+ 0: every row used once — none omitted/,
    /agency-only adjustments: 1 \(1 MVR\), total MVR chargebacks -\$184\.80/,
    /statement month: 2025-11 \(Month End 202511\)/,
    /PASS  8d\. Reconciliation/,
    /ok {3}Gross policy commission .*= Summary "Commissions - Current"/,
    /ok {3}Net agency payment .*= Summary "Net Amount Due Agent"/,
    /ok {3}Each MVR charge recorded exactly once/,
    /PASS  8e\. Simulated broker \/ agency allocation\n {6}SIMULATION ONLY — test broker share 50 %/,
    /affected transaction \(line 58\): gross \$\d+\.\d{2} → test broker .* \(NOT reduced by the MVR\)/,
    /"MVR chargeback \(Detailed row 59, policy hidden\)": -\$184\.80 → broker \$0\.00, agency -\$184\.80/,
    /Not needed for this workbook: production reads the DetailedStatement layout with the deterministic reader/,
  ]) assert.match(r.stdout, line);
  assert.doesNotMatch(r.stdout, /Synthetic Insured|\b00[49]\d{3}\b/, 'no insured names or policy numbers by default');
});

test('an MVR workbook whose Summary does not match is refused by the reader (FAIL, exit 1)', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'insp-')), 'bad.xlsx');
  const base = mvrStatement();
  writeFileSync(f, mvrStatement({ summary: { net: base.netCents + 1 } }).bytes);
  const r = run(f);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL  8d\. Reconciliation/);
  assert.match(r.stdout, /FAIL Net agency payment/);
});
