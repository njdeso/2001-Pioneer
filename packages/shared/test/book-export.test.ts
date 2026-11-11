import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBookExport, FOLDER_CHECKLIST_COLUMNS, POLICY_DETAIL_COLUMNS,
  type BookExportData, type ExportClient, type ExportPolicy,
} from '../src/reports/bookExport.ts';
import { writeBookExportXlsx } from '../src/excelWrite.ts';

// Synthetic data only: 1,600 customers, ~3,200 policies.
const N = 1600;
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
function book(): BookExportData {
  const clients: ExportClient[] = []; const policies: ExportPolicy[] = [];
  for (let i = 0; i < N; i++) {
    const name = i === 7 ? '=SUM(A1) Holdings' : i === 8 ? 'O"Brien, Pat & Co' : `${['zeta', 'Alpha', 'beta', 'Mu'][i % 4]} Synthetic ${N - i}`;
    clients.push({ id: `C${String(i).padStart(5, '0')}`, name, externalId: i % 3 ? `00${i}` : '' });
    // 0–3 policies. Customers with i % 4 === 0 have none; i % 8 === 1 has only a cancelled policy.
    const count = i % 4;
    for (let k = 0; k < count; k++) {
      const status = i % 8 === 1 ? 'cancelled' : k === 2 ? 'expired' : 'active';
      policies.push({ id: `P${i}-${k}`, clientId: clients[i].id, carrierId: k % 2 ? 'CB' : 'CA',
        policyNumber: k === 0 ? `000${i}` : k === 1 ? `61773${String(i).padStart(7, '0')}` : `POL-${i}-${k}`, policyType: k % 2 ? 'Personal Auto' : 'Homeowners',
        effectiveDate: `2026-0${(k % 9) + 1}-15`, expirationDate: `2027-0${(k % 9) + 1}-15`, status, brokerId: i % 5 ? 'B50' : 'UNASSIGNED',
        // financial fields carried on the records must never reach the file
        ...({ premiumCents: 98765432, commissionRateBps: 1777, brokerShareBps: 4321 } as object) });
    }
  }
  return { clients, policies, carriers: [{ id: 'CA', name: 'Synthetic Mutual' }, { id: 'CB', name: 'Other Synthetic Co' }], brokers: [{ id: 'B50', name: 'Test Broker Fifty' }] };
}
const activeCount = (d: BookExportData, id: string) => d.policies.filter((p) => p.clientId === id && p.status === 'active').length;

test(`Folder Checklist, all records: every one of the ${N} customers, A–Z, numbered, with blank boxes`, () => {
  const d = book();
  const r = buildBookExport(d, { format: 'folder_checklist', scope: 'all' }, '2026-11-11');
  assert.deepEqual(r.columns.map((c) => c.header), ['No.', 'Customer Name', 'Customer ID', 'Active Policies', 'File Located', 'File Reviewed', 'Ready for Pioneer', 'Box Number']);
  assert.deepEqual(r.columns.slice(4).map((c) => c.kind), ['mark', 'mark', 'mark', 'mark']);
  assert.equal(r.rows.length, N); assert.equal(r.counts.customers, N);
  assert.deepEqual(r.rows.map((x) => x[0]), Array.from({ length: N }, (_, i) => i + 1));
  const names = r.rows.map((x) => String(x[1]));
  assert.deepEqual(names, [...names].sort(collator.compare));
  assert.equal(new Set(r.rows.map((x) => x[2])).size, N, 'each customer once');
  assert.ok(r.rows.every((x) => x.slice(4).every((v) => v === null)), 'File Located / Reviewed / Ready / Box are blank');
  assert.equal(r.orientation, 'portrait');
  assert.equal(r.fileName, 'customer-folder-checklist-all-2026-11-11.xlsx');
});

test('Folder Checklist, active only = customers with at least one ACTIVE policy (policy status, not customer status)', () => {
  const d = book();
  const r = buildBookExport(d, { format: 'folder_checklist', scope: 'active' }, '2026-11-11');
  const expected = d.clients.filter((c) => activeCount(d, c.id) > 0);
  assert.equal(r.rows.length, expected.length);
  assert.ok(r.rows.length < N);
  const byId = new Map(d.clients.map((c) => [c.externalId || c.id, c]));
  for (const row of r.rows) {
    const c = byId.get(String(row[2]))!;
    assert.equal(row[3], activeCount(d, c.id), 'Active Policies counts only active policies');
    assert.ok((row[3] as number) > 0);
  }
  // A customer whose only policy is cancelled is NOT on the active checklist; one with active + expired is, counted 2.
  assert.ok(!r.rows.some((x) => x[2] === '001'), 'C00001 has only a cancelled policy');
  assert.equal(r.rows.find((x) => x[2] === 'C00003')![3], 2, 'C00003 (no external ID, so the record ID is shown): two active, one expired');
  assert.equal(r.counts.policies, d.policies.filter((p) => p.status === 'active').length);
  assert.match(r.subtitle, /^Customers with at least one active policy · [\d,]+ customers · 2026-11-11$/);
});

