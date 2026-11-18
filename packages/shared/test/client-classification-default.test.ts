import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { importOptionsInput, importRecordInput, normalizeRecord, type ImportRecordInput } from '../src/importMap.ts';
import { planImport, type ImportExisting } from '../src/importPlan.ts';

// New clients default to Personal (Nov 2026: imports had defaulted every client to Commercial).
const existing: ImportExisting = {
  clients: [{ id: 'C-EX', name: 'Existing Commercial LLC', normalizedName: 'existing commercial', classification: 'commercial', brokerId: 'UNASSIGNED', externalId: '' }],
  policies: [], carrierKinds: new Map([['K-A', 'carrier']]), brokerIds: new Set(['UNASSIGNED']),
};
let n = 0;
const rec = (p: Partial<ImportRecordInput>) => normalizeRecord(importRecordInput.parse({ rowNumber: ++n, carrierId: 'K-A', ...p }));
const defaults = importOptionsInput.parse({});

test('import options default to Personal', () => {
  assert.equal(defaults.defaultLine, 'personal');
});

test('a new imported client with no classification and no policy line is Personal', () => {
  const plan = planImport([rec({ clientName: 'New Synthetic Household', policyNumber: 'N-1' })], existing, defaults);
  assert.deepEqual(plan.clients.filter((c) => c.isNew).map((c) => c.data.classification), ['personal']);
});

test("the file's own line column still wins, for the new client and its policy", () => {
  const plan = planImport([rec({ clientName: 'Synthetic Trucking', policyNumber: 'T-1', line: 'Commercial' })], existing, defaults);
  assert.deepEqual(plan.clients.filter((c) => c.isNew).map((c) => c.data.classification), ['commercial']);
  assert.equal(plan.rows.find((r) => r.policyData?.policyNumber === 'T-1')?.policyData?.line, 'commercial');
});

test('existing clients keep their classification (an import never changes it through the default)', () => {
  const plan = planImport([rec({ clientName: 'Existing Commercial LLC', policyNumber: 'E-1' })], existing, defaults);
  assert.equal(plan.clients.filter((c) => c.isNew).length, 0);
  assert.ok(!plan.clients.some((c) => !c.isNew && 'classification' in (c.changes ?? {})), 'no classification change on the existing client');
});

test('the new-client form starts at Personal', () => {
  const forms = readFileSync(fileURLToPath(new URL('../../../apps/admin/src/forms.tsx', import.meta.url)), 'utf8');
  assert.match(forms, /classification: client\?\.classification \?\? 'personal',/);
  const page = readFileSync(fileURLToPath(new URL('../../../apps/admin/src/pages/Import.tsx', import.meta.url)), 'utf8');
  assert.match(page, /useState<ImportOptionsInput>\(\{ defaultLine: 'personal',/);
});
