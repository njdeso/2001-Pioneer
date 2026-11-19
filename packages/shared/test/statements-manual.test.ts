import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  draftFromExtracted, emptyManualDraft, emptyManualLine, manualDraftToStatement, manualEditBlocker, manualLineChanges,
  MANUAL_CSV_TEMPLATE, parseManualCsv, validateManualDraft, type ManualDraft, type ManualLine,
} from '../src/statements/manual.ts';
import { reconcileStatement } from '../src/statements/reconcile.ts';

/**
 * Manual reconciliation (keying or correcting a statement from its preserved original).
 * Every name, policy number and amount below is SYNTHETIC.
 */

const ln = (o: Partial<ManualLine>): ManualLine => ({ ...emptyManualLine(), ...o });

/** Shaped like the SMIC layout: page-1 transactions, printed month total on page 2. Synthetic sum: 222.50. */
const smicDraft = (): ManualDraft => ({
  ...emptyManualDraft('carrier_smic'),
  statementMonth: '2026-11',
  statementDate: '2026-11-15',
  stated: { commissionPayableCents: 22250, monthCommissionPayableCents: 22250, ytdCommissionPayableCents: 512345 },
  lines: [
    ln({ insuredName: 'SAMPLE ONE', policyNumberRaw: 'SM 100-001', transactionType: 'new_business', premiumForCommissionCents: 100000, rateBps: 1500, paidCommissionCents: 15000, page: 1 }),
    ln({ insuredName: 'SAMPLE TWO', policyNumberRaw: 'SM 100-002', transactionType: 'continuation', premiumForCommissionCents: 50000, rateBps: 1000, paidCommissionCents: 5000, page: 1 }),
    ln({ insuredName: 'SAMPLE THREE', policyNumberRaw: 'SM 100-003', transactionType: 'endorsement', premiumForCommissionCents: -10000, rateBps: 1500, paidCommissionCents: -1500, page: 1 }),
    ln({ insuredName: 'SAMPLE FOUR', policyNumberRaw: 'SM 100-004', transactionType: 'new_business', premiumForCommissionCents: 30000, rateBps: 1250, paidCommissionCents: 3750, page: 1 }),
  ],
  reason: 'Scanned statement; AI misread the totals',
});

test('a complete manual statement reconciles exactly through the shared reconciler', () => {
  const v = validateManualDraft(smicDraft(), 'apply');
  assert.ok(v.ok, v.ok ? '' : v.errors.join('; '));
  const s = manualDraftToStatement(v.draft, 'Security Mutual Ins Co');
  assert.equal(s.carrierName, 'Security Mutual Ins Co');
  assert.deepEqual(s.lines.map((l) => l.lineNo), [1, 2, 3, 4]);
  assert.equal(s.lines[0].policyNumberNormalized, 'SM100001');
  assert.equal(s.lines[0].rawText, 'Manual entry');
  assert.ok(s.issues.some((i) => i.code === 'manual_entry' && i.level === 'warning'), 'manual entry is flagged, not blocking');
  const rec = reconcileStatement(s);
  assert.equal(rec.reconciled, true, rec.blockingReasons.join('; '));
  assert.equal(rec.totals.commissionCents, 22250);
});

test('nothing is balanced: typed lines that do not add up to the printed total do not reconcile', () => {
  const d = smicDraft();
  d.lines[1].paidCommissionCents = 5001;
  const v = validateManualDraft(d, 'apply');
  assert.ok(v.ok);
  const rec = reconcileStatement(manualDraftToStatement(v.draft, 'X'));
  assert.equal(rec.reconciled, false);
  assert.ok(rec.blockingReasons.some((b) => b.includes('222.51') && b.includes('222.50')));
});

test('year-to-date is reference only, never the statement total', () => {
  const d = smicDraft();
  d.stated = { commissionPayableCents: null, monthCommissionPayableCents: null, ytdCommissionPayableCents: 22250 };
  const v = validateManualDraft(d, 'apply');
  assert.equal(v.ok, false);
  assert.ok(!v.ok && v.errors.some((e) => e.includes('exactly as printed')));
});

test('adjustments are included in the month payable check', () => {
  const d = smicDraft();
  d.stated = { commissionPayableCents: 22250, monthCommissionPayableCents: 21250, ytdCommissionPayableCents: null };
  d.adjustments = [{ label: 'MVR charges', amountCents: -1000 }];
  const v = validateManualDraft(d, 'apply');
  assert.ok(v.ok);
  assert.equal(reconcileStatement(manualDraftToStatement(v.draft, 'X')).reconciled, true);
});

test('drafts may be incomplete; applying requires carrier, month, a printed total, complete lines and a reason', () => {
  const draft = { ...emptyManualDraft(), lines: [ln({ policyNumberRaw: 'P1' })] };
  assert.equal(validateManualDraft(draft, 'draft').ok, true);
  const v = validateManualDraft(draft, 'apply');
  assert.equal(v.ok, false);
  const errs = v.ok ? [] : v.errors.join(' | ');
  for (const want of ['carrier', 'statement month', 'exactly as printed', 'commission amount is required', 'reason']) assert.match(String(errs), new RegExp(want, 'i'));
});

