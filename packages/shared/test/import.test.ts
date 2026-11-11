import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, toTable, detectDelimiter } from '../src/csv.ts';
import {
  detectColumns, parseFlexibleDate, interpretLine, interpretStatus, normalizeRecord, importRecordInput, similarity,
  type ImportRecordInput,
} from '../src/importMap.ts';
import { planImport, planUndo, type ImportExisting, type ImportOptions } from '../src/importPlan.ts';

// ---------------- CSV ----------------

test('CSV: quotes, escaped quotes, embedded commas and newlines, BOM, CRLF', () => {
  const text = '﻿Client,Policy #,Notes\r\n"Smith, John",P-1,"He said ""hi"""\r\n"Quick Cab LLC",Q-2,"line one\nline two"\r\n\r\n';
  const rows = parseCsv(text);
  assert.deepEqual(rows, [
    ['Client', 'Policy #', 'Notes'],
    ['Smith, John', 'P-1', 'He said "hi"'],
    ['Quick Cab LLC', 'Q-2', 'line one\nline two'],
  ]);
});

test('CSV: delimiter detection and ragged rows', () => {
  assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
  assert.equal(detectDelimiter('a,b,c\n1,2,3'), ',');
  const t = toTable(parseCsv('A,B,C\n1,2\n4,5,6,7'));
  assert.deepEqual(t.rows, [['1', '2', ''], ['4', '5', '6']]);
  assert.throws(() => parseCsv('a,"b\n1,2'));
});

// ---------------- Column detection ----------------

test('detects typical agency export headers', () => {
  const headers = ['Insured Name', 'Client Code', 'Policy #', 'Company', 'LOB', 'Producer', 'Eff Date', 'Exp Date', 'Annual Premium', 'Status', 'Pers/Comm'];
  const m = detectColumns(headers);
  assert.equal(m.clientName, 0);
  assert.equal(m.clientExternalId, 1);
  assert.equal(m.policyNumber, 2);
  assert.equal(m.carrier, 3);
  assert.equal(m.policyType, 4);
  assert.equal(m.broker, 5);
  assert.equal(m.effectiveDate, 6);
  assert.equal(m.expirationDate, 7);
  assert.equal(m.premium, 8);
  assert.equal(m.policyStatus, 9);
  assert.equal(m.line, 10);
});

test('missing optional columns are simply unmapped', () => {
  const m = detectColumns(['Client', 'Policy Number', 'Carrier']);
  assert.equal(m.clientName, 0);
  assert.equal(m.policyNumber, 1);
  assert.equal(m.carrier, 2);
  assert.equal(m.premium, undefined);
  assert.equal(m.broker, undefined);
});

// ---------------- Values ----------------

test('flexible dates', () => {
  assert.equal(parseFlexibleDate('2025-11-01'), '2025-11-01');
  assert.equal(parseFlexibleDate('11/1/2025'), '2025-11-01');
  assert.equal(parseFlexibleDate('11/01/25'), '2025-11-01');
  assert.equal(parseFlexibleDate('1-Nov-2025'), '2025-11-01');
  assert.equal(parseFlexibleDate('November 1, 2025'), '2025-11-01');
  assert.equal(parseFlexibleDate('45962'), '2025-11-01'); // Excel serial
  assert.equal(parseFlexibleDate(''), null);
  assert.ok(typeof parseFlexibleDate('2/30/2025') === 'object');
  assert.ok(typeof parseFlexibleDate('soon') === 'object');
});

test('line and status words', () => {
  assert.equal(interpretLine('PL'), 'personal');
  assert.equal(interpretLine('Commercial Lines'), 'commercial');
  assert.equal(interpretLine('?'), null);
  assert.equal(interpretStatus('In Force'), 'active');
  assert.equal(interpretStatus('Canceled'), 'cancelled');
  assert.equal(interpretStatus('Non-Renewed'), 'expired');
  assert.equal(interpretStatus('weird'), null);
});

test('similarity', () => {
  assert.ok(similarity('smith trucking', 'smith truckng') > 0.9);
  assert.ok(similarity('smith trucking', 'jones towing') < 0.5);
});

// ---------------- Planner ----------------
// Synthetic reference data
const existing: ImportExisting = {
  clients: [
    { id: 'C-EX1', name: 'Synthetic Cab LLC', normalizedName: 'synthetic cab', classification: 'commercial', brokerId: 'B-1', externalId: '' },
    { id: 'C-EX2', name: 'Pat Example', normalizedName: 'pat example', classification: 'personal', brokerId: 'UNASSIGNED', externalId: 'PE01' },
  ],
  policies: [
    {
      id: 'P-EX1', clientId: 'C-EX1', carrierId: 'K-A', wholesalerId: null, policyNumber: 'SYN-100', normalizedPolicyNumber: 'SYN100',
      policyType: 'Commercial Auto', line: 'commercial', namedInsured: 'Synthetic Cab LLC', brokerId: 'B-1',
      effectiveDate: '2025-06-01', expirationDate: '2026-06-01', premiumCents: 500000, status: 'active',
    },
  ],
  carrierKinds: new Map([['K-A', 'carrier'], ['K-B', 'carrier'], ['W-J', 'wholesaler']]),
  brokerIds: new Set(['UNASSIGNED', 'B-1', 'B-2']),
};
const opts: ImportOptions = { defaultLine: 'commercial', defaultBrokerId: 'B-2', updateExisting: true, updateBrokerOnExisting: false };

