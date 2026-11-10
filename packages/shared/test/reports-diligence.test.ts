import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowMonths } from '../src/period.ts';
import { reversalOf } from '../src/statements/posting.ts';
import type { ReportEntry } from '../src/reports/ledger.ts';
import {
  buildDiligenceSummary, clientPolicyExport, diligenceCategory, diligenceSummaryCsv, CLIENT_POLICY_HEADERS,
  type DiligenceCarrier, type DiligenceClient, type DiligencePolicy, type DiligenceStatement,
} from '../src/reports/diligence.ts';

// Synthetic data only. Entries carry broker fields and staff emails on purpose: the exports must drop them.
const START = '2025-11';
const MONTHS = windowMonths(START, 12);
const carriers: DiligenceCarrier[] = [
  { id: 'MUT', name: 'Mutual Synthetic', kind: 'carrier', commissionMethod: 'statement', status: 'active' },
  { id: 'WHL', name: 'Wholesale Synthetic', kind: 'wholesaler', commissionMethod: 'statement', status: 'active' },
  { id: 'LAN', name: 'Lancer Synthetic', kind: 'carrier', commissionMethod: 'retained', status: 'active' },
];
const SECRET = { brokerId: 'BROKER-SECRET-ID', brokerShareBps: 5000, brokerShareSource: 'broker' as const, postedByEmail: 'staff.member@example.test', note: 'INTERNAL-NOTE-TEXT' };
const clients = [
  { id: 'C1', name: 'Alpha Trucking LLC', externalId: 'AMS-1', classification: 'commercial', status: 'active', brokerId: 'BROKER-SECRET-ID', contact: { email: 'alpha@customer.test', phone: '555-0100', address: '1 Secret St', notes: 'CLIENT-NOTE' } },
  { id: 'C2', name: 'Beta Cab Corp', externalId: 'AMS-2', classification: 'commercial', status: 'active', brokerId: 'BROKER-SECRET-ID', contact: { email: '', phone: '', address: '', notes: '' } },
  { id: 'C3', name: 'Gamma Household', externalId: '', classification: 'personal', status: 'inactive', brokerId: 'UNASSIGNED', contact: {} },
] as unknown as DiligenceClient[];
const policies = [
  { id: 'P1', clientId: 'C1', carrierId: 'MUT', wholesalerId: null, policyNumber: 'A-1', policyType: 'Commercial Auto', line: 'commercial', namedInsured: 'Alpha Trucking LLC', effectiveDate: '2026-01-01', expirationDate: '2027-01-01', premiumCents: 1200000, commissionRateBps: 1500, status: 'active', brokerId: 'BROKER-SECRET-ID', brokerShareBps: 3000 },
  { id: 'P2', clientId: 'C2', carrierId: 'MUT', wholesalerId: 'WHL', policyNumber: 'B-2', policyType: 'Livery', line: 'commercial', namedInsured: 'Beta Cab Corp', effectiveDate: '2026-03-01', expirationDate: '2027-03-01', premiumCents: null, commissionRateBps: null, status: 'active', brokerId: 'BROKER-SECRET-ID' },
  { id: 'P3', clientId: 'C1', carrierId: 'LAN', wholesalerId: null, policyNumber: '=CMD()', policyType: 'Auto', line: 'commercial', effectiveDate: null, expirationDate: null, status: 'active' },
] as unknown as DiligencePolicy[];

