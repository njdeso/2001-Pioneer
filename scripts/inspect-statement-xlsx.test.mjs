// The local Excel inspection script: read-only by construction, and correct on synthetic workbooks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detailedStatementWorkbook } from './lib/synthetic-xlsx.mjs';

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
    for (const line of [/PASS  1\. Workbook opens/, /PASS  2\. Detailed worksheet/, /data rows below the header: 94/, /20 header columns — matches/, /PASS  4\. 01\/01\/0001/, /"Month End": 202511 × 94 → 2025-11/, /PASS  6d\. Column that reconciles as the commission paid to the agency/, /INFO  7\. NOT TESTED here: the AI extraction step/]) assert.match(r.stdout, line);
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

test('three commission columns (Comm, Gross Comm, Net Due Agent): the Summary totals decide, Net Due Agent is the paid amount', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'insp-')), 'DetailedStatement20261110.xlsx');
  const wb = detailedStatementWorkbook({ prefix: 'x', refs: false, inline: true, threeCommission: true });
  writeFileSync(f, wb.bytes);
  const r = run(f);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /"Comm": total .* = Summary "Gross Commission"/);
  assert.match(r.stdout, /"Gross Comm": total .* = Summary "Gross Commission"/);
  assert.match(r.stdout, /"Net Due Agent": total .* = Summary "Net Due Agent"/);
  assert.match(r.stdout, /"Comm" vs "Gross Comm": equal on 94 of 94 rows/);
  assert.match(r.stdout, /PASS  6d\. Column that reconciles as the commission paid to the agency\n {6}"Net Due Agent" — its Detailed total/);
  assert.match(r.stdout, /PASS  6c\. Every commission row is present and readable\n {6}94 data rows/);
  assert.match(r.stdout, /"Trans Date": 2025-11-03 … 2025-11-03 \(94 dates; 94 in 2025-11\)/);
});