test('Policy Detail, all records: every policy once, grouped by customer A–Z then policy number', () => {
  const d = book();
  const r = buildBookExport(d, { format: 'policy_detail', scope: 'all' }, '2026-11-11');
  assert.deepEqual(r.columns.map((c) => c.header), ['Customer Name', 'Policy Number', 'Carrier', 'Policy Type', 'Effective Date', 'Expiration Date', 'Policy Status', 'Broker']);
  assert.equal(r.rows.length, d.policies.length);
  assert.deepEqual(r.rows.map((x) => x[1]).sort(), d.policies.map((p) => p.policyNumber).sort());
  const names = r.rows.map((x) => String(x[0]));
  assert.deepEqual(names, [...names].sort(collator.compare));
  const row = r.rows.find((x) => x[1] === 'POL-3-2')!;
  assert.deepEqual(row, ['Mu Synthetic 1597', 'POL-3-2', 'Synthetic Mutual', 'Homeowners', '2026-03-15', '2027-03-15', 'Expired', 'Test Broker Fifty']);
  assert.equal(r.rows.find((x) => x[1] === '0005')![7], 'Unassigned');
  assert.equal(r.orientation, 'landscape');
});

test('Policy Detail, active only = active policies only (whatever the customer status)', () => {
  const d = book();
  const r = buildBookExport(d, { format: 'policy_detail', scope: 'active' }, '2026-11-11');
  assert.equal(r.rows.length, d.policies.filter((p) => p.status === 'active').length);
  assert.ok(r.rows.every((x) => x[6] === 'Active'));
  assert.equal(r.fileName, 'policy-detail-active-2026-11-11.xlsx');
});

test('a policy whose customer record is missing is listed last, not dropped', () => {
  const d = book();
  d.policies.push({ id: 'ORPH', clientId: 'GONE', carrierId: 'CA', policyNumber: '000999', status: 'active', brokerId: 'B50' });
  const r = buildBookExport(d, { format: 'policy_detail', scope: 'active' }, '2026-11-11');
  assert.equal(r.counts.orphanPolicies, 1);
  assert.deepEqual(r.rows.at(-1)!.slice(0, 2), ['(customer record missing)', '000999']);
});

test('no commission, premium, rate, share or other financial columns or values', () => {
  const d = book();
  for (const format of ['folder_checklist', 'policy_detail'] as const) for (const scope of ['active', 'all'] as const) {
    const r = buildBookExport(d, { format, scope }, '2026-11-11');
    assert.doesNotMatch(r.columns.map((c) => c.header).join('|'), /commission|premium|rate|share|compensation|amount|valuation|buyout|advance|\$/i);
    assert.doesNotMatch(JSON.stringify(r.rows), /98765432|987654\.32|1777|4321/);
  }
  assert.deepEqual([...FOLDER_CHECKLIST_COLUMNS, ...POLICY_DETAIL_COLUMNS].filter((c) => /comm|prem|share/i.test(c.header)), []);
});

test('does not change the input records', () => {
  const d = book(); const before = JSON.stringify(d);
  buildBookExport(d, { format: 'policy_detail', scope: 'active' }, '2026-11-11');
  buildBookExport(d, { format: 'folder_checklist', scope: 'all' }, '2026-11-11');
  assert.equal(JSON.stringify(d), before);
});

// ---- the .xlsx file itself (exceljs: installed in CI) ----
async function excel(t: { skip: (m: string) => void }) {
  try { const m: { default?: unknown } = await import('exceljs'); return (m.default ?? m) as { Workbook: new () => { xlsx: { load(b: Uint8Array): Promise<void> }; worksheets: any[] } }; } catch { t.skip('exceljs is not installed in this environment'); return null; }
}

