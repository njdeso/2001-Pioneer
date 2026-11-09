import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoMatchLine, commissionSplit, matchToPolicy, nameEvidence, noMatch, policyNumberKey, prepareMatchContext, summarizeMatches,
  type MatchContext, type MatchPolicy,
} from '../src/statements/match.ts';

// Synthetic book: fictional names and numbers only.
const brokers = [{ id: 'UNASSIGNED', name: 'Unassigned', shareBps: 0 }, { id: 'B1', name: 'Broker One', shareBps: 5000 }, { id: 'B2', name: 'Broker Two', shareBps: 4000 }];
const clients = [
  { id: 'C1', name: 'Alpha Trucking LLC' },
  { id: 'C2', name: 'John Smith' },
  { id: 'C3', name: 'Beta Cab Corp' },
  { id: 'C4', name: 'Gamma Holdings DBA Quick Cab' },
];
const P = (p: Partial<MatchPolicy> & Pick<MatchPolicy, 'id' | 'clientId' | 'carrierId' | 'policyNumber'>): MatchPolicy => ({ wholesalerId: null, brokerId: 'B1', status: 'active', ...p });
const policies: MatchPolicy[] = [
  P({ id: 'P1', clientId: 'C1', carrierId: 'TRAV', policyNumber: 'AB-123 456' }),
  P({ id: 'P2', clientId: 'C2', carrierId: 'TRAV', policyNumber: '617738486', brokerId: 'B2' }),
  P({ id: 'P3', clientId: 'C3', carrierId: 'MAYA', policyNumber: 'AB123456' }),            // same number, other carrier
  P({ id: 'P4', clientId: 'C4', carrierId: 'CLEARBLUE', wholesalerId: 'JJ', policyNumber: 'CB-777' }), // via wholesaler J&J
  P({ id: 'P5', clientId: 'C1', carrierId: 'TRAV', policyNumber: '0045678', brokerId: 'UNASSIGNED' }),
  P({ id: 'P6', clientId: 'C3', carrierId: 'TRAV', policyNumber: 'ZZ-1', alternateNumbers: ['ZZ-1-OLD'] }),
];
const ctx = (payerId: string | null, extra: Partial<MatchContext> = {}) => prepareMatchContext({ payerId, policies, clients, brokers, ...extra });
const L = (policyNumberRaw: string, insuredName: string, paid: number | null = 10000) => ({ policyNumberRaw, insuredName, paidCommissionCents: paid });

// ---- policy numbers -------------------------------------------------------------------------

test('policy numbers: spaces, dashes, slashes and case are ignored', () => {
  assert.equal(policyNumberKey('ab-123 456').key, 'AB123456');
  assert.equal(policyNumberKey(' AB/123-456 ').key, 'AB123456');
  assert.equal(policyNumberKey('').problem, 'missing');
  assert.equal(policyNumberKey('--').problem, 'missing');
});

test('Excel scientific notation is expanded only when every digit is present', () => {
  assert.deepEqual(policyNumberKey('6.17738486E+08'), { key: '617738486', problem: null, expanded: true });
  assert.deepEqual(policyNumberKey('6.17738486e+8'), { key: '617738486', problem: null, expanded: true });
  // Digits missing: never padded with zeros, never guessed.
  assert.deepEqual(policyNumberKey('6.17738E+08'), { key: null, problem: 'scientific_notation_truncated', expanded: false });
  assert.deepEqual(policyNumberKey('6E+08'), { key: null, problem: 'scientific_notation_truncated', expanded: false });
  // More than Excel's 15 significant digits: the last digits are unreliable.
  assert.equal(policyNumberKey('1.2345678901234567E+16').problem, 'scientific_notation_truncated');
  // Fraction longer than the exponent would be a decimal, not a policy number.
  assert.equal(policyNumberKey('6.177384861E+08').problem, 'scientific_notation_truncated');
  // Real alphanumeric numbers that merely contain an E are left alone.
  assert.equal(policyNumberKey('12E3').key, '12E3');
  assert.equal(policyNumberKey('AB1E+5').key, 'AB1E5');
});

test('Excel float artefacts like "617738486.0" lose only the ".0"', () => {
  assert.equal(policyNumberKey('617738486.0').key, '617738486');
  assert.equal(policyNumberKey('617738486.5').key, '6177384865'); // not an artefact: kept as printed characters
});

