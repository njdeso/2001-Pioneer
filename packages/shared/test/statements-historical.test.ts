import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPostingPlan, planFingerprint, postingReadiness, type PostingLine, type PostingStatement } from '../src/statements/posting.ts';
import { autoMatchLine, noMatch, prepareMatchContext, type HistoricalAttribution, type MatchPolicy } from '../src/statements/match.ts';
import { ledgerCsv, ledgerTotals, type ReportEntry } from '../src/reports/ledger.ts';
import { buildDiligenceSummary, clientPolicyExport, diligenceSummaryCsv, type DiligenceCarrier, type DiligencePolicy } from '../src/reports/diligence.ts';

// Historical commission: a line on a statement for a cancelled/expired policy that was never imported
// (e.g. a customer with other active policies whose cancelled Travelers policy still produced commission).
// Synthetic data only.
const brokers = [{ id: 'UNASSIGNED', shareBps: 0 }, { id: 'B50', shareBps: 5000 }];
const policies: MatchPolicy[] = [{ id: 'P-ACTIVE', clientId: 'C-PAT', policyNumber: 'HO-111', carrierId: 'TRV', wholesalerId: null, brokerId: 'B50', status: 'active' }];
const ctx = prepareMatchContext({ payerId: 'TRV', policies, clients: [{ id: 'C-PAT', name: 'Pat Example' }], brokers });
const mk = (id: string, n: number, pn: string, name: string, cents: number): PostingLine => {
  const l = { id, lineNo: n, policyNumberRaw: pn, insuredName: name, paidCommissionCents: cents, transactionType: 'continuation', effectiveDate: '2025-12-01' } as PostingLine;
  return { ...l, match: autoMatchLine(l, ctx) };
};
const stmt: PostingStatement = {
  id: 'S-DEC', status: 'needs_review', payerId: 'TRV', payerKind: 'carrier', statementMonth: '2025-12', statementDate: '2025-12-31',
  adjustments: [], postedCents: 0, postingSeq: 0, possibleDuplicateOf: null, matching: { stale: false, balanced: true },
};
const H: HistoricalAttribution = {
  clientId: 'C-PAT', insuredName: 'PAT EXAMPLE', policyNumber: 'AU-999 (cancelled)', carrierId: 'TRV', policyStatus: 'cancelled',
  attributedBrokerId: 'B50', buyoutEligible: false, note: 'Cancelled 2025-06; customer still has HO-111',
};
function lines(historical: boolean): PostingLine[] {
  const active = mk('1', 1, 'HO-111', 'PAT EXAMPLE', 20000);
  const past = mk('2', 2, 'AU-999', 'EXAMPLE PAT', 7500);
  const manual = noMatch(past, 'unmatched', 'manual', historical ? ['historical_policy'] : ['manually_unmatched'], [], 'AU999');
  return [active, { ...past, match: historical ? { ...manual, historical: H } : manual }];
}
const plan = (historical: boolean) => buildPostingPlan(stmt, lines(historical));
const asEntries = (p: ReturnType<typeof buildPostingPlan>) => p.entries.map((e) => ({ ...(e as unknown as ReportEntry), postingStatus: 'posted' as const }));
const carriers: DiligenceCarrier[] = [{ id: 'TRV', name: 'Travelers (synthetic)', kind: 'carrier', commissionMethod: 'statement', status: 'active' }];
const ddPolicies = [{ id: 'P-ACTIVE', clientId: 'C-PAT', carrierId: 'TRV', policyNumber: 'HO-111', status: 'active' }] as DiligencePolicy[];

