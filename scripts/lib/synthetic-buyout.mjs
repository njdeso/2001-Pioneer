// Synthetic broker-buyout fixtures for the DEV smoke test (fictional broker, insureds and policies).
// Fixed document IDs, so re-seeding is idempotent and never creates duplicate advances.
// The expected figures are verified against the engine in packages/shared/test/buyout-synthetic.test.ts.

export const BUYOUT_CLOSING = '2026-03-07';
export const BROKER = { id: 'SYNBO-B50', name: 'Synthetic Buyout Broker', shareBps: 5000, status: 'active' };
export const CARRIER = { id: 'SYNBO-CAR', name: 'Synthetic Buyout Mutual', kind: 'carrier', defaultRateBps: 1000, status: 'active' };
export const CLIENTS = [
  { id: 'SYNBO-C1', name: 'Synthetic Alder Holdings' },
  { id: 'SYNBO-C2', name: 'Synthetic Birch Partners' },
  { id: 'SYNBO-C3', name: 'Synthetic Cedar Works' },
];
export const POLICIES = [
  // 365-day term, $1,000 term commission, $500 paid upfront, 300 days left at closing → the specified example.
  { id: 'SYNBO-P1', clientId: 'SYNBO-C1', carrierId: 'SYNBO-CAR', policyNumber: 'SYNBO-1001', brokerId: 'SYNBO-B50', brokerShareBps: null, status: 'active', effectiveDate: '2026-01-01', expirationDate: '2027-01-01', premiumCents: null, commissionRateBps: null },
  // Two consecutive terms under ONE policy record (renewed, then cancelled after closing); closing falls in term 1.
  { id: 'SYNBO-P2', clientId: 'SYNBO-C2', carrierId: 'SYNBO-CAR', policyNumber: 'SYNBO-2002', brokerId: 'SYNBO-B50', brokerShareBps: null, status: 'cancelled', effectiveDate: '2026-07-03', expirationDate: '2027-07-03', premiumCents: null, commissionRateBps: null },
  // Cancelled before closing: excluded, no clawback, its advance is never deducted.
  { id: 'SYNBO-P3', clientId: 'SYNBO-C3', carrierId: 'SYNBO-CAR', policyNumber: 'SYNBO-3003', brokerId: 'SYNBO-B50', brokerShareBps: null, status: 'cancelled', effectiveDate: '2025-01-01', expirationDate: '2026-01-01', premiumCents: null, commissionRateBps: null },
];
export const TERMS = {
  'SYNBO-P2': [
    { id: '2025-07-02', effectiveDate: '2025-07-02', scheduledExpirationDate: '2026-07-03', cancellationDate: null, status: 'renewed', note: 'synthetic' },
    { id: '2026-07-03', effectiveDate: '2026-07-03', scheduledExpirationDate: '2027-07-03', cancellationDate: '2026-08-13', status: 'cancelled', note: 'synthetic' },
  ],
};
const adv = (id, policyId, clientId, eff, exp, basis, paid, paymentType) => ({
  id, policyId, clientId, brokerId: 'SYNBO-B50', termId: eff, termEffectiveDate: eff, termExpirationDate: exp,
  commissionBasisCents: basis, brokerShareBps: 5000, amountPaidCents: paid, paymentDate: eff, paymentReference: `SYN-${id}`, paymentType,
  status: 'active', source: { kind: 'manual' }, note: 'synthetic smoke fixture', replacesId: null, replacedById: null, voidReason: null,
});
export const ADVANCES = [
  adv('SYNBO-ADV1', 'SYNBO-P1', 'SYNBO-C1', '2026-01-01', '2027-01-01', 100000, 50000, 'new_business'),
  adv('SYNBO-ADV2', 'SYNBO-P2', 'SYNBO-C2', '2025-07-02', '2026-07-03', 80000, 40000, 'new_business'),
  adv('SYNBO-ADV3', 'SYNBO-P3', 'SYNBO-C3', '2025-01-01', '2026-01-01', 60000, 30000, 'new_business'),
];

/** Expected results for the synthetic broker at BUYOUT_CLOSING (independent of other dev data). */
export const EXPECTED = {
  P1: { included: true, termDays: 365, remainingDays: 300, grossBuyoutCents: 75000, outstandingAdvanceCents: 41096, netContributionCents: 33904 },
  P2: { included: true, termDays: 366, remainingDays: 118, annualizedAgencyCents: 79781, annualizedBrokerCents: 39890, grossBuyoutCents: 59835, outstandingAdvanceCents: 12896, netContributionCents: 46939 },
  P3: { included: false, exclusion: 'cancelled' },
  broker: { policies: 2, finalNetCents: 80843, installments: [40421, 20211, 20211] }, // 25 % of 808.43 = 202.1075 → 202.11
  // After a +$0.03 adjustment: 808.46 → 25 % = 202.115 → 202.12 (half-even); closing takes the rest.
  adjusted: { finalNetCents: 80846, installments: [40422, 20212, 20212] },
};

export async function seedBuyout(db, FieldValue) {
  const b = db.batch();
  const meta = { synthetic: true, updatedAt: FieldValue.serverTimestamp() };
  b.set(db.collection('brokers').doc(BROKER.id), { ...BROKER, ...meta }, { merge: true });
  b.set(db.collection('carriers').doc(CARRIER.id), { ...CARRIER, ...meta }, { merge: true });
  for (const c of CLIENTS) b.set(db.collection('clients').doc(c.id), { ...c, status: 'active', ...meta }, { merge: true });
  for (const p of POLICIES) { const { id, ...rest } = p; b.set(db.collection('policies').doc(id), { ...rest, alternateNumbers: [], line: 'commercial', namedInsured: '', policyType: '', ...meta }); }
  for (const [pid, terms] of Object.entries(TERMS)) for (const t of terms) { const { id, ...rest } = t; b.set(db.collection('policies').doc(pid).collection('terms').doc(id), { ...rest, policyId: pid, ...meta }); }
  for (const a of ADVANCES) { const { id, ...rest } = a; b.set(db.collection('brokerAdvances').doc(id), { ...rest, ...meta }); }
  await b.commit();
}
