import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyLineOfBusiness, normalizeLob, planLineCorrection, planLineRollback, CORRECTION_FIELDS,
  type CorrectionClientIn, type CorrectionPolicyIn, type AppliedChange,
} from '../src/lineOfBusiness.ts';

const cls = (s: string) => classifyLineOfBusiness(s).line;

test('normalizeLob: case, punctuation and "&"', () => {
  assert.equal(normalizeLob('  Business-Owners (BOP) '), 'business owners bop');
  assert.equal(normalizeLob('E&O'), 'e and o');
  assert.equal(normalizeLob(null), '');
});

test('personal lines of business', () => {
  for (const s of ['Homeowners', 'HO-3', 'HO6', 'Renters', 'Condo', 'Dwelling Fire', 'DP-3', 'Personal Auto', 'Private Passenger Auto', 'PPA',
    'Motorcycle', 'Boat', 'RV', 'Mobile Home', 'Jewelry Floater', 'Personal Articles', 'Personal Umbrella', 'Home & Auto', 'Personal Inland Marine']) {
    assert.equal(cls(s), 'personal', s);
  }
});

test('commercial lines of business', () => {
  for (const s of ['BOP', 'Businessowners', 'Business Owners', 'Commercial Package', 'CPP', 'General Liability', 'GL', 'CGL', 'Workers Comp',
    'Workers Compensation', 'WC', 'NYS DBL', 'Disability Benefits', 'Paid Family Leave', 'Commercial Auto', 'Business Auto', 'Commercial Umbrella',
    'Garage Liability', 'Builders Risk', 'E&O', 'D&O', 'EPLI', 'Cyber Liability', 'Surety Bond', 'Condo Association', 'Homeowners Association',
    'Home Based Business', 'Home Health Care', 'Contractors Equipment', 'Liquor Liability', 'Apartment Building']) {
    assert.equal(cls(s), 'commercial', s);
  }
});

test('ambiguous, blank or conflicting lines of business are never guessed', () => {
  for (const s of ['', '   ', 'Auto', 'Umbrella', 'Excess Liability', 'Flood', 'Inland Marine', 'Package', 'Property', 'Landlord', 'Life', 'Fire',
    'Home Improvement Contractor', 'Personal Business Pursuits', 'XYZ-123', 'Other']) {
    const r = classifyLineOfBusiness(s);
    assert.equal(r.line, null, s);
    assert.equal(r.basis, 'none', s);
    assert.ok(r.reason.length > 0);
  }
});

test('reviewed overrides win, by normalized value; "review" keeps it for manual review', () => {
  assert.equal(classifyLineOfBusiness('Umbrella', { umbrella: 'personal' }).line, 'personal');
  assert.equal(classifyLineOfBusiness('UMBRELLA ', { umbrella: 'personal' }).basis, 'override');
  assert.equal(classifyLineOfBusiness('Homeowners', { homeowners: 'review' }).line, null);
  assert.equal(classifyLineOfBusiness('Auto', { auto: 'commercial' }).line, 'commercial');
});

// --------------------------------------------------------------------------------------------- planner

const T = '2026-11-01T00:00:00.000000Z';
const client = (id: string, classification: unknown = 'commercial'): CorrectionClientIn => ({ id, name: `Client ${id}`, classification, updateTime: T });
const policy = (id: string, clientId: string, policyType: string, line: unknown = 'commercial', status = 'active'): CorrectionPolicyIn =>
  ({ id, clientId, policyNumber: `PN-${id}`, policyType, line, status, updateTime: T });

test('policies of every status are corrected from their line of business', () => {
  const plan = planLineCorrection({
    clients: [client('c1')],
    policies: [policy('p1', 'c1', 'Homeowners', 'commercial', 'active'), policy('p2', 'c1', 'Personal Auto', 'commercial', 'expired'),
      policy('p3', 'c1', 'HO-3', 'commercial', 'cancelled'), policy('p4', 'c1', 'Renters', 'personal', 'pending')],
  });
  assert.deepEqual(plan.policies.map((p) => [p.id, p.action, p.target]), [
    ['p1', 'change', 'personal'], ['p2', 'change', 'personal'], ['p3', 'change', 'personal'], ['p4', 'unchanged', 'personal'],
  ]);
  assert.equal(plan.counts.policiesChange, 3);
  assert.deepEqual(plan.counts.policiesByStatus.cancelled, { total: 1, change: 1, review: 0 });
  assert.deepEqual(plan.counts.policiesByStatus.expired, { total: 1, change: 1, review: 0 });
  assert.equal(plan.clients[0].action, 'change');
  assert.equal(plan.clients[0].target, 'personal');
});

