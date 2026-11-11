import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPostingPlan, ledgerEntryId, planFingerprint, postingReadiness, retainedEntry, reversalOf, storedBrokerShare, TRANSACTION_CLASSIFICATION,
  type PostingLine, type PostingStatement,
} from '../src/statements/posting.ts';
import { autoMatchLine, noMatch, matchToPolicy, prepareMatchContext, type MatchPolicy } from '../src/statements/match.ts';
import { totalInWindow, monthlyTotals, totalsBy } from '../src/aggregate.ts';

// Synthetic data only.
const brokers = [{ id: 'UNASSIGNED', shareBps: 0 }, { id: 'B50', shareBps: 5000 }, { id: 'B40', shareBps: 4000 }];
const clients = [{ id: 'C1', name: 'Alpha Trucking LLC' }, { id: 'C2', name: 'Beta Cab Corp' }, { id: 'C3', name: 'Zeta Logistics' }];
const P = (p: Partial<MatchPolicy> & Pick<MatchPolicy, 'id' | 'clientId' | 'policyNumber'>): MatchPolicy => ({ carrierId: 'MUT', wholesalerId: null, brokerId: 'B50', status: 'active', ...p });
const policies = [
  P({ id: 'P1', clientId: 'C1', policyNumber: 'A-1' }),
  P({ id: 'P2', clientId: 'C2', policyNumber: 'B-2', brokerId: 'B40' }),
  P({ id: 'P3', clientId: 'C3', policyNumber: 'Z-3', brokerShareBps: 3000 }),
];
const ctx = prepareMatchContext({ payerId: 'MUT', policies, clients, brokers });

const line = (id: string, lineNo: number, policyNumberRaw: string, insuredName: string, paid: number | null, transactionType: PostingLine['transactionType'] = 'new_business'): PostingLine => {
  const l = { id, lineNo, policyNumberRaw, insuredName, paidCommissionCents: paid, transactionType, effectiveDate: '2026-10-01' } as PostingLine;
  return { ...l, match: autoMatchLine(l, ctx) };
};
const stmt = (over: Partial<PostingStatement> = {}): PostingStatement => ({
  id: 'S1', status: 'needs_review', payerId: 'MUT', payerKind: 'carrier', statementMonth: '2026-10', statementDate: '2026-10-31',
  adjustments: [{ label: 'Shared cost', amountCents: -500 }], postedCents: 0, postingSeq: 0, possibleDuplicateOf: null,
  matching: { stale: false, balanced: true }, ...over,
});
const ready = () => [
  line('00001', 1, 'A-1', 'ALPHA TRUCKING', 12345),        // B50 50 %
  line('00002', 2, 'B-2', 'BETA CAB', 10000, 'continuation'), // B40 40 %
  line('00003', 3, 'Z-3', 'ZETA LOGISTICS', -4500, 'cancellation'), // policy 30 %, chargeback
  line('00004', 4, 'A-1', 'ALPHA TRUCKING', null, 'installment_payment'), // payment only: not posted
];

// ---- readiness -----------------------------------------------------------------------------

test('a reconciled, fully matched statement is ready', () => {
  const r = postingReadiness(stmt(), ready());
  assert.equal(r.ready, true, JSON.stringify(r.blockers));
});

test('blockers: discrepancy, no payer, no month, matching missing/stale/unbalanced, already posted', () => {
  const codes = (s: PostingStatement, l = ready()) => postingReadiness(s, l).blockers.map((b) => b.code);
  assert.ok(codes(stmt({ status: 'discrepancy' })).includes('not_reconciled'));
  assert.ok(codes(stmt({ payerId: null })).includes('no_payer'));
  assert.ok(codes(stmt({ statementMonth: null })).includes('no_month'));
  assert.ok(codes(stmt({ matching: null })).includes('matching_not_run'));
  assert.ok(codes(stmt({ matching: { stale: true, balanced: true } })).includes('matching_stale'));
  assert.ok(codes(stmt({ matching: { stale: false, balanced: false } })).includes('matching_unbalanced'));
  assert.ok(codes(stmt({ postedCents: 100 })).includes('already_posted'));
  assert.ok(codes(stmt({ status: 'posted' })).includes('already_posted'));
  assert.ok(codes(stmt({ status: 'processing' })).includes('wrong_status'));
});

test('ambiguous, never-matched and unreviewed unmatched commission lines block; manual unmatched goes to suspense', () => {
  const l = ready();
  l.push(line('00005', 5, 'B-2', 'SOMEONE ELSE', 700));              // ambiguous (name conflicts)
  l.push(line('00006', 6, 'NOPE', 'NOBODY', 300));                   // unmatched, automatic
  l.push({ ...line('00007', 7, 'Q-9', 'X', 200), match: { status: 'not_started' } });
  const r = postingReadiness(stmt(), l);
  const by = Object.fromEntries(r.blockers.map((b) => [b.code, b.lineNos]));
  assert.deepEqual(by.lines_ambiguous, [5]);
  assert.deepEqual(by.lines_unmatched_unreviewed, [6]);
  assert.deepEqual(by.lines_not_matched_yet, [7]);
  // Resolve: 5 matched manually, 6 marked unmatched by a person, 7 matched.
  l[4] = { ...l[4], match: matchToPolicy(l[4], ctx.policyById.get('P2')!, ctx, 'manual') };
  l[5] = { ...l[5], match: noMatch(l[5], 'unmatched', 'manual', ['manually_unmatched'], [], 'NOPE') };
  l[6] = { ...l[6], match: matchToPolicy(l[6], ctx.policyById.get('P1')!, ctx, 'manual') };
  const r2 = postingReadiness(stmt(), l);
  assert.equal(r2.ready, true, JSON.stringify(r2.blockers));
  assert.deepEqual(r2.warnings.find((w) => w.code === 'suspense')?.lineNos, [6]);
});

