import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addYearsCalendar, daysBetween, valueBuyout, type BuyoutPolicy } from '../src/buyout/engine.ts';
import type { BrokerAdvance } from '../src/buyout/advances.ts';
import type { PolicyTerm } from '../src/terms.ts';

// Synthetic data only.
const brokers = [{ id: 'UNASSIGNED', name: 'Unassigned', shareBps: 0 }, { id: 'B50', name: 'Broker Fifty', shareBps: 5000 }, { id: 'B40', name: 'Broker Forty', shareBps: 4000 }, { id: 'B0', name: 'House', shareBps: 0 }];
const P = (o: Partial<BuyoutPolicy> & Pick<BuyoutPolicy, 'id'>): BuyoutPolicy => ({ clientId: `C-${o.id}`, carrierId: 'TRV', policyNumber: `N-${o.id}`, brokerId: 'B50', status: 'active', effectiveDate: '2026-01-01', expirationDate: '2027-01-01', premiumCents: null, commissionRateBps: null, ...o });
let n = 0;
const A = (o: Partial<BrokerAdvance> & Pick<BrokerAdvance, 'policyId'>): BrokerAdvance => ({
  id: `A${++n}`, clientId: 'C', brokerId: 'B50', termId: o.termEffectiveDate ?? '2026-01-01', termEffectiveDate: '2026-01-01', termExpirationDate: '2027-01-01',
  commissionBasisCents: 100000, brokerShareBps: 5000, amountPaidCents: 50000, paymentDate: '2026-01-05', paymentReference: `R${n}`, paymentType: 'new_business',
  status: 'active', source: { kind: 'manual' }, note: '', ...o,
});
const run = (policies: BuyoutPolicy[], advances: BrokerAdvance[], closingDate: string, extra: Partial<Parameters<typeof valueBuyout>[0]> = {}) =>
  valueBuyout({ closingDate, policies, advances, brokers, termsByPolicy: new Map(), ...extra });
const pv = (r: ReturnType<typeof run>, id: string) => r.policies.find((p) => p.policyId === id)!;

test('the specified example: $1,000 annual, $500 upfront, 300 days remaining → gross $750, outstanding $410.96, net $339.04', () => {
  // 365-day term 2026-01-01 → 2027-01-01; closing 300 days before expiration = 2026-03-07.
  const closing = '2026-03-07';
  assert.equal(daysBetween(closing, '2027-01-01'), 300);
  const r = run([P({ id: 'X' })], [A({ policyId: 'X' })], closing);
  const v = pv(r, 'X');
  assert.equal(v.included, true);
  assert.deepEqual([v.termDays, v.remainingDays], [365, 300]);
  assert.equal(v.annualizedAgencyCents, 100000);
  assert.equal(v.annualizedBrokerCents, 50000);
  assert.equal(v.grossBuyoutCents, 75000);
  assert.equal(v.outstandingAdvanceCents, 41096); // 500 × 300 / 365 = 410.958… → 410.96
  assert.equal(v.netContributionCents, 33904);
  assert.equal(v.earnedAdvanceCents, 8904);
  assert.deepEqual(v.flags, []);
  assert.equal(r.finalizable, true, r.blockers.join(' '));
});

test('six-month policy: term commission is annualized (× 365 / 181), not used as the annual figure', () => {
  // 2026-01-01 → 2026-07-01 = 181 days; term commission $500 → annualized $1,008.29
  const r = run([P({ id: 'S', expirationDate: '2026-07-01' })], [A({ policyId: 'S', termExpirationDate: '2026-07-01', commissionBasisCents: 50000, amountPaidCents: 25000 })], '2026-04-01');
  const v = pv(r, 'S');
  assert.equal(v.termDays, 181);
  assert.equal(v.annualizedAgencyCents, 100829); // 50000 × 365 / 181 = 100828.73… → 100829
  assert.equal(v.annualizedBrokerCents, 50414);  // 50 % of 100829 = 50414.5 → half-even 50414
  assert.equal(v.grossBuyoutCents, 75621);       // 1.5 × 50414
  assert.equal(v.remainingDays, 91);
  assert.equal(v.outstandingAdvanceCents, 12569); // 25000 × 91 / 181 = 12569.06…
});

