import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyLineOfBusiness, normalizeLob, planLineCorrection, planLineRollback, entityNameSignal, CORRECTION_FIELDS,
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

// --------------------------------------------------------------------------------------------- spelling

test('obvious spelling variations and abbreviations are read, and reported', () => {
  const cases: [string, 'personal' | 'commercial'][] = [
    ['Homowners', 'personal'], ['Genl Liability', 'commercial'], ['Gen. Liab.', 'commercial'], ["Gen'l Liability", 'commercial'],
    ['Homeownres', 'personal'], ['H/O', 'personal'], ['Pers Auto', 'personal'], ['Pvt Pass Auto', 'personal'], ['Pers Umb', 'personal'],
    ['Comm Auto', 'commercial'], ['Coml Auto', 'commercial'], ['Bus Auto', 'commercial'], ['Wkrs Comp', 'commercial'], ['W/C', 'commercial'],
    ['Dwell Fire', 'personal'], ['Motorcyle', 'personal'], ['Prof Liab', 'commercial'],
  ];
  for (const [s, want] of cases) {
    const r = classifyLineOfBusiness(s);
    assert.equal(r.line, want, s);
    assert.ok(r.corrections.length > 0, `${s} should list its correction`);
    assert.match(r.reason, /read as/);
  }
  assert.deepEqual(classifyLineOfBusiness('Homowners').corrections, ['homowners → homeowners']);
});

test('spelling correction is cautious: short, distant or unclear words are left as typed', () => {
  for (const s of ['Personnel', 'Trust', 'Contracts', 'Comprehensive', 'Auto', 'Umb', 'Liabilty', 'Inland Mar']) {
    assert.equal(classifyLineOfBusiness(s).line, null, s);
  }
});

// --------------------------------------------------------------------------------------------- evidence

const ALL = ['statement_classification', 'statement_section', 'statement_title', 'entity_name', 'policy_number_pattern'] as const;
const stmt = (kind: 'statement_classification' | 'statement_section' | 'statement_title', line: 'personal' | 'commercial') =>
  ({ kind, line, detail: `${kind} ${line}` });

test('Auto is never classified without evidence, and never all Personal', () => {
  const plan = planLineCorrection({
    clients: [client('c1'), client('c2')],
    policies: [policy('a1', 'c1', 'Auto'), policy('a2', 'c2', 'Auto', 'personal')],
    acceptEvidence: ALL,
  });
  assert.deepEqual(plan.policies.map((p) => p.action), ['review', 'review']);
  assert.equal(plan.counts.evidence.noAcceptedEvidence, 2);
});

test('statement evidence resolves an ambiguous Auto policy, and the client follows', () => {
  const ev = new Map([['a1', [stmt('statement_classification', 'personal'), stmt('statement_section', 'personal')]], ['a2', [stmt('statement_title', 'commercial')]]]);
  const plan = planLineCorrection({
    clients: [client('c1'), client('c2', 'personal')],
    policies: [policy('a1', 'c1', 'Auto'), policy('h1', 'c1', 'Homeowners'), policy('a2', 'c2', 'Auto', 'personal')],
    statementEvidence: ev, acceptEvidence: ['statement_classification', 'statement_section', 'statement_title'],
  });
  const a1 = plan.policies.find((p) => p.id === 'a1')!;
  assert.equal(a1.target, 'personal'); assert.equal(a1.basis, 'evidence'); assert.match(a1.reason, /decided by evidence/);
  assert.equal(plan.policies.find((p) => p.id === 'a2')!.target, 'commercial');
  assert.equal(plan.clients.find((c) => c.id === 'c1')!.target, 'personal');
  assert.equal(plan.clients.find((c) => c.id === 'c2')!.target, 'commercial');
  assert.equal(plan.counts.evidence.resolvedPersonal, 1);
  assert.equal(plan.counts.evidence.resolvedCommercial, 1);
  const row = plan.lobSummary.find((r) => r.lobNormalized === 'auto')!;
  assert.deepEqual(row.evidence, { personal: 1, commercial: 1, conflict: 0, none: 0 });
});

test('evidence that is not accepted is reported, never applied', () => {
  const ev = new Map([['a1', [stmt('statement_classification', 'personal')]]]);
  const plan = planLineCorrection({
    clients: [{ ...client('c1'), name: 'Synthetic Towing LLC' }],
    policies: [policy('a1', 'c1', 'Auto'), policy('a2', 'c1', 'Auto')],
    statementEvidence: ev, acceptEvidence: [],
  });
  assert.ok(plan.policies.every((p) => p.action === 'review'));
  assert.deepEqual(plan.counts.evidence.availableNotAccepted.statement_classification, { personal: 1, commercial: 0 });
  assert.deepEqual(plan.counts.evidence.availableNotAccepted.entity_name, { personal: 0, commercial: 2 });
});