test('unknown fields are refused anywhere (no broker or split data can be stored)', () => {
  for (const bad of [
    { ...smicDraft(), brokerId: 'b1' },
    { ...smicDraft(), stated: { ...smicDraft().stated, brokerCents: 1 } },
    { ...smicDraft(), lines: [{ ...smicDraft().lines[0], brokerShareBps: 5000 }] },
    { ...smicDraft(), adjustments: [{ label: 'x', amountCents: 1, brokerId: 'b' }] },
  ]) {
    for (const mode of ['draft', 'apply'] as const) {
      const v = validateManualDraft(bad, mode);
      assert.equal(v.ok, false, `${mode} accepted ${JSON.stringify(bad).slice(0, 60)}`);
      assert.ok(!v.ok && v.errors.some((e) => /unknown field/i.test(e)));
    }
  }
});

test('amounts must be whole cents; implausible values and bad dates are refused', () => {
  const d = smicDraft() as unknown as Record<string, unknown>;
  (d.lines as Record<string, unknown>[])[0].paidCommissionCents = 150.5;
  (d.lines as Record<string, unknown>[])[1].paidCommissionCents = 1e15;
  (d.lines as Record<string, unknown>[])[2].effectiveDate = '11/01/2026';
  d.statementMonth = '2026-13';
  const v = validateManualDraft(d, 'draft');
  assert.equal(v.ok, false);
  const e = v.ok ? '' : v.errors.join(' | ');
  assert.match(e, /whole number of cents/); assert.match(e, /implausibly large/); assert.match(e, /YYYY-MM-DD/); assert.match(e, /YYYY-MM/);
});

test('payment-only lines cannot carry commission', () => {
  const d = smicDraft();
  d.lines.push(ln({ policyNumberRaw: 'SM 100-005', kind: 'payment_only', transactionType: 'installment_payment', paidCommissionCents: 100, paymentReceivedCents: 5000 }));
  const v = validateManualDraft(d, 'apply');
  assert.ok(!v.ok && v.errors.some((x) => x.includes('payment-only')));
});

test('correction starts from the extracted lines in order, and the audit diff lists what changed', () => {
  const extracted = smicDraft().lines.map((l, i) => ({ ...l, lineNo: i + 1 })).reverse();
  const d = draftFromExtracted({ payerId: 'carrier_smic', statementMonth: '2026-11', stated: { commissionPayableCents: 22250, monthCommissionPayableCents: null, ytdCommissionPayableCents: 999 } }, extracted);
  assert.equal(d.basedOn, 'extracted');
  assert.deepEqual(d.lines.map((l) => l.policyNumberRaw), ['SM 100-001', 'SM 100-002', 'SM 100-003', 'SM 100-004']);
  assert.equal(d.stated.ytdCommissionPayableCents, 999);

  const after = d.lines.map((l, i) => ({ ...l, lineNo: i + 1 }));
  after[1] = { ...after[1], paidCommissionCents: 5100 };
  after.pop();
  after.push({ ...ln({ policyNumberRaw: 'NEW-1', paidCommissionCents: 10 }), lineNo: 4 });
  const ch = manualLineChanges(extracted, after);
  assert.equal(ch.before, 4); assert.equal(ch.after, 4);
  assert.ok(ch.changes.some((c) => c.lineNo === 2 && c.field === 'paidCommissionCents' && c.before === 5000 && c.after === 5100));
  assert.ok(ch.changes.some((c) => c.lineNo === 4 && c.field === 'policyNumberRaw' && c.after === 'NEW-1'));
  const removed = manualLineChanges(extracted, after.slice(0, 2));
  assert.ok(removed.changes.some((c) => c.field === '(line)' && c.after === '(removed)'));
});

test('CSV import: the template reads into lines; type words, dates, rates and credits are understood', () => {
  const csv = `${MANUAL_CSV_TEMPLATE}\n`
    + 'SAMPLE ONE,SM 100-001,11/01/2026,NEW,"1,000.00",15%,150.00,,1,keyed from p1\n'
    + 'SAMPLE TWO,SM 100-002,2026-11-03,Renewal,500.00,10,50.00,,1,\n'
    + 'SAMPLE THREE,SM 100-003,,END,(100.00),15,(15.00),,1,\n'
    + 'SAMPLE FIVE,SM 100-005,,Payment,,,,250.00,1,\n';
  const r = parseManualCsv(csv);
  assert.deepEqual(r.errors, []);
  assert.equal(r.lines.length, 4);
  assert.equal(r.lines[0].effectiveDate, '2026-11-01');
  assert.equal(r.lines[0].premiumForCommissionCents, 100000);
  assert.equal(r.lines[0].rateBps, 1500);
  assert.equal(r.lines[0].transactionType, 'new_business');
  assert.equal(r.lines[1].transactionType, 'continuation');
  assert.equal(r.lines[2].paidCommissionCents, -1500);
  assert.equal(r.lines[2].transactionType, 'endorsement');
  assert.equal(r.lines[3].kind, 'payment_only');
  assert.equal(r.lines[3].paidCommissionCents, null);
  assert.equal(r.lines[0].note, 'keyed from p1');
});