test('a past-policy line posts to suspense exactly like any unmatched line: 100 % agency, no policy, client or carrier', () => {
  const e = plan(true).entries.find((x) => x.lineNo === 2)!;
  assert.equal(e.level, 'suspense');
  assert.equal(e.amountCents, 7500);
  assert.deepEqual([e.policyId, e.clientId, e.carrierId, e.brokerId, e.brokerShareBps, e.brokerCents, e.agencyCents], [null, null, null, 'UNASSIGNED', 0, 0, 7500]);
  assert.equal(e.historical?.clientId, 'C-PAT', 'linked to the existing customer for reference');
  assert.equal(e.historical?.attributedBrokerId, 'B50', 'broker attribution recorded for internal reporting');
  assert.equal(e.historical?.buyoutEligible, false, 'never broker-buyout eligible');
});

test('totals, the Dashboard calculation and every Pioneer export are byte-identical with or without the attribution', () => {
  const a = asEntries(plan(false)), b = asEntries(plan(true));
  assert.deepEqual(ledgerTotals(a), ledgerTotals(b));
  const dd = (entries: ReportEntry[]) => buildDiligenceSummary({ entries, start: '2025-01', months: 12, carriers, policies: ddPolicies, statements: [] });
  const sa = dd(a), sb = dd(b);
  assert.deepEqual(sa.total, sb.total);
  assert.equal(sb.total.unmatched, 7500);
  assert.equal(diligenceSummaryCsv(sa, { agencyName: 'X', preparedAtIso: 't' }), diligenceSummaryCsv(sb, { agencyName: 'X', preparedAtIso: 't' }));
  assert.equal(ledgerCsv(a, 'due_diligence'), ledgerCsv(b, 'due_diligence'));
  assert.equal(ledgerCsv(a, 'accounting'), ledgerCsv(b, 'accounting'));
  const cpa = clientPolicyExport({ clients: [{ id: 'C-PAT', name: 'Pat Example' }], policies: ddPolicies, carriers, entries: a, start: '2025-01' });
  const cpb = clientPolicyExport({ clients: [{ id: 'C-PAT', name: 'Pat Example' }], policies: ddPolicies, carriers, entries: b, start: '2025-01' });
  assert.equal(cpa.csv, cpb.csv, 'the past policy is not added to the client/policy list');
  assert.equal(cpb.policyRows, 1);
});

test('the attribution is part of the approval fingerprint (changing it after approval is detected); other plans are unchanged', () => {
  assert.notEqual(planFingerprint(plan(false)), planFingerprint(plan(true)));
  const changed = buildPostingPlan(stmt, lines(true).map((l) => (l.lineNo === 2 ? { ...l, match: { ...(l.match as object), historical: { ...H, attributedBrokerId: null } } as PostingLine['match'] } : l)));
  assert.notEqual(planFingerprint(changed), planFingerprint(plan(true)));
  // Fingerprint algorithm for plans without historical lines is exactly the previous one.
  const p = plan(false);
  const parts = p.entries.map((e) => [e.id, e.level, e.policyId ?? '', e.amountCents, e.brokerId, e.brokerShareBps, e.brokerCents, e.agencyCents, e.classification, e.statementPeriod].join('|'));
  let h = 0x811c9dc5; const text = `${p.postingId}#${parts.join('\n')}`;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  assert.equal(planFingerprint(p), `${p.entries.length}-${p.totals.amountCents}-${p.totals.brokerCents}-${h.toString(16).padStart(8, '0')}`);
});

test('readiness: a past-policy line counts as reviewed and is called out', () => {
  const r = postingReadiness(stmt, lines(true), { duplicateAcknowledged: false, otherPostedSameMonth: [] });
  assert.equal(r.ready, true, JSON.stringify(r.blockers));
  assert.ok(r.warnings.some((w) => w.code === 'historical' && w.lineNos.includes(2)));
  assert.ok(r.warnings.some((w) => w.code === 'suspense'));
});

test('broker attribution never moves commission to the broker in any total', () => {
  const t = ledgerTotals(asEntries(plan(true)));
  // Only the matched active line (B50, 50 %) has a broker share: 50 % of $200.00.
  assert.equal(t.brokerCents, 10000);
  assert.equal(t.agencyCents, 10000 + 7500);
});