test('any contradicting evidence keeps the policy unchanged — even evidence of a kind not accepted', () => {
  const ev = new Map([['a1', [stmt('statement_classification', 'personal')]], ['a2', [stmt('statement_classification', 'personal'), stmt('statement_section', 'commercial')]]]);
  const plan = planLineCorrection({
    clients: [{ ...client('c1'), name: 'Synthetic Towing LLC' }, client('c2')],
    policies: [policy('a1', 'c1', 'Auto'), policy('a2', 'c2', 'Auto')],
    statementEvidence: ev, acceptEvidence: ['statement_classification', 'statement_section', 'statement_title'],
  });
  assert.equal(plan.policies.find((p) => p.id === 'a1')!.action, 'review', 'personal statement but an LLC name');
  assert.equal(plan.policies.find((p) => p.id === 'a2')!.action, 'review', 'personal and commercial statements');
  assert.equal(plan.counts.exceptionsByCode.policy_evidence_conflict, 2);
});

test('business-entity names give Commercial evidence only; individuals and trusts give none', () => {
  for (const n of ['Synthetic Cab LLC', 'Example Towing, Inc.', 'Acme Corp', 'Smith Holdings L.L.C.', 'Joe Smith DBA Joe Plumbing']) {
    assert.equal(entityNameSignal(n)?.line, 'commercial', n);
  }
  for (const n of ['Pat Example', 'Smith Family Trust', 'Estate of J Doe', 'Lincoln Smith', 'Vince Coco']) assert.equal(entityNameSignal(n), null, n);
});

test('policy-number pattern evidence needs at least 10 clear policies, all one type, at the same carrier', () => {
  const pol = (id: string, num: string, type: string, carrierId = 'K1') => ({ ...policy(id, 'c1', type), policyNumber: num, carrierId });
  const clear = Array.from({ length: 10 }, (_, i) => pol(`h${i}`, `HP${1000 + i}`, 'Homeowners'));
  const plan = planLineCorrection({
    clients: [client('c1')],
    policies: [...clear, pol('a1', 'HP5555', 'Auto'), pol('a2', 'HP6666', 'Auto', 'K2'), pol('a3', 'ZZ1234', 'Auto')],
    acceptEvidence: ['policy_number_pattern'],
  });
  const by = new Map(plan.policies.map((p) => [p.id, p]));
  assert.equal(by.get('a1')!.target, 'personal');
  assert.equal(by.get('a2')!.action, 'review', 'other carrier');
  assert.equal(by.get('a3')!.action, 'review', 'other pattern');
  const nine = planLineCorrection({ clients: [client('c1')], policies: [...clear.slice(1), pol('a1', 'HP5555', 'Auto')], acceptEvidence: ['policy_number_pattern'] });
  assert.equal(nine.policies.find((p) => p.id === 'a1')!.action, 'review', 'only 9 examples');
});

test("the client's other policies are shown but never decide", () => {
  const plan = planLineCorrection({ clients: [client('c1')], policies: [policy('a1', 'c1', 'Auto'), policy('h1', 'c1', 'Homeowners')], acceptEvidence: ALL });
  const a1 = plan.policies.find((p) => p.id === 'a1')!;
  assert.equal(a1.action, 'review');
  assert.deepEqual(a1.siblings, { personal: 1, commercial: 0 });
});

test('a value the owner marked "review" is not decided by evidence', () => {
  const ev = new Map([['a1', [stmt('statement_classification', 'personal')]]]);
  const plan = planLineCorrection({ clients: [client('c1')], policies: [policy('a1', 'c1', 'Auto')], overrides: { auto: 'review' }, statementEvidence: ev, acceptEvidence: ALL });
  assert.equal(plan.policies[0].action, 'review');
});

test('a clear line of business still decides when statement evidence disagrees, and the disagreement is reported', () => {
  const ev = new Map([['h1', [stmt('statement_classification', 'commercial')]]]);
  const plan = planLineCorrection({ clients: [client('c1')], policies: [policy('h1', 'c1', 'Homeowners')], statementEvidence: ev, acceptEvidence: ALL });
  assert.equal(plan.policies[0].target, 'personal');
  assert.match(plan.policies[0].crossCheck ?? '', /line of business says Personal/);
  assert.equal(plan.counts.evidence.lobStatementDisagreements, 1);
});
