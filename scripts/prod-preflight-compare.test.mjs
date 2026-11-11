// Tests for the after-comparison block of scripts/prod-preflight.sh (extracted and run on sample snapshots;
// no Google access). Every fingerprint, total and new-collection count must equal the baseline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const block = (() => { const src = readFileSync('scripts/prod-preflight.sh', 'utf8'); const i = src.indexOf('if [ "$LABEL" = "after" ]'); return src.slice(i, src.indexOf('\nfi\n', i) + 4); })();
const BEFORE = ['  clients          1001', '  FP clients                  1001 aaa', '  FP ledger                     48 bbb', '  TOTAL amountCents          123456',
  '  NEW policy terms              20', '  NEW buyoutSettlements         0', '  FP-COMPLETE 11 collections'].join('\n');
function compare(after, before = BEFORE) {
  const d = mkdtempSync(join(tmpdir(), 'pf-'));
  writeFileSync(join(d, 'cmp.sh'), block); writeFileSync(join(d, 'preflight-before.txt'), before); writeFileSync(join(d, 'preflight-after.txt'), after);
  const r = spawnSync('bash', ['-euo', 'pipefail', 'cmp.sh'], { cwd: d, env: { ...process.env, LABEL: 'after' }, encoding: 'utf8' });
  return `${r.stdout}${r.stderr}`;
}

test('pre-existing coverage terms equal to the baseline pass (the 20-term case)', () => {
  const out = compare(BEFORE);
  assert.match(out, /OK +NEW policy terms +20/);
  assert.match(out, /RESULT: OK/);
});
test('a changed count in a new collection (terms created or deleted) stops', () => {
  assert.match(compare(BEFORE.replace('NEW policy terms              20', 'NEW policy terms              21')), /RESULT: STOP/);
  assert.match(compare(BEFORE.replace('NEW buyoutSettlements         0', 'NEW buyoutSettlements         1')), /CHANGED +before: NEW buyoutSettlements +0/);
});
test('changed records, a changed total or a missing line stop', () => {
  assert.match(compare(BEFORE.replace('bbb', 'ccc')), /RESULT: STOP/);
  assert.match(compare(BEFORE.replace('123456', '123457')), /RESULT: STOP/);
  assert.match(compare(BEFORE.split('\n').filter((l) => !l.includes('FP ledger')).join('\n')), /after: +missing/);
  assert.match(compare(BEFORE.replace('  FP-COMPLETE 11 collections', '')), /INCOMPLETE preflight-after\.txt/);
});
test('a line the older baseline lacks (terms fingerprint) is shown, not judged', () => {
  const out = compare(`${BEFORE}\n  FP policy terms               20 ddd`);
  assert.match(out, /NO BASELINE FP policy terms +20 ddd/);
  assert.match(out, /RESULT: OK/);
});