// ---- names ----------------------------------------------------------------------------------

test('names are evidence: order, punctuation, legal suffixes and DBA do not matter', () => {
  assert.equal(nameEvidence('SMITH JOHN', 'John Smith'), 'strong');
  assert.equal(nameEvidence('ALPHA TRUCKING', 'Alpha Trucking LLC'), 'strong');
  assert.equal(nameEvidence('QUICK CAB', 'Gamma Holdings DBA Quick Cab'), 'strong');
  assert.equal(nameEvidence('ALPHA TRUCKING EXPRESS', 'Alpha Trucking LLC'), 'partial');
  assert.equal(nameEvidence('DELTA LIMO', 'Alpha Trucking LLC'), 'none');
  assert.equal(nameEvidence('', 'Alpha Trucking LLC'), 'unknown');
});

// ---- automatic matching ---------------------------------------------------------------------

test('number + carrier + name → matched, high confidence, broker split in cents', () => {
  const m = autoMatchLine(L('AB 123-456', 'ALPHA TRUCKING', 12345), ctx('TRAV'));
  assert.equal(m.status, 'matched');
  assert.equal(m.method, 'auto');
  assert.equal(m.confidence, 'high');
  assert.equal(m.policyId, 'P1');
  assert.equal(m.clientId, 'C1');
  assert.equal(m.brokerId, 'B1');
  assert.equal(m.brokerShareBps, 5000);
  assert.equal(m.brokerCents + m.agencyCents, 12345);
  assert.deepEqual([m.brokerCents, m.agencyCents], [6172, 6173]); // half-even on 6172.5
  assert.ok(m.reasons.includes('number_and_carrier') && m.reasons.includes('name_supports'));
});

test('the same number at another carrier is never matched to the wrong carrier', () => {
  const trav = autoMatchLine(L('AB123456', 'ALPHA TRUCKING'), ctx('TRAV'));
  assert.equal(trav.policyId, 'P1');
  const maya = autoMatchLine(L('AB123456', 'BETA CAB'), ctx('MAYA'));
  assert.equal(maya.policyId, 'P3');
  const other = autoMatchLine(L('AB123456', 'ALPHA TRUCKING'), ctx('INTEGON'));
  assert.equal(other.status, 'ambiguous');
  assert.equal(other.policyId, null);
  assert.ok(other.reasons.includes('number_at_other_carrier'));
  assert.equal(other.candidates.length, 2);
  assert.ok(other.candidates.every((c) => !c.samePayer));
});

test('a wholesaler statement matches policies placed through that wholesaler', () => {
  const m = autoMatchLine(L('CB 777', 'QUICK CAB'), ctx('JJ'));
  assert.equal(m.status, 'matched');
  assert.equal(m.policyId, 'P4');
  assert.equal(m.carrierId, 'CLEARBLUE');
});

test('the name alone never creates a match; a conflicting name blocks an automatic match', () => {
  const nameOnly = autoMatchLine(L('NOPE-999', 'ALPHA TRUCKING'), ctx('TRAV'));
  assert.equal(nameOnly.status, 'unmatched');
  assert.ok(nameOnly.reasons.includes('no_policy_found'));
  assert.ok(nameOnly.candidates.some((c) => c.policyId === 'P1' && c.numberEvidence === 'none')); // suggestion only
  const conflict = autoMatchLine(L('AB123456', 'DELTA LIMO'), ctx('TRAV'));
  assert.equal(conflict.status, 'ambiguous');
  assert.ok(conflict.reasons.includes('name_conflicts'));
  assert.equal(conflict.candidates[0].policyId, 'P1');
});

test('no insured name printed: number + carrier still match, medium confidence', () => {
  const m = autoMatchLine(L('AB123456', ''), ctx('TRAV'));
  assert.equal(m.status, 'matched');
  assert.equal(m.confidence, 'medium');
  assert.ok(m.reasons.includes('name_not_printed'));
});

