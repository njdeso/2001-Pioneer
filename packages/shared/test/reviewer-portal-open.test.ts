import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Regression (production, 17 Nov 2026): in the reviewer portal (and the owner's "Preview what reviewers see"),
// clicking a statement did nothing — rows had no click handler, the only Open button was the last column of a
// horizontally scrolling table, and the detail (View / Download original) opened below a list of up to 50 rows.
const portal = readFileSync(fileURLToPath(new URL('../../../apps/admin/src/pages/ReviewerPortal.tsx', import.meta.url)), 'utf8');
const view = portal.slice(portal.indexOf('function StatementsView('), portal.indexOf('function StatementDetailView('));
const detail = portal.slice(portal.indexOf('function StatementDetailView('), portal.indexOf('function BookView('));

test('a click anywhere on a statement row opens it (toggle), like the internal Statements page', () => {
  assert.match(view, /onRowClick=\{\(r\) => toggle\(r\.id\)\}/);
  assert.match(view, /const toggle = \(id: string\) => setOpenId\(\(cur\) => \(cur === id \? null : id\)\);/);
});

test('the Open button is the first column and does not also trigger the row click (which would close it again)', () => {
  const cols = view.slice(view.indexOf('columns={['));
  assert.ok(cols.indexOf("key: 'open'") < cols.indexOf("key: 'month'"), 'Open is the first column, visible without scrolling');
  assert.match(cols, /key: 'open'.*onClick=\{\(e\) => \{ e\.stopPropagation\(\); toggle\(r\.id\); \}\}/);
  assert.equal((view.match(/key: 'open'/g) ?? []).length, 1);
});

test('the statement detail scrolls into view when opened', () => {
  assert.match(detail, /const panel = useRef<HTMLDivElement \| null>\(null\);/);
  assert.match(detail, /useEffect\(\(\) => \{ panel\.current\?\.scrollIntoView\(\{ behavior: 'smooth', block: 'start' \}\); \}, \[statementId\]\);/);
  assert.match(detail, /<div ref=\{panel\} className="scroll-mt-4">/);
});

test('the detail still offers View original, Download original and the statement CSV through the reviewer callables only', () => {
  assert.match(detail, /api\.getReviewerStatementFile\(statementId\)/);
  assert.match(detail, /api\.getReviewerExport\('statement', statementId\)/);
  assert.match(detail, /api\.getReviewerData<\{ statement: ReviewerStatementDetail \}>\('statement', statementId\)/);
  assert.doesNotMatch(portal, /getStatementFileUrl|firebase\/storage|getDownloadURL/, 'no internal file function or direct Storage access in the reviewer portal');
});

test('the internal Statements page still opens a statement on row click', () => {
  const internal = readFileSync(fileURLToPath(new URL('../../../apps/admin/src/pages/Statements.tsx', import.meta.url)), 'utf8');
  assert.match(internal, /onRowClick=\{\(r\) => navigate\(`\/statements\/\$\{r\.id\}`\)\}/);
});
