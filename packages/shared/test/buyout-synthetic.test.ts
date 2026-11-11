import { test } from 'node:test';
import assert from 'node:assert/strict';
import { valueBuyout, settleBuyout } from '../src/buyout/engine.ts';
import { toBuyoutInputs } from '../src/buyout/snapshot.ts';
import type { BrokerAdvance } from '../src/buyout/advances.ts';
import type { PolicyTerm } from '../src/terms.ts';
// The DEV smoke test's fixtures and expected figures: verified here against the engine so the live
// check can never drift from the code.
import * as F from '../../../scripts/lib/synthetic-buyout.mjs';

test('synthetic smoke fixtures produce exactly the figures the live smoke test expects', () => {
  const { policies, brokers, carrierRateBps } = toBuyoutInputs({ policies: F.POLICIES, brokers: [F.BROKER], carriers: [F.CARRIER] });
  const termsByPolicy = new Map<string, PolicyTerm[]>(Object.entries(F.TERMS).map(([pid, ts]) => [pid, (ts as PolicyTerm[]).map((t) => ({ ...t, policyId: pid }))]));
  const v = valueBuyout({ closingDate: F.BUYOUT_CLOSING, policies, brokers, termsByPolicy, advances: F.ADVANCES as unknown as BrokerAdvance[], carrierRateBps });
  const row = (id: string) => v.policies.find((p) => p.policyId === id)!;
  for (const [k, id] of [['P1', 'SYNBO-P1'], ['P2', 'SYNBO-P2'], ['P3', 'SYNBO-P3']] as const) {
    for (const [field, want] of Object.entries(F.EXPECTED[k])) assert.equal((row(id) as unknown as Record<string, unknown>)[field], want, `${id}.${field}`);
  }
  assert.deepEqual(row('SYNBO-P1').flags, []);
  assert.equal(row('SYNBO-P2').term?.source, 'terms');
  assert.ok(!row('SYNBO-P2').material, 'term history resolves the renewed term cleanly');
  const b = v.brokers.find((x) => x.brokerId === F.BROKER.id)!;
  assert.equal(b.policies, F.EXPECTED.broker.policies);
  assert.equal(b.finalNetCents, F.EXPECTED.broker.finalNetCents);
  assert.deepEqual(b.installments.map((i) => i.amountCents), F.EXPECTED.broker.installments);
  assert.equal(v.finalizable, true, v.blockers.join(' '));

  const adj = settleBuyout({ closingDate: F.BUYOUT_CLOSING, rules: v.rules, policies: v.policies, brokers, adjustments: [{ id: 'a', brokerId: F.BROKER.id, amountCents: 3, reason: 'smoke' }], expectedPolicyCount: v.policies.length });
  const ab = adj.brokers.find((x) => x.brokerId === F.BROKER.id)!;
  assert.equal(ab.finalNetCents, F.EXPECTED.adjusted.finalNetCents);
  assert.deepEqual(ab.installments.map((i) => i.amountCents), F.EXPECTED.adjusted.installments);
});
