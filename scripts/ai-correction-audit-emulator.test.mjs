// AI-value correction history survives re-reads — against the Firestore EMULATOR (demo project, no
// credentials, never dev or production). Run by CI:
//
//   npx firebase emulators:exec --only firestore --project demo-asm-audit \
//     "node --import tsx --test scripts/ai-correction-audit-emulator.test.mjs"
//
// Uses the real server code that processStatement uses — replaceLines (a re-read replaces every line) and
// recordAiCorrections (audit-log entries staged in the extraction run's batch) — on a small SYNTHETIC Utica
// statement (no customer data): read 1 misreads a net premium (corrected, audited), read 2 is clean (lines
// replaced, no new entry), read 3 misreads again (a second entry). The first entry must survive unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PROJECT = process.env.GCLOUD_PROJECT || '';
if (!PROJECT.startsWith('demo-')) throw new Error(`Refusing: "${PROJECT}" is not a demo (emulator-only) project`);
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run inside firebase emulators:exec (FIRESTORE_EMULATOR_HOST not set)');

const { applyUticaDirectBillRules, reconcileStatement } = await import('@asm/shared');
const { db, FieldValue } = await import('../functions/src/lib/core.ts');
const { recordAiCorrections, replaceLines } = await import('../functions/src/lib/statementLines.ts');

const actor = { uid: 'SYN-ADMIN', email: 'admin@example.test', role: 'admin' };

/** Synthetic Utica direct-bill statement as the AI maps it (gross → premium for commission, net → transaction premium). */
function synthetic(misread) {
  const row = (lineNo, policy, code, gross, rateBps, commPrinted, net) => ({
    lineNo, page: 1, insuredName: policy === 'MVRCLU' ? '' : `Synthetic Insured ${lineNo}`, policyNumberRaw: policy, policyNumberNormalized: policy,
    paymentReceivedCents: null, paidCommissionCents: commPrinted, rateBps, termCommissionCents: null,
    premiumForCommissionCents: gross, transactionPremiumCents: net, feeCents: null, effectiveDate: '2026-05-15',
    transactionCodeRaw: code, transactionType: code === 'REN' ? 'renewal' : 'other', paymentMethod: '', kind: 'commission', rawText: '', issues: [],
  });
  return {
    carrierName: 'UTICA MUTUAL INS CO. - ERO', agencyCode: 'SYN01', officeCode: null, statementMonth: '2026-05', statementDate: null, title: 'DIRECT BILL STATEMENT', pageCount: 1,
    stated: { commissionPayableCents: -16486, monthCommissionPayableCents: -16486, paymentReceivedCents: null, premiumForCommissionCents: 117000, transactionPremiumCents: 100514, feeCents: null, ytdCommissionPayableCents: null },
    adjustments: [], issues: [],
    lines: [
      row(1, 'SYN0000001', 'REN', 100000, 1500, -15000, 85000),
      row(2, 'SYN0000002', 'REN', 17000, 2000, -3400, misread ? -13600 : 13600),
      row(3, 'MVRCLU', 'EXP', 0, 0, 1914, 1914),
    ],
  };
}

/** What processStatement does after extraction: replace the lines, then one batch with the run and its audit entries. */
async function reread(ref, misread) {
  const { statement, report } = applyUticaDirectBillRules(synthetic(misread));
  assert.equal(reconcileStatement(statement).reconciled, true);
  await replaceLines(ref, statement, null);
  const runRef = db.collection('extractionRuns').doc();
  const b = db.batch();
  b.set(runRef, { statementId: ref.id, ok: true, aiValuesCorrected: report.corrections.length, at: FieldValue.serverTimestamp(), by: actor.uid });
  recordAiCorrections(b, actor, ref.id, runRef.id, report.corrections);
  b.update(ref, { stated: statement.stated, statementIssues: statement.issues, lastRunId: runRef.id });
  await b.commit();
  return runRef.id;
}
const history = async (id) => (await db.collection('auditLog').where('entityId', '==', id).get()).docs
  .filter((d) => d.data().action === 'ai_value_corrected').map((d) => ({ id: d.id, ...d.data() }));

test('a later re-read replaces the lines but never erases the correction history', async () => {
  const ref = db.collection('statements').doc(`SYN-UTICA-${Date.now()}`);
  await ref.set({ status: 'processing', fileName: 'synthetic.pdf' });

  const run1 = await reread(ref, true);
  const after1 = await history(ref.id);
  assert.equal(after1.length, 1);
  const e1 = after1[0];
  assert.equal(e1.entityType, 'statement');
  assert.equal(e1.actorEmail, actor.email);
  assert.ok(e1.at?.toDate() instanceof Date, 'timestamp recorded');
  assert.deepEqual({ ...e1.detail, reason: undefined, arithmetic: undefined }, {
    statementId: ref.id, runId: run1, lineNo: 2, policyNumber: 'SYN0000002', field: 'transactionPremiumCents',
    originalCents: -13600, correctedCents: 13600, rule: 'utica-direct-bill-v1/net-sign', reason: undefined, arithmetic: undefined,
  });
  assert.match(e1.detail.reason, /only figure on the row/);
  assert.match(e1.detail.arithmetic, /^gross \$170\.00 x 20\.00% = commission \$34\.00 \(printed 34\.00-\); gross \$170\.00 \+ commission as printed -\$34\.00 = net \$136\.00; .* printed total \$1,005\.14 \(as read it added up to \$733\.14\)$/);
  assert.deepEqual(e1.changes, { 'line 2 net premium': { before: -13600, after: 13600 } });
  const line2 = (await ref.collection('lines').doc('00002').get()).data();
  assert.ok(line2.issues.some((i) => i.code === 'utica_net_sign_read'), 'read 1: the note is on the line');

  // Read 2: clean. Every line is replaced (the note is gone from the line) — the audit entry is not.
  const run2 = await reread(ref, false);
  assert.notEqual(run2, run1);
  const line2b = (await ref.collection('lines').doc('00002').get()).data();
  assert.ok(!line2b.issues.some((i) => i.code === 'utica_net_sign_read'), 'read 2 replaced the line');
  assert.equal(line2b.transactionPremiumCents, 13600);
  const after2 = await history(ref.id);
  assert.equal(after2.length, 1, 'no new entry for a clean read, and the earlier one is still there');
  assert.deepEqual(after2[0], e1, 'the earlier entry is unchanged');

  // Read 3: misread again → a second entry; both kept, each with its own run.
  const run3 = await reread(ref, true);
  const after3 = await history(ref.id);
  assert.equal(after3.length, 2);
  assert.deepEqual(after3.find((e) => e.id === e1.id), e1);
  assert.deepEqual(after3.map((e) => e.detail.runId).sort(), [run1, run3].sort());
});

test('replaceLines touches only the statement\'s lines', async () => {
  const ref = db.collection('statements').doc(`SYN-UTICA-ONLY-${Date.now()}`);
  await ref.set({ status: 'processing' });
  await reread(ref, true);
  const before = JSON.stringify((await db.collection('auditLog').get()).docs.map((d) => [d.id, d.data()]).sort());
  await replaceLines(ref, applyUticaDirectBillRules(synthetic(false)).statement, null);
  assert.equal(JSON.stringify((await db.collection('auditLog').get()).docs.map((d) => [d.id, d.data()]).sort()), before);
});
