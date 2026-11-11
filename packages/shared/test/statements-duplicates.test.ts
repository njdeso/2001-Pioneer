import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assessDuplicates, compareStatements, confirmationRefusal, contentCanonical, type DupLine, type DupStatement, type SeparateConfirmation } from '../src/statements/duplicates.ts';
import { postingReadiness, buildPostingPlan, planFingerprint, type PostingLine, type PostingStatement } from '../src/statements/posting.ts';

// Synthetic data only.
const L = (n: number, o: Partial<DupLine> = {}): DupLine => ({ policyNumberRaw: `PL-${1000 + n}`, insuredName: `Synthetic Insured ${n}`, paidCommissionCents: 1000 + n, paymentReceivedCents: 10000 + n, transactionType: 'renewal', effectiveDate: '2026-08-01', kind: 'commission', ...o });
const digest = (lines: DupLine[]) => createHash('sha256').update(contentCanonical(lines)).digest('hex');
const S = (id: string, lines: DupLine[], o: Partial<DupStatement> = {}): DupStatement => ({ id, status: 'needs_review', fileName: `${id}.pdf`, payerId: 'TRV', statementMonth: '2026-08', classification: null, agencyCode: '1234', officeCode: null, statementDate: '2026-08-31', title: '', statedTotalCents: null, postedCents: 0, lines, digest: digest(lines), ...o });

const personal = Array.from({ length: 20 }, (_, i) => L(i));
const commercial = Array.from({ length: 12 }, (_, i) => L(i, { policyNumberRaw: `CL-${5000 + i}`, insuredName: `Synthetic Company ${i} LLC`, paidCommissionCents: 9000 + i }));

test('Personal and Commercial Lines statements for the same carrier and month are SEPARATE, not duplicates', () => {
  const pl = S('PL', personal, { classification: 'personal', title: 'Personal Lines Commission Statement' });
  const cl = S('CL', commercial, { classification: 'commercial', title: 'Commercial Lines Commission Statement' });
  const [f] = assessDuplicates(cl, [pl]);
  assert.equal(f.relation, 'separate');
  assert.equal(f.hard, false);
  assert.equal(f.sharedLines, 0);
  assert.equal(f.confirmed, false, 'still needs one explicit owner confirmation');
  assert.ok(f.evidence.some((e) => /Different statement titles/.test(e)));
  assert.ok(f.evidence.some((e) => /does not prove/.test(e)), 'classification is shown, never trusted');
  assert.equal(confirmationRefusal(f, 'Commercial Lines statement for August', 'commercial'), null);
});

test('the same statement uploaded again under another file name is IDENTICAL, whatever its classification', () => {
  const original = S('A', personal, { classification: 'personal', fileName: 'Travelers Aug.pdf' });
  const copy = S('B', [...personal].reverse(), { classification: 'commercial', fileName: 'scan_0042.pdf' }); // order and label differ
  const [f] = assessDuplicates(copy, [original]);
  assert.equal(f.relation, 'identical');
  assert.equal(f.hard, true);
  assert.match(confirmationRefusal(f, 'I am sure these are different statements', 'commercial')!, /cannot be confirmed as separate/);
  // Even a stored confirmation (e.g. forged or from before) never makes an identical statement confirmed.
  const conf: SeparateConfirmation = { by: 'u', email: 'o@x', at: '', reason: 'x', digest: copy.digest, otherDigest: original.digest };
  assert.equal(assessDuplicates(copy, [original], { A: conf })[0].confirmed, false);
});

test('a re-issued copy with almost all lines the same is treated as the same statement', () => {
  const reissued = S('R', [...personal.slice(0, 18), L(90), L(91)]); // 18 of 20 lines shared = 90 %
  const [f] = assessDuplicates(reissued, [S('A', personal)]);
  assert.equal(f.relation, 'same_statement');
  assert.equal(f.hard, true);
});

test('a few lines in common: confirmable, but the overlap is shown', () => {
  const mixed = S('M', [...commercial, L(3), L(4)]);
  const [f] = assessDuplicates(mixed, [S('A', personal)]);
  assert.equal(f.relation, 'overlapping');
  assert.equal(f.hard, false);
  assert.equal(f.sharedLines, 2);
  assert.match(f.evidence[0], /2 of 14 line\(s\)/);
});

test('a confirmation applies only while BOTH statements still have the content that was confirmed', () => {
  const pl = S('PL', personal), cl = S('CL', commercial);
  const conf: SeparateConfirmation = { by: 'u', email: 'owner@example.test', at: '2026-11-10T00:00:00Z', reason: 'Commercial Lines statement', digest: cl.digest, otherDigest: pl.digest };
  assert.equal(assessDuplicates(cl, [pl], { PL: conf })[0].confirmed, true);
  const reExtracted = S('CL', [...commercial.slice(0, 11), L(77, { policyNumberRaw: 'CL-NEW' })]);
  assert.equal(assessDuplicates(reExtracted, [pl], { PL: conf })[0].confirmed, false, 'this statement changed');
  const plChanged = S('PL', personal.slice(1));
  assert.equal(assessDuplicates(cl, [plChanged], { PL: conf })[0].confirmed, false, 'the other statement changed');
});

