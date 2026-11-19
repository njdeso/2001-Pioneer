import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewerOverview, reviewerSummaryCsv, guardReviewerPayload } from '../src/external/reviewerViews.ts';
import { reviewerLineBreakdown, pct } from '../src/external/lineBreakdown.ts';

// Synthetic data only.
const settings = { agencyName: 'Test Agency', snapshotStartMonth: '2025-12', snapshotMonths: 12 };
const carriers = [{ id: 'CA', name: 'Synthetic Mutual', kind: 'carrier', commissionMethod: 'statement', status: 'active' }, { id: 'CB', name: 'Example Casualty', kind: 'carrier', commissionMethod: 'statement', status: 'active' }];
const clients = ['C1', 'C2', 'C3', 'C4', 'C5'].map((id) => ({ id, status: 'active' }));
const policies = [
  { id: 'P1', clientId: 'C1', carrierId: 'CA', policyNumber: 'H-1', status: 'active', line: 'personal' },
  { id: 'P2', clientId: 'C1', carrierId: 'CA', policyNumber: 'A-1', status: 'active', line: 'personal' },
  { id: 'P3', clientId: 'C2', carrierId: 'CB', policyNumber: 'B-1', status: 'active', line: 'commercial' },
  { id: 'P4', clientId: 'C3', carrierId: 'CA', policyNumber: 'H-2', status: 'active', line: 'personal' },
  { id: 'P5', clientId: 'C3', carrierId: 'CB', policyNumber: 'W-1', status: 'active', line: 'commercial' },
  { id: 'P6', clientId: 'C4', carrierId: 'CA', policyNumber: 'X-1', status: 'cancelled', line: 'commercial' },
  { id: 'P7', clientId: 'C5', carrierId: 'CB', policyNumber: 'U-1', status: 'active', line: '' },
];
const statements = [
  { id: 'S-PL', status: 'posted', statementMonth: '2026-01', payerId: 'CA', classification: 'personal' },
  { id: 'S-CL', status: 'posted', statementMonth: '2026-01', payerId: 'CB', classification: 'commercial' },
  { id: 'S-UN', status: 'posted', statementMonth: '2026-02', payerId: 'CA' },
];
const e = (id: string, amountCents: number, x: Record<string, unknown>) => ({ id, amountCents, statementPeriod: '2026-01', postingStatus: 'posted', level: 'policy', sourceType: 'statement', classification: 'new_business', ...x });
const entries = [
  e('L1', 10000, { policyId: 'P1', carrierId: 'CA', payerId: 'CA', statementId: 'S-PL', clientId: 'C1', postingId: 'G1' }),
  e('L2', 5000, { policyId: 'P4', carrierId: 'CA', payerId: 'CA', statementId: 'S-PL', clientId: 'C3', postingId: 'G1' }),
  e('L3', 20000, { policyId: 'P3', carrierId: 'CB', payerId: 'CB', statementId: 'S-CL', clientId: 'C2', postingId: 'G2' }),
  e('L4', 3000, { policyId: 'P5', carrierId: 'CB', payerId: 'CB', statementId: 'S-CL', clientId: 'C3', postingId: 'G2' }),
  e('L5', 700, { policyId: 'P7', carrierId: 'CB', payerId: 'CB', statementId: 'S-UN', statementPeriod: '2026-02', clientId: 'C5', postingId: 'G3' }),
  // a posting and its reversal: nets to zero
  e('L6', 4000, { policyId: 'P2', carrierId: 'CA', payerId: 'CA', statementId: 'S-UN', statementPeriod: '2026-02', postingStatus: 'reversed', reversalId: 'L6R', postingId: 'G4' }),
  e('L6R', -4000, { policyId: 'P2', carrierId: 'CA', payerId: 'CA', statementId: 'S-UN', statementPeriod: '2026-02', postingStatus: 'posted', reversalOf: 'L6', postingId: 'G4' }),
  // carrier-level bonus and profit sharing (no policy)
  e('L7', 2500, { level: 'carrier', carrierId: 'CA', payerId: 'CA', statementId: 'S-PL', classification: 'bonus', postingId: 'G1' }),
  e('L8', 1200, { level: 'carrier', carrierId: 'CB', payerId: 'CB', sourceType: 'manual', classification: 'profit_sharing', statementId: null, postingId: 'G5' }),
  // outside the window: excluded
  e('L9', 99999, { policyId: 'P1', carrierId: 'CA', payerId: 'CA', statementPeriod: '2025-01', postingId: 'G6' }),
];

