// The ledger and posted statements are append-only outside the disposable emulator:
//   - the smoke test and the seed script never delete anything
//   - the Cloud Functions never delete ledger or audit-log documents, and never re-extract (replace
//     the lines of) a statement that has posting history
//   - the synthetic-statement helper refuses to replace a statement that was approved, posted or
//     reversed, or that any ledger entry refers to
//   node --test scripts/ledger-append-only.test.mjs        (run from the repository root; CI does this)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeStatement } from './lib/synthetic-3b.mjs';

const code = (f) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const DELETE = /\.delete\s*\(|recursiveDelete|bulkWriter/;

test('smoke test and seed script contain no delete calls', () => {
  for (const f of ['scripts/smoke-dev.mjs', 'scripts/seed-dev.mjs']) assert.doesNotMatch(code(f), DELETE, `${f} must not delete anything`);
});

test('Cloud Functions never delete ledger or audit-log documents, and never re-read a statement with posting history', () => {
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.ts$/.test(n)) files.push(p); } };
  walk('functions/src');
  assert.ok(files.length > 0);
  for (const f of files) {
    const src = code(f);
    assert.doesNotMatch(src, /delete\(\s*db\.collection\(\s*['"](ledger|auditLog)['"]/, `${f} must not delete ledger or audit-log documents`);
    assert.doesNotMatch(src, /collection\(\s*['"](ledger|auditLog)['"]\s*\)[^;]*\.(delete|update|set)\s*\(/, `${f} must not change or delete ledger or audit-log documents directly`);
  }
  // Posting code writes the ledger with create() only (originals, reversal twins) and marks originals
  // reversed with update(); it never deletes.
  assert.doesNotMatch(code('functions/src/callables/posting.ts'), DELETE);
  // Re-extraction (which replaces a statement's lines) is refused once a statement has posting history.
  const st = code('functions/src/callables/statements.ts');
  const claim = st.slice(st.indexOf('async function claimForProcessing'), st.indexOf('async function replaceLines'));
  assert.match(claim, /postingSeq[\s\S]*reversals[\s\S]*throw new HttpsError\('failed-precondition'/);
});

test('the only delete in the synthetic helpers is resetting lines of a never-posted statement, after the refusal check', () => {
  const src = code('scripts/lib/synthetic-3b.mjs');
  const deletes = [...src.matchAll(/\.delete\s*\(/g)];
  assert.equal(deletes.length, 1);
  const refusal = src.indexOf('Refusing to replace statement');
  assert.ok(refusal > 0 && refusal < deletes[0].index, 'the refusal check must come before the delete');
  assert.doesNotMatch(src, /collection\(['"]ledger['"]\)[^;\n]*\.(delete|set|update)\(/, 'synthetic helpers must never write to the ledger');
});

// Minimal in-memory stand-in for the Admin SDK calls writeStatement makes.
function fakeDb({ statement, ledgerFor = [] }) {
  const writes = [];
  const ref = {
    get: async () => ({ exists: !!statement, data: () => statement }),
    collection: () => ({ listDocuments: async () => [{ id: '00001' }], doc: (id) => ({ id }) }),
  };
  return {
    writes,
    collection: (name) => ({
      doc: () => ref,
      where: (_f, _op, v) => ({ limit: () => ({ get: async () => ({ empty: !(name === 'ledger' && ledgerFor.includes(v)) }) }) }),
    }),
    batch: () => ({ set: (r) => writes.push(['set', r.id ?? 'stmt']), delete: (r) => writes.push(['delete', r.id]), commit: async () => {} }),
  };
}
const FV = { serverTimestamp: () => 'ts' };

test('writeStatement refuses to replace an approved, posted or reversed statement, or one with ledger entries', async () => {
  const cases = [
    { status: 'posted', synthetic: true, postedCents: 41000 },
    { status: 'approved', synthetic: true, approval: { at: 'x' } },
    { status: 'needs_review', synthetic: true, reversals: [{ postingId: 'SYN3B-MANUAL__p1', amountCents: -41000 }], postingSeq: 1 },
    { status: 'needs_review', synthetic: false },
  ];
  for (const statement of cases) {
    const db = fakeDb({ statement });
    await assert.rejects(writeStatement(db, FV, 'SYN3B-MANUAL', 'x'), /Refusing to replace/);
    assert.equal(db.writes.length, 0, 'nothing written or deleted');
  }
  const withLedger = fakeDb({ statement: { status: 'needs_review', synthetic: true }, ledgerFor: ['SYN3B-MANUAL'] });
  await assert.rejects(writeStatement(withLedger, FV, 'SYN3B-MANUAL', 'x'), /Refusing to replace/);
  assert.equal(withLedger.writes.length, 0);
});

test('writeStatement creates a new statement, and may reset one never approved or posted', async () => {
  const fresh = fakeDb({ statement: null });
  await writeStatement(fresh, FV, 'SYN3B-AUTO-1', 'x');
  assert.ok(fresh.writes.some(([op]) => op === 'set'));
  const untouched = fakeDb({ statement: { status: 'needs_review', synthetic: true, postedCents: 0 } });
  await writeStatement(untouched, FV, 'SYN3B-MANUAL', 'x');
  assert.ok(untouched.writes.some(([op]) => op === 'delete'), 'lines of a never-posted synthetic statement can be reset');
});