let seq = 0;
const entry = (o: Partial<ReportEntry> & Pick<ReportEntry, 'amountCents' | 'statementPeriod'>): ReportEntry => ({
  id: `E${++seq}`, postingStatus: 'posted', reversalOf: null, sourceType: 'statement', level: 'policy', brokerCents: Math.trunc(o.amountCents / 2), agencyCents: o.amountCents - Math.trunc(o.amountCents / 2), ...SECRET, ...o,
});
/** One posted statement per payer per month: a policy line, an unmatched line and an adjustment. */
function postMonth(month: string, payer: string, policyId: string, cents: number): ReportEntry[] {
  const postingId = `S-${payer}-${month}__p1`;
  return [
    entry({ statementPeriod: month, payerId: payer, carrierId: 'MUT', policyId, amountCents: cents, postingId, statementId: `S-${payer}-${month}` }),
    entry({ statementPeriod: month, payerId: payer, carrierId: null, policyId: null, level: 'suspense', amountCents: 1000, postingId, statementId: `S-${payer}-${month}` }),
    entry({ statementPeriod: month, payerId: payer, carrierId: null, policyId: null, level: 'carrier', amountCents: -250, postingId, statementId: `S-${payer}-${month}` }),
  ];
}
function reverseAll(entries: ReportEntry[], postingId: string): ReportEntry[] {
  const out: ReportEntry[] = [];
  for (const e of entries) {
    if (e.postingId !== postingId) { out.push(e); continue; }
    const rev = reversalOf(e as unknown as Parameters<typeof reversalOf>[0], 'test') as unknown as ReportEntry;
    out.push({ ...e, postingStatus: 'reversed', reversalId: rev.id }, rev);
  }
  return out;
}
const fullYear = () => MONTHS.flatMap((m) => [...postMonth(m, 'MUT', 'P1', 10000), ...postMonth(m, 'WHL', 'P2', 5000)]);
const retained = (month: string) => entry({ statementPeriod: month, payerId: 'LAN', carrierId: 'LAN', policyId: 'P3', sourceType: 'retained', amountCents: 7500, postingId: `retained__${month}`, statementId: null });

const parse = (csv: string) => csv.replace(/^﻿/, '').trimEnd().split('\r\n');
const section = (lines: string[], title: string) => {
  const i = lines.findIndex((l) => l.replace(/^"|"$/g, '').startsWith(title));
  assert.ok(i >= 0, `section ${title}`);
  const out: string[] = [];
  for (let j = i + 1; j < lines.length && lines[j] !== ''; j++) out.push(lines[j]);
  return out;
};

test('categories: matched commission, unmatched, adjustments, retained, manual', () => {
  assert.equal(diligenceCategory({ sourceType: 'statement', level: 'policy' }), 'commission');
  assert.equal(diligenceCategory({ sourceType: 'statement', level: 'suspense' }), 'unmatched');
  assert.equal(diligenceCategory({ sourceType: 'statement', level: 'carrier' }), 'adjustment');
  assert.equal(diligenceCategory({ sourceType: 'retained', level: 'policy' }), 'retained');
  assert.equal(diligenceCategory({ sourceType: 'manual', level: 'policy' }), 'manual');
});

test('one posted month of twelve is stamped PRELIMINARY — INCOMPLETE, never presented as complete', () => {
  const s = buildDiligenceSummary({ entries: postMonth('2026-10', 'MUT', 'P1', 41000), start: START, carriers, policies });
  assert.equal(s.status, 'INCOMPLETE');
  assert.equal(s.missingMonths.length, 11);
  assert.match(s.statusText, /NOT a complete 12-month/);
  assert.ok(s.checks.every((c) => c.pass), JSON.stringify(s.checks));
  const csv = diligenceSummaryCsv(s, { agencyName: 'Central Insurance Agency', preparedAtIso: '2026-11-10T04:00:00Z' });
  const lines = parse(csv);
  assert.match(lines[1], /^Status,PRELIMINARY — INCOMPLETE$/);
  assert.ok(lines.some((l) => l.includes('NOT a complete 12-month')));
  assert.ok(lines.some((l) => /^2025-11,.*NO — missing$/.test(l)));
  assert.ok(lines.some((l) => /^2026-10,.*,Yes$/.test(l)));
});

test('a month whose only posting was reversed counts as missing', () => {
  const entries = reverseAll([...fullYear(), ...MONTHS.map(retained)], 'S-MUT-2026-03__p1');
  const s = buildDiligenceSummary({ entries, start: START, carriers, policies });
  assert.equal(s.byMonth.find((m) => m.month === '2026-03')!.hasPostedStatement, true, 'WHL still posted in March');
  const onlyMut = reverseAll(MONTHS.flatMap((m) => postMonth(m, 'MUT', 'P1', 10000)), 'S-MUT-2026-03__p1');
  const s2 = buildDiligenceSummary({ entries: onlyMut, start: START, carriers, policies: [policies[0]] });
  assert.deepEqual(s2.missingMonths, ['2026-03']);
  assert.equal(s2.status, 'INCOMPLETE');
  assert.equal(s2.byMonth.find((m) => m.month === '2026-03')!.totals.total, 0);
});

