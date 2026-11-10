import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPostingPlan, retainedEntry, reversalOf, type PostingLine, type PostingStatement } from '../src/statements/posting.ts';
import { autoMatchLine, prepareMatchContext, type MatchPolicy } from '../src/statements/match.ts';
import { totalInWindow } from '../src/aggregate.ts';
import {
  auditLedger, centsToDecimal, csvCell, filterLedger, groupPostings, ledgerCsv, ledgerTotals, postingsCsv, windowRange,
  LEDGER_CSV_ACCOUNTING_HEADERS, type AuditStatement, type ReportEntry,
} from '../src/reports/ledger.ts';

// Synthetic data only. The fixture is produced by the real posting engine, then posted, reversed and
// re-posted exactly as functions/src/callables/posting.ts does it.
const brokers = [{ id: 'UNASSIGNED', shareBps: 0 }, { id: 'B50', shareBps: 5000 }, { id: 'B40', shareBps: 4000 }];
const clients = [{ id: 'C1', name: 'Alpha Trucking LLC' }, { id: 'C2', name: 'Beta Cab Corp' }, { id: 'C3', name: 'Zeta Logistics' }];
const P = (p: Partial<MatchPolicy> & Pick<MatchPolicy, 'id' | 'clientId' | 'policyNumber'>): MatchPolicy => ({ carrierId: 'MUT', wholesalerId: null, brokerId: 'B50', status: 'active', ...p });
const policies = [
  P({ id: 'P1', clientId: 'C1', policyNumber: 'A-1' }),
  P({ id: 'P2', clientId: 'C2', policyNumber: 'B-2', brokerId: 'B40' }),
  P({ id: 'P3', clientId: 'C3', policyNumber: 'Z-3', brokerShareBps: 3000 }),
];
const ctx = prepareMatchContext({ payerId: 'MUT', policies, clients, brokers });
const line = (id: string, lineNo: number, policyNumberRaw: string, insuredName: string, paid: number, transactionType: PostingLine['transactionType'] = 'new_business'): PostingLine => {
  const l = { id, lineNo, policyNumberRaw, insuredName, paidCommissionCents: paid, transactionType, effectiveDate: '2026-10-01' } as PostingLine;
  return { ...l, match: autoMatchLine(l, ctx) };
};
const lines = () => [
  line('00001', 1, 'A-1', 'ALPHA TRUCKING', 12345),                 // B50 50 % (odd cent)
  line('00002', 2, 'B-2', 'BETA CAB', 10000, 'continuation'),       // B40 40 %
  line('00003', 3, 'Z-3', 'ZETA LOGISTICS', -4500, 'cancellation'), // policy 30 %, chargeback
];
const stmt = (id: string, seq = 0): PostingStatement => ({
  id, status: 'approved', payerId: 'MUT', payerKind: 'carrier', statementMonth: '2026-10', statementDate: '2026-10-31',
  adjustments: [{ label: 'Shared cost', amountCents: -500 }], postedCents: 0, postingSeq: seq, possibleDuplicateOf: null,
  matching: { stale: false, balanced: true },
});

type Ledger = Map<string, ReportEntry>;
function post(ledger: Ledger, s: PostingStatement, at: string): string {
  const plan = buildPostingPlan({ ...s, status: 'needs_review' }, lines());
  for (const e of plan.entries) {
    assert.ok(!ledger.has(e.id), 'ledger entry IDs are never reused');
    ledger.set(e.id, { ...(e as unknown as ReportEntry), postedAtIso: at, postedByEmail: 'admin@example.test' });
  }
  return plan.postingId;
}
function reverse(ledger: Ledger, postingId: string, reason: string, at: string): void {
  for (const o of [...ledger.values()].filter((e) => e.postingId === postingId && !e.reversalOf && e.postingStatus === 'posted')) {
    const rev = reversalOf(o as unknown as Parameters<typeof reversalOf>[0], reason);
    ledger.set(rev.id, { ...(rev as unknown as ReportEntry), postedAtIso: at, reversalReason: reason });
    ledger.set(o.id, { ...o, postingStatus: 'reversed', reversalId: rev.id });
  }
}

