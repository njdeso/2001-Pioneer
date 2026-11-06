import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMonths, windowMonths, inWindow, isIsoDate, trailingTwelveStart, formatWindow,
} from '../src/period.ts';
import {
  totalInWindow, monthlyTotals, totalsBy, totalsByBroker, brokerSplit, CARRIER_LEVEL_BUCKET,
} from '../src/aggregate.ts';
import type { LedgerEntry } from '../src/types.ts';

test('month math', () => {
  assert.equal(addMonths('2025-11', 1), '2025-12');
  assert.equal(addMonths('2025-12', 1), '2026-01');
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(addMonths('2025-11', 11), '2026-10');
  assert.deepEqual(windowMonths('2025-11', 3), ['2025-11', '2025-12', '2026-01']);
  assert.equal(trailingTwelveStart('2026-11-05'), '2025-11');
  assert.equal(formatWindow('2025-11'), 'Nov 2025 – Oct 2026');
  assert.ok(inWindow('2026-10', '2025-11'));
  assert.ok(!inWindow('2026-11', '2025-11'));
  assert.ok(!inWindow('2025-10', '2025-11'));
});

test('date validation', () => {
  assert.ok(isIsoDate('2024-02-29'));
  assert.ok(!isIsoDate('2025-02-29'));
  assert.ok(!isIsoDate('2025-13-01'));
  assert.ok(!isIsoDate('11/05/2026'));
});

// ---- Synthetic ledger (clearly fake data) ----
let n = 0;
function entry(p: Partial<LedgerEntry>): LedgerEntry {
  return {
    id: `SYN-${++n}`, level: 'policy', payerId: 'SYN-CARRIER-A', carrierId: 'SYN-CARRIER-A',
    clientId: 'SYN-CLIENT-1', policyId: 'SYN-POL-1', classification: 'renewal', amountCents: 0,
    statementPeriod: '2026-01', transactionDate: null, paymentDate: null, sourceType: 'statement',
    statementId: 'SYN-STMT-1', lineId: null, note: '', postingStatus: 'posted', reversalOf: null,
    ...p,
  };
}

const ledger: LedgerEntry[] = [
  entry({ amountCents: 50000, statementPeriod: '2025-11', policyId: 'SYN-POL-1' }),
  entry({ amountCents: 25000, statementPeriod: '2025-12', policyId: 'SYN-POL-2', classification: 'new_business' }),
  entry({ amountCents: -10000, statementPeriod: '2026-01', policyId: 'SYN-POL-1', classification: 'chargeback' }),
  // Carrier-level bonus: no policy
  entry({ amountCents: 20000, statementPeriod: '2026-03', level: 'carrier', policyId: null, clientId: null, classification: 'bonus' }),
  // Wholesaler-paid policy on a different underlying carrier
  entry({ amountCents: 30000, statementPeriod: '2026-06', payerId: 'SYN-WHOLESALER-J', carrierId: 'SYN-CARRIER-B', policyId: 'SYN-POL-3' }),
  // Earned in October 2025 but on the November statement: counts in the statement period
  entry({ amountCents: 7000, statementPeriod: '2025-11', transactionDate: '2025-10-15', paymentDate: '2025-12-02', policyId: 'SYN-POL-2' }),
  // Outside the window
  entry({ amountCents: 99999, statementPeriod: '2025-10' }),
  entry({ amountCents: 99999, statementPeriod: '2026-11' }),
  // An entry and its reversal net to zero
  entry({ id: 'SYN-ORIG', amountCents: 12345, statementPeriod: '2026-02', policyId: 'SYN-POL-3', postingStatus: 'reversed' }),
  entry({ amountCents: -12345, statementPeriod: '2026-02', policyId: 'SYN-POL-3', reversalOf: 'SYN-ORIG', classification: 'other_adjustment' }),
];

test('trailing 12-month total uses statement period and excludes outside months', () => {
  assert.equal(totalInWindow(ledger, '2025-11'), 50000 + 25000 - 10000 + 20000 + 30000 + 7000);
});

test('monthly totals cover every month, including zero months', () => {
  const m = monthlyTotals(ledger, '2025-11');
  assert.equal(m.size, 12);
  assert.equal(m.get('2025-11'), 57000);
  assert.equal(m.get('2026-01'), -10000);
  assert.equal(m.get('2026-02'), 0);
  assert.equal(m.get('2026-04'), 0);
  const sum = [...m.values()].reduce((a, b) => a + b, 0);
  assert.equal(sum, totalInWindow(ledger, '2025-11'));
});

test('totals by payer and by underlying carrier both tie to the window total', () => {
  const byPayer = totalsBy(ledger, (e) => e.payerId, '2025-11');
  const byCarrier = totalsBy(ledger, (e) => e.carrierId, '2025-11');
  const total = totalInWindow(ledger, '2025-11');
  assert.equal([...byPayer.values()].reduce((a, b) => a + b, 0), total);
  assert.equal([...byCarrier.values()].reduce((a, b) => a + b, 0), total);
  assert.equal(byPayer.get('SYN-WHOLESALER-J'), 30000);
  assert.equal(byCarrier.get('SYN-CARRIER-B'), 30000);
});

test('broker totals follow the current broker; carrier-level money is kept separate', () => {
  // POL-1 was transferred to BROKER-2; current assignment is what counts.
  const policyBroker = new Map([
    ['SYN-POL-1', 'SYN-BROKER-2'],
    ['SYN-POL-2', 'SYN-BROKER-1'],
  ]);
  const t = totalsByBroker(ledger, policyBroker, '2025-11');
  assert.equal(t.get('SYN-BROKER-2'), 40000);
  assert.equal(t.get('SYN-BROKER-1'), 32000);
  assert.equal(t.get('UNASSIGNED'), 30000); // POL-3 not in the map
  assert.equal(t.get(CARRIER_LEVEL_BUCKET), 20000);
  assert.equal([...t.values()].reduce((a, b) => a + b, 0), totalInWindow(ledger, '2025-11'));
});

test('50% broker split always sums back to gross', () => {
  for (const gross of [0, 1, 333, 12345, -10001, 1500000]) {
    const { broker, agency } = brokerSplit(gross, 5000);
    assert.equal(broker + agency, gross);
  }
  assert.deepEqual(brokerSplit(40000, 5000), { broker: 20000, agency: 20000 });
});
