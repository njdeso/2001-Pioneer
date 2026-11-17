import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  guardReviewerPayload, reviewerExportInput, reviewerFileInput, reviewerOriginalName, reviewerStatementDetail,
  reviewerOverview, reviewerStatementDetailCsv, reviewerStatementLinesCsv, reviewerStatements, reviewerViewInput,
} from '../src/index.ts';

// Statement lines and statements exactly as stored: full match details (broker, shares, splits), raw extracted
// text, internal checks and approval/posting records — all "canary" values that must never reach a reviewer.
const CANARY = {
  brokerName: 'Canary Broker Smithwick', brokerId: 'BRKCANARY7', brokerCode: 'CANBRK', note: 'CANARY-INTERNAL-NOTE',
  email: 'canary.staff@example.test', file: 'Canary-Broker-Statement.pdf', path: 'statements/S1/original.pdf', shareBps: 4321, brokerCents: 77777, agencyCents: 72223,
};
const carriers = [{ id: 'CA', name: 'Synthetic Mutual', code: 'SYM', kind: 'carrier', commissionMethod: 'statement', status: 'active', contact: { email: CANARY.email } }];
const policies = [
  { id: 'P1', policyNumber: 'SYN-001', clientId: 'C1', brokerId: CANARY.brokerId, brokerShareBps: CANARY.shareBps },
  { id: 'P3', policyNumber: 'SYN-003', clientId: 'C3', status: 'cancelled', brokerId: CANARY.brokerId },
];
const clients = [{ id: 'C1', name: 'ALPHA SYNTHETIC LLC', brokerId: CANARY.brokerId }, { id: 'C3', name: 'Charlie Lapsed' }];
const statementS1 = {
  id: 'S1', status: 'posted', statementMonth: '2026-05', statementDate: '2026-06-03', payerId: 'CA', statementTotalCents: 148_086, postedCents: 148_086,
  fileName: CANARY.file, originalPath: CANARY.path, fileType: 'pdf', sha256: 'abc',
  stated: { commissionPayableCents: 150_000, monthCommissionPayableCents: 148_086, premiumForCommissionCents: 1_000_000, transactionPremiumCents: 850_000, feeCents: null, paymentReceivedCents: null },
  adjustments: [
    { label: 'MVR/CLUE expense (statement page 2, line 20, 2026-05-31)', amountCents: -1_914, source: { sheet: 'page 2', sheetRow: 20, kind: 'mvr', policyNumberRaw: 'MVRCLU', lineNo: null } },
  ],
  reconciliation: { reconciled: true, checks: [{ key: 'commission', label: `Producer ${CANARY.brokerName} subtotal`, statedCents: 150_000, extractedCents: 150_000, differenceCents: 0, ok: true }], totals: { commissionCents: 150_000, adjustmentsCents: -1_914, brokerCents: CANARY.brokerCents } },
  approval: { email: CANARY.email, note: CANARY.note, totals: { brokerCents: CANARY.brokerCents, agencyCents: CANARY.agencyCents } },
  posting: { brokerCents: CANARY.brokerCents },
};
const fullLine = (lineNo: number, extra: Record<string, unknown>) => ({
  id: String(lineNo).padStart(5, '0'), lineNo, page: 1, insuredName: 'ALPHA SYNTHETIC LLC', policyNumberRaw: 'SYN-001', policyNumberNormalized: 'SYN001',
  transactionCodeRaw: 'REN', transactionType: 'renewal', effectiveDate: '2026-05-01', premiumForCommissionCents: 1_000_000, transactionPremiumCents: 850_000,
  rateBps: 1500, paidCommissionCents: 150_000, termCommissionCents: null, feeCents: null, paymentReceivedCents: null, kind: 'commission', paymentMethod: '',
  rawText: `ALPHA SYNTHETIC ${CANARY.brokerName} ${CANARY.note}`,
  issues: [{ level: 'warning', code: 'utica_net_sign_read', text: `${CANARY.note} line corrected` }],
  match: { status: 'matched', method: 'auto', policyId: 'P1', clientId: 'C1', carrierId: 'CA', brokerId: CANARY.brokerId, brokerShareBps: CANARY.shareBps, brokerShareSource: 'broker', commissionCents: 150_000, brokerCents: CANARY.brokerCents, agencyCents: CANARY.agencyCents, reasons: [CANARY.note], candidates: [{ policyId: 'P1', brokerId: CANARY.brokerId }] },
  ...extra,
});
const lines = [
  fullLine(2, { insuredName: 'UNMATCHED SYNTHETIC', policyNumberRaw: 'XX-999', paidCommissionCents: 1_000, premiumForCommissionCents: 10_000, rateBps: 1000, match: { status: 'unmatched', brokerId: CANARY.brokerId, brokerCents: 0 } }),
  fullLine(1, {}),
];
const brokerIds = [CANARY.brokerId, CANARY.brokerCode, 'UNASSIGNED'];
/** CSV fields of one row (quoted fields may contain commas). */
function fields(r: string): string[] {
  const out: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < r.length; i++) {
    const c = r[i];
    if (q) { if (c === '"' && r[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

function assertNoLeak(payload: unknown, label: string) {
  const json = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const v of [CANARY.brokerName, CANARY.brokerId, CANARY.brokerCode, CANARY.note, CANARY.email, CANARY.file, CANARY.path, 'UNASSIGNED', 'Producer ']) assert.ok(!json.includes(v), `${label}: contains "${v}"`);
  for (const n of [CANARY.shareBps, CANARY.brokerCents, CANARY.agencyCents, '777.77', '722.23', '43.21']) assert.ok(!new RegExp(`(?<![0-9.])${String(n).replace('.', '\\.')}(?![0-9])`).test(json), `${label}: contains ${n}`);
  if (typeof payload !== 'string') {
    for (const [, k] of json.matchAll(/"([^"]+)":/g)) assert.ok(!/broker|share|split|advance|buyout|settlement|note|email|contact|approv|createdBy|updatedBy|fileName|path|raw|issue|reason|candidate|agencyCents/i.test(k), `${label}: key ${k}`);
    guardReviewerPayload(payload, brokerIds);
  }
}

test('request formats: a statement view, statement export and original file take a statement ID only', () => {
  assert.equal(reviewerViewInput.safeParse({ view: 'statement', statementId: 'S1' }).success, true);
  assert.equal(reviewerExportInput.safeParse({ kind: 'statement', statementId: 'S1' }).success, true);
  assert.equal(reviewerExportInput.safeParse({ kind: 'statementLines' }).success, true);
  assert.equal(reviewerFileInput.safeParse({ statementId: 'S1' }).success, true);
  for (const bad of [
    { view: 'statement' }, { view: 'statement', statementId: '../brokers' }, { view: 'statement', statementId: 'statements/S1' }, { view: 'statement', statementId: 'S1', fields: ['match'] },
    { view: 'overview', statementId: 'S1' }, { view: 'lines', statementId: 'S1' },
  ]) assert.equal(reviewerViewInput.safeParse(bad).success, false, JSON.stringify(bad));
  for (const bad of [{ kind: 'statement' }, { kind: 'statement', statementId: 'a/b' }, { kind: 'statementLines', statementId: 'S1' }, { kind: 'lines' }]) assert.equal(reviewerExportInput.safeParse(bad).success, false, JSON.stringify(bad));
  for (const bad of [{}, { statementId: '' }, { statementId: CANARY.path }, { statementId: 'S1', path: 'x' }, { statementId: 'S1', download: true }]) assert.equal(reviewerFileInput.safeParse(bad).success, false, JSON.stringify(bad));
});

test('statement detail from FULL stored lines: every commission line, premium, rate and fee; nothing about brokers, raw text or internal notes', () => {
  const d = reviewerStatementDetail({ statement: statementS1, lines, carriers, policies, clients })!;
  assertNoLeak(d, 'detail');
  assert.deepEqual(Object.keys(d).sort(), ['adjustments', 'carrierPrinted', 'lines', 'statement', 'totals']);
  assert.deepEqual(Object.keys(d.lines[0]).sort(), ['commissionCents', 'effectiveDate', 'feeCents', 'insured', 'lineNo', 'matched', 'matchedClient', 'matchedPolicyNumber', 'page', 'paymentReceivedCents', 'policyNumber', 'premiumForCommissionCents', 'rateBps', 'termCommissionCents', 'transactionCode', 'transactionPremiumCents', 'transactionType']);
  assert.deepEqual(d.lines.map((l) => l.lineNo), [1, 2], 'in line order');
  const l1 = d.lines[0];
  assert.deepEqual([l1.insured, l1.policyNumber, l1.transactionCode, l1.premiumForCommissionCents, l1.transactionPremiumCents, l1.rateBps], ['ALPHA SYNTHETIC LLC', 'SYN-001', 'REN', 1_000_000, 850_000, 1500]);
  assert.equal(l1.commissionCents, 150_000, 'the FULL carrier commission, although a broker services this policy (broker share 777.77 never shown)');
  assert.deepEqual([l1.matched, l1.matchedPolicyNumber, l1.matchedClient], [true, 'SYN-001', 'Alpha Synthetic LLC']);
  assert.deepEqual([d.lines[1].matched, d.lines[1].matchedPolicyNumber, d.lines[1].matchedClient], [false, null, null]);
  assert.deepEqual(d.adjustments, [{ label: 'MVR/CLUE expense (statement page 2, line 20, 2026-05-31)', kind: 'MVR / CLUE charge', amountCents: -1_914 }]);
  assert.deepEqual(d.totals, { lines: 2, commissionCents: 151_000, adjustmentsCents: -1_914, premiumForCommissionCents: 1_010_000, transactionPremiumCents: 1_700_000, feeCents: 0 });
  assert.deepEqual(d.carrierPrinted, { commissionCents: 150_000, statementTotalCents: 148_086, premiumForCommissionCents: 1_000_000, transactionPremiumCents: 850_000, feeCents: null, paymentReceivedCents: null });
  assert.equal(d.statement.checks[0].label, 'Commission total (carrier printed vs extracted)', 'fixed check label: the stored label naming a producer is not passed through');
  assert.deepEqual([d.statement.hasOriginal, d.statement.fileType], [true, 'pdf']);
});

test('discarded or missing statements have no detail; a statement without a stored file says so', () => {
  assert.equal(reviewerStatementDetail({ statement: { ...statementS1, status: 'discarded', postedCents: 0 }, lines, carriers, policies, clients }), null);
  const noFile = reviewerStatementDetail({ statement: { ...statementS1, originalPath: null }, lines: [], carriers, policies, clients })!;
  assert.equal(noFile.statement.hasOriginal, false);
  assert.equal(reviewerStatements([{ ...statementS1, originalPath: '   ' }], carriers)[0].hasOriginal, false);
});

test('original download name is neutral (carrier, month, type) — never the uploaded file name', () => {
  const [st] = reviewerStatements([statementS1], carriers);
  assert.equal(reviewerOriginalName(st), 'Synthetic Mutual 2026-05 commission statement.pdf');
  assert.equal(reviewerOriginalName({ ...st, payer: 'A/B "Mutual"\r\n', statementMonth: null, fileType: 'xlsx' }), 'A B Mutual undated commission statement.xlsx');
  assert.ok(!reviewerOriginalName(st).includes('Canary'));
});

test('statement detail CSV and the all-statements lines CSV: lines, adjustments and totals; no broker information', () => {
  const d = reviewerStatementDetail({ statement: statementS1, lines, carriers, policies, clients })!;
  const one = reviewerStatementDetailCsv(d, 'Test Agency LLC', '2026-11-16T00:00:00Z');
  assertNoLeak(one, 'detail CSV');
  assert.match(one, /^Commission statement detail — Synthetic Mutual 2026-05\r\n/);
  assert.match(one, /\r\n1,1,ALPHA SYNTHETIC LLC,SYN-001,REN,renewal,2026-05-01,10000\.00,8500\.00,15\.00,1500\.00,,,,SYN-001,Alpha Synthetic LLC\r\n/);
  assert.match(one, /\r\n"MVR\/CLUE expense \(statement page 2, line 20, 2026-05-31\)",MVR \/ CLUE charge,-19\.14\r\n/, 'negative amounts stay numbers (no apostrophe)');
  assert.ok(!one.includes("'-"), 'no formula-guard apostrophe on any amount');
  assert.match(one, /Commission plus adjustments,1490\.86/);
  const all = reviewerStatementLinesCsv([d, d], 'Test Agency LLC', '2026-11-16T00:00:00Z');
  assertNoLeak(all, 'all lines CSV');
  const rows = all.split('\r\n');
  const head = fields(rows.find((r) => r.startsWith('Statement month,'))!);
  assert.equal(head.length, 3 + 1 + 16 + 3);
  for (const r of rows.filter((x) => x.startsWith('2026-05,'))) assert.equal(fields(r).length, head.length, `same columns: ${r}`);
  assert.equal(rows.filter((r) => r.includes(',Commission line,')).length, 4);
  assert.equal(rows.filter((r) => r.includes(',Adjustment,')).length, 2);
});

test('the response guard still blocks a broker field or a broker ID anywhere in a statement detail', () => {
  const d = reviewerStatementDetail({ statement: statementS1, lines, carriers, policies, clients })!;
  assert.throws(() => guardReviewerPayload({ ...d, lines: [{ ...d.lines[0], brokerCents: 1 }] }, brokerIds), /forbidden field/);
  assert.throws(() => guardReviewerPayload({ ...d, lines: [{ ...d.lines[0], insured: CANARY.brokerId }] }, brokerIds), /broker identifier/);
});

// Regression (found in dev, 16 Nov 2026): the reviewer summary reported "Ledger balanced … ✗" for a ledger the
// app's own summary reports as balanced, so the commission summary CSV was withheld. The reviewer read leaves
// out broker/agency splits by design; it also left out `reversalId`, the original's link to its reversal.
const reversedPair = (withLink: boolean) => [
  { id: 'O1', amountCents: 50_000, statementPeriod: '2026-05', postingStatus: 'reversed', payerId: 'CA', carrierId: 'CA', clientId: 'C1', policyId: 'P1', sourceType: 'statement', level: 'policy', classification: 'commission', transactionDate: null, reversalOf: null, statementId: 'S9', postingId: 'PST1', ...(withLink ? { reversalId: 'R1' } : {}) },
  { id: 'R1', amountCents: -50_000, statementPeriod: '2026-05', postingStatus: 'posted', payerId: 'CA', carrierId: 'CA', clientId: 'C1', policyId: 'P1', sourceType: 'statement', level: 'policy', classification: 'commission', transactionDate: null, reversalOf: 'O1', statementId: 'S9', postingId: 'PST1' },
];
const overviewOf = (entries: Record<string, unknown>[]) => reviewerOverview({ settings: { agencyName: 'Test', snapshotStartMonth: '2025-11', snapshotMonths: 12 }, entries: entries as never, carriers, policies: [{ id: 'P1', clientId: 'C1', carrierId: 'CA', policyNumber: 'SYN-001', status: 'active' }], statements: [] });
test('reviewer summary: a reversed posting (no broker splits loaded) is balanced when the reversal link is read', () => {
  const ok = overviewOf(reversedPair(true));
  assert.ok(ok.checks.every((c) => c.pass), ok.checks.filter((c) => !c.pass).map((c) => c.name).join('; '));
  assert.notEqual(ok.status, 'CHECKS_FAILED');
  const without = overviewOf(reversedPair(false));
  assert.deepEqual(without.checks.filter((c) => !c.pass).map((c) => c.name), ['Ledger balanced: every reversal exactly offsets its original; no partial reversals'], 'without the link the same ledger looks unbalanced (the dev failure)');
});