/** Mirrors the dev history: p1 reversed, p2 reversed, p3 reversed (the manual test), plus another statement still posted. */
function history() {
  const ledger: Ledger = new Map();
  const p1 = post(ledger, stmt('S1', 0), '2026-11-10T03:10:55Z'); reverse(ledger, p1, 'smoke test: reversal', '2026-11-10T03:10:59Z');
  const p2 = post(ledger, stmt('S1', 1), '2026-11-10T03:11:00Z'); reverse(ledger, p2, 'smoke test: cleanup', '2026-11-10T03:11:01Z');
  const p3 = post(ledger, stmt('S1', 2), '2026-11-10T03:20:00Z'); reverse(ledger, p3, 'manual test', '2026-11-10T03:21:00Z');
  const k1 = post(ledger, stmt('S2', 0), '2026-11-10T03:30:00Z');
  const statements: AuditStatement[] = [
    { id: 'S1', status: 'needs_review', postedCents: 0, posting: null, reversals: [p1, p2, p3].map((p) => ({ postingId: p, amountCents: -17345, entries: 4 })) },
    { id: 'S2', status: 'posted', postedCents: 17345, posting: { postingId: k1 }, reversals: [] },
  ];
  return { ledger, entries: [...ledger.values()], statements, p1, p2, p3, k1 };
}

// ---- totals --------------------------------------------------------------------------------

test('every reversed posting nets to zero in gross, broker and agency; only the active posting remains', () => {
  const { entries, p1, p2, p3, k1 } = history();
  const groups = groupPostings(entries);
  assert.equal(groups.length, 4);
  for (const id of [p1, p2, p3]) {
    const g = groups.find((x) => x.postingId === id)!;
    assert.equal(g.state, 'reversed');
    assert.equal(g.original.grossCents, 17345); // 123.45 + 100.00 − 45.00 − 5.00 adjustment
    assert.deepEqual([g.net.grossCents, g.net.brokerCents, g.net.agencyCents], [0, 0, 0]);
    assert.equal(g.reversal.brokerCents, -g.original.brokerCents);
    assert.equal(g.reversal.agencyCents, -g.original.agencyCents);
  }
  const active = groups.find((x) => x.postingId === k1)!;
  assert.equal(active.state, 'active');
  // Broker: 50 % of 123.45 = 61.72 (half-even), 40 % of 100 = 40.00, 30 % of −45.00 = −13.50; adjustment agency only.
  assert.deepEqual([active.original.grossCents, active.original.brokerCents, active.original.agencyCents], [17345, 8822, 8523]);
  const t = ledgerTotals(entries);
  assert.deepEqual([t.grossCents, t.brokerCents, t.agencyCents], [17345, 8822, 8523]);
  assert.equal(t.entries, 4 * 3 * 2 + 4);
});

test('Dashboard and Ledger report use the same calculation: window totals equal the aggregate total', () => {
  const { entries } = history();
  const win = windowRange('2025-11', 12);
  assert.deepEqual(win, { from: '2025-11', to: '2026-10' });
  const inWin = filterLedger(entries, { from: win.from, to: win.to });
  assert.equal(ledgerTotals(inWin).grossCents, totalInWindow(entries, '2025-11', 12));
  const outside = filterLedger(entries, { from: '2026-11', to: '2027-10' });
  assert.equal(outside.length, 0);
});

test('legacy entries without a stored allocation use the broker fallback, grouped per broker', () => {
  const legacy: ReportEntry[] = [
    { id: 'L1', amountCents: 1001, statementPeriod: '2026-01', postingStatus: 'posted', policyId: 'P1' },
    { id: 'L2', amountCents: 1001, statementPeriod: '2026-01', postingStatus: 'posted', policyId: 'P1' },
    { id: 'L3', amountCents: 500, statementPeriod: '2026-01', postingStatus: 'posted', policyId: null },
  ];
  const t = ledgerTotals(legacy, (e) => (e.policyId === 'P1' ? { brokerId: 'B50', shareBps: 5000 } : null));
  assert.deepEqual([t.grossCents, t.brokerCents, t.agencyCents, t.legacyEntries], [2502, 1001, 1501, 3]);
});

// ---- filters -------------------------------------------------------------------------------

test('posting-state filter keeps originals and reversals together, so filtered nets stay exact', () => {
  const { entries, k1 } = history();
  const reversed = filterLedger(entries, { postingState: 'reversed' });
  assert.equal(reversed.length, 3 * 8);
  const t = ledgerTotals(reversed);
  assert.deepEqual([t.grossCents, t.brokerCents, t.agencyCents], [0, 0, 0]);
  const active = filterLedger(entries, { postingState: 'active' });
  assert.ok(active.every((e) => e.postingId === k1));
  assert.equal(ledgerTotals(active).grossCents, 17345);
});