test('scientific notation: exact expansion matches; truncated numbers are left for manual matching', () => {
  const ok = autoMatchLine(L('6.17738486E+08', 'SMITH JOHN'), ctx('TRAV'));
  assert.equal(ok.status, 'matched');
  assert.equal(ok.policyId, 'P2');
  assert.ok(ok.reasons.includes('scientific_notation_expanded'));
  const cut = autoMatchLine(L('6.17738E+08', 'SMITH JOHN'), ctx('TRAV'));
  assert.equal(cut.status, 'unmatched');
  assert.equal(cut.policyNumberKey, null);
  assert.ok(cut.reasons.includes('scientific_notation_truncated'));
  assert.ok(cut.candidates.every((c) => c.numberEvidence === 'none')); // name suggestions only, no digit guessing
});

test('leading zeros lost by Excel: matched only with a strong name, otherwise ambiguous', () => {
  const strong = autoMatchLine(L('45678', 'ALPHA TRUCKING'), ctx('TRAV'));
  assert.equal(strong.status, 'matched');
  assert.equal(strong.policyId, 'P5');
  assert.equal(strong.confidence, 'medium');
  assert.ok(strong.reasons.includes('leading_zeros_only'));
  const weak = autoMatchLine(L('45678', 'SOMEONE ELSE'), ctx('TRAV'));
  assert.equal(weak.status, 'ambiguous');
  assert.equal(weak.candidates[0].policyId, 'P5');
});

test('alternate policy numbers match', () => {
  const m = autoMatchLine(L('ZZ1OLD', 'BETA CAB'), ctx('TRAV'));
  assert.equal(m.status, 'matched');
  assert.equal(m.policyId, 'P6');
});

test('two policies of the same payer share a number: ambiguous unless exactly one name agrees', () => {
  const dup = [...policies, P({ id: 'P7', clientId: 'C2', carrierId: 'CLEARBLUE', wholesalerId: 'JJ', policyNumber: 'CB777' })];
  const c = ctx('JJ', { policies: dup });
  const byName = autoMatchLine(L('CB-777', 'SMITH JOHN'), c);
  assert.equal(byName.status, 'matched');
  assert.equal(byName.policyId, 'P7');
  assert.ok(byName.reasons.includes('multiple_policies'));
  const neither = autoMatchLine(L('CB-777', 'DELTA LIMO'), c);
  assert.equal(neither.status, 'ambiguous');
  assert.ok(neither.reasons.includes('multiple_policies'));
  assert.equal(neither.candidates.length, 2);
});

test('without the statement payer nothing is matched automatically', () => {
  const m = autoMatchLine(L('AB123456', 'ALPHA TRUCKING'), ctx(null));
  assert.equal(m.status, 'ambiguous');
  assert.ok(m.reasons.includes('payer_not_set'));
});

test('missing policy number → unmatched with a clear reason', () => {
  const m = autoMatchLine(L('', 'ALPHA TRUCKING'), ctx('TRAV'));
  assert.equal(m.status, 'unmatched');
  assert.ok(m.reasons.includes('no_policy_number'));
});

// ---- commissions ----------------------------------------------------------------------------

test('negative commissions and chargebacks split the same way; parts always sum exactly', () => {
  for (const cents of [-12345, -1, -50, 0, 1, 99999, -99999]) {
    for (const bps of [0, 4000, 5000, 3333, 10000]) {
      const { brokerCents, agencyCents } = commissionSplit(cents, bps);
      assert.equal(brokerCents + agencyCents, cents, `${cents} @ ${bps}`);
      assert.ok(Number.isInteger(brokerCents) && Number.isInteger(agencyCents));
      if (cents < 0) assert.ok(brokerCents <= 0 && agencyCents <= 0, 'a chargeback reduces both shares');
    }
  }
  assert.deepEqual(commissionSplit(-12345, 5000), { brokerCents: -6172, agencyCents: -6173 });
});

test('unassigned broker: the agency keeps the whole commission', () => {
  const m = autoMatchLine(L('0045678', 'ALPHA TRUCKING', 5000), ctx('TRAV'));
  assert.equal(m.brokerId, 'UNASSIGNED');
  assert.deepEqual([m.brokerCents, m.agencyCents], [0, 5000]);
});

test('payment-only lines (no paid commission) match with zero split', () => {
  const m = autoMatchLine(L('AB123456', 'ALPHA TRUCKING', null), ctx('TRAV'));
  assert.equal(m.status, 'matched');
  assert.deepEqual([m.commissionCents, m.brokerCents, m.agencyCents], [0, 0, 0]);
});

