import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoMatchLine, nameEvidence, prepareMatchContext, type MatchPolicy } from '../src/statements/match.ts';
import { parsePersons, personEvidence } from '../src/statements/personName.ts';

// Regression: legitimate name variations found on real statements (Nov 2026) that produced
// "number and carrier match, but the name conflicts" instead of a match. Synthetic policy numbers.
const CASES: [printed: string, book: string][] = [
  ['AUGUSTINE WILLIAM A', 'WILLIAM & JOELLE AUGUSTINE'],
  ['BIONDI,D', 'DANA BIONDI'],
  ['DEMPSEY,D', 'DENNIS DEMPSEY'],
  ['DILORENZO,M', 'MICHAEL & JUNE DILORENZO'],
];

test('the four reported variations are the same person (partial support, never strong)', () => {
  for (const [printed, book] of CASES) {
    assert.equal(personEvidence(printed, book), 'compatible', `${printed} vs ${book}`);
    assert.equal(nameEvidence(printed, book), 'partial', `${printed} vs ${book}`);
  }
});

const brokers = [{ id: 'UNASSIGNED', shareBps: 0 }, { id: 'B50', shareBps: 5000 }];
const P = (id: string, clientId: string, num: string, carrierId = 'TRV'): MatchPolicy => ({ id, clientId, policyNumber: num, carrierId, wholesalerId: null, brokerId: 'B50', status: 'active' });
const line = (insuredName: string, policyNumberRaw: string, paid = 10000) => ({ id: '1', lineNo: 1, insuredName, policyNumberRaw, paidCommissionCents: paid, transactionType: 'continuation', effectiveDate: '2025-12-01' }) as Parameters<typeof autoMatchLine>[0];

test('regression: each case now auto-matches on number + carrier with medium confidence', () => {
  CASES.forEach(([printed, book], i) => {
    const num = `TST-90${i}`;
    const ctx = prepareMatchContext({ payerId: 'TRV', policies: [P(`P${i}`, `C${i}`, num)], clients: [{ id: `C${i}`, name: book }], brokers });
    const m = autoMatchLine(line(printed, num), ctx);
    assert.equal(m.status, 'matched', `${printed}: ${m.reasons.join(',')}`);
    assert.equal(m.confidence, 'medium');
    assert.ok(m.reasons.includes('number_and_carrier') && m.reasons.includes('name_partial'));
    assert.equal(m.policyId, `P${i}`);
  });
});

test('genuine identity conflicts stay ambiguous', () => {
  const conflicts: [string, string][] = [
    ['SMITH,J', 'MARY SMITH'],             // same surname, different initial
    ['SMITH JOHN A', 'MARY A SMITH'],      // overlapping words, different first name (was "partial" before)
    ['BIONDI,D', 'DANA SMITH'],            // different surname
    ['DEMPSEY,R', 'DENNIS & JOAN DEMPSEY'],// joint insured, initial matches nobody
  ];
  for (const [printed, book] of conflicts) {
    assert.equal(nameEvidence(printed, book), 'none', `${printed} vs ${book}`);
    const ctx = prepareMatchContext({ payerId: 'TRV', policies: [P('P1', 'C1', 'TST-1')], clients: [{ id: 'C1', name: book }], brokers });
    const m = autoMatchLine(line(printed, 'TST-1'), ctx);
    assert.equal(m.status, 'ambiguous', `${printed} vs ${book}`);
    assert.ok(m.reasons.includes('name_conflicts'));
  }
});

test('initials never choose between several policies with the same number (still ambiguous)', () => {
  const ctx = prepareMatchContext({
    payerId: 'TRV',
    policies: [P('P1', 'C1', 'TST-7'), P('P2', 'C2', 'TST-7')],
    clients: [{ id: 'C1', name: 'DANA BIONDI' }, { id: 'C2', name: 'DAVID BIONDI' }],
    brokers,
  });
  const m = autoMatchLine(line('BIONDI,D', 'TST-7'), ctx);
  assert.equal(m.status, 'ambiguous');
  assert.ok(m.reasons.includes('multiple_policies'));
});

test('strict number and carrier safeguards are unchanged: a name never matches without the number', () => {
  const ctx = prepareMatchContext({ payerId: 'TRV', policies: [P('P1', 'C1', 'TST-1')], clients: [{ id: 'C1', name: 'DANA BIONDI' }], brokers });
  assert.equal(autoMatchLine(line('BIONDI,D', 'OTHER-1'), ctx).status, 'unmatched');
  const otherCarrier = prepareMatchContext({ payerId: 'TRV', policies: [P('P1', 'C1', 'TST-1', 'OTHER')], clients: [{ id: 'C1', name: 'DANA BIONDI' }], brokers });
  assert.notEqual(autoMatchLine(line('BIONDI,D', 'TST-1'), otherCarrier).status, 'matched');
  // Name-only suggestions still require a strong name match: an initial is not enough.
  assert.equal(autoMatchLine(line('BIONDI,D', 'OTHER-1'), ctx).candidates.length, 0);
});

test('formats: comma, last-first with middle initial, joint insureds, punctuation and spacing', () => {
  assert.equal(personEvidence('BIONDI , DANA', 'Dana Biondi'), 'compatible');
  assert.equal(personEvidence('Biondi, D.', 'DANA M. BIONDI'), 'compatible');
  assert.equal(personEvidence('DILORENZO  M', 'Michael and June DiLorenzo'), 'compatible');
  assert.equal(personEvidence('DILORENZO,JUNE', 'Michael & June Dilorenzo'), 'compatible');
  assert.equal(personEvidence('OCONNOR,P', "Patrick O'Connor"), 'compatible');
  assert.equal(personEvidence('SMITH JR,JOHN', 'John Smith'), 'compatible', 'a suffix on one side only');
  assert.equal(personEvidence('SMITH JR,JOHN', 'John Smith Sr'), 'conflict', 'Jr and Sr are different people');
  assert.equal(personEvidence('VAN DYKE,P', 'Peter Van Dyke'), null, 'a multi-word surname before the comma is not guessed');
  assert.deepEqual(parsePersons('BIONDI,D', 'printed'), [[{ surname: 'biondi', given: ['d'] }]]);
});

test('business names are left to the existing word comparison', () => {
  assert.equal(personEvidence('ALPHA TRUCKING LLC', 'Alpha Trucking'), null);
  assert.equal(personEvidence('SMITH,J', 'Smith Plumbing Inc'), null);
  assert.equal(nameEvidence('ALPHA TRUCKING EXPRESS', 'Alpha Trucking LLC'), 'partial');
  assert.equal(nameEvidence('SMITH JOHN', 'John Smith'), 'strong');
});