let rowNo = 0;
function rec(p: Partial<ImportRecordInput>) {
  return normalizeRecord(importRecordInput.parse({ rowNumber: ++rowNo, ...p }));
}

test('one client with multiple policies at different carriers', () => {
  const plan = planImport([
    rec({ clientName: 'New Synthetic Co', policyNumber: 'A-1', carrierId: 'K-A' }),
    rec({ clientName: 'New Synthetic Co.', policyNumber: 'B-1', carrierId: 'K-B' }),
    rec({ clientName: 'NEW SYNTHETIC CO', policyNumber: 'B-2', carrierId: 'K-B' }),
  ], existing, opts);
  assert.equal(plan.summary.clientsNew, 1);
  assert.equal(plan.summary.policiesNew, 3);
  const keys = new Set(plan.rows.map((r) => r.clientKey));
  assert.equal(keys.size, 1);
  assert.equal(plan.rows[0].policyData?.brokerId, 'B-2'); // default broker
});

test('same policy number at two carriers creates two policies; same carrier+number twice is a duplicate', () => {
  const plan = planImport([
    rec({ clientName: 'Dup Synthetic', policyNumber: 'X-9', carrierId: 'K-A' }),
    rec({ clientName: 'Dup Synthetic', policyNumber: 'X9', carrierId: 'K-B' }),
    rec({ clientName: 'Dup Synthetic', policyNumber: 'x 9', carrierId: 'K-A' }),
  ], existing, opts);
  assert.equal(plan.rows[0].policyAction, 'create');
  assert.equal(plan.rows[1].policyAction, 'create');
  assert.equal(plan.rows[2].policyAction, 'duplicate');
  assert.equal(plan.summary.duplicatesInFile, 1);
});

test('existing policy is updated only with non-blank values; untouched fields preserved', () => {
  const plan = planImport([
    rec({ clientName: 'Synthetic Cab, L.L.C.', policyNumber: 'syn 100', carrierId: 'K-A', premium: '5,250.00', effectiveDate: '' }),
  ], existing, opts);
  const r = plan.rows[0];
  assert.equal(r.clientAction, 'existing');
  assert.equal(r.policyAction, 'update');
  assert.deepEqual(Object.keys(r.policyChanges), ['premiumCents']);
  assert.deepEqual(r.policyChanges.premiumCents, { before: 500000, after: 525000 });
});

test('re-importing identical data changes nothing', () => {
  const plan = planImport([
    rec({ clientName: 'Synthetic Cab LLC', policyNumber: 'SYN-100', carrierId: 'K-A', premium: '5000', policyType: 'Commercial Auto' }),
  ], existing, opts);
  assert.equal(plan.rows[0].policyAction, 'unchanged');
  assert.equal(plan.summary.policiesUpdated, 0);
});

test('existing policy under a different client is a conflict, not a silent move', () => {
  const plan = planImport([rec({ clientName: 'Someone Else Synthetic', policyNumber: 'SYN-100', carrierId: 'K-A' })], existing, opts);
  assert.equal(plan.rows[0].policyAction, 'conflict');
  assert.equal(plan.summary.conflicts, 1);
});

test('similar names warn but are not merged; Client ID distinguishes same-named clients', () => {
  const plan = planImport([
    rec({ clientName: 'Synthetic Cabb LLC', policyNumber: 'N-1', carrierId: 'K-A' }),
    rec({ clientName: 'Pat Example', clientExternalId: 'PE02', policyNumber: 'N-2', carrierId: 'K-B' }),
    rec({ clientName: 'Pat Example', clientExternalId: 'PE01', policyNumber: 'N-3', carrierId: 'K-B' }),
  ], existing, opts);
  assert.equal(plan.rows[0].clientAction, 'create');
  assert.ok(plan.rows[0].messages.some((m) => m.text.includes('similar')));
  assert.equal(plan.rows[1].clientAction, 'create'); // different Client ID
  assert.ok(plan.rows[2].clientKey === 'C-EX2');
});

