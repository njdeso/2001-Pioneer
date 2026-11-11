import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADVANCE_TEMPLATE_HEADERS, brokerAdvanceInput, MATERIAL_ADVANCE_FLAGS, parseAdvanceRows, reviewPolicyAdvances,
  type BrokerAdvance, type ImportLookups, type ReviewPolicy,
} from '../src/buyout/advances.ts';
import type { PolicyTerm } from '../src/terms.ts';

// Synthetic data only. B50 = 50 % broker, B40 = 40 % broker.
const share = (id: string) => (id === 'B40' ? 4000 : 5000);
const policy: ReviewPolicy = { id: 'P1', clientId: 'C1', brokerId: 'B50', brokerShareBps: null, status: 'active', effectiveDate: '2026-03-01', expirationDate: '2027-03-01' };
let n = 0;
const adv = (o: Partial<BrokerAdvance> = {}): BrokerAdvance => ({
  id: `A${++n}`, policyId: 'P1', clientId: 'C1', brokerId: 'B50', termId: '2026-03-01', termEffectiveDate: '2026-03-01', termExpirationDate: '2027-03-01',
  commissionBasisCents: 100000, brokerShareBps: 5000, amountPaidCents: 50000, paymentDate: '2026-03-10', paymentReference: 'CHK 1001',
  paymentType: 'new_business', status: 'active', source: { kind: 'manual' }, note: 'synthetic', ...o,
});
const review = (advances: BrokerAdvance[], o: { policy?: Partial<ReviewPolicy>; terms?: PolicyTerm[]; asOf?: string } = {}) =>
  reviewPolicyAdvances({ policy: { ...policy, ...o.policy }, terms: o.terms ?? [], advances, brokerShareBps: share, asOf: o.asOf ?? '2027-01-15' });

test('a correct advance: paid = basis × share, no flags', () => {
  const r = review([adv()]);
  assert.deepEqual(r.flags, []);
  assert.equal(r.material, false);
  assert.deepEqual([r.paidCents, r.basisCents, r.expectedCents, r.applicableShareBps], [50000, 100000, 50000, 5000]);
  assert.equal(r.term?.source, 'policy');
});

test('missing advance: a broker-owned policy is never assumed paid', () => {
  const r = review([]);
  assert.ok(r.flags.includes('missing_advance'));
  assert.equal(r.material, true);
  assert.equal(r.paidCents, 0);
  // An advance for an EARLIER term does not count for the current term.
  assert.ok(review([adv({ termEffectiveDate: '2025-03-01', termExpirationDate: '2026-03-01', termId: '2025-03-01' })]).flags.includes('missing_advance'));
});

test('multiple and partial payments are summed; a shortfall is a material mismatch', () => {
  const r = review([adv({ amountPaidCents: 30000 }), adv({ amountPaidCents: 20000, paymentReference: 'CHK 1002' })]);
  assert.deepEqual(r.flags, ['multiple_advances']);
  assert.equal(r.paidCents, 50000);
  const short = review([adv({ amountPaidCents: 30000 })]);
  assert.ok(short.flags.includes('amount_mismatch') && short.material);
});

test('corrected payments: voided records are excluded, the correction is noted, negative corrections are summed', () => {
  const r = review([adv({ status: 'voided', amountPaidCents: 55000, replacedById: 'A-new' }), adv({ id: 'A-new', replacesId: 'A1' })]);
  assert.deepEqual(r.flags, ['corrected']);
  assert.equal(r.paidCents, 50000);
  const refund = review([adv({ amountPaidCents: 55000 }), adv({ amountPaidCents: -5000, paymentReference: 'ADJ' })]);
  assert.ok(refund.flags.includes('negative_amount') && refund.flags.includes('multiple_advances'));
  assert.equal(refund.paidCents, 50000);
  assert.equal(refund.material, false);
});

test('a one-cent difference is rounding, not a mismatch', () => {
  const r = review([adv({ commissionBasisCents: 100001, amountPaidCents: 50001 })]); // 50 % of 1000.01 = 500.005 → 500.00 half-even
  assert.deepEqual(r.flags, ['rounding_difference']);
  assert.equal(r.material, false);
});

test('broker reassignment: an advance paid to a different broker is flagged (ownership at closing decides elsewhere)', () => {
  const r = review([adv({ brokerId: 'B40', brokerShareBps: 4000, amountPaidCents: 40000 })]);
  assert.ok(r.flags.includes('broker_mismatch'));
  assert.ok(r.flags.includes('share_mismatch'), 'B40’s 40 % differs from the policy broker’s 50 %');
  assert.equal(r.material, true);
});