const overview = () => reviewerOverview({ settings, entries: entries as never, carriers, policies, statements, clients });

test('client breakdown counts each client once; mixed clients are separate', () => {
  const l = overview().lines!;
  assert.deepEqual(l.clients, { total: 5, personal: 1, commercial: 1, mixed: 1, unclassified: 1, noActivePolicies: 1 });
  assert.equal(l.clients.personal + l.clients.commercial + l.clients.mixed + l.clients.unclassified + l.clients.noActivePolicies, l.clients.total);
});

test('active and all policies by line', () => {
  const l = overview().lines!;
  assert.deepEqual(l.activePolicies, { total: 6, personal: 3, commercial: 2, unclassified: 1 });
  assert.deepEqual(l.allPolicies, { total: 7, personal: 3, commercial: 3, unclassified: 1 });
});

test('commission by line comes only from the policy posted to; nothing estimated; reversals net; window respected', () => {
  const l = overview().lines!;
  assert.deepEqual(l.commission, { personal: 15000, commercial: 23000, unclassified: 700, notAttributable: 3700, total: 42400 });
  assert.equal(l.byMonth.find((m) => m.month === '2026-02')!.cents.personal, 0, 'reversed posting nets to zero');
  assert.equal(l.byMonth.reduce((t, m) => t + m.cents.total, 0), l.commission.total);
});

test('ties exactly to the commission summary total', () => {
  const o = overview();
  assert.equal(o.lines!.commission.total, o.postedTotal.total);
  assert.equal(o.lines!.tiesToSummaryTotal, true);
});

test('carrier split, bonuses and profit sharing, and statement marking cross-check', () => {
  const l = overview().lines!;
  const ca = l.byCarrier.find((c) => c.name === 'Synthetic Mutual')!.cents;
  assert.deepEqual(ca, { personal: 15000, commercial: 0, unclassified: 0, notAttributable: 2500, total: 17500 });
  assert.deepEqual(l.bonusProfitSharing, { bonusCents: 2500, profitSharingCents: 1200, byCarrier: [
    { name: 'Example Casualty', bonusCents: 0, profitSharingCents: 1200 }, { name: 'Synthetic Mutual', bonusCents: 2500, profitSharingCents: 0 }] });
  assert.deepEqual(l.byStatementMarking, { personal: 17500, commercial: 23000, other: 0, unmarked: 700, notFromStatement: 1200, total: 42400 });
});

test('always marked PRELIMINARY with the reconciliation notice', () => {
  const l = overview().lines!;
  assert.equal(l.preliminary, true);
  assert.match(l.notice, /^PRELIMINARY — subject to classification reconciliation/);
});

test('passes the reviewer payload guard and carries no broker data, even with broker IDs present', () => {
  const o = overview();
  guardReviewerPayload({ overview: o }, ['BRK1', 'NICK']);
  assert.doesNotMatch(JSON.stringify(o.lines), /broker|split|advance|buyout|settlement|BRK1|NICK/i);
});

test('summary CSV includes the breakdown, labelled PRELIMINARY, with no broker data', () => {
  const csv = reviewerSummaryCsv(overview(), '2026-11-19T18:00:00Z');
  assert.match(csv, /PERSONAL LINES vs COMMERCIAL LINES — PRELIMINARY — subject to classification reconciliation/);
  assert.match(csv, /Mixed \(both\),1,20\.0%/);
  assert.match(csv, /Personal Lines,150\.00,35\.4%/);
  assert.match(csv, /Ties to the posted commission total: yes/);
  // The standard banner line says "Contains no broker information"; nothing else may mention brokers.
  assert.doesNotMatch(csv.split('\r\n').filter((l) => !/Contains no broker information/.test(l)).join('\n'), /broker|BRK/i);
});

test('without a client list (older callers) the breakdown is simply absent', () => {
  const o = reviewerOverview({ settings, entries: entries as never, carriers, policies, statements });
  assert.equal(o.lines, null);
});

test('no snapshot window: no breakdown; pct handles zero totals', () => {
  assert.equal(reviewerLineBreakdown({ entries: [], policies: [], clients: [], carriers: [], statements: [], start: null, months: 12, summaryTotalCents: null }), null);
  assert.equal(pct(1, 0), '—');
  assert.equal(pct(1, 3), '33.3%');
});