test('a statement uploaded but not posted keeps the summary INCOMPLETE', () => {
  const statements: DiligenceStatement[] = [{ id: 'X', status: 'needs_review', statementMonth: '2026-05', payerId: 'MUT' }, { id: 'D', status: 'discarded', statementMonth: '2026-05' }, { id: 'O', status: 'needs_review', statementMonth: '2024-01' }];
  const s = buildDiligenceSummary({ entries: [...fullYear(), ...MONTHS.map(retained)], start: START, carriers, policies, statements });
  assert.equal(s.status, 'INCOMPLETE');
  assert.deepEqual(s.unpostedStatements.map((u) => u.id), ['X']);
});

test('every month and carrier posted and all checks pass: READY; a carrier gap: REVIEW', () => {
  const all = [...fullYear(), ...MONTHS.map(retained)];
  const s = buildDiligenceSummary({ entries: all, start: START, carriers, policies, statements: [] });
  assert.equal(s.status, 'READY', JSON.stringify(s.notices));
  assert.ok(s.checks.every((c) => c.pass));
  // 12 × (10000 + 1000 − 250) + 12 × (5000 + 1000 − 250) + 12 × 7500
  assert.equal(s.total.total, 12 * 10750 + 12 * 5750 + 12 * 7500);
  assert.equal(s.total.commission, 12 * 15000);
  assert.equal(s.total.unmatched, 24 * 1000);
  assert.equal(s.total.adjustment, 24 * -250);
  assert.equal(s.total.retained, 12 * 7500);
  const gap = all.filter((e) => !(e.payerId === 'WHL' && e.statementPeriod === '2026-02'));
  const r = buildDiligenceSummary({ entries: gap, start: START, carriers, policies, statements: [] });
  assert.equal(r.status, 'REVIEW');
  assert.deepEqual(r.carrierGaps, [{ id: 'WHL', name: 'Wholesale Synthetic', missingMonths: ['2026-02'] }]);
});

test('reconciliation: months, carriers, grid and categories tie to the total; entries outside the period are excluded', () => {
  const all = [...fullYear(), ...MONTHS.map(retained), ...postMonth('2025-10', 'MUT', 'P1', 999999)];
  const s = buildDiligenceSummary({ entries: all, start: START, carriers, policies, statements: [] });
  assert.ok(s.checks.every((c) => c.pass));
  const lines = parse(diligenceSummaryCsv(s, { agencyName: 'CIA', preparedAtIso: 'x' }));
  const cents = (v: string) => Math.round(Number(v) * 100);
  const monthly = section(lines, 'Monthly commission').slice(1);
  const monthRows = monthly.filter((l) => /^\d{4}-\d{2},/.test(l));
  assert.equal(monthRows.length, 12);
  const totalCol = 6; // month, 5 categories, total
  assert.equal(monthRows.reduce((t, l) => t + cents(l.split(',')[totalCol]), 0), s.total.total);
  const grid = section(lines, 'Carrier by month').slice(1);
  const gridTotal = grid.find((l) => l.startsWith('Total,'))!.split(',');
  assert.equal(cents(gridTotal[13]), s.total.total);
  assert.ok(!lines.some((l) => l.includes('9999.99')), 'out-of-period entries excluded');
});

test('checks fail (and the status says do not send) on an unbalanced reversal or commission on a missing policy', () => {
  const base = fullYear();
  const reversed = reverseAll(base, 'S-MUT-2026-01__p1');
  const bad = reversed.map((e) => (e.reversalOf && e.postingId === 'S-MUT-2026-01__p1' && e.level === 'policy' ? { ...e, amountCents: e.amountCents + 1 } : e));
  const s = buildDiligenceSummary({ entries: bad, start: START, carriers, policies, statements: [] });
  assert.equal(s.status, 'CHECKS_FAILED');
  assert.match(s.statusLabel, /NOT FOR DISTRIBUTION/);
  const orphan = buildDiligenceSummary({ entries: [...base, entry({ statementPeriod: '2026-01', payerId: 'MUT', policyId: 'GONE', amountCents: 100, postingId: 'S-x__p1', statementId: 'S-x' })], start: START, carriers, policies, statements: [] });
  assert.equal(orphan.status, 'CHECKS_FAILED');
  assert.ok(orphan.checks.some((c) => !c.pass && /policy/.test(c.name)));
});