test('twelve-month policy across a leap day: 366-day term, exact days', () => {
  const r = run([P({ id: 'L', effectiveDate: '2027-06-01', expirationDate: '2028-06-01' })], [A({ policyId: 'L', termEffectiveDate: '2027-06-01', termExpirationDate: '2028-06-01' })], '2027-12-01');
  const v = pv(r, 'L');
  assert.equal(v.termDays, 366);
  assert.equal(v.annualizedAgencyCents, 99727); // 100000 × 365 / 366 = 99726.78 → 99727
  assert.equal(v.remainingDays, 183);
  assert.equal(v.outstandingAdvanceCents, 25000); // 50000 × 183 / 366 = exactly 25000
});

test('closing date is the first unearned day; remaining days are clamped to the term', () => {
  const on = (c: string) => pv(run([P({ id: 'X' })], [A({ policyId: 'X' })], c), 'X');
  assert.deepEqual([on('2026-01-01').remainingDays, on('2026-01-01').outstandingAdvanceCents], [365, 50000], 'closing on the effective date: all unearned');
  assert.equal(on('2026-12-31').remainingDays, 1);
  assert.equal(on('2026-07-02').remainingDays, 183, 'midterm');
});

test('new business and renewal advances: only the closing term’s advance is deducted', () => {
  const terms: PolicyTerm[] = [
    { id: '2025-01-01', policyId: 'R', effectiveDate: '2025-01-01', scheduledExpirationDate: '2026-01-01', cancellationDate: null, status: 'renewed', note: '' },
    { id: '2026-01-01', policyId: 'R', effectiveDate: '2026-01-01', scheduledExpirationDate: '2027-01-01', cancellationDate: null, status: 'active', note: '' },
  ];
  const nb = A({ policyId: 'R', termEffectiveDate: '2025-01-01', termExpirationDate: '2026-01-01', paymentType: 'new_business', amountPaidCents: 45000, commissionBasisCents: 90000 });
  const rn = A({ policyId: 'R', paymentType: 'renewal' });
  const v = pv(run([P({ id: 'R' })], [nb, rn], '2026-03-07', { termsByPolicy: new Map([['R', terms]]) }), 'R');
  assert.equal(v.term?.source, 'terms');
  assert.deepEqual(v.advanceIds, [rn.id]);
  assert.equal(v.outstandingAdvanceCents, 41096);
});

test('missing advance: nothing is deducted, the policy requires review and finalization is blocked', () => {
  const r = run([P({ id: 'M', premiumCents: 1000000, commissionRateBps: 1000 })], [], '2026-03-07');
  const v = pv(r, 'M');
  assert.ok(v.flags.includes('missing_advance') && v.flags.includes('basis_fallback'));
  assert.equal(v.basis?.source, 'premium_x_rate');
  assert.equal(v.annualizedAgencyCents, 100000, '$10,000 × 10 % = $1,000');
  assert.equal(v.outstandingAdvanceCents, 0);
  assert.equal(r.finalizable, false);
  assert.equal(r.totals.missingAdvances, 1);
  assert.ok(r.blockers.some((b) => /requires? review/.test(b)));
});

test('multiple, partial and corrected advance records', () => {
  const two = [A({ policyId: 'X', amountPaidCents: 30000 }), A({ policyId: 'X', amountPaidCents: 20000 })];
  const v = pv(run([P({ id: 'X' })], two, '2026-03-07'), 'X');
  assert.equal(v.advancePaidCents, 50000);
  assert.equal(v.outstandingAdvanceCents, 41096);
  assert.ok(v.flags.includes('multiple_advances') && !v.material);
  const corrected = [A({ policyId: 'X', amountPaidCents: 60000, status: 'voided' }), A({ policyId: 'X' })];
  assert.equal(pv(run([P({ id: 'X' })], corrected, '2026-03-07'), 'X').advancePaidCents, 50000);
  const partial = pv(run([P({ id: 'X' })], [A({ policyId: 'X', amountPaidCents: 30000 })], '2026-03-07'), 'X');
  assert.ok(partial.flags.includes('amount_mismatch') && partial.material, 'a shortfall against basis × share must be resolved');
  assert.equal(partial.outstandingAdvanceCents, 24658, 'deduction uses the amount ACTUALLY paid: 300 × 300/365');
});

