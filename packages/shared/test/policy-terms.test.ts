import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTerms, policyTermInput, resolveTerm, termEnd, type PolicyTerm } from '../src/terms.ts';
import { autoMatchLine, prepareMatchContext, withTerm, type MatchPolicy } from '../src/statements/match.ts';
import { buildPostingPlan, planFingerprint, type PostingLine, type PostingStatement } from '../src/statements/posting.ts';
import { ledgerTotals, type ReportEntry } from '../src/reports/ledger.ts';

// One policy number, two consecutive terms (the reported case, with synthetic names and numbers):
//   2025-07-02 → 2026-07-03  expired (renewed)
//   2026-07-03 → 2027-07-03  cancelled 2026-08-13
const T = (o: Partial<PolicyTerm> & Pick<PolicyTerm, 'effectiveDate' | 'scheduledExpirationDate' | 'status'>): PolicyTerm => ({
  id: o.effectiveDate, policyId: 'P-TRV', cancellationDate: null, note: '', ...o,
});
const term1 = T({ effectiveDate: '2025-07-02', scheduledExpirationDate: '2026-07-03', status: 'renewed' });
const term2 = T({ effectiveDate: '2026-07-03', scheduledExpirationDate: '2027-07-03', status: 'cancelled', cancellationDate: '2026-08-13' });
const terms = [term1, term2];

test('a single policy number holds consecutive terms; each with effective, scheduled expiration, cancellation and status', () => {
  assert.deepEqual(checkTerms(terms), []);
  assert.equal(termEnd(term1), '2026-07-03');
  assert.equal(termEnd(term2), '2026-08-13', 'coverage ends at the actual cancellation date');
  assert.ok(policyTermInput.safeParse({ ...term2 }).success);
  // "expired" (not renewed) is also accepted for the first term.
  assert.deepEqual(checkTerms([{ ...term1, status: 'expired' }, term2]), []);
});

test('term validation: cancellation needs a date inside the term; overlaps, two active terms and a non-latest active term are errors', () => {
  assert.equal(policyTermInput.safeParse({ ...term2, cancellationDate: null }).success, false);
  assert.equal(policyTermInput.safeParse({ ...term2, cancellationDate: '2027-08-01' }).success, false);
  assert.equal(policyTermInput.safeParse({ ...term1, cancellationDate: '2025-08-01' }).success, false, 'only cancelled terms have a cancellation date');
  assert.equal(policyTermInput.safeParse({ ...term1, scheduledExpirationDate: '2025-07-02' }).success, false);
  const overlap = checkTerms([term1, T({ effectiveDate: '2026-06-01', scheduledExpirationDate: '2027-06-01', status: 'active' })]);
  assert.ok(overlap.some((p) => p.code === 'overlap' && p.severity === 'error'));
  const twoActive = checkTerms([T({ effectiveDate: '2025-01-01', scheduledExpirationDate: '2026-01-01', status: 'active' }), T({ effectiveDate: '2026-01-01', scheduledExpirationDate: '2027-01-01', status: 'active' })]);
  assert.ok(twoActive.some((p) => p.code === 'multiple_active'));
  const activeFirst = checkTerms([T({ effectiveDate: '2025-01-01', scheduledExpirationDate: '2026-01-01', status: 'active' }), T({ effectiveDate: '2026-01-01', scheduledExpirationDate: '2027-01-01', status: 'pending' })]);
  assert.ok(activeFirst.some((p) => p.code === 'active_not_latest'));
  // A lapse between terms is allowed but reported; "renewed" with no following term is reported.
  assert.ok(checkTerms([term1, T({ effectiveDate: '2026-08-01', scheduledExpirationDate: '2027-08-01', status: 'active' })]).some((p) => p.code === 'gap' && p.severity === 'warning'));
  assert.ok(checkTerms([term1]).some((p) => p.code === 'renewed_without_next'));
});

test('statement lines are assigned to the term their dates support, and left undetermined otherwise', () => {
  assert.deepEqual(resolveTerm('2025-07-02', terms), { term: term1, resolution: 'exact' });           // new business / renewal line, term 1
  assert.deepEqual(resolveTerm('2026-07-03', terms), { term: term2, resolution: 'exact' });           // renewal line: term 2, not the end of term 1
  assert.deepEqual(resolveTerm('2025-11-15', terms), { term: term1, resolution: 'within' });          // endorsement in term 1
  assert.deepEqual(resolveTerm('2026-08-13', terms), { term: term2, resolution: 'within' });          // the cancellation line itself
  assert.equal(resolveTerm('2026-09-01', terms).resolution, 'not_determined');                         // after cancellation
  assert.equal(resolveTerm('2024-01-01', terms).resolution, 'not_determined');
  assert.equal(resolveTerm(null, terms).resolution, 'no_date');
  assert.equal(resolveTerm('2025-07-02', []).resolution, 'no_terms');
});

