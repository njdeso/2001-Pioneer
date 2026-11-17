import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXTERNAL_ROLES, externalAccessDecision, externalInviteInput, externalRevokeInput, reviewerViewInput, reviewerExportInput,
} from '../src/external/access.ts';
import {
  guardReviewerPayload, reviewerBook, reviewerBookCsv, reviewerCarriers, reviewerOverview, reviewerStatements, reviewerStatementsCsv,
  reviewerSummaryCsv, reviewerTransactions, reviewerTransactionsCsv,
} from '../src/external/reviewerViews.ts';
import type { ReportEntry } from '../src/reports/ledger.ts';

// Synthetic records shaped like the stored documents, deliberately FULL of confidential broker and internal
// data ("canaries"). None of it may appear in anything a reviewer receives.
const CANARY = {
  brokerName: 'Canary Broker Smithwick', brokerId: 'BRK-CANARY-7', brokerCode: 'CANBRK',
  shareBps: 4321, brokerCents: 77_777, agencyCents: 66_666, note: 'CANARY-INTERNAL-NOTE', email: 'canary.staff@example.test',
  phone: '555-0199-CANARY', street: '1 Canary Lane', file: 'Canary-Broker-Statement.pdf', approver: 'canary-approver-uid',
};
const carriers = [
  { id: 'CA', name: 'Synthetic Mutual', code: 'SYM', kind: 'carrier', commissionMethod: 'statement', status: 'active', agencyCodes: ['AG-CANARY'], contact: { email: CANARY.email, phone: CANARY.phone, street: CANARY.street }, defaultRateBps: 1500 },
  { id: 'W1', name: 'Synthetic MGA', code: 'SMGA', kind: 'wholesaler', commissionMethod: 'statement', status: 'active', contact: { email: CANARY.email } },
  { id: 'RT', name: 'Retained Co', code: 'RET', kind: 'carrier', commissionMethod: 'retained', status: 'active' },
];
const clients = [
  { id: 'C1', name: 'ALPHA SYNTHETIC LLC', externalId: '1001', classification: 'commercial', brokerId: CANARY.brokerId, contact: { email: CANARY.email, phone: CANARY.phone, street: CANARY.street }, status: 'active', createdBy: CANARY.approver },
  { id: 'C2', name: 'Bravo Synthetic', externalId: '1002', classification: 'personal', brokerId: CANARY.brokerId, status: 'active' },
  { id: 'C3', name: 'Charlie Lapsed', externalId: '1003', classification: 'personal', brokerId: CANARY.brokerId, status: 'inactive' },
];
const policies = [
  { id: 'P1', clientId: 'C1', carrierId: 'CA', wholesalerId: null, policyNumber: 'SYN-001', alternateNumbers: [], line: 'commercial', policyType: 'BOP', namedInsured: 'ALPHA SYNTHETIC LLC', effectiveDate: '2026-01-01', expirationDate: '2027-01-01', status: 'active', premiumCents: 250_000, commissionRateBps: 1500, brokerId: CANARY.brokerId, brokerShareBps: CANARY.shareBps, updatedBy: CANARY.approver },
  { id: 'P2', clientId: 'C2', carrierId: 'CA', wholesalerId: 'W1', policyNumber: 'SYN-002', line: 'personal', policyType: 'Auto', status: 'active', premiumCents: 120_000, commissionRateBps: 1000, brokerId: CANARY.brokerId, brokerShareBps: CANARY.shareBps },
  { id: 'P3', clientId: 'C3', carrierId: 'CA', policyNumber: 'SYN-003', line: 'personal', status: 'cancelled', premiumCents: 90_000, brokerId: CANARY.brokerId },
];
const e = (id: string, period: string, amount: number, extra: Partial<ReportEntry> = {}): ReportEntry => ({
  id, statementPeriod: period, amountCents: amount, postingStatus: 'posted', payerId: 'CA', carrierId: 'CA', clientId: 'C1', policyId: 'P1',
  sourceType: 'statement', level: 'policy', classification: 'renewal', statementId: 'S1', postingId: 'PST1', reversalOf: null, transactionDate: `${period}-15`,
  brokerId: CANARY.brokerId, brokerShareBps: CANARY.shareBps, brokerCents: CANARY.brokerCents, agencyCents: amount - CANARY.brokerCents, note: CANARY.note, approvedBy: CANARY.approver,
  ...extra,
} as ReportEntry);
const entries: ReportEntry[] = [
  e('L1', '2026-01', 150_000),
  e('L2', '2026-02', 150_000, { policyId: 'P2', clientId: 'C2' }),
  e('L3', '2026-02', 10_000, { policyId: 'P3', clientId: 'C3' }), // policy since cancelled: posted, still counted
  e('L4', '2025-06', 99_999), // outside the window
];
const statements = [
  { id: 'S1', status: 'posted', statementMonth: '2026-01', payerId: 'CA', statementTotalCents: 150_000, postedCents: 150_000, fileName: CANARY.file, approval: { email: CANARY.email, totals: { brokerCents: CANARY.brokerCents, agencyCents: CANARY.agencyCents } }, posting: { email: CANARY.email, brokerCents: CANARY.brokerCents }, reconciliation: { reconciled: true, checks: [{ key: 'commission', label: 'Paid commission (sum of lines)', statedCents: 150_000, extractedCents: 150_000, differenceCents: 0, ok: true, required: true }], totals: { commissionCents: 150_000, adjustmentsCents: 0, brokerCents: CANARY.brokerCents }, blockingReasons: [`Broker ${CANARY.brokerName} split`] } },
  { id: 'S2', status: 'discrepancy', statementMonth: '2026-03', payerId: 'CA', statementTotalCents: 390_000, postedCents: 0, fileName: CANARY.file, reconciliation: { reconciled: false, checks: [{ key: 'monthPayable', label: 'Statement total (final net commission as printed)', statedCents: 390_000, extractedCents: 270_000, differenceCents: -120_000, ok: false, required: true }], totals: { commissionCents: 270_000, adjustmentsCents: 0 }, blockingReasons: [CANARY.note], findings: [CANARY.note] } },
  { id: 'S3', status: 'needs_review', statementMonth: '2026-02', payerId: 'W1', statementTotalCents: 2_500, postedCents: 0, reconciliation: { reconciled: true, checks: [], totals: { commissionCents: 2_500, adjustmentsCents: 0 } } },
  { id: 'S4', status: 'discarded', statementMonth: '2026-02', payerId: 'CA', statementTotalCents: 1, fileName: CANARY.file },
  { id: 'S5', status: 'approved', statementMonth: '2026-02', payerId: 'CA', statementTotalCents: 5_000, postedCents: 0, approval: { totals: { brokerCents: 2500 } }, reconciliation: { reconciled: true, checks: [], totals: { commissionCents: 5_000, adjustmentsCents: 0 } } },
];
const settings = { agencyName: 'Test Agency LLC', snapshotStartMonth: '2025-11', snapshotMonths: 12, defaultBrokerShareBps: CANARY.shareBps, aiModel: 'x' };
const brokerIds = [CANARY.brokerId, CANARY.brokerCode, 'UNASSIGNED'];

