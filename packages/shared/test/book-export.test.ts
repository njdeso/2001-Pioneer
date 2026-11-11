import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/csv.ts';
import {
  buildBookExport, excelTextCell, CUSTOMER_SUMMARY_HEADERS, POLICY_DETAIL_HEADERS, FILE_TRACKING_HEADERS,
  type BookExportData, type ExportClient, type ExportPolicy, type FileTracking,
} from '../src/reports/bookExport.ts';

// Synthetic data only. 1,500 customers, ~3,000 policies.
const N = 1500;
function book(): BookExportData {
  const carriers = [{ id: 'CA', name: 'Synthetic Mutual' }, { id: 'CB', name: 'Other Synthetic Co' }, { id: 'W1', name: 'Synthetic Wholesale MGA' }];
  const brokers = [{ id: 'B50', name: 'Test Broker Fifty' }, { id: 'UNASSIGNED', name: 'Unassigned' }];
  const clients: ExportClient[] = []; const policies: ExportPolicy[] = [];
  for (let i = 0; i < N; i++) {
    // Names deliberately out of order, mixed case, with digits, commas, quotes and a formula-looking name.
    const name = i === 7 ? '=SUM(A1) Holdings' : i === 8 ? 'O"Brien, Pat & Co' : `${['zeta', 'Alpha', 'beta', 'Mu'][i % 4]} Synthetic ${N - i}`;
    clients.push({ id: `C${String(i).padStart(5, '0')}`, name, externalId: i % 3 ? `00${i}` : '', classification: i % 2 ? 'personal' : 'commercial', brokerId: i % 5 ? 'B50' : 'UNASSIGNED', status: i % 10 === 0 ? 'inactive' : 'active' });
    const n = i % 4; // 0..3 policies; every 4th customer has none
    for (let k = 0; k < n; k++) {
      policies.push({ id: `P${i}-${k}`, clientId: clients[i].id, carrierId: k % 2 ? 'CB' : 'CA', wholesalerId: k === 2 ? 'W1' : null,
        policyNumber: k === 0 ? `000${i}${k}` : k === 1 ? '617738486000' : `POL-${i}-${k}`, policyType: k % 2 ? 'Personal Auto' : 'Homeowners',
        effectiveDate: `2026-0${(k % 9) + 1}-01`, expirationDate: `2027-0${(k % 9) + 1}-01`, status: k === 2 ? 'cancelled' : 'active', brokerId: 'B50' });
    }
  }
  return { clients, policies, carriers, brokers };
}

const table = (csv: string) => { assert.ok(csv.startsWith('﻿'), 'UTF-8 BOM for Excel'); assert.ok(csv.includes('\r\n')); return parseCsv(csv.slice(1)); };
const unwrap = (cell: string) => (/^="(.*)"$/s.exec(cell)?.[1].replace(/""/g, '"') ?? cell);

