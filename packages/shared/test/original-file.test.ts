import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { originalFileAccess, originalFileDisposition } from '../src/statements/originalFile.ts';

const STATUSES = ['awaiting_upload', 'processing', 'needs_review', 'discrepancy', 'extraction_failed', 'discarded', 'approved', 'posted'];
const PATH = 'statements/S1/original.pdf';

test('the original is available in every status once stored — approved and posted included', () => {
  for (const status of STATUSES) assert.deepEqual(originalFileAccess({ status, originalPath: PATH }), { available: true }, status);
});

test('posted (and approved) statements: original available — regression for the greyed-out "View original"', () => {
  assert.equal(originalFileAccess({ status: 'posted', originalPath: PATH }).available, true);
  assert.equal(originalFileAccess({ status: 'approved', originalPath: PATH }).available, true);
});

test('no stored original: not available, with a clear explanation for each case', () => {
  for (const originalPath of [undefined, null, '', '   ']) {
    const r = originalFileAccess({ status: 'posted', originalPath });
    assert.equal(r.available, false);
    if (!r.available) assert.match(r.reason, /never stored for this statement .* Upload the statement again/);
  }
  const waiting = originalFileAccess({ status: 'awaiting_upload', originalPath: null });
  assert.deepEqual(waiting, { available: false, reason: 'The original file has not been uploaded yet.' });
  const storing = originalFileAccess({ status: 'processing' });
  assert.deepEqual(storing, { available: false, reason: 'The original file is still being stored. Try again in a moment.' });
});

test('view opens inline, download is an attachment; the file name cannot break the header', () => {
  assert.equal(originalFileDisposition('Utica May 2026.pdf', false), 'inline; filename="Utica May 2026.pdf"');
  assert.equal(originalFileDisposition('Utica May 2026.pdf', true), 'attachment; filename="Utica May 2026.pdf"');
  assert.equal(originalFileDisposition('a"b\\c\r\nd.pdf', true), 'attachment; filename="abcd.pdf"');
  assert.equal(originalFileDisposition(undefined, false), 'inline; filename="statement"');
});

// The statement page and the server function must both use this rule — never the statement's status.
test('statement page and getStatementFileUrl gate the original on the stored file, not on status', () => {
  const page = readFileSync(new URL('../../../apps/admin/src/pages/Statements.tsx', import.meta.url), 'utf8');
  const buttons = page.split('\n').filter((l) => />(View original|Download original)</.test(l));
  assert.equal(buttons.length, 2);
  for (const b of buttons) {
    assert.match(b, /disabled=\{busy \|\| !original\.available\}/);
    assert.doesNotMatch(b, /status/);
  }
  assert.match(page, /const original = originalFileAccess\(stmt\);/);
  const fn = readFileSync(new URL('../../../functions/src/callables/statements.ts', import.meta.url), 'utf8');
  const body = fn.slice(fn.indexOf('export const getStatementFileUrl'), fn.indexOf('\n});\n', fn.indexOf('export const getStatementFileUrl')));
  assert.match(body, /originalFileAccess\(/);
  assert.match(body, /requireRole\(req, \['admin', 'staff'\]\)/);
  assert.doesNotMatch(body, /'posted'|'approved'|needs_review/, 'no status restriction');
  assert.doesNotMatch(body, /\.(set|update|delete)\(\s*ref|statements'\)\.doc\(statementId\)\.(set|update)/, 'viewing never writes the statement');
});