test('only live same-payer same-month statements are compared; discarded ones and other months are ignored', () => {
  const cur = S('C', personal);
  const fs = assessDuplicates(cur, [S('D', personal, { status: 'discarded' }), S('F', personal, { status: 'extraction_failed' }), S('O', personal, { statementMonth: '2026-07' }), S('W', personal, { payerId: 'OTHER' }), S('P', personal, { status: 'posted', postedCents: 20190 })]);
  assert.deepEqual(fs.map((f) => f.otherId), ['P']);
  assert.ok(fs[0].evidence.some((e) => /already posted/.test(e)));
  assert.deepEqual(assessDuplicates(S('N', personal, { payerId: null }), [S('P', personal)]), [], 'no payer yet: nothing to compare (posting needs a payer anyway)');
});

test('confirmation is refused without classifications or a real reason', () => {
  const [f] = assessDuplicates(S('CL', commercial, { classification: 'commercial' }), [S('PL', personal)]);
  assert.match(confirmationRefusal(f, 'Commercial Lines for August', null)!, /Classify this statement/);
  assert.match(confirmationRefusal(f, 'Commercial Lines for August', 'commercial')!, /Classify the other statement/);
  const [g] = assessDuplicates(S('CL', commercial, { classification: 'commercial' }), [S('PL', personal, { classification: 'personal' })]);
  assert.match(confirmationRefusal(g, 'ok', 'commercial')!, /at least 10 characters/);
  assert.match(confirmationRefusal(undefined, 'Commercial Lines for August', 'commercial')!, /not a same-month statement/);
});

test('line identity ignores extraction noise (order, policy punctuation, name case) but not amounts', () => {
  const a = compareStatements(S('A', [L(1)]), S('B', [L(1, { policyNumberRaw: 'pl 1001', insuredName: 'SYNTHETIC  insured 1' })]));
  assert.equal(a.relation, 'identical');
  const b = compareStatements(S('A', [L(1)]), S('B', [L(1, { paidCommissionCents: 1002 })]));
  assert.equal(b.relation, 'separate');
});

// ---- posting gate with real findings ---------------------------------------------------------

const stmt: PostingStatement = { id: 'CL', status: 'needs_review', payerId: 'TRV', payerKind: 'carrier', statementMonth: '2026-08', statementDate: '2026-08-31', adjustments: [], postedCents: 0, postingSeq: 0, possibleDuplicateOf: 'PL', matching: { stale: false, balanced: true } };
const pLines: PostingLine[] = [{ id: '00001', lineNo: 1, insuredName: 'Synthetic Company 0 LLC', policyNumberRaw: 'CL-5000', paidCommissionCents: 9000, transactionType: 'renewal', effectiveDate: '2026-08-01', match: { status: 'unmatched', method: 'manual', reasons: [], score: 0, policyId: null, clientId: null, carrierId: null, brokerId: null, brokerShareBps: null, candidates: [] } as never }];

test('posting: a separate statement posts once confirmed; the same statement can never be posted twice', () => {
  const pl = S('PL', personal, { status: 'posted', postedCents: 20190 }), cl = S('CL', commercial);
  const unconfirmed = postingReadiness(stmt, pLines, { duplicates: assessDuplicates(cl, [pl]) });
  assert.ok(unconfirmed.blockers.some((b) => b.code === 'possible_duplicate'));
  const conf: SeparateConfirmation = { by: 'u', email: 'o@x', at: '', reason: 'Commercial Lines statement', digest: cl.digest, otherDigest: pl.digest };
  const ok = postingReadiness(stmt, pLines, { duplicates: assessDuplicates(cl, [pl], { PL: conf }) });
  assert.equal(ok.ready, true, JSON.stringify(ok.blockers));

  const copy = S('CL2', personal, { fileName: 'renamed copy.pdf' }); // the posted PL statement again
  const dup = postingReadiness({ ...stmt, id: 'CL2' }, pLines, { duplicates: assessDuplicates(copy, [pl]), legacyDuplicateAcknowledged: true });
  assert.ok(dup.blockers.some((b) => b.code === 'duplicate_statement' && /cannot be posted twice/.test(b.message)));
  assert.throws(() => buildPostingPlan({ ...stmt, id: 'CL2' }, pLines, { duplicates: assessDuplicates(copy, [pl]) }), /Not ready/);
});

test('the posting plan and its fingerprint do not depend on duplicate findings (existing approvals stay valid)', () => {
  const pl = S('PL', personal), cl = S('CL', commercial);
  const conf: SeparateConfirmation = { by: 'u', email: 'o@x', at: '', reason: 'Commercial Lines statement', digest: cl.digest, otherDigest: pl.digest };
  const a = planFingerprint(buildPostingPlan(stmt, pLines, { duplicates: assessDuplicates(cl, [pl], { PL: conf }) }));
  const b = planFingerprint(buildPostingPlan(stmt, pLines, { legacyDuplicateAcknowledged: true, duplicates: assessDuplicates(cl, [pl]) }));
  const c = planFingerprint(buildPostingPlan(stmt, pLines, { duplicates: [] }));
  assert.equal(a, b); assert.equal(b, c);
});