/** Nothing confidential, anywhere in the serialized payload (keys or values). */
function assertNoLeak(payload: unknown, label: string) {
  const json = JSON.stringify(payload);
  for (const v of [CANARY.brokerName, CANARY.brokerId, CANARY.brokerCode, CANARY.note, CANARY.email, CANARY.phone, CANARY.street, CANARY.file, CANARY.approver, 'AG-CANARY', 'UNASSIGNED']) {
    assert.ok(!json.includes(v), `${label}: contains "${v}"`);
  }
  for (const n of [CANARY.shareBps, CANARY.brokerCents, CANARY.agencyCents, 150_000 - CANARY.brokerCents]) {
    assert.ok(!new RegExp(`(?<![0-9])${n}(?![0-9])`).test(json), `${label}: contains the number ${n}`);
  }
  assert.ok(!/broker|share|split|note|email|phone|contact|approv|createdBy|updatedBy|fileName/i.test(json.replace(/"[^"]*"\s*:/g, (k) => k).match(/"([^"]+)"\s*:/g)?.join(' ') ?? ''), `${label}: forbidden key`);
  guardReviewerPayload(payload, brokerIds);
}

test('access decision: only an active, unexpired record with the same role authorizes an external caller', () => {
  const rec = { role: 'buyer' as const, status: 'active' as const, expiresOn: '2026-12-31' };
  assert.deepEqual(externalAccessDecision('buyer', rec, '2026-11-16'), { ok: true });
  assert.deepEqual(externalAccessDecision('buyer', rec, '2026-12-31'), { ok: true }, 'valid through the end date');
  assert.deepEqual(externalAccessDecision('buyer', rec, '2027-01-01'), { ok: false, reason: 'expired' });
  assert.deepEqual(externalAccessDecision('buyer', { ...rec, status: 'revoked' }, '2026-11-16'), { ok: false, reason: 'revoked' });
  assert.deepEqual(externalAccessDecision('diligence', rec, '2026-11-16'), { ok: false, reason: 'role_mismatch' }, 'a buyer record cannot authorize a diligence claim');
  assert.deepEqual(externalAccessDecision('buyer', null, '2026-11-16'), { ok: false, reason: 'no_record' }, 'a forged claim without an owner record gets nothing');
  for (const r of ['admin', 'staff', '', undefined, 'BUYER']) assert.deepEqual(externalAccessDecision(r, rec, '2026-11-16'), { ok: false, reason: 'not_external' });
  assert.deepEqual(externalAccessDecision('buyer', { ...rec, expiresOn: 'never' }, '2026-11-16'), { ok: false, reason: 'expired' });
});

test('inputs: only the two external roles; strict objects; manipulated requests are rejected', () => {
  assert.deepEqual([...EXTERNAL_ROLES], ['buyer', 'diligence']);
  assert.equal(externalInviteInput.safeParse({ email: 'A@Example.com ', role: 'buyer', expiresOn: '2026-12-31' }).data?.email, 'a@example.com');
  for (const bad of [
    { email: 'a@example.com', role: 'admin', expiresOn: '2026-12-31' },
    { email: 'a@example.com', role: 'staff', expiresOn: '2026-12-31' },
    { email: 'a@example.com', role: 'buyer' },
    { email: 'a@example.com', role: 'buyer', expiresOn: '2026-12-31', claims: { role: 'admin' } },
    { email: 'not-an-email', role: 'buyer', expiresOn: '2026-12-31' },
  ]) assert.equal(externalInviteInput.safeParse(bad).success, false, JSON.stringify(bad));
  assert.equal(externalRevokeInput.safeParse({ uid: 'abc', reason: 'done', extra: 1 }).success, false);
  for (const bad of [{ view: 'brokers' }, { view: 'buyout' }, { view: 'overview', fields: ['brokerId'] }, { view: 'overview', collection: 'brokers' }, {}]) assert.equal(reviewerViewInput.safeParse(bad).success, false, JSON.stringify(bad));
  for (const bad of [{ kind: 'ledger' }, { kind: 'brokers' }, { kind: 'summary', variant: 'accounting' }]) assert.equal(reviewerExportInput.safeParse(bad).success, false, JSON.stringify(bad));
});

test('views built from FULL records (broker fields, notes, contacts, audit fields present) contain none of them', () => {
  const o = reviewerOverview({ settings, entries, carriers, policies, statements });
  const views = {
    carriers: reviewerCarriers(carriers),
    statements: reviewerStatements(statements, carriers),
    book: reviewerBook({ clients, policies, carriers, entries, start: '2025-11', months: 12 }),
    transactions: reviewerTransactions({ entries, carriers, clients, policies, start: '2025-11', months: 12 }),
    overview: o,
  };
  for (const [k, v] of Object.entries(views)) assertNoLeak(v, k);
  assert.deepEqual(Object.keys(views.carriers[0]).sort(), ['commissionMethod', 'id', 'kind', 'name', 'status']);
  assert.deepEqual(Object.keys(views.book.policies[0]).sort(), ['agencyCommissionRateBps', 'alternateNumbers', 'annualPremiumCents', 'carrier', 'client', 'clientId', 'effectiveDate', 'expirationDate', 'id', 'line', 'namedInsured', 'policyNumber', 'policyType', 'status', 'statusLabel', 'wholesaler', 'windowCommissionCents']);
  assert.deepEqual(Object.keys(views.transactions[0]).sort(), ['amountCents', 'carrier', 'category', 'classification', 'client', 'id', 'isReversal', 'payer', 'policyNumber', 'postingStatus', 'statementId', 'statementPeriod', 'transactionDate']);
  assert.deepEqual(Object.keys(views.statements[0]).sort(), ['carrierTotalCents', 'checks', 'extractedCents', 'fileType', 'hasOriginal', 'id', 'payer', 'postedCents', 'reconciled', 'statementDate', 'statementMonth', 'status', 'statusLabel']);
});

test('every policy status is listed and labelled (active first); posted window commission per policy, cancelled included', () => {
  const b = reviewerBook({ clients, policies, carriers, entries, start: '2025-11', months: 12 });
  assert.deepEqual(b.policies.map((p) => [p.policyNumber, p.status, p.statusLabel]), [['SYN-001', 'active', 'Active'], ['SYN-002', 'active', 'Active'], ['SYN-003', 'cancelled', 'Cancelled']]);
  assert.deepEqual(b.policiesByStatus, { active: 2, cancelled: 1 });
  assert.deepEqual(b.clients.map((c) => [c.name, c.activePolicies, c.policyCount]), [['Alpha Synthetic LLC', 1, 1], ['Bravo Synthetic', 1, 1], ['Charlie Lapsed', 0, 1]]);
  assert.deepEqual(b.policies.map((p) => p.windowCommissionCents), [150_000, 150_000, 10_000], 'the June 2025 entry is outside the window; the cancelled policy keeps its posted commission');
  assert.equal(b.windowCommissionCents, 310_000);
  assert.equal(b.activeWindowCommissionCents, 300_000);
  assert.equal(b.policies[1].wholesaler, 'Synthetic MGA');
  const csv = reviewerBookCsv(b, 'Test Agency LLC', '2026-11-16T00:00:00Z');
  assert.match(csv, /Policies by status: Active 2, Cancelled 1/);
  assert.match(csv, /SYN-003,.*,Cancelled,/);
});

test('statements: posted vs not posted vs disputed are distinct; discarded uploads are not part of the record', () => {
  const st = reviewerStatements(statements, carriers);
  assert.deepEqual(st.map((x) => [x.id, x.status]), [['S2', 'disputed'], ['S3', 'reconciled_not_posted'], ['S5', 'approved_not_posted'], ['S1', 'posted']], 'newest month first, then carrier name');
  const s2 = st.find((x) => x.id === 'S2')!;
  assert.deepEqual([s2.carrierTotalCents, s2.extractedCents, s2.postedCents, s2.reconciled], [390_000, 270_000, 0, false]);
  assert.deepEqual(s2.checks, [{ label: 'Statement total (carrier printed vs extracted)', carrierPrintedCents: 390_000, extractedCents: 270_000, differenceCents: -120_000, ok: false }]);
});

test('overview: commission totals are the POSTED ledger only; disputed and unposted statements are reported separately, never added', () => {
  const o = reviewerOverview({ settings, entries, carriers, policies, statements });
  assert.equal(o.postedTotal.total, 310_000, 'L1 + L2 + L3 (window), nothing from statements S2/S3/S5');
  const by = Object.fromEntries(o.notPosted.map((x) => [x.status, [x.count, x.carrierTotalCents, x.extractedCents]]));
  assert.deepEqual(by.disputed, [1, 390_000, 270_000]);
  assert.deepEqual(by.reconciled_not_posted, [1, 2_500, 2_500]);
  assert.deepEqual(by.approved_not_posted, [1, 5_000, 5_000]);
  assert.equal(o.byMonth.length, 12);
  assert.deepEqual(o.settings, { agencyName: 'Test Agency LLC', snapshotStartMonth: '2025-11', snapshotMonths: 12 }, 'no broker default share or AI settings');
});

test('CSV exports contain no broker information and state that the totals are posted-only', () => {
  const at = '2026-11-16T12:00:00.000Z';
  const o = reviewerOverview({ settings, entries, carriers, policies, statements });
  const files = {
    summary: reviewerSummaryCsv(o, at),
    book: reviewerBookCsv(reviewerBook({ clients, policies, carriers, entries, start: '2025-11', months: 12 }), 'Test Agency LLC', at),
    transactions: reviewerTransactionsCsv(reviewerTransactions({ entries, carriers, clients, policies, start: '2025-11', months: 12 }), 'Test Agency LLC', at),
    statements: reviewerStatementsCsv(reviewerStatements(statements, carriers), 'Test Agency LLC', at),
  };
  for (const [k, csv] of Object.entries(files)) {
    for (const v of [CANARY.brokerName, CANARY.brokerId, CANARY.note, CANARY.email, CANARY.phone, CANARY.file, String(CANARY.brokerCents / 100), '777.77', '43.21']) assert.ok(!csv.includes(v), `${k}: contains ${v}`);
    assert.match(csv, /Contains no broker information/);
    assert.ok(!/broker/i.test(csv.replace(/Contains no broker information/g, '')), `${k}: mentions broker`);
  }
  assert.match(files.summary, /Statements NOT included in the totals/);
  assert.match(files.statements, /Disputed — does not reconcile to the carrier total; not included/);
  assert.match(files.statements, /Only statements with status ""Posted"" are included/);
});

test('response guard fails closed on any forbidden field or broker identifier, at any depth', () => {
  assert.doesNotThrow(() => guardReviewerPayload({ a: [{ name: 'Synthetic Mutual', amountCents: 1 }] }, brokerIds));
  for (const bad of [{ brokerId: 'x' }, { rows: [{ ok: 1, brokerCents: 5 }] }, { x: { brokerShareBps: 1 } }, { note: '' }, { contact: {} }, { approval: { email: 'a' } }, { fileName: 'a.pdf' }, { agencyCents: 1 }, { advances: [] }, { buyoutSettlement: {} }]) {
    assert.throws(() => guardReviewerPayload(bad, brokerIds), /forbidden field/, JSON.stringify(bad));
  }
  assert.throws(() => guardReviewerPayload({ rows: [{ owner: CANARY.brokerId }] }, brokerIds), /broker identifier/);
  assert.throws(() => guardReviewerPayload({ rows: [{ owner: 'canbrk' }] }, brokerIds), /broker identifier/, 'case-insensitive');
});

test('download responses pass the guard (their shape is { downloadName, csv })', () => {
  const o = reviewerOverview({ settings, entries, carriers, policies, statements });
  assert.doesNotThrow(() => guardReviewerPayload({ downloadName: 'Due-diligence-summary-2026-11-16.csv', csv: reviewerSummaryCsv(o, '2026-11-16T00:00:00Z') }, brokerIds));
  assert.throws(() => guardReviewerPayload({ fileName: 'x.csv', csv: '' }, brokerIds), /forbidden field/, 'stored statement file names stay blocked');
});

test('free text never passes through: check labels are fixed by check type; failed check details are generic; no client external IDs', () => {
  const withSection = [{ id: 'SX', status: 'discrepancy', statementMonth: '2026-04', payerId: 'CA', statementTotalCents: 100, postedCents: 0,
    reconciliation: { reconciled: false, checks: [
      { key: 'section', label: `Section subtotal: ${CANARY.brokerName} (sub-producer)`, statedCents: 100, extractedCents: 90, differenceCents: -10, ok: false },
      { key: 'futureKey', label: `Broker ${CANARY.brokerCode}`, statedCents: 1, extractedCents: 1, differenceCents: 0, ok: true },
    ], totals: { commissionCents: 90, adjustmentsCents: 0 } } }];
  const st = reviewerStatements(withSection, carriers);
  assert.deepEqual(st[0].checks.map((c) => c.label), ['Section subtotal (carrier printed vs extracted)', 'Other check (carrier printed vs extracted)']);
  assertNoLeak(st, 'statements with printed section names');
  // A reversal that does not offset its original fails the ledger check; the audit wording is not shown.
  const bad = [...entries, e('L9', '2026-03', 500), e('L9__rev', '2026-03', -400, { reversalOf: 'L9', postingStatus: 'posted' })];
  const o = reviewerOverview({ settings, entries: bad, carriers, policies, statements });
  const failed = o.checks.filter((c) => !c.pass);
  assert.ok(failed.length >= 1);
  for (const c of o.checks) assert.ok(!/broker|agency [0-9-]|undefined|split/i.test(c.detail), c.detail);
  assert.ok(failed.every((c) => c.detail === 'This check did not pass. Details are available from the agency.'));
  const b = reviewerBook({ clients, policies, carriers, entries, start: '2025-11', months: 12 });
  assert.deepEqual(Object.keys(b.clients[0]).sort(), ['activePolicies', 'classification', 'id', 'name', 'policyCount', 'status']);
  assert.ok(!reviewerBookCsv(b, 'A', 'now').includes('1001'), 'agency-system client IDs are not exported');
  assert.deepEqual(Object.keys(o.postedTotal), ['commission', 'unmatched', 'adjustment', 'retained', 'manual', 'total']);
});