test('same-month statements: unconfirmed blocks, confirmed passes, an identical statement always blocks', () => {
  const f = (o: Record<string, unknown>) => ({ otherId: 'S0', other: { fileName: 'other.pdf', status: 'posted', classification: null, agencyCode: null, officeCode: null, statementDate: null, title: '', statedTotalCents: null, postedCents: 0, lineCount: 3 }, relation: 'separate', hard: false, sharedLines: 0, thisLines: 3, otherLines: 3, evidence: [], confirmation: null, confirmed: false, ...o }) as never;
  assert.ok(postingReadiness(stmt(), ready(), { duplicates: [f({})] }).blockers.some((b) => b.code === 'possible_duplicate'));
  assert.equal(postingReadiness(stmt(), ready(), { duplicates: [f({ confirmed: true })] }).ready, true);
  assert.equal(postingReadiness(stmt(), ready(), { duplicates: [f({})], legacyDuplicateAcknowledged: true }).ready, true, 'pre-existing approval acknowledgement still honoured');
  const hard = postingReadiness(stmt(), ready(), { duplicates: [f({ relation: 'identical', hard: true, sharedLines: 3 })], legacyDuplicateAcknowledged: true });
  assert.ok(hard.blockers.some((b) => b.code === 'duplicate_statement'), 'nothing unlocks an identical statement');
  // possibleDuplicateOf on old records no longer blocks by itself; the server's content check decides.
  assert.equal(postingReadiness(stmt({ possibleDuplicateOf: 'S0' }), ready(), { duplicates: [] }).ready, true);
});

// ---- plan ----------------------------------------------------------------------------------

test('posting plan: entries, allocations, chargeback, adjustment; totals tie to commission + adjustments', () => {
  const plan = buildPostingPlan(stmt(), ready());
  assert.equal(plan.seq, 1);
  assert.equal(plan.postingId, 'S1__p1');
  assert.equal(plan.entries.length, 4); // 3 commission lines + 1 adjustment; payment-only line not posted
  const [e1, e2, e3, adj] = plan.entries;
  assert.deepEqual([e1.id, e1.level, e1.policyId, e1.brokerId, e1.brokerShareBps, e1.brokerCents, e1.agencyCents], [ledgerEntryId('S1', 1, '00001'), 'policy', 'P1', 'B50', 5000, 6172, 6173]);
  assert.deepEqual([e2.brokerShareBps, e2.brokerCents, e2.agencyCents, e2.classification], [4000, 4000, 6000, 'renewal']);
  assert.deepEqual([e3.brokerShareBps, e3.brokerShareSource, e3.brokerCents, e3.agencyCents, e3.classification], [3000, 'policy', -1350, -3150, 'cancellation']);
  assert.deepEqual([adj.level, adj.policyId, adj.amountCents, adj.brokerCents, adj.agencyCents, adj.carrierId], ['carrier', null, -500, 0, -500, 'MUT']);
  assert.equal(plan.totals.commissionCents, 12345 + 10000 - 4500);
  assert.equal(plan.totals.amountCents, 12345 + 10000 - 4500 - 500);
  assert.equal(plan.totals.brokerCents + plan.totals.agencyCents, plan.totals.amountCents);
  assert.equal(plan.balanced, true);
  for (const e of plan.entries) {
    assert.equal(e.statementPeriod, '2026-10');
    assert.equal(e.postingStatus, 'posted');
    assert.ok(Number.isInteger(e.amountCents) && Number.isInteger(e.brokerCents));
  }
});

test('suspense entries: no policy, 100 % agency', () => {
  const l = ready();
  const u = line('00009', 9, 'NOPE', 'NOBODY', 999);
  l.push({ ...u, match: noMatch(u, 'unmatched', 'manual', ['manually_unmatched'], [], 'NOPE') });
  const plan = buildPostingPlan(stmt(), l);
  const s = plan.entries.find((e) => e.lineId === '00009')!;
  assert.deepEqual([s.level, s.policyId, s.brokerCents, s.agencyCents], ['suspense', null, 0, 999]);
  assert.equal(plan.totals.suspenseCents, 999);
  assert.equal(plan.balanced, true);
});

test('a plan cannot be built for a statement that is not ready', () => {
  assert.throws(() => buildPostingPlan(stmt({ status: 'discrepancy' }), ready()), /Not ready to post/);
});