const brokers = [{ id: 'UNASSIGNED', shareBps: 0 }, { id: 'B50', shareBps: 5000 }];
const policies: MatchPolicy[] = [{ id: 'P-TRV', clientId: 'C-SYN', policyNumber: 'TRV-5555', carrierId: 'TRV', wholesalerId: null, brokerId: 'B50', status: 'cancelled' }];
const ctx = prepareMatchContext({ payerId: 'TRV', policies, clients: [{ id: 'C-SYN', name: 'Kay Synthetic' }], brokers });
const line = (id: string, n: number, effectiveDate: string, cents: number): PostingLine => {
  const l = { id, lineNo: n, policyNumberRaw: 'TRV-5555', insuredName: 'SYNTHETIC,K', paidCommissionCents: cents, transactionType: 'continuation', effectiveDate } as PostingLine;
  return { ...l, match: withTerm(autoMatchLine(l, ctx), effectiveDate, terms) };
};

test('matching to the policy is unchanged; the term is added only to matched lines', () => {
  const m = line('1', 1, '2026-07-03', 12000).match!;
  assert.equal(m.status, 'matched');
  assert.equal(m.policyId, 'P-TRV');
  assert.deepEqual(m.term, { termId: '2026-07-03', effectiveDate: '2026-07-03', endDate: '2026-08-13', status: 'cancelled' });
  assert.equal(m.termResolution, 'exact');
  assert.ok(m.reasons.includes('policy_not_active'), 'the existing safeguard warning for non-active policies is kept');
  const unmatched = withTerm(autoMatchLine({ ...line('9', 9, '2026-07-03', 100), policyNumberRaw: 'NOPE-1' }, ctx), '2026-07-03', terms);
  assert.equal(unmatched.status, 'unmatched');
  assert.equal(unmatched.term, null);
});

test('posted entries carry their term; amounts and splits are exactly as before', () => {
  const stmt: PostingStatement = { id: 'S1', status: 'needs_review', payerId: 'TRV', payerKind: 'carrier', statementMonth: '2026-08', statementDate: '2026-08-31', adjustments: [], postedCents: 0, postingSeq: 0, possibleDuplicateOf: null, matching: { stale: false, balanced: true } };
  const withTerms = [line('1', 1, '2026-07-03', 12000), line('2', 2, '2026-08-13', -9000), line('3', 3, '2026-09-01', 500)];
  const plan = buildPostingPlan(stmt, withTerms);
  assert.deepEqual(plan.entries.map((e) => e.termId ?? null), ['2026-07-03', '2026-07-03', null]);
  const noTerms = buildPostingPlan(stmt, withTerms.map((l) => ({ ...l, match: { ...l.match!, term: null } })));
  const strip = (p: ReturnType<typeof buildPostingPlan>) => p.entries.map(({ termId: _t, ...e }) => e);
  assert.deepEqual(strip(plan), strip(noTerms), 'everything except the term ID is identical');
  const tot = (p: ReturnType<typeof buildPostingPlan>) => ledgerTotals(p.entries.map((e) => ({ ...(e as unknown as ReportEntry), postingStatus: 'posted' as const })));
  assert.deepEqual(tot(plan), tot(noTerms));
  assert.notEqual(planFingerprint(plan), planFingerprint(noTerms), 'a term change after approval is detected');
});

/** Firestore refuses undefined anywhere in a document (regression: runStatementMatching failed with
 *  "Cannot use undefined as a Firestore value (found in field match.termResolution)"). */
function undefinedPaths(v: unknown, path = ''): string[] {
  if (v === undefined) return [path || '(root)'];
  if (v === null || typeof v !== 'object') return [];
  return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => undefinedPaths(x, path ? `${path}.${k}` : k));
}

test('regression: match results written to Firestore never contain undefined (matched, ambiguous, unmatched, no terms)', () => {
  const cases = [
    withTerm(autoMatchLine(line('1', 1, '2026-07-03', 100), ctx), '2026-07-03', terms),                    // matched, term found
    withTerm(autoMatchLine(line('2', 2, '2026-09-01', 100), ctx), '2026-09-01', terms),                    // matched, not determined
    withTerm(autoMatchLine(line('3', 3, '2026-07-03', 100), ctx), '2026-07-03', []),                       // matched, no terms
    withTerm(autoMatchLine({ ...line('4', 4, '2026-07-03', 100), policyNumberRaw: 'NOPE-1' }, ctx), '2026-07-03', terms), // unmatched
    withTerm(autoMatchLine({ ...line('5', 5, '2026-07-03', 100), insuredName: 'OTHER,Z' }, ctx), null, terms),           // ambiguous (name conflict)
  ];
  for (const m of cases) assert.deepEqual(undefinedPaths(m), [], `${m.status}: ${undefinedPaths(m).join(', ')}`);
  assert.equal(cases[3].status, 'unmatched');
  assert.ok(!('termResolution' in cases[3]));
  assert.equal(cases[4].status, 'ambiguous');
});