test('manual match to another carrier is allowed but flagged; manual unmatch is kept as manual', () => {
  const c = ctx('TRAV');
  const m = matchToPolicy(L('ZZ9', 'BETA CAB'), c.policyById.get('P3')!, c, 'manual');
  assert.equal(m.method, 'manual');
  assert.ok(m.reasons.includes('manual') && m.reasons.includes('carrier_differs'));
  const u = noMatch(L('ZZ9', 'BETA CAB'), 'unmatched', 'manual', ['manually_unmatched'], [], 'ZZ9');
  assert.equal(u.method, 'manual');
  assert.equal(u.brokerCents + u.agencyCents, 0);
});

test('statement summary: totals, progress and per-broker figures balance to the cent', () => {
  const c = ctx('TRAV');
  const raw = [
    L('AB123456', 'ALPHA TRUCKING', 12345),
    L('617738486', 'SMITH JOHN', -2500),        // chargeback, broker B2 at 40%
    L('AB123456', 'DELTA LIMO', 700),           // ambiguous (name conflict)
    L('NOPE', 'UNKNOWN', 333),                  // unmatched
    L('ZZ-1', 'BETA CAB', null),                // payment-only, matched
  ];
  const lines = raw.map((l) => ({ ...l, match: autoMatchLine(l, c) }));
  const s = summarizeMatches(lines, [{ label: 'Shared cost', amountCents: -1500 }]);
  assert.equal(s.lineCount, 5);
  assert.equal(s.commissionLineCount, 4);
  assert.deepEqual([s.matched, s.ambiguous, s.unmatched], [3, 1, 1]);
  assert.equal(s.matchedCommissionLines, 2);
  assert.equal(s.commissionCents, 12345 - 2500 + 700 + 333);
  assert.equal(s.matchedCommissionCents, 12345 - 2500);
  assert.equal(s.ambiguousCommissionCents, 700);
  assert.equal(s.unmatchedCommissionCents, 333);
  assert.equal(s.brokerCents, 6172 + -1000);
  assert.equal(s.agencyCents, 6173 + -1500);
  assert.equal(s.adjustmentsCents, -1500);
  assert.equal(s.balanced, true);
  const b2 = s.byBroker.find((b) => b.brokerId === 'B2')!;
  assert.deepEqual([b2.commissionCents, b2.brokerCents, b2.agencyCents], [-2500, -1000, -1500]);
});

test('the engine never changes the extracted line it is given', () => {
  const line = Object.freeze({ policyNumberRaw: '6.17738486E+08', insuredName: 'SMITH JOHN', paidCommissionCents: 100 });
  const before = JSON.stringify(line);
  autoMatchLine(line, ctx('TRAV'));
  assert.equal(JSON.stringify(line), before);
});

test('applicable broker share: the policy’s own share overrides the broker standard; Unassigned is always 0 %', () => {
  const withOverride = [...policies, P({ id: 'P8', clientId: 'C2', carrierId: 'TRAV', policyNumber: 'OV-1', brokerId: 'B1', brokerShareBps: 3000 })];
  const c = ctx('TRAV', { policies: withOverride });
  const o = autoMatchLine(L('OV-1', 'JOHN SMITH', 10001), c);
  assert.equal(o.brokerShareBps, 3000);
  assert.equal(o.brokerShareSource, 'policy');
  assert.deepEqual([o.brokerCents, o.agencyCents], [3000, 7001]);
  const std = autoMatchLine(L('AB123456', 'ALPHA TRUCKING', 10001), c);
  assert.equal(std.brokerShareSource, 'broker');
  assert.equal(std.brokerShareBps, 5000);
  const un = autoMatchLine(L('0045678', 'ALPHA TRUCKING', 10001), c);
  assert.equal(un.brokerShareSource, 'unassigned');
  assert.equal(un.brokerShareBps, 0);
  // An override on an Unassigned policy is ignored: nobody to pay.
  const odd = prepareMatchContext({ payerId: 'TRAV', clients, brokers, policies: [P({ id: 'P9', clientId: 'C1', carrierId: 'TRAV', policyNumber: 'UN-1', brokerId: 'UNASSIGNED', brokerShareBps: 5000 })] });
  assert.equal(autoMatchLine(L('UN-1', 'ALPHA TRUCKING', 100), odd).brokerCents, 0);
});