test('no broker, compensation, staff or note information in either export', () => {
  const all = [...fullYear(), ...MONTHS.map(retained)];
  const s = buildDiligenceSummary({ entries: all, start: START, carriers, policies, statements: [] });
  const summary = diligenceSummaryCsv(s, { agencyName: 'CIA', preparedAtIso: 'x' });
  const cp = clientPolicyExport({ clients, policies, carriers, entries: all, start: START, policyAttributedCents: s.policyAttributedCents }).csv;
  for (const [name, csv] of [['summary', summary], ['client/policy', cp]] as const) {
    for (const bad of ['BROKER-SECRET-ID', 'staff.member@example.test', 'INTERNAL-NOTE-TEXT', 'CLIENT-NOTE', 'alpha@customer.test', '555-0100', 'Secret St', '@']) {
      assert.ok(!csv.includes(bad), `${name} export must not contain "${bad}"`);
    }
    assert.doesNotMatch(csv.split('\r\n')[0].toLowerCase(), /broker/);
  }
  assert.ok(!/broker/i.test(cp.split('\r\n')[0]), 'no broker columns');
});

test('client/policy export: every policy and client, Excel-safe, t12 commission ties to the summary', () => {
  const all = [...fullYear(), ...MONTHS.map(retained)];
  const s = buildDiligenceSummary({ entries: all, start: START, carriers, policies, statements: [] });
  const x = clientPolicyExport({ clients, policies, carriers, entries: all, start: START, policyAttributedCents: s.policyAttributedCents });
  assert.ok(x.checks.every((c) => c.pass), JSON.stringify(x.checks));
  assert.equal(x.policyRows, 3);
  assert.equal(x.clientsWithoutPolicies, 1);
  assert.equal(x.rows, 4);
  const lines = parse(x.csv);
  assert.deepEqual(lines[0].split(','), [...CLIENT_POLICY_HEADERS]);
  const col = (n: string) => CLIENT_POLICY_HEADERS.indexOf(n as (typeof CLIENT_POLICY_HEADERS)[number]);
  const p1 = lines.find((l) => l.split(',')[col('policy_id')] === 'P1')!.split(',');
  assert.equal(p1[col('carrier')], 'Mutual Synthetic');
  assert.equal(p1[col('annual_premium')], '12000.00');
  assert.equal(p1[col('agency_commission_rate_pct')], '15.00');
  assert.equal(p1[col('t12_commission')], '1200.00');
  assert.equal(p1[col('t12_commission_entries')], '12');
  const p2 = lines.find((l) => l.split(',')[col('policy_id')] === 'P2')!.split(',');
  assert.equal(p2[col('wholesaler')], 'Wholesale Synthetic');
  assert.ok(lines.some((l) => l.includes("'=CMD()")), 'formula-like text neutralised');
  assert.equal(x.t12PolicyCents, s.policyAttributedCents);
  assert.equal(x.t12PolicyCents, 12 * 10000 + 12 * 5000 + 12 * 7500);
  // Tie-out mismatch is reported.
  const off = clientPolicyExport({ clients, policies, carriers, entries: all, start: START, policyAttributedCents: s.policyAttributedCents + 1 });
  assert.ok(off.checks.some((c) => !c.pass));
  // A policy whose client is missing is flagged.
  const orphan = clientPolicyExport({ clients: clients.slice(1), policies, carriers, entries: all, start: START });
  assert.equal(orphan.orphanPolicies, 2);
  assert.ok(orphan.checks.some((c) => !c.pass && /client/.test(c.name)));
});

test('no reporting period: not for distribution', () => {
  const s = buildDiligenceSummary({ entries: [], start: null, carriers, policies });
  assert.equal(s.status, 'NO_PERIOD');
});
