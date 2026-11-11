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
  for (const i of imports) assert.ok(i.startsWith('node:fs') || i.startsWith('node:path') || i.startsWith('../packages/shared/src/'), `unexpected import ${i}`);
});

test('a DetailedStatement-like workbook (Excel and .NET formats) passes every read check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'insp-'));
  for (const [name, opts] of [['DetailedStatement20261110.xlsx', { prefix: 'x', refs: false, inline: true }], ['excel.xlsx', {}]]) {
    const f = join(dir, name); writeFileSync(f, detailedStatementWorkbook(opts).bytes);
    const r = run(f);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    for (const line of [/PASS  1\. Workbook opens/, /PASS  2\. Detailed worksheet/, /data rows below the header: 94/, /20 header columns — matches/, /PASS  4\. 01\/01\/0001/, /"Month End": 202511 × 94 → 2025-11/, /PASS  6b\. Detailed commission total equals the Summary sheet/, /INFO  7\. NOT TESTED here: the AI extraction step/]) assert.match(r.stdout, line);
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