test('policy-level share override applies; basis/share missing or inconsistent, and term-date mismatches, are material', () => {
  const r = review([adv({ brokerShareBps: 3000, amountPaidCents: 30000 })], { policy: { brokerShareBps: 3000 } });
  assert.deepEqual(r.flags, []);
  assert.equal(r.applicableShareBps, 3000);
  for (const [o, flag] of [
    [{ commissionBasisCents: null }, 'basis_missing'],
    [{ brokerShareBps: null }, 'share_missing'],
    [{ termExpirationDate: '2026-09-01' }, 'term_dates_mismatch'],
  ] as const) {
    const x = review([adv(o as Partial<BrokerAdvance>)]);
    assert.ok(x.flags.includes(flag) && x.material, flag);
  }
  const inconsistent = review([adv(), adv({ commissionBasisCents: 120000, amountPaidCents: 10000, paymentReference: 'X' })]);
  assert.ok(inconsistent.flags.includes('basis_inconsistent'));
});

test('renewal terms: the term covering the date comes from the policy-term history', () => {
  const terms: PolicyTerm[] = [
    { id: '2025-03-01', policyId: 'P1', effectiveDate: '2025-03-01', scheduledExpirationDate: '2026-03-01', cancellationDate: null, status: 'renewed', note: '' },
    { id: '2026-03-01', policyId: 'P1', effectiveDate: '2026-03-01', scheduledExpirationDate: '2027-03-01', cancellationDate: null, status: 'active', note: '' },
  ];
  const nb = adv({ termEffectiveDate: '2025-03-01', termExpirationDate: '2026-03-01', termId: '2025-03-01', paymentType: 'new_business' });
  const rn = adv({ paymentType: 'renewal' });
  const r = review([nb, rn], { terms });
  assert.equal(r.term?.source, 'terms');
  assert.equal(r.term?.effectiveDate, '2026-03-01');
  assert.deepEqual(r.advances.map((a) => a.id), [rn.id], 'only the current (renewal) term’s advance counts');
  assert.deepEqual(r.flags, []);
  // As of a date in the earlier term, the new-business advance applies.
  assert.deepEqual(review([nb, rn], { terms, asOf: '2025-06-01' }).advances.map((a) => a.id), [nb.id]);
});

test('no current term, and advances on unassigned policies, are flagged', () => {
  assert.ok(review([adv()], { asOf: '2028-01-01' }).flags.includes('no_current_term'));
  const u = review([adv()], { policy: { brokerId: 'UNASSIGNED' } });
  assert.deepEqual(u.flags, ['advance_on_unassigned_policy']);
  assert.equal(review([], { policy: { brokerId: 'UNASSIGNED' } }).flags.length, 0, 'no advance is expected without a broker');
});

test('material flags are exactly the ones that must block a final settlement', () => {
  for (const f of ['missing_advance', 'broker_mismatch', 'amount_mismatch', 'basis_missing', 'term_dates_mismatch'] as const) assert.ok(MATERIAL_ADVANCE_FLAGS.has(f));
  for (const f of ['multiple_advances', 'negative_amount', 'corrected', 'rounding_difference'] as const) assert.ok(!MATERIAL_ADVANCE_FLAGS.has(f));
});

test('manual entry validation: broker required (not Unassigned), non-zero whole cents, term order', () => {
  const ok = { policyId: 'P1', brokerId: 'B50', termEffectiveDate: '2026-03-01', termExpirationDate: '2027-03-01', amountPaidCents: 50000 };
  assert.ok(brokerAdvanceInput.safeParse(ok).success);
  assert.equal(brokerAdvanceInput.safeParse({ ...ok, brokerId: 'UNASSIGNED' }).success, false);
  assert.equal(brokerAdvanceInput.safeParse({ ...ok, amountPaidCents: 0 }).success, false);
  assert.equal(brokerAdvanceInput.safeParse({ ...ok, amountPaidCents: 100.5 }).success, false);
  assert.equal(brokerAdvanceInput.safeParse({ ...ok, termExpirationDate: '2026-03-01' }).success, false);
});

// ---------------------------------------------------------------- import

