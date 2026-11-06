import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePolicyNumber, policyKey, normalizeName, nameVariants, searchTokens,
} from '../src/normalize.ts';

test('policy numbers normalize across formatting differences', () => {
  assert.equal(normalizePolicyNumber('ab-123 456/01'), 'AB12345601');
  assert.equal(normalizePolicyNumber(' CA.000123 '), 'CA000123');
  assert.equal(normalizePolicyNumber('ca000123'), normalizePolicyNumber('CA-000123'));
});

test('the same policy number at two carriers produces two different keys', () => {
  // Synthetic carriers
  const a = policyKey('carrierA', 'P-100200');
  const b = policyKey('carrierB', 'P100200');
  assert.notEqual(a, b);
  assert.equal(a, 'carrierA__P100200');
  assert.equal(policyKey('carrierA', 'p 100200'), a);
  assert.throws(() => policyKey('', '123'));
  assert.throws(() => policyKey('x', '--'));
});

test('names normalize punctuation and legal suffixes', () => {
  assert.equal(normalizeName('The Smith Trucking, L.L.C.'), 'smith trucking');
  assert.equal(normalizeName('SMITH TRUCKING LLC'), 'smith trucking');
  assert.equal(normalizeName('A & B Cab Corp.'), 'a and b cab');
  assert.equal(normalizeName('Inc'), 'inc');
});

test('similar but different client names stay distinct', () => {
  // Synthetic: multiple clients with similar names
  assert.notEqual(normalizeName('John Smith'), normalizeName('John Smith Jr'));
  assert.notEqual(normalizeName('Smith Trucking'), normalizeName('Smith Towing'));
});

test('DBA names produce both variants', () => {
  const v = nameVariants('ABC Holdings LLC DBA Quick Cab');
  assert.ok(v.includes('abc holdings'));
  assert.ok(v.includes('quick cab'));
});

test('search tokens are prefixes', () => {
  const t = searchTokens('Quick Cab LLC', 'QC-55012');
  for (const tok of ['qu', 'quick', 'ca', 'cab', 'qc', 'qc550']) assert.ok(t.includes(tok), tok);
  assert.ok(!t.includes('q'));
  assert.ok(!t.includes('llc'));
});