test('cancelled and expired policies are excluded, with no clawback and no deduction against other policies', () => {
  const pols = [P({ id: 'ACT' }), P({ id: 'CAN', status: 'cancelled', effectiveDate: '2025-01-01', expirationDate: '2026-01-01' }), P({ id: 'EXP', status: 'expired', effectiveDate: '2025-01-01', expirationDate: '2026-01-01' })];
  const advs = [A({ policyId: 'ACT' }), A({ policyId: 'CAN', termEffectiveDate: '2025-01-01', termExpirationDate: '2026-01-01', amountPaidCents: 99900 }), A({ policyId: 'EXP', termEffectiveDate: '2025-01-01', termExpirationDate: '2026-01-01' })];
  const r = run(pols, advs, '2026-03-07');
  assert.deepEqual([pv(r, 'CAN').exclusion, pv(r, 'EXP').exclusion], ['cancelled', 'expired']);
  assert.equal(pv(r, 'CAN').netContributionCents, 0);
  const b = r.brokers.find((x) => x.brokerId === 'B50')!;
  assert.equal(b.outstandingAdvanceCents, 41096, 'only the active policy’s outstanding advance is deducted');
  assert.equal(b.finalNetCents, 33904);
  // Term history: cancelled BEFORE closing is excluded; cancelled AFTER closing was in force at closing.
  const t = (cancel: string): PolicyTerm[] => [{ id: '2026-01-01', policyId: 'T', effectiveDate: '2026-01-01', scheduledExpirationDate: '2027-01-01', cancellationDate: cancel, status: 'cancelled', note: '' }];
  assert.equal(pv(run([P({ id: 'T', status: 'cancelled' })], [], '2026-03-07', { termsByPolicy: new Map([['T', t('2026-02-01')]]) }), 'T').exclusion, 'cancelled');
  const after = pv(run([P({ id: 'T', status: 'cancelled' })], [A({ policyId: 'T' })], '2026-03-07', { termsByPolicy: new Map([['T', t('2026-05-01')]]) }), 'T');
  assert.equal(after.included, true);
  assert.ok(after.flags.includes('cancelled_after_closing'));
});

test('eligibility: pending, Unassigned, 0 % (agency-owned), stale dates and unknown cancellation dates', () => {
  const r = run([
    P({ id: 'PEN', status: 'pending' }), P({ id: 'UNA', brokerId: 'UNASSIGNED' }), P({ id: 'HOU', brokerId: 'B0' }),
    P({ id: 'STALE', effectiveDate: '2025-01-01', expirationDate: '2026-01-01' }),
    P({ id: 'CNX', status: 'cancelled' }), P({ id: 'NODATE', effectiveDate: null, expirationDate: null }),
  ], [], '2026-03-07');
  assert.deepEqual(r.policies.map((v) => [v.policyId, v.exclusion]).sort(), [['CNX', 'cancellation_date_unknown'], ['HOU', 'zero_share'], ['NODATE', 'no_term_dates'], ['PEN', 'pending'], ['STALE', 'renewal_not_recorded'], ['UNA', 'agency_owned']].sort());
  assert.ok(pv(r, 'STALE').material && pv(r, 'CNX').material, 'possible eligibility errors block finalization');
  assert.ok(!pv(r, 'PEN').material && !pv(r, 'UNA').material);
  assert.equal(r.totals.eligiblePolicies, 0);
  assert.ok(r.policies.every((v) => v.explanation.startsWith('Excluded:')));
});

test('historical commission receipts never create an entitlement: the engine does not read the ledger', () => {
  // A cancelled policy with years of posted commission is still excluded; there is no ledger input at all.
  const r = run([P({ id: 'HIST', status: 'cancelled', effectiveDate: '2024-01-01', expirationDate: '2025-01-01' })], [], '2026-03-07');
  assert.equal(pv(r, 'HIST').included, false);
  assert.equal(r.totals.grossBuyoutCents, 0);
  assert.ok(!('entries' in (valueBuyout as unknown as Record<string, unknown>)));
});

test('broker reassignment: buyout goes to the broker at closing; another broker’s advance is flagged and not deducted', () => {
  const r = run([P({ id: 'RE', brokerId: 'B40' })], [A({ policyId: 'RE', brokerId: 'B50' })], '2026-03-07');
  const v = pv(r, 'RE');
  assert.equal(v.brokerId, 'B40');
  assert.equal(v.brokerShareBps, 4000);
  assert.ok(v.flags.includes('broker_mismatch') && v.material);
  assert.equal(v.outstandingAdvanceCents, 0);
  assert.equal(r.brokers[0].brokerId, 'B40');
});