test('entry IDs are deterministic and unique; the next posting uses new IDs', () => {
  const a = buildPostingPlan(stmt(), ready());
  const b = buildPostingPlan(stmt(), ready());
  assert.deepEqual(a.entries.map((e) => e.id), b.entries.map((e) => e.id));
  assert.equal(new Set(a.entries.map((e) => e.id)).size, a.entries.length);
  const next = buildPostingPlan(stmt({ postingSeq: 1 }), ready());
  assert.equal(next.seq, 2);
  assert.ok(next.entries.every((e) => e.id.startsWith('S1__p2__')));
});

test('fingerprint changes when anything that would be posted changes', () => {
  const base = planFingerprint(buildPostingPlan(stmt(), ready()));
  assert.equal(planFingerprint(buildPostingPlan(stmt(), ready())), base);
  const l = ready();
  l[1] = { ...l[1], match: matchToPolicy(l[1], ctx.policyById.get('P1')!, ctx, 'manual') }; // different policy/broker
  assert.notEqual(planFingerprint(buildPostingPlan(stmt(), l)), base);
  assert.notEqual(planFingerprint(buildPostingPlan(stmt({ adjustments: [] }), ready())), base);
  assert.notEqual(planFingerprint(buildPostingPlan(stmt({ statementMonth: '2026-09' }), ready())), base);
});

test('classification mapping covers every transaction type', () => {
  for (const t of ['installment_payment', 'new_business', 'continuation', 'endorsement', 'cancellation', 'reinstatement', 'reversal', 'other'] as const) {
    assert.ok(TRANSACTION_CLASSIFICATION[t], t);
  }
});

// ---- reversal ------------------------------------------------------------------------------

test('reversal: exact negative twins, deterministic IDs; nets to zero in every report', () => {
  const plan = buildPostingPlan(stmt(), ready());
  const revs = plan.entries.map((e) => reversalOf(e, 'posted to wrong month'));
  for (const [e, r] of plan.entries.map((e, i) => [e, revs[i]] as const)) {
    assert.equal(r.id, `${e.id}__rev`);
    assert.equal(r.reversalOf, e.id);
    assert.deepEqual([r.amountCents, r.brokerCents, r.agencyCents], [-e.amountCents, -e.brokerCents, -e.agencyCents]);
    assert.equal(r.statementPeriod, e.statementPeriod);
    assert.match(r.note, /posted to wrong month/);
  }
  const ledger = [...plan.entries.map((e) => ({ ...e, postingStatus: 'reversed' as const })), ...revs];
  assert.equal(totalInWindow(ledger, '2026-01', 12), 0);
  assert.equal(storedBrokerShare(ledger), 0);
  for (const v of totalsBy(ledger, (e) => e.policyId, '2026-01', 12).values()) assert.equal(v, 0);
});

// ---- reports -------------------------------------------------------------------------------

test('posted entries flow into the rolling-12-month reports by statement period', () => {
  const plan = buildPostingPlan(stmt(), ready());
  assert.equal(totalInWindow(plan.entries, '2025-11', 12), plan.totals.amountCents); // Nov 2025 … Oct 2026
  assert.equal(totalInWindow(plan.entries, '2025-10', 12), 0);                     // Oct 2025 … Sep 2026
  assert.equal(monthlyTotals(plan.entries, '2025-11', 12).get('2026-10'), plan.totals.amountCents);
  assert.equal(storedBrokerShare(plan.entries), 6172 + 4000 - 1350);
  assert.equal(totalsBy(plan.entries, (e) => e.payerId, '2025-11', 12).get('MUT'), plan.totals.amountCents);
});

test('storedBrokerShare uses stored allocations and falls back only for entries without one', () => {
  assert.equal(storedBrokerShare([{ amountCents: 1000, brokerCents: 300 }, { amountCents: 1000 }], (e) => e.amountCents / 2), 300 + 500);
});

// ---- retained ------------------------------------------------------------------------------

test('retained commission: policy-level entry with the applicable broker share', () => {
  const brokerMap = new Map(brokers.map((b) => [b.id, b]));
  const r = retainedEntry({ requestId: 'req-1', policy: policies[2], payerId: 'MUT', brokers: brokerMap, amountCents: 10001, statementPeriod: '2026-10', transactionDate: '2026-10-05', classification: 'new_business', note: 'Bind document 123' });
  assert.equal(r.id, 'retained__req-1');
  assert.deepEqual([r.sourceType, r.level, r.policyId, r.brokerShareBps, r.brokerShareSource, r.brokerCents, r.agencyCents], ['retained', 'policy', 'P3', 3000, 'policy', 3000, 7001]);
  const neg = retainedEntry({ requestId: 'req-2', policy: policies[0], payerId: 'MUT', brokers: brokerMap, amountCents: -2001, statementPeriod: '2026-10', transactionDate: null, classification: 'return_commission', note: 'Return' });
  assert.equal(neg.brokerCents + neg.agencyCents, -2001);
  assert.ok(neg.brokerCents <= 0 && neg.agencyCents <= 0);
});