test('XLSX Folder Checklist: native text cells for IDs (leading zeros), numbers for counts, print setup, blank bordered boxes', async (t) => {
  const ExcelJS = await excel(t); if (!ExcelJS) return;
  const r = buildBookExport(book(), { format: 'folder_checklist', scope: 'all' }, '2026-11-11');
  const bytes = await writeBookExportXlsx(r);
  assert.equal(String.fromCharCode(bytes[0], bytes[1]), 'PK');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(bytes);
  const ws = wb.worksheets[0];
  assert.equal(ws.name, 'Folder Checklist');
  assert.equal(ws.rowCount, N + 1, `header + all ${N} customers`);
  assert.deepEqual(ws.getRow(1).values.slice(1), r.columns.map((c) => c.header));
  // Customer "C00001" has external ID "001": stored as TEXT, not the number 1.
  const row = (i: number) => ws.getRow(i + 2);
  const idx = r.rows.findIndex((x) => x[2] === '001');
  const id = row(idx).getCell(3);
  assert.equal(id.value, '001'); assert.equal(typeof id.value, 'string'); assert.equal(id.numFmt, '@');
  assert.equal(typeof row(idx).getCell(1).value, 'number');
  assert.equal(typeof row(idx).getCell(4).value, 'number');
  for (const c of [5, 6, 7, 8]) { assert.equal(row(idx).getCell(c).value, null); assert.ok(row(idx).getCell(c).border?.top, 'blank box has a border'); }
  assert.ok(r.rows.some((x, i) => x[1] === '=SUM(A1) Holdings' && ws.getRow(i + 2).getCell(2).value === '=SUM(A1) Holdings'), 'a name that looks like a formula is plain text, not a formula');
  assert.equal(ws.pageSetup.orientation, 'portrait');
  assert.equal(ws.pageSetup.fitToWidth, 1); assert.equal(ws.pageSetup.fitToHeight, 0);
  assert.equal(ws.pageSetup.printTitlesRow, '1:1', 'header row repeats on every printed page');
  assert.match(ws.headerFooter.oddHeader, /Customer Folder Checklist/);
  assert.match(ws.headerFooter.oddFooter, /Page &P of &N/);
  assert.equal(ws.views[0].state, 'frozen');
});

test('XLSX Policy Detail: policy numbers as text (no scientific notation, zeros kept), real dates, landscape', async (t) => {
  const ExcelJS = await excel(t); if (!ExcelJS) return;
  const r = buildBookExport(book(), { format: 'policy_detail', scope: 'all' }, '2026-11-11');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await writeBookExportXlsx(r));
  const ws = wb.worksheets[0];
  assert.equal(ws.rowCount, r.rows.length + 1);
  const find = (num: string) => { const i = r.rows.findIndex((x) => x[1] === num); return ws.getRow(i + 2); };
  const lead = find('0005').getCell(2);
  assert.equal(lead.value, '0005'); assert.equal(lead.numFmt, '@');
  const long = find('617730000002').getCell(2);
  assert.equal(long.value, '617730000002'); assert.equal(typeof long.value, 'string');
  const eff = find('POL-3-2').getCell(5);
  assert.ok(eff.value instanceof Date); assert.equal((eff.value as Date).toISOString().slice(0, 10), '2026-03-15'); assert.equal(eff.numFmt, 'mm/dd/yyyy');
  assert.equal(ws.pageSetup.orientation, 'landscape');
  // Every cell in the Policy Number column is a string.
  for (let i = 2; i <= ws.rowCount; i++) assert.equal(typeof ws.getRow(i).getCell(2).value, 'string');
});

// ---- proper-case customer names (PR #11 display rule) in both exports ----
test('both exports show customer names in proper case; order and stored records are unchanged', () => {
  const d: BookExportData = {
    clients: [
      { id: 'K1', name: 'SMITH TRUCKING LLC', externalId: '0101' },
      { id: 'K2', name: "o'brien, pat", externalId: '0102' },
      { id: 'K3', name: 'McDonald & Sons, Inc.', externalId: '0103' }, // mixed case: as typed
      { id: 'K4', name: 'ACME INC. DBA ACE AUTO', externalId: '0104' },
      { id: 'K5', name: 'adams family trust', externalId: '0105' },
    ],
    policies: ['K1', 'K2', 'K3', 'K4', 'K5'].map((c, i) => ({ id: `Q${i}`, clientId: c, carrierId: 'CA', policyNumber: `00${i}`, status: 'active', brokerId: 'UNASSIGNED' })),
    carriers: [{ id: 'CA', name: 'Synthetic Mutual' }], brokers: [],
  };
  const before = JSON.stringify(d);
  const chk = buildBookExport(d, { format: 'folder_checklist', scope: 'all' }, '2026-11-11');
  assert.deepEqual(chk.rows.map((r) => r[1]), ['Acme Inc. DBA Ace Auto', 'Adams Family Trust', 'McDonald & Sons, Inc.', "O'Brien, Pat", 'Smith Trucking LLC']);
  assert.deepEqual(chk.rows.map((r) => r[2]), ['0104', '0105', '0103', '0102', '0101'], 'same A–Z order as the stored names (case-insensitive)');
  const pd = buildBookExport(d, { format: 'policy_detail', scope: 'all' }, '2026-11-11');
  assert.deepEqual(pd.rows.map((r) => r[0]), ['Acme Inc. DBA Ace Auto', 'Adams Family Trust', 'McDonald & Sons, Inc.', "O'Brien, Pat", 'Smith Trucking LLC']);
  assert.deepEqual(pd.rows.map((r) => r[1]), ['003', '004', '002', '001', '000'], 'policy numbers untouched');
  assert.equal(JSON.stringify(d), before, 'stored names are not changed');
});
