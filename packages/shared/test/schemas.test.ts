import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carrierInput, brokerInput, clientInput, policyInput, settingsInput, fieldErrors } from '../src/schemas.ts';

test('carrier input normalizes code and defaults', () => {
  const c = carrierInput.parse({ name: ' Synthetic Mutual ', code: 'syn-1', kind: 'carrier' });
  assert.equal(c.name, 'Synthetic Mutual');
  assert.equal(c.code, 'SYN-1');
  assert.equal(c.commissionMethod, 'statement');
  assert.equal(c.status, 'active');
  assert.equal(c.contact.email, '');
});

test('retained-commission carriers are supported', () => {
  const c = carrierInput.parse({ name: 'Synthetic Retained Co', code: 'SRC', kind: 'carrier', commissionMethod: 'retained', defaultRateBps: 1000 });
  assert.equal(c.commissionMethod, 'retained');
});

test('broker share defaults to 50%', () => {
  assert.equal(brokerInput.parse({ name: 'Synthetic Broker', code: 'B1' }).shareBps, 5000);
  assert.equal(brokerInput.safeParse({ name: 'X', code: 'B', shareBps: 10001 }).success, false);
});

test('client requires a name and classification', () => {
  const r = clientInput.safeParse({ name: '', classification: 'personal' });
  assert.equal(r.success, false);
  if (!r.success) assert.ok(fieldErrors(r.error).name);
  assert.equal(clientInput.parse({ name: 'Synthetic Client', classification: 'commercial' }).brokerId, 'UNASSIGNED');
});

test('policy validates dates and integer cents', () => {
  const base = { clientId: 'c', carrierId: 'k', policyNumber: 'SYN-1', line: 'commercial' as const };
  assert.ok(policyInput.safeParse(base).success);
  assert.equal(policyInput.safeParse({ ...base, premiumCents: 10.5 }).success, false);
  assert.equal(policyInput.safeParse({ ...base, effectiveDate: '2026-02-30' }).success, false);
  const bad = policyInput.safeParse({ ...base, effectiveDate: '2026-05-01', expirationDate: '2026-04-01' });
  assert.equal(bad.success, false);
  if (!bad.success) assert.ok(fieldErrors(bad.error).expirationDate);
});

test('settings require a valid snapshot month', () => {
  assert.ok(settingsInput.safeParse({ agencyName: 'Syn Agency', snapshotStartMonth: '2025-11' }).success);
  assert.equal(settingsInput.safeParse({ agencyName: 'Syn Agency', snapshotStartMonth: '2025-13' }).success, false);
});
