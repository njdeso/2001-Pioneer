import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatWindow, formatMonth } from '../src/period.ts';
import { totalInWindow } from '../src/aggregate.ts';
import { settingsInput } from '../src/schemas.ts';
import { buildPostingPlan, type PostingLine, type PostingStatement } from '../src/statements/posting.ts';
import { autoMatchLine, prepareMatchContext, type MatchPolicy } from '../src/statements/match.ts';
import { filterLedger, ledgerTotals, windowRange, type ReportEntry } from '../src/reports/ledger.ts';
import { buildDiligenceSummary, type DiligenceCarrier, type DiligencePolicy } from '../src/reports/diligence.ts';

// Regression (dev, build cff83dd): Settings showed Nov 2025 – Oct 2026 while the due-diligence CSV used
// Jan 2025 – Dec 2025, so a posted October 2026 statement showed $0. The form was showing an UNSAVED edit
// (the save failed); every report uses the SAVED settings. These tests pin down that one saved setting
// gives the same period everywhere, and that an October 2026 posting lands in Nov 2025 – Oct 2026.

const saved = settingsInput.parse({ agencyName: 'Central Insurance Agency', snapshotStartMonth: '2025-11', snapshotMonths: 12, defaultBrokerShareBps: 5000 });

/** A posted October 2026 statement of $410.00, produced by the real matching and posting engines. */
function octoberPosting(): ReportEntry[] {
  const brokers = [{ id: 'UNASSIGNED', shareBps: 0 }, { id: 'B50', shareBps: 5000 }];
  const policies: MatchPolicy[] = [
    { id: 'P1', clientId: 'C1', policyNumber: 'A-1', carrierId: 'MUT', wholesalerId: null, brokerId: 'B50', status: 'active' },
    { id: 'P2', clientId: 'C2', policyNumber: 'B-2', carrierId: 'MUT', wholesalerId: null, brokerId: 'B50', status: 'active' },
  ];
  const ctx = prepareMatchContext({ payerId: 'MUT', policies, clients: [{ id: 'C1', name: 'Alpha' }, { id: 'C2', name: 'Beta' }], brokers });
  const mk = (id: string, n: number, pn: string, name: string, cents: number): PostingLine => {
    const l = { id, lineNo: n, policyNumberRaw: pn, insuredName: name, paidCommissionCents: cents, transactionType: 'new_business', effectiveDate: '2026-10-01' } as PostingLine;
    return { ...l, match: autoMatchLine(l, ctx) };
  };
  const stmt: PostingStatement = {
    id: 'SYN-OCT', status: 'needs_review', payerId: 'MUT', payerKind: 'carrier', statementMonth: '2026-10', statementDate: '2026-10-31',
    adjustments: [], postedCents: 0, postingSeq: 0, possibleDuplicateOf: null, matching: { stale: false, balanced: true },
  };
  const plan = buildPostingPlan(stmt, [mk('1', 1, 'A-1', 'ALPHA', 30000), mk('2', 2, 'B-2', 'BETA', 11000)]);
  assert.equal(plan.totals.amountCents, 41000);
  return plan.entries.map((e) => e as unknown as ReportEntry);
}
const carriers: DiligenceCarrier[] = [{ id: 'MUT', name: 'Synthetic Mutual Insurance Co (TEST)', kind: 'carrier', commissionMethod: 'statement', status: 'active' }];
const policies = [{ id: 'P1', clientId: 'C1', carrierId: 'MUT', policyNumber: 'A-1', status: 'active' }, { id: 'P2', clientId: 'C2', carrierId: 'MUT', policyNumber: 'B-2', status: 'active' }] as DiligencePolicy[];

test('one saved setting gives the same period in Settings, the Dashboard, the Ledger and the due-diligence summary', () => {
  const label = formatWindow(saved.snapshotStartMonth, saved.snapshotMonths);            // Settings page and Dashboard subtitle
  const range = windowRange(saved.snapshotStartMonth, saved.snapshotMonths);             // Dashboard totals and Ledger default range
  const dd = buildDiligenceSummary({ entries: [], start: saved.snapshotStartMonth, months: saved.snapshotMonths, carriers, policies });
  assert.equal(label, 'Nov 2025 – Oct 2026');
  assert.deepEqual(range, { from: '2025-11', to: '2026-10' });
  assert.deepEqual([dd.from, dd.to], [range.from, range.to]);
  assert.equal(`${formatMonth(dd.from)} – ${formatMonth(dd.to)}`, label);
  assert.equal(dd.months.length, 12);
});

test('regression: a posted October 2026 statement appears in the Nov 2025 – Oct 2026 commission summary at $410.00', () => {
  const entries = octoberPosting();
  const dd = buildDiligenceSummary({ entries, start: saved.snapshotStartMonth, months: saved.snapshotMonths, carriers, policies, statements: [{ id: 'SYN-OCT', status: 'posted', statementMonth: '2026-10', payerId: 'MUT' }] });
  assert.equal(dd.total.total, 41000);
  assert.equal(dd.byMonth.find((m) => m.month === '2026-10')!.totals.total, 41000);
  assert.equal(dd.byMonth.find((m) => m.month === '2026-10')!.hasPostedStatement, true);
  assert.ok(dd.checks.every((c) => c.pass), JSON.stringify(dd.checks.filter((c) => !c.pass)));
  assert.equal(dd.status, 'INCOMPLETE', 'one posted month of twelve is still not a complete history');
  // Dashboard and Ledger give the same figure for the same saved period.
  const range = windowRange(saved.snapshotStartMonth, saved.snapshotMonths);
  assert.equal(totalInWindow(entries, saved.snapshotStartMonth, saved.snapshotMonths), 41000);
  assert.equal(ledgerTotals(filterLedger(entries, range)).grossCents, 41000);
});

test('the same posting is outside Jan 2025 – Dec 2025 (the period that was actually saved) and shows $0 there', () => {
  const dd = buildDiligenceSummary({ entries: octoberPosting(), start: '2025-01', months: 12, carriers, policies });
  assert.equal(dd.total.total, 0);
  assert.equal(`${formatMonth(dd.from)} – ${formatMonth(dd.to)}`, 'Jan 2025 – Dec 2025');
});

test('settings persistence payload: what the Settings form sends is exactly what saveSettings validates and stores', () => {
  const form = { agencyName: 'Central Insurance Agency', snapshotStartMonth: '2025-11', snapshotMonths: 12, revenueBasis: 'statementPeriod', defaultBrokerShareBps: 5000, aiEnabled: true, aiModel: 'claude-sonnet-5-5', aiMonthlyCallLimit: 200 };
  const parsed = settingsInput.parse(form);
  assert.equal(parsed.snapshotStartMonth, '2025-11');
  assert.equal(parsed.snapshotMonths, 12);
  assert.throws(() => settingsInput.parse({ ...form, snapshotStartMonth: '2025-13' }));
  assert.throws(() => settingsInput.parse({ ...form, snapshotMonths: 0 }));
});
