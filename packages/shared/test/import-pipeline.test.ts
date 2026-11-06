import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCsv, toTable } from '../src/csv.ts';
import { detectColumns, importRecordInput, normalizeRecord, normalizeName, type ImportField } from '../src/index.ts';
import { planImport } from '../src/importPlan.ts';

// End-to-end over a synthetic agency export: title row, quoted commas, mixed date
// formats, a wholesaler in the Company column, a duplicate row and a bad row.
test('synthetic client list imports as expected', () => {
  const text = readFileSync(new URL('./fixtures/synthetic-client-list.csv', import.meta.url), 'utf8');
  const headerRow = 2;
  const table = toTable(parseCsv(text).slice(headerRow - 1));
  const m = detectColumns(table.headers);
  const col = (f: ImportField, r: string[]) => (m[f] == null ? '' : r[m[f]!] ?? '');

  const carriers: Record<string, string> = { 'synthetic mutual': 'K-SM', 'example casualty': 'K-EC', 'j and j': 'W-JJ' };
  const brokers: Record<string, string> = { 'broker one': 'B-1', 'broker two': 'B-2' };

  const records = table.rows.map((r, i) => normalizeRecord(importRecordInput.parse({
    rowNumber: headerRow + i + 1,
    clientName: col('clientName', r), clientExternalId: col('clientExternalId', r), policyNumber: col('policyNumber', r),
    carrierRaw: col('carrier', r), carrierId: carriers[normalizeName(col('carrier', r))] ?? null,
    brokerRaw: col('broker', r), brokerId: brokers[normalizeName(col('broker', r))] ?? null,
    policyType: col('policyType', r), line: col('line', r), effectiveDate: col('effectiveDate', r),
    expirationDate: col('expirationDate', r), premium: col('premium', r), policyStatus: col('policyStatus', r), phone: col('phone', r),
  })));

  const plan = planImport(records, {
    clients: [], policies: [],
    carrierKinds: new Map([['K-SM', 'carrier'], ['K-EC', 'carrier'], ['W-JJ', 'wholesaler']]),
    brokerIds: new Set(['UNASSIGNED', 'B-1', 'B-2']),
  }, { defaultLine: 'commercial', defaultBrokerId: 'UNASSIGNED', updateExisting: true, updateBrokerOnExisting: false });

  const s = plan.summary;
  assert.equal(s.rows, 8);
  assert.equal(s.clientsNew, 4);          // Synthetic Cab, Pat Example (PE01), Pat Examples (PE02), Synthetic Towing
  assert.equal(s.policiesNew, 6);
  assert.equal(s.duplicatesInFile, 1);    // repeated ES-5001 row
  assert.equal(s.errors, 1);              // unknown carrier row
  const cab = plan.rows.find((r) => r.rowNumber === 3)!;
  assert.equal(cab.policyData?.premiumCents, 1250000);
  assert.equal(cab.policyData?.effectiveDate, '2025-11-01');
  assert.equal(cab.policyData?.brokerId, 'B-1');
  assert.equal(plan.rows.find((r) => r.rowNumber === 4)!.policyData?.effectiveDate, '2026-01-15');
  const towing = plan.rows.find((r) => r.rowNumber === 8)!;
  assert.equal(towing.policyData?.wholesalerId, 'W-JJ');
  assert.equal(towing.policyData?.brokerId, 'UNASSIGNED');
  const pat = plan.clients.find((c) => c.data.externalId === 'PE01')!;
  assert.equal(pat.data.classification, 'personal');
  assert.equal(pat.rows.length, 2);
  // No orphan client from the failed row
  assert.ok(!plan.clients.some((c) => c.data.name === 'Mystery Row'));
});