test('Customer Summary, all customers: one row per customer (1,500), alphabetical, every customer included', () => {
  const d = book();
  const r = buildBookExport(d, { format: 'customer_summary', scope: 'all', includeFileTracking: false }, '2026-11-11');
  const t = table(r.csv);
  assert.deepEqual(t[0], [...CUSTOMER_SUMMARY_HEADERS]);
  assert.equal(t.length - 1, N); assert.equal(r.customers, N); assert.equal(r.rows, N);
  assert.equal(r.policies, d.policies.length);
  const names = t.slice(1).map((row) => row[0].replace(/^'/, ''));
  const sorted = [...names].sort(new Intl.Collator('en', { sensitivity: 'base', numeric: true }).compare);
  assert.deepEqual(names, sorted, 'alphabetical, case-insensitive, numeric-aware');
  assert.equal(new Set(t.slice(1).map((row) => unwrap(row[2]))).size, N, 'every customer record exactly once');
  assert.equal(r.fileName, 'customer-summary-all-customers-2026-11-11.csv');
  assert.equal(t.slice(1).reduce((s, row) => s + Number(row[6]), 0), d.policies.length, 'policy counts add up to every policy');
});

test('Policy Detail, all customers: one row per policy plus one per customer without policies — nothing missing', () => {
  const d = book();
  const r = buildBookExport(d, { format: 'policy_detail', scope: 'all', includeFileTracking: false }, '2026-11-11');
  const t = table(r.csv);
  assert.deepEqual(t[0], [...POLICY_DETAIL_HEADERS]);
  const noPolicy = d.clients.filter((c) => !d.policies.some((p) => p.clientId === c.id)).length;
  assert.equal(r.customersWithoutPolicies, noPolicy);
  assert.equal(t.length - 1, d.policies.length + noPolicy);
  assert.equal(r.policies, d.policies.length);
  const exported = new Set(t.slice(1).map((row) => unwrap(row[5])).filter(Boolean).map((n, i) => `${n}#${i}`));
  assert.equal(exported.size, d.policies.length);
  // Customers stay alphabetical; each customer's policies are together.
  const ids = t.slice(1).map((row) => unwrap(row[2]));
  const order = [...new Set(ids)];
  assert.equal(order.length, N);
  for (let i = 1; i < ids.length; i++) if (ids[i] !== ids[i - 1]) assert.ok(order.indexOf(ids[i]) > order.indexOf(ids[i - 1]));
});

test('active customers only: inactive customers and their policies are left out, every active one is in', () => {
  const d = book();
  const active = d.clients.filter((c) => c.status === 'active');
  const activePolicies = d.policies.filter((p) => active.some((c) => c.id === p.clientId));
  const s = buildBookExport(d, { format: 'customer_summary', scope: 'active', includeFileTracking: false }, '2026-11-11');
  assert.equal(s.customers, active.length); assert.equal(table(s.csv).length - 1, active.length);
  assert.ok(table(s.csv).slice(1).every((row) => row[3] === 'Active'));
  const p = buildBookExport(d, { format: 'policy_detail', scope: 'active', includeFileTracking: false }, '2026-11-11');
  assert.equal(p.policies, activePolicies.length);
  assert.ok(table(p.csv).slice(1).every((row) => row[3] === 'Active'));
  assert.equal(p.fileName, 'policy-detail-active-customers-2026-11-11.csv');
});

test('policy numbers and IDs are Excel text: leading zeros kept, no scientific notation', () => {
  assert.equal(excelTextCell('0045678'), '"=""0045678"""');
  assert.equal(excelTextCell('617738486000'), '"=""617738486000"""');
  assert.equal(excelTextCell('A"B'), '"=""A""""B"""');
  assert.equal(unwrap(parseCsv(excelTextCell('A"B'))[0][0]), 'A"B');
  assert.equal(excelTextCell(''), '');
  const r = buildBookExport(book(), { format: 'policy_detail', scope: 'all', includeFileTracking: false }, '2026-11-11');
  const rows = table(r.csv).slice(1);
  const lead = rows.find((row) => unwrap(row[5]) === '00010');
  assert.ok(lead, 'policy 00010 kept with its leading zeros');
  assert.equal(lead![5], '="00010"');
  assert.ok(rows.some((row) => row[5] === '="617738486000"'));
  assert.ok(rows.every((row) => !row[5] || /^="/.test(row[5])));
  assert.ok(rows.some((row) => row[1] === '="001"'), 'customer IDs with leading zeros are text too');
});

test('fields: carrier, wholesaler, type, dates, status, broker; formula-looking names neutralised; commas and quotes survive', () => {
  const t = table(buildBookExport(book(), { format: 'policy_detail', scope: 'all', includeFileTracking: false }, '2026-11-11').csv);
  const row = t.find((r) => r[5] === '="POL-3-2"')!;
  assert.deepEqual(row.slice(6), ['Synthetic Mutual', 'Synthetic Wholesale MGA', 'Homeowners', '2026-03-01', '2027-03-01', 'Cancelled', 'Test Broker Fifty']);
  assert.ok(t.some((r) => r[0] === "'=SUM(A1) Holdings"), 'formula injection guarded');
  assert.ok(t.some((r) => r[0] === 'O"Brien, Pat & Co'));
  const s = table(buildBookExport(book(), { format: 'customer_summary', scope: 'all', includeFileTracking: false }, '2026-11-11').csv);
  const unassigned = s.find((r) => unwrap(r[2]) === 'C00005')!;
  assert.equal(unassigned[5], 'Unassigned');
  const three = s.find((r) => unwrap(r[2]) === 'C00003')!;
  assert.deepEqual([three[6], three[7], three[8], three[9], three[11], three[12], three[13]],
    ['3', '2', '00030; 617738486000; POL-3-2', 'Other Synthetic Co; Synthetic Mutual', 'Active 2; Cancelled 1', '2026-01-01', '2027-03-01']);
});

test('no commission, premium, rate, broker share or other financial columns — ever', () => {
  const d = book();
  // Even if records carry financial fields, nothing financial reaches the file.
  for (const p of d.policies) Object.assign(p, { premiumCents: 98765432, commissionRateBps: 1777, brokerShareBps: 4321, commissionCents: 55554444 });
  for (const fmt of ['customer_summary', 'policy_detail'] as const) {
    const csv = buildBookExport(d, { format: fmt, scope: 'all', includeFileTracking: true }, '2026-11-11').csv;
    const header = table(csv)[0].join('|');
    assert.doesNotMatch(header, /commission|premium|rate|share|compensation|amount|t12|valuation|buyout|advance|\$/i);
    assert.doesNotMatch(csv, /98765432|987654\.32|1777|17\.77|4321|43\.21|55554444|555544\.44/);
  }
});

test('optional physical file tracking columns', () => {
  const d = book();
  const ft = new Map<string, FileTracking>([['C00001', { fileReviewed: true, reviewStatus: 'reviewed', boxNumber: '007', transferDate: '2026-12-01' }]]);
  d.fileTracking = ft;
  const off = table(buildBookExport(d, { format: 'customer_summary', scope: 'all', includeFileTracking: false }, '2026-11-11').csv);
  assert.ok(!off[0].includes('Box Number'));
  const on = buildBookExport(d, { format: 'policy_detail', scope: 'all', includeFileTracking: true }, '2026-11-11');
  const t = table(on.csv);
  assert.deepEqual(t[0].slice(-4), [...FILE_TRACKING_HEADERS]);
  const rows = t.filter((r) => unwrap(r[2]) === 'C00001');
  assert.ok(rows.length >= 1 && rows.every((r) => r.slice(-4).join('|') === 'Yes|Reviewed|="007"|2026-12-01'));
  assert.ok(t.filter((r) => unwrap(r[2]) === 'C00002').every((r) => r.slice(-4).join('|') === '|||'), 'no record: blank');
  assert.match(on.fileName, /-with-file-tracking-/);
});

test('a policy whose customer record is missing is listed, not dropped', () => {
  const d = book();
  d.policies.push({ id: 'ORPH', clientId: 'GONE', carrierId: 'CA', policyNumber: '000999', status: 'active', brokerId: 'B50' });
  const r = buildBookExport(d, { format: 'policy_detail', scope: 'all', includeFileTracking: false }, '2026-11-11');
  assert.equal(r.orphanPolicies, 1);
  const last = table(r.csv).at(-1)!;
  assert.equal(last[0], '(customer record missing)'); assert.equal(last[5], '="000999"');
});

test('does not change the input records', () => {
  const d = book();
  const before = JSON.stringify(d);
  buildBookExport(d, { format: 'policy_detail', scope: 'active', includeFileTracking: true }, '2026-11-11');
  buildBookExport(d, { format: 'customer_summary', scope: 'all', includeFileTracking: false }, '2026-11-11');
  assert.equal(JSON.stringify(d), before);
});