const lk: ImportLookups = {
  brokers: [{ id: 'UNASSIGNED', name: 'Unassigned', code: 'UNASSIGNED' }, { id: 'B50', name: 'Broker Fifty', code: 'BF50' }, { id: 'B40', name: 'Broker Forty', code: 'BF40' }],
  carriers: [{ id: 'TRV', name: 'Travelers', code: 'TRV' }, { id: 'MAYA', name: 'Maya', code: 'MAYA' }],
  policies: [
    { id: 'P1', clientId: 'C1', carrierId: 'TRV', policyNumber: 'TRV-100' },
    { id: 'P2', clientId: 'C2', carrierId: 'TRV', policyNumber: 'DUP-1' },
    { id: 'P3', clientId: 'C3', carrierId: 'MAYA', policyNumber: 'DUP-1' },
  ],
  existing: [{ policyId: 'P1', termEffectiveDate: '2025-03-01', amountPaidCents: 40000, paymentDate: '2025-03-05', paymentReference: 'OLD', status: 'active' }],
};

test('import: template headers and common aliases are recognised; required columns are reported', () => {
  const h = parseAdvanceRows(ADVANCE_TEMPLATE_HEADERS, [], lk);
  assert.deepEqual(h.missingColumns, []);
  assert.deepEqual(parseAdvanceRows(['Producer', 'Policy #', 'Eff Date', 'Exp Date', 'Advance'], [], lk).missingColumns, []);
  assert.deepEqual(parseAdvanceRows(['Broker', 'Policy number'], [], lk).missingColumns, ['termEffectiveDate', 'termExpirationDate', 'amountPaid']);
});

test('import: rows resolve broker, policy and money formats; problems are row-level errors, nothing is assumed', () => {
  const rows = [
    ['BF50', 'TRV 100', 'Travelers', '3/1/2026', '3/1/2027', '$1,000.00', '50%', '$500.00', '3/10/2026', 'CHK 1001', 'New', ''],
    ['Broker Forty', 'TRV-100', '', '2026-03-01', '2027-03-01', '', '0.4', '(25.00)', '', 'ADJ', 'renewal', 'correction'],
    ['NOBODY', 'TRV-100', '', '2026-03-01', '2027-03-01', '', '', '10', '', '', '', ''],
    ['BF50', 'DUP-1', '', '2026-03-01', '2027-03-01', '', '', '10', '', '', '', ''],
    ['BF50', 'DUP-1', 'Maya', '2026-03-01', '2027-03-01', '', '', '10', '', '', 'bonus', ''],
    ['BF50', 'TRV-100', '', '2025-03-01', '2026-03-01', '', '', '400', '3/5/2025', 'OLD', '', ''],
    ['BF50', 'TRV 100', 'Travelers', '3/1/2026', '3/1/2027', '$1,000.00', '50%', '$500.00', '3/10/2026', 'CHK 1001', 'New', ''],
    ['BF50', 'TRV-100', '', '13/45/2026', '2027-03-01', '', '', 'abc', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
  ];
  const r = parseAdvanceRows(ADVANCE_TEMPLATE_HEADERS, rows, lk).rows;
  assert.equal(r.length, 8, 'blank rows are skipped');
  const [a, b, c, d, e, f, g, h] = r;
  assert.ok(a.ok);
  assert.deepEqual(a.advance, { policyId: 'P1', clientId: 'C1', brokerId: 'B50', termEffectiveDate: '2026-03-01', termExpirationDate: '2027-03-01', commissionBasisCents: 100000, brokerShareBps: 5000, amountPaidCents: 50000, paymentDate: '2026-03-10', paymentReference: 'CHK 1001', paymentType: 'new_business', note: '' });
  assert.ok(b.ok, b.errors.join());
  assert.deepEqual([b.advance!.brokerId, b.advance!.brokerShareBps, b.advance!.amountPaidCents, b.advance!.paymentType, b.advance!.commissionBasisCents], ['B40', 4000, -2500, 'renewal', null]);
  assert.ok(b.warnings.some((w) => /commission basis/.test(w)) && b.warnings.some((w) => /payment date/i.test(w)));
  assert.ok(!c.ok && c.errors.some((x) => /Broker "NOBODY" not found/.test(x)));
  assert.ok(!d.ok && d.errors.some((x) => /several carriers/.test(x)), 'ambiguous policy number needs the carrier');
  assert.ok(!e.ok && e.errors.some((x) => /new business or renewal/.test(x)));
  assert.ok(!f.ok && f.errors.some((x) => /Already recorded/.test(x)));
  assert.ok(!g.ok && g.errors.some((x) => /Duplicate of an earlier row/.test(x)));
  assert.ok(!h.ok && h.errors.some((x) => /Term effective date/.test(x)) && h.errors.some((x) => /not an amount/.test(x)));
  assert.ok(r.every((x) => x.ok === (x.advance !== null)));
});