test('filters: carrier/wholesaler, broker, statement, source type and search', () => {
  const { entries, p3 } = history();
  assert.equal(filterLedger(entries, { companyId: 'NOPE' }).length, 0);
  assert.equal(filterLedger(entries, { companyId: 'MUT' }).length, entries.length);
  const b40 = filterLedger(entries, { brokerId: 'B40' });
  assert.ok(b40.length > 0 && b40.every((e) => e.brokerId === 'B40'));
  assert.equal(filterLedger(entries, { statementId: 'S2' }).length, 4);
  assert.equal(filterLedger(entries, { sourceType: 'retained' }).length, 0);
  const s = filterLedger(entries, { search: `${p3}`.toUpperCase() });
  assert.equal(s.length, 8);
  assert.equal(ledgerTotals(s).grossCents, 0);
  assert.equal(filterLedger(entries, { search: 'zeta' }).length, 4 + 3); // 4 originals, 3 reversed
});

// ---- CSV -----------------------------------------------------------------------------------

test('csvCell quotes delimiters and neutralises spreadsheet formulas in text, not in amounts', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('-45.00', 'number'), '-45.00');
  assert.equal(csvCell(null), '');
  assert.equal(centsToDecimal(-4500), '-45.00');
  assert.equal(centsToDecimal(5), '0.05');
  assert.equal(centsToDecimal(-1), '-0.01');
  assert.equal(centsToDecimal(1234567), '12345.67');
});

const parse = (csv: string) => csv.replace(/^﻿/, '').trimEnd().split('\r\n').map((l) => l.split(','));

test('accounting CSV: every entry, original then reversal, amounts tie to the ledger total', () => {
  const { entries, p3 } = history();
  const csv = ledgerCsv(entries, 'accounting', { companyName: (id) => (id === 'MUT' ? 'Mutual (synthetic)' : id ?? ''), brokerName: (id) => `Broker ${id}` });
  assert.ok(csv.startsWith('﻿'));
  const [head, ...rows] = parse(csv);
  assert.deepEqual(head, [...LEDGER_CSV_ACCOUNTING_HEADERS]);
  assert.equal(rows.length, entries.length);
  const col = (name: string) => head.indexOf(name);
  const sum = (name: string, rs = rows) => rs.reduce((s, r) => s + Math.round(Number(r[col(name)] || 0) * 100), 0);
  assert.equal(sum('amount'), 17345);
  assert.equal(sum('broker_amount'), 8822);
  assert.equal(sum('agency_amount'), 8523);
  const p3rows = rows.filter((r) => r[col('posting_id')] === p3);
  assert.equal(p3rows.length, 8);
  assert.ok(p3rows.every((r) => r[col('posting_state')] === 'reversed'));
  assert.equal(sum('amount', p3rows), 0);
  assert.equal(sum('broker_amount', p3rows), 0);
  // Each original is followed by its reversal.
  const types = p3rows.map((r) => r[col('entry_type')]);
  assert.deepEqual(types, ['original', 'reversal', 'original', 'reversal', 'original', 'reversal', 'original', 'reversal']);
  assert.equal(p3rows[1][col('reversal_of')], p3rows[0][col('entry_id')]);
  assert.ok(rows.some((r) => r[col('broker')] === 'Broker B50'));
});

test('due-diligence CSV has no broker, allocation, staff or note columns, but keeps amounts and lineage', () => {
  const { entries } = history();
  const [head, ...rows] = parse(ledgerCsv(entries, 'due_diligence'));
  for (const h of ['broker', 'broker_share_pct', 'broker_share_source', 'broker_amount', 'agency_amount', 'posted_by', 'reversal_reason', 'note']) {
    assert.ok(!head.includes(h), `${h} must not be in the due-diligence export`);
  }
  for (const h of ['entry_id', 'posting_id', 'statement_id', 'entry_type', 'reversal_of', 'posting_state', 'statement_period', 'payer', 'policy_number', 'insured', 'amount']) {
    assert.ok(head.includes(h), `${h} must be in the due-diligence export`);
  }
  assert.equal(rows.length, entries.length);
  assert.ok(!ledgerCsv(entries, 'due_diligence').includes('admin@example.test'));
});

test('postings CSV: one row per posting with original, reversal and net', () => {
  const { entries } = history();
  const [head, ...rows] = parse(postingsCsv(groupPostings(entries), 'accounting'));
  assert.equal(rows.length, 4);
  const c = (n: string) => head.indexOf(n);
  const reversed = rows.filter((r) => r[c('state')] === 'reversed');
  assert.equal(reversed.length, 3);
  assert.ok(reversed.every((r) => r[c('net_amount')] === '0.00' && r[c('net_broker')] === '0.00' && r[c('net_agency')] === '0.00' && r[c('reversal_amount')] === '-173.45'));
  const [ddHead] = parse(postingsCsv(groupPostings(entries), 'due_diligence'));
  assert.ok(!ddHead.some((h) => /broker|agency|_by$|reason/.test(h)));
});

// ---- audit ---------------------------------------------------------------------------------