test('broker on existing records only changes when allowed or currently unassigned', () => {
  const a = planImport([rec({ clientName: 'Synthetic Cab LLC', policyNumber: 'SYN-100', carrierId: 'K-A', brokerId: 'B-2', brokerRaw: 'Two' })], existing, opts);
  assert.equal(a.rows[0].policyAction, 'unchanged');
  const b = planImport([rec({ clientName: 'Synthetic Cab LLC', policyNumber: 'SYN-100', carrierId: 'K-A', brokerId: 'B-2', brokerRaw: 'Two' })], existing, { ...opts, updateBrokerOnExisting: true });
  assert.deepEqual(b.rows[0].policyChanges.brokerId, { before: 'B-1', after: 'B-2' });
  const c = planImport([rec({ clientName: 'Pat Example', clientExternalId: 'PE01', brokerId: 'B-1', brokerRaw: 'One' })], existing, opts);
  assert.equal(c.clients[0].changes.brokerId?.after, 'B-1'); // was unassigned
});

test('wholesaler in the carrier column records the policy under the wholesaler', () => {
  const plan = planImport([rec({ clientName: 'Synthetic E&S Risk', policyNumber: 'ES-1', carrierId: 'W-J', carrierRaw: 'J&J' })], existing, opts);
  assert.equal(plan.rows[0].policyData?.wholesalerId, 'W-J');
  assert.equal(plan.rows[0].policyData?.carrierId, 'W-J');
});

test('row errors: unknown client name, unmapped carrier, missing policy number', () => {
  const plan = planImport([
    rec({ clientName: '', policyNumber: 'Z-1', carrierId: 'K-A' }),
    rec({ clientName: 'Synthetic Row', policyNumber: 'Z-2', carrierRaw: 'Mystery Mutual' }),
    rec({ clientName: 'Synthetic Row', carrierId: 'K-A' }),
    rec({ clientName: 'Client Only Synthetic' }),
  ], existing, opts);
  assert.deepEqual(plan.rows.map((r) => r.status), ['error', 'error', 'error', 'ok']);
  assert.equal(plan.rows[3].clientAction, 'create');
  assert.equal(plan.rows[3].policyAction, 'none');
});

test('bad values become warnings, not crashes', () => {
  const plan = planImport([rec({ clientName: 'Warn Synthetic', policyNumber: 'W-1', carrierId: 'K-A', premium: 'abc', effectiveDate: '13/45/2025', email: 'nope' })], existing, opts);
  const r = plan.rows[0];
  assert.equal(r.status, 'warning');
  assert.equal(r.policyData?.premiumCents, null);
  assert.equal(r.policyData?.effectiveDate, null);
});

// ---------------- Undo ----------------

test('undo deletes only untouched records created by the import and restores updates', () => {
  const u = planUndo({
    createdPolicies: [
      { id: 'P1', exists: true, modifiedSince: false },
      { id: 'P2', exists: true, modifiedSince: true },
      { id: 'P3', exists: true, modifiedSince: false, hasLedger: true },
      { id: 'P4', exists: false, modifiedSince: false },
    ],
    updatedPolicies: [
      { id: 'PX', exists: true, modifiedSince: false, before: { premiumCents: 500000 } },
      { id: 'PY', exists: true, modifiedSince: true, before: { status: 'active' } },
    ],
    createdClients: [
      { id: 'C1', exists: true, modifiedSince: false, policyIds: ['P1'] },
      { id: 'C2', exists: true, modifiedSince: false, policyIds: ['P2'] },
      { id: 'C3', exists: true, modifiedSince: false, policyIds: ['P1', 'P-UNRELATED'] },
    ],
    updatedClients: [],
  });
  assert.deepEqual(u.deletePolicies, ['P1']);
  assert.deepEqual(u.restorePolicies, [{ id: 'PX', before: { premiumCents: 500000 } }]);
  assert.deepEqual(u.deleteClients, ['C1']);
  assert.deepEqual(u.skipped.map((s) => s.id).sort(), ['C2', 'C3', 'P2', 'P3', 'PY']);
});

test('a new client whose only rows fail is not created', () => {
  const plan = planImport([rec({ clientName: 'Orphan Synthetic', policyNumber: 'O-1', carrierId: 'K-GONE' })], existing, opts);
  assert.equal(plan.rows[0].status, 'error');
  assert.equal(plan.summary.clientsNew, 0);
  assert.equal(plan.rows[0].clientAction, 'none');
});

test('placeholder dates such as 01/01/0001 are blank, not 2001-01-01; four-digit years are used as written', () => {
  assert.equal(parseFlexibleDate('01/01/0001'), null);
  assert.equal(parseFlexibleDate('0001-01-01'), null);
  assert.equal(parseFlexibleDate('1/1/1899'), null);
  assert.equal(parseFlexibleDate('01/01/2001'), '2001-01-01');
  assert.equal(parseFlexibleDate('1/1/01'), '2001-01-01', 'two-digit years still expand');
  assert.equal(parseFlexibleDate('12/31/1999'), '1999-12-31');
  assert.equal(parseFlexibleDate('11/3/2025'), '2025-11-03');
});