test('client rules: all personal, all commercial, mixed, no policies, ambiguous', () => {
  const plan = planLineCorrection({
    clients: [client('allP'), client('allC', 'personal'), client('mixed', 'commercial'), client('empty'), client('amb'), client('ok', 'commercial')],
    policies: [
      policy('a1', 'allP', 'Homeowners'), policy('a2', 'allP', 'Auto - Personal'),
      policy('b1', 'allC', 'BOP', 'personal'), policy('b2', 'allC', 'Workers Comp', 'personal'),
      policy('m1', 'mixed', 'Homeowners'), policy('m2', 'mixed', 'BOP'),
      policy('x1', 'amb', 'Homeowners'), policy('x2', 'amb', 'Umbrella'),
      policy('k1', 'ok', 'General Liability'),
    ],
  });
  const by = new Map(plan.clients.map((c) => [c.id, c]));
  assert.equal(by.get('allP')!.target, 'personal');
  assert.equal(by.get('allP')!.action, 'change');
  assert.equal(by.get('allC')!.target, 'commercial');
  assert.equal(by.get('allC')!.action, 'change');
  assert.equal(by.get('mixed')!.action, 'review');
  assert.equal(by.get('mixed')!.target, null, 'mixed keeps its current classification');
  assert.equal(by.get('empty')!.action, 'review');
  assert.equal(by.get('amb')!.action, 'review');
  assert.equal(by.get('ok')!.action, 'unchanged');
  const codes = plan.exceptions.map((e) => `${e.code}:${e.id}`).sort();
  assert.deepEqual(codes, ['client_has_review_policies:amb', 'client_mixed:mixed', 'client_no_policies:empty', 'policy_lob_review:x2']);
  // The ambiguous policy itself is not changed; its unambiguous sibling still is.
  assert.equal(plan.policies.find((p) => p.id === 'x2')!.action, 'review');
  assert.equal(plan.policies.find((p) => p.id === 'x1')!.action, 'change');
  assert.equal(plan.counts.clientsChange, 2);
  assert.equal(plan.counts.clientsReview, 3);
});

test('blank line of business and orphan policies are flagged, never changed', () => {
  const plan = planLineCorrection({ clients: [client('c1')], policies: [policy('p1', 'c1', ''), policy('p2', 'gone', 'Homeowners')] });
  assert.equal(plan.policies.find((p) => p.id === 'p1')!.action, 'review');
  assert.deepEqual(plan.exceptions.map((e) => e.code).sort(), ['client_has_review_policies', 'policy_client_missing', 'policy_lob_blank']);
});

test('an invalid current value is corrected when the policies agree', () => {
  const plan = planLineCorrection({ clients: [client('c1', '')], policies: [policy('p1', 'c1', 'BOP', null)] });
  assert.equal(plan.policies[0].action, 'change');
  assert.equal(plan.clients[0].action, 'change');
  assert.equal(plan.clients[0].target, 'commercial');
});

test('line-of-business summary counts every distinct value and its changes', () => {
  const plan = planLineCorrection({
    clients: [client('c1')],
    policies: [policy('p1', 'c1', 'Homeowners'), policy('p2', 'c1', 'HOMEOWNERS'), policy('p3', 'c1', 'Umbrella'), policy('p4', 'c1', '')],
  });
  const row = plan.lobSummary.find((r) => r.lobNormalized === 'homeowners')!;
  assert.equal(row.policies, 2);
  assert.equal(row.changes, 2);
  assert.deepEqual(row.examples, ['Homeowners', 'HOMEOWNERS']);
  assert.equal(plan.lobSummary.find((r) => r.lobNormalized === 'umbrella')!.decision, 'review');
  assert.ok(plan.lobSummary.find((r) => r.lobNormalized === '(blank)'));
});

test('planner output never carries broker, premium, carrier or commission data', () => {
  const plan = planLineCorrection({
    clients: [{ ...client('c1'), brokerId: 'B1' } as CorrectionClientIn],
    policies: [{ ...policy('p1', 'c1', 'Homeowners'), brokerId: 'B1', brokerShareBps: 5000, premiumCents: 100, carrierId: 'X', commissionRateBps: 1500 } as CorrectionPolicyIn],
  });
  const text = JSON.stringify(plan);
  for (const k of ['brokerId', 'brokerShareBps', 'premiumCents', 'carrierId', 'commissionRateBps', 'B1']) assert.ok(!text.includes(k), k);
});

test('only policies.line and clients.classification are correction fields', () => {
  assert.deepEqual(CORRECTION_FIELDS, { clients: 'classification', policies: 'line' });
});

test('rollback restores only records the correction still owns', () => {
  const applied: AppliedChange[] = [
    { collection: 'policies', id: 'p1', field: 'line', before: 'commercial', after: 'personal', writeTime: 'W1' },
    { collection: 'policies', id: 'p2', field: 'line', before: 'commercial', after: 'personal', writeTime: 'W2' },
    { collection: 'clients', id: 'c1', field: 'classification', before: 'commercial', after: 'personal', writeTime: 'W3' },
    { collection: 'clients', id: 'c2', field: 'classification', before: 'commercial', after: 'personal', writeTime: 'W4' },
  ];
  const current = new Map([
    ['policies/p1', { exists: true, value: 'personal', updateTime: 'W1' }],
    ['policies/p2', { exists: true, value: 'personal', updateTime: 'LATER' }], // edited since (e.g. premium)
    ['clients/c1', { exists: true, value: 'commercial', updateTime: 'LATER' }], // owner set it back by hand
  ]);
  const r = planLineRollback(applied, current);
  assert.deepEqual(r.restore.map((c) => c.id), ['p1']);
  assert.deepEqual(r.skipped.map((s) => s.change.id), ['p2', 'c1', 'c2']);
});
