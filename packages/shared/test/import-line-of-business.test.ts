import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importOptionsInput, importRecordInput, normalizeRecord, type ImportRecordInput } from '../src/importMap.ts';
import { planImport, type ImportExisting, type ImportOptions } from '../src/importPlan.ts';

// Imports must never default a Personal account to Commercial: the line of business decides when the file
// has no Personal/Commercial column, and nothing is guessed when neither says.

const existing: ImportExisting = {
  clients: [{ id: 'C-OLD', name: 'Old Synthetic Client', normalizedName: 'old synthetic client', classification: 'commercial', brokerId: 'UNASSIGNED', externalId: '' }],
  policies: [{
    id: 'P-OLD', clientId: 'C-OLD', carrierId: 'K-A', wholesalerId: null, policyNumber: 'OLD-1', normalizedPolicyNumber: 'OLD1',
    policyType: 'Homeowners', line: 'commercial', namedInsured: 'Old Synthetic Client', brokerId: 'UNASSIGNED',
    effectiveDate: null, expirationDate: null, premiumCents: null, status: 'active',
  }],
  carrierKinds: new Map([['K-A', 'carrier']]),
  brokerIds: new Set(['UNASSIGNED']),
};
const noDefault: ImportOptions = { defaultLine: null, defaultBrokerId: 'UNASSIGNED', updateExisting: true, updateBrokerOnExisting: false };
let n = 0;
const rec = (p: Partial<ImportRecordInput>) => normalizeRecord(importRecordInput.parse({ rowNumber: ++n, carrierId: 'K-A', ...p }));
const texts = (r: { messages: { text: string }[] }) => r.messages.map((m) => m.text).join(' | ');

test('the import default no longer assumes Commercial: it does not guess', () => {
  assert.equal(importOptionsInput.parse({}).defaultLine, null);
  assert.equal(importOptionsInput.parse({ defaultLine: 'personal' }).defaultLine, 'personal');
});

test('no Personal/Commercial column: Personal lines of business make Personal clients and policies', () => {
  const plan = planImport([
    rec({ clientName: 'Pat Synthetic', policyNumber: 'H-1', policyType: 'Homeowners' }),
    rec({ clientName: 'Pat Synthetic', policyNumber: 'A-1', policyType: 'Personal Auto' }),
    rec({ clientName: 'Biz Synthetic LLC', policyNumber: 'B-1', policyType: 'BOP' }),
  ], existing, noDefault);
  assert.deepEqual(plan.rows.map((r) => [r.status, r.policyData?.line]), [['ok', 'personal'], ['ok', 'personal'], ['ok', 'commercial']]);
  const byName = new Map(plan.clients.map((c) => [c.data.name, c.data.classification]));
  assert.equal(byName.get('Pat Synthetic'), 'personal');
  assert.equal(byName.get('Biz Synthetic LLC'), 'commercial');
});

test('an unrecognized line of business with no default is flagged, not imported as Commercial', () => {
  const plan = planImport([rec({ clientName: 'Unsure Synthetic', policyNumber: 'U-1', policyType: 'Umbrella' })], existing, noDefault);
  assert.equal(plan.rows[0].status, 'error');
  assert.match(texts(plan.rows[0]), /Can't tell if this policy is Personal or Commercial/);
  assert.equal(plan.clients.length, 0, 'no client is created from a flagged row');
});

test('a chosen default is used only when nothing else says, and the row says so', () => {
  const plan = planImport([rec({ clientName: 'Unsure Synthetic', policyNumber: 'U-1', policyType: 'Umbrella' })], existing, { ...noDefault, defaultLine: 'personal' });
  assert.equal(plan.rows[0].status, 'warning');
  assert.equal(plan.rows[0].policyData?.line, 'personal');
  assert.match(texts(plan.rows[0]), /used your default, Personal/);
});

test("the file's own column wins, with a warning when it contradicts the line of business", () => {
  const plan = planImport([rec({ clientName: 'Odd Synthetic', policyNumber: 'O-1', policyType: 'Homeowners', line: 'Commercial' })], existing, noDefault);
  assert.equal(plan.rows[0].policyData?.line, 'commercial');
  assert.equal(plan.clients[0].data.classification, 'commercial');
  assert.match(texts(plan.rows[0]), /File says Commercial but policy type "Homeowners" is Personal/);
});

test('a new client with both kinds of policy is flagged for review', () => {
  const plan = planImport([
    rec({ clientName: 'Both Synthetic', policyNumber: 'M-1', policyType: 'Homeowners' }),
    rec({ clientName: 'Both Synthetic', policyNumber: 'M-2', policyType: 'Workers Comp' }),
  ], existing, noDefault);
  assert.equal(plan.clients[0].data.classification, 'personal');
  assert.match(texts(plan.rows[0]), /both Personal and Commercial policies/);
});

test("a new policy on an existing Commercial client follows its own line of business, not the client's", () => {
  const plan = planImport([rec({ clientName: 'Old Synthetic Client', policyNumber: 'H-9', policyType: 'Renters' })], existing, noDefault);
  assert.equal(plan.rows[0].policyAction, 'create');
  assert.equal(plan.rows[0].policyData?.line, 'personal');
  assert.equal(plan.clients[0].data.classification, 'commercial', 'existing clients are never reclassified by an import');
});

test("an existing policy's line changes only from an explicit column, never from inference", () => {
  const inferred = planImport([rec({ clientName: 'Old Synthetic Client', policyNumber: 'OLD-1', policyType: 'Homeowners' })], existing, noDefault);
  assert.equal(inferred.rows[0].policyChanges.line, undefined);
  assert.match(texts(inferred.rows[0]), /recorded as Commercial \(not changed by the import\)/);
  const explicit = planImport([rec({ clientName: 'Old Synthetic Client', policyNumber: 'OLD-1', policyType: 'Homeowners', line: 'Personal' })], existing, noDefault);
  assert.deepEqual(explicit.rows[0].policyChanges.line, { before: 'commercial', after: 'personal' });
});