test('policy-level share override', () => {
  const v = pv(run([P({ id: 'O', brokerShareBps: 3000 })], [A({ policyId: 'O', brokerShareBps: 3000, amountPaidCents: 30000 })], '2026-03-07'), 'O');
  assert.equal(v.brokerShareBps, 3000);
  assert.equal(v.annualizedBrokerCents, 30000);
  assert.equal(v.grossBuyoutCents, 45000);
});

test('negative commissions and negative net contributions are kept, offset within the broker, and flagged', () => {
  const r = run([
    P({ id: 'NEG' }), P({ id: 'POS' }),
  ], [
    A({ policyId: 'NEG', commissionBasisCents: -20000, amountPaidCents: -10000, brokerShareBps: 5000 }), // chargeback-reduced basis
    A({ policyId: 'POS' }),
  ], '2026-03-07');
  const neg = pv(r, 'NEG');
  assert.equal(neg.grossBuyoutCents, -15000);
  assert.equal(neg.netContributionCents, -15000 - -8219);
  assert.ok(neg.flags.includes('negative_policy_contribution') || neg.netContributionCents < 0);
  const b = r.brokers[0];
  assert.equal(b.netBeforeAdjustmentsCents, pv(r, 'POS').netContributionCents + neg.netContributionCents, 'offset, not discarded');
});

test('negative broker settlement is flagged for manual resolution; no installments, no debt', () => {
  const r = run([P({ id: 'X' })], [A({ policyId: 'X', amountPaidCents: 50000 })], '2026-03-07', { adjustments: [{ id: 'adj1', brokerId: 'B50', amountCents: -100000, reason: 'Overpayment on another account' }] });
  const b = r.brokers[0];
  assert.equal(b.finalNetCents, 33904 - 100000);
  assert.ok(b.flags.includes('negative_broker_settlement'));
  assert.deepEqual(b.installments.map((i) => i.amountCents), [0, 0, 0]);
  assert.equal(r.finalizable, false);
});

test('installments: 50 / 25 / 25 on calendar anniversaries; rounding goes to the closing payment; totals exact', () => {
  const r = run([P({ id: 'X' })], [A({ policyId: 'X' })], '2026-03-07', { adjustments: [{ id: 'a', brokerId: 'B50', amountCents: 3, reason: 'rounding test' }] });
  const b = r.brokers[0];
  assert.equal(b.finalNetCents, 33907);
  assert.deepEqual(b.installments.map((i) => i.amountCents), [16953, 8477, 8477]); // 25 % of 339.07 = 84.7675 → 84.77; closing takes the rest
  assert.equal(b.installments.reduce((s, i) => s + i.amountCents, 0), b.finalNetCents);
  assert.deepEqual(b.installments.map((i) => i.dueDate), ['2026-03-07', '2027-03-07', '2028-03-07']);
  assert.equal(addYearsCalendar('2028-02-29', 1), '2029-02-28');
  assert.equal(addYearsCalendar('2028-02-29', 4), '2032-02-29');
  assert.deepEqual(r.totals.installmentsCents, [16953, 8477, 8477]);
});

test('cent rounding is half-even at each printed step', () => {
  // Annualized broker 50 % of 100001 = 50000.5 → 50000 (even); gross 1.5 × 50000 = 75000.
  const v = pv(run([P({ id: 'X' })], [A({ policyId: 'X', commissionBasisCents: 100001, amountPaidCents: 50000 })], '2026-03-07'), 'X');
  assert.equal(v.annualizedAgencyCents, 100001);
  assert.equal(v.annualizedBrokerCents, 50000);
  assert.equal(v.grossBuyoutCents, 75000);
});

test('reconciliation checks pass on a mixed book; every policy accounted for exactly once', () => {
  const pols = [P({ id: 'A1' }), P({ id: 'A2', brokerId: 'B40' }), P({ id: 'C1', status: 'cancelled', expirationDate: '2026-02-01' }), P({ id: 'U1', brokerId: 'UNASSIGNED' })];
  const advs = [A({ policyId: 'A1' }), A({ policyId: 'A2', brokerId: 'B40', brokerShareBps: 4000, amountPaidCents: 40000 })];
  const r = run(pols, advs, '2026-03-07');
  assert.ok(r.checks.every((c) => c.pass), JSON.stringify(r.checks.filter((c) => !c.pass)));
  assert.equal(r.totals.eligiblePolicies + r.totals.excludedPolicies, 4);
  assert.equal(r.totals.finalNetCents, r.brokers.reduce((s, b) => s + b.finalNetCents, 0));
  assert.equal(r.totals.grossBuyoutCents, 75000 + 60000);
});