test('CSV import is all-or-nothing and refuses unknown columns', () => {
  const bad = parseManualCsv('Policy number,Commission\nP1,10.00\nP2,ten dollars\n');
  assert.equal(bad.lines.length, 0);
  assert.ok(bad.errors.some((e) => e.startsWith('Row 3')));
  const extraCol = parseManualCsv('Policy number,Commission,Broker\nP1,10.00,Jim\n');
  assert.equal(extraCol.lines.length, 0);
  assert.ok(extraCol.errors.some((e) => e.includes('"Broker" is not recognized')));
  const missing = parseManualCsv('Insured,Commission\nA,1\n');
  assert.ok(missing.errors.some((e) => e.includes('Policy number')));
  const zero = parseManualCsv('Policy number,Commission\nP1,\n');
  assert.ok(zero.errors.some((e) => e.includes('commission is missing')));
});

test('imported CSV lines are a valid draft', () => {
  const r = parseManualCsv(`${MANUAL_CSV_TEMPLATE}\nA,P-1,,new,100.00,10,10.00,,,\n`);
  const d = { ...smicDraft(), lines: r.lines, stated: { commissionPayableCents: 1000, monthCommissionPayableCents: null, ytdCommissionPayableCents: null } };
  const v = validateManualDraft(d, 'apply');
  assert.ok(v.ok, v.ok ? '' : v.errors.join('; '));
  assert.equal(reconcileStatement(manualDraftToStatement(v.draft, 'X')).reconciled, true);
});

test('posted or approved statements, posting history and missing originals block manual reconciliation', () => {
  const ok = { status: 'extraction_failed', postedCents: 0, originalPath: 'statements/s1/original.pdf' };
  assert.equal(manualEditBlocker(ok), null);
  assert.equal(manualEditBlocker({ ...ok, status: 'discrepancy' }), null);
  assert.equal(manualEditBlocker({ ...ok, status: 'needs_review' }), null);
  assert.match(String(manualEditBlocker({ ...ok, status: 'posted' })), /approved or posted/);
  assert.match(String(manualEditBlocker({ ...ok, status: 'approved' })), /approved or posted/);
  assert.match(String(manualEditBlocker({ ...ok, status: 'processing' })), /processing/);
  assert.match(String(manualEditBlocker({ ...ok, status: 'discarded' })), /discarded/);
  assert.match(String(manualEditBlocker({ ...ok, postedCents: 100 })), /posted/);
  assert.match(String(manualEditBlocker({ ...ok, postingSeq: 1 })), /posting history/);
  assert.match(String(manualEditBlocker({ ...ok, reversals: [{}] })), /posting history/);
  assert.match(String(manualEditBlocker({ ...ok, originalPath: null })), /original file was never stored/);
});

test('only the printed month payable typed (no column total): lines + adjustments are checked against it exactly', () => {
  const d = smicDraft();
  d.stated = { commissionPayableCents: null, monthCommissionPayableCents: 22250, ytdCommissionPayableCents: null };
  const v = validateManualDraft(d, 'apply');
  assert.ok(v.ok);
  const s = manualDraftToStatement(v.draft, 'X');
  assert.equal(s.finalTotalOnly, true);
  const rec = reconcileStatement(s);
  assert.equal(rec.reconciled, true, rec.blockingReasons.join('; '));
  d.lines[0].paidCommissionCents = 15001;
  const v2 = validateManualDraft(d, 'apply');
  assert.ok(v2.ok);
  assert.equal(reconcileStatement(manualDraftToStatement(v2.draft, 'X')).reconciled, false);
  // With a column total typed, the normal two required checks apply (no final-total-only shortcut).
  assert.equal(manualDraftToStatement(smicDraft(), 'X').finalTotalOnly, undefined);
});

test('line limit keeps a saved draft well inside the document size limit', () => {
  const many = { ...smicDraft(), lines: Array.from({ length: 1001 }, (_, i) => ln({ policyNumberRaw: `P${i}`, paidCommissionCents: 1 })) };
  const v = validateManualDraft(many, 'draft');
  assert.ok(!v.ok && v.errors.some((e) => e.includes('At most 1000 lines')));
  const max = { ...smicDraft(), lines: Array.from({ length: 1000 }, (_, i) => ln({ insuredName: 'X'.repeat(60), policyNumberRaw: `POLICY-${i}-ABCDEFGH`, paidCommissionCents: 123456, premiumForCommissionCents: 1234567, rateBps: 1000, effectiveDate: '2026-11-01', note: 'n'.repeat(80), page: 1 })) };
  assert.ok(validateManualDraft(max, 'draft').ok);
  assert.ok(JSON.stringify(max).length < 500_000, `draft of 1000 full lines is ${JSON.stringify(max).length} bytes`);
});
