import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchBook, policyNumberMatches } from '../src/bookSearch.ts';

// Synthetic data only.
const clients = [{ id: 'c1', name: 'Karen Testcase' }, { id: 'c2', name: 'Alder Synthetic LLC' }];
const policies = [
  { id: 'p1', clientId: 'c1', policyNumber: '6X-123 456', alternateNumbers: ['OLD-777'] },
  { id: 'p2', clientId: 'c2', policyNumber: 'BA1234567' },
];

test('search by customer name or policy number (current or alternate), ignoring punctuation and case', () => {
  const run = (q: string) => { const s = searchBook(clients, policies, q); return clients.filter(s.matchesClient).map((c) => c.id); };
  assert.deepEqual(run('karen'), ['c1']);
  assert.deepEqual(run('6x123456'), ['c1']);
  assert.deepEqual(run('6X-123 456'), ['c1']);
  assert.deepEqual(run('x-12 3'), ['c1']);
  assert.deepEqual(run('12345'), ['c1', 'c2'], 'a fragment found in both numbers matches both');
  assert.deepEqual(run('old777'), ['c1'], 'alternate number');
  assert.deepEqual(run('ba12'), ['c2']);
  assert.deepEqual(run(''), ['c1', 'c2']);
  assert.deepEqual(run('zzz'), []);
  assert.deepEqual(searchBook(clients, policies, '6x123').policiesFor('c1').map((p) => p.id), ['p1']);
});

test('policy-number matching needs at least 3 characters so short queries do not match everything', () => {
  assert.equal(policyNumberMatches(policies[0], '6x'), false);
  assert.equal(policyNumberMatches(policies[0], '6x1'), true);
  assert.equal(policyNumberMatches(policies[0], '--'), false);
});