test('audit passes on a correct history and reports the reversed postings and window totals', () => {
  const { entries, statements } = history();
  const r = auditLedger({ entries, statements, window: windowRange('2025-11', 12) });
  assert.equal(r.ok, true, JSON.stringify(r.findings, null, 2));
  assert.equal(r.errors, 0);
  assert.equal(r.counts.reversedPostings, 3);
  assert.equal(r.counts.activePostings, 1);
  assert.deepEqual([r.window!.totals.grossCents, r.window!.totals.brokerCents, r.window!.totals.agencyCents], [17345, 8822, 8523]);
});

test('audit passes for a retained commission and its reversal', () => {
  const policy = policies[2];
  const e = retainedEntry({ requestId: 'r1', policy, payerId: 'MUT', brokers: new Map(brokers.map((b) => [b.id, b])), amountCents: 10000, statementPeriod: '2026-10', transactionDate: '2026-10-05', classification: 'new_business' as never, note: 'retained' });
  const rev = reversalOf(e as unknown as Parameters<typeof reversalOf>[0], 'oops');
  const entries: ReportEntry[] = [{ ...(e as unknown as ReportEntry), postingStatus: 'reversed', reversalId: rev.id }, rev as unknown as ReportEntry];
  const r = auditLedger({ entries });
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  assert.deepEqual([r.totals.grossCents, r.totals.brokerCents, r.totals.agencyCents], [0, 0, 0]);
  assert.equal(groupPostings(entries)[0].original.brokerCents, 3000);
});

function corrupt(mutate: (l: Ledger, h: ReturnType<typeof history>) => void, statementsMutate?: (s: AuditStatement[]) => void) {
  const h = history();
  mutate(h.ledger, h);
  statementsMutate?.(h.statements);
  return auditLedger({ entries: [...h.ledger.values()], statements: h.statements }).findings.filter((f) => f.severity === 'error').map((f) => f.code);
}
const firstOf = (l: Ledger, postingId: string, reversal: boolean) => [...l.values()].find((e) => e.postingId === postingId && !!e.reversalOf === reversal)!;

test('audit catches a reversal that does not exactly negate the broker or agency share', () => {
  const codes = corrupt((l, h) => { const r = firstOf(l, h.p3, true); l.set(r.id, { ...r, brokerCents: r.brokerCents! + 1, agencyCents: r.agencyCents! - 1 }); });
  assert.ok(codes.includes('reversal_amount_mismatch'));
  assert.ok(codes.includes('reversed_posting_not_zero'));
});

test('audit catches a missing, duplicated or orphaned reversal entry', () => {
  assert.ok(corrupt((l, h) => { l.delete(firstOf(l, h.p3, true).id); }).includes('reversed_without_reversal_entry'));
  assert.ok(corrupt((l, h) => { l.delete(firstOf(l, h.p3, true).id); }).includes('partial_reversal'));
  assert.ok(corrupt((l, h) => { const r = firstOf(l, h.p3, true); l.set(`${r.id}2`, { ...r, id: `${r.id}2` }); }).includes('multiple_reversals'));
  assert.ok(corrupt((l, h) => { const o = firstOf(l, h.p3, false); l.delete(o.id); }).includes('reversal_without_original'));
  assert.ok(corrupt((l, h) => { const o = firstOf(l, h.p3, false); l.set(o.id, { ...o, postingStatus: 'posted' }); }).includes('original_not_marked_reversed'));
});

test('audit catches allocation splits that do not add up and non-cent amounts', () => {
  assert.ok(corrupt((l, h) => { const e = firstOf(l, h.k1, false); l.set(e.id, { ...e, agencyCents: e.agencyCents! + 1 }); }).includes('split_mismatch'));
  assert.ok(corrupt((l, h) => { const e = firstOf(l, h.k1, false); l.set(e.id, { ...e, amountCents: 10.5 }); }).includes('amount_not_integer_cents'));
});

test('audit catches statement status that disagrees with the ledger', () => {
  assert.ok(corrupt(() => {}, (s) => { s[1].postedCents = 1; }).includes('posted_amount_mismatch'));
  assert.ok(corrupt(() => {}, (s) => { s[1].status = 'needs_review'; }).includes('unposted_statement_has_active_entries'));
  assert.ok(corrupt(() => {}, (s) => { s[0].status = 'posted'; }).includes('posted_statement_posting_count'));
  assert.ok(corrupt(() => {}, (s) => { s[0].reversals = s[0].reversals!.slice(0, 2); }).includes('reversal_not_recorded_on_statement'));
  assert.ok(corrupt(() => {}, (s) => { s[0].reversals![2].amountCents = -1; }).includes('reversal_record_mismatch'));
  assert.ok(corrupt(() => {}, (s) => { s.splice(1, 1); }).includes('unknown_statement'));
});
