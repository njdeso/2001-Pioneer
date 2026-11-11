// Synthetic Stage 3B data for the DEVELOPMENT project only. Every name and number is fictional,
// every document is tagged `synthetic: true`, and every ID starts with "SYN3B".
// Used by scripts/seed-dev.mjs (book + a statement for your manual tests) and by
// scripts/smoke-dev.mjs (a fresh statement per run for the automated tests).

export const CARRIERS = {
  'SYN3B-MUTUAL': { name: 'Synthetic Mutual Insurance Co (TEST)', code: 'SYN3BMUT', kind: 'carrier', agencyCodes: ['DEV001'] },
  'SYN3B-OTHER': { name: 'Other Synthetic Carrier (TEST)', code: 'SYN3BOTH', kind: 'carrier', agencyCodes: [] },
};
export const PAYER_ID = 'SYN3B-MUTUAL';

export const BROKERS = {
  'SYN3B-B50': { name: 'Test Broker Fifty (TEST)', code: 'SYN3BB50', shareBps: 5000 },
  'SYN3B-B40': { name: 'Test Broker Forty (TEST)', code: 'SYN3BB40', shareBps: 4000 },
};

export const CLIENTS = {
  'SYN3B-C-ALPHA': { name: 'Alpha Synthetic Trucking LLC', brokerId: 'SYN3B-B50' },
  'SYN3B-C-BETA': { name: 'Beta Synthetic Cab Corp', brokerId: 'SYN3B-B40' },
  'SYN3B-C-GAMMA': { name: 'Gamma Synthetic Holdings', brokerId: 'SYN3B-B50' },
  'SYN3B-C-DELTA': { name: 'Delta Synthetic Limo', brokerId: 'SYN3B-B40' },
  'SYN3B-C-EPSILON': { name: 'Epsilon Synthetic Services', brokerId: 'UNASSIGNED' },
  'SYN3B-C-ZETA': { name: 'Zeta Synthetic Logistics', brokerId: 'SYN3B-B50' },
  'SYN3B-C-THETA': { name: 'Theta Synthetic Transport', brokerId: 'SYN3B-B50' },
  // Stored in ALL CAPS (as legacy agency systems export names); no policies, so no statement or financial effect.
  // The app and the Customer & Policy Export show it in proper case: "Iota O'Neil Synthetic Auto Body LLC".
  'SYN3B-C-IOTA': { name: "IOTA O'NEIL SYNTHETIC AUTO BODY LLC", brokerId: 'UNASSIGNED' },
};

// carrierId, number, broker, optional per-policy broker share, status
export const POLICIES = {
  'SYN3B-P-ALPHA': { clientId: 'SYN3B-C-ALPHA', carrierId: 'SYN3B-MUTUAL', policyNumber: 'SYN-1001', brokerId: 'SYN3B-B50' },
  'SYN3B-P-BETA': { clientId: 'SYN3B-C-BETA', carrierId: 'SYN3B-MUTUAL', policyNumber: 'SYN-1002', brokerId: 'SYN3B-B40' },
  'SYN3B-P-GAMMA': { clientId: 'SYN3B-C-GAMMA', carrierId: 'SYN3B-OTHER', policyNumber: 'SYN-1003', brokerId: 'SYN3B-B50' }, // number exists only at another carrier
  'SYN3B-P-DELTA': { clientId: 'SYN3B-C-DELTA', carrierId: 'SYN3B-MUTUAL', policyNumber: '617738486', brokerId: 'SYN3B-B40' },
  'SYN3B-P-EPSILON': { clientId: 'SYN3B-C-EPSILON', carrierId: 'SYN3B-MUTUAL', policyNumber: '0045678', brokerId: 'UNASSIGNED' },
  'SYN3B-P-ZETA': { clientId: 'SYN3B-C-ZETA', carrierId: 'SYN3B-MUTUAL', policyNumber: 'SYN-1006', brokerId: 'SYN3B-B50', brokerShareBps: 3000 }, // per-policy 30 %
  'SYN3B-P-THETA': { clientId: 'SYN3B-C-THETA', carrierId: 'SYN3B-MUTUAL', policyNumber: 'SYN-1008', brokerId: 'SYN3B-B50', status: 'cancelled' },
};

/**
 * Statement lines, each with the result the matching engine must produce.
 * Amounts are integer cents. brokerCents/agencyCents are expected only for matched lines.
 */
export const LINES = [
  { insuredName: 'ALPHA SYNTHETIC TRUCKING', policyNumberRaw: 'SYN 1001', paid: 12000, type: 'continuation',
    expect: { status: 'matched', policyId: 'SYN3B-P-ALPHA', confidence: 'high', brokerId: 'SYN3B-B50', shareBps: 5000, brokerCents: 6000, agencyCents: 6000 } },
  { insuredName: 'UNRELATED NAME SERVICES', policyNumberRaw: 'SYN-1002', paid: 5000, type: 'endorsement',
    expect: { status: 'ambiguous', reason: 'name_conflicts' } },
  { insuredName: 'GAMMA SYNTHETIC HOLDINGS', policyNumberRaw: 'SYN-1003', paid: 7000, type: 'new_business',
    expect: { status: 'ambiguous', reason: 'number_at_other_carrier' } },
  { insuredName: 'DELTA SYNTHETIC LIMO', policyNumberRaw: '6.17738486E+08', paid: 8000, type: 'continuation',
    expect: { status: 'matched', policyId: 'SYN3B-P-DELTA', reason: 'scientific_notation_expanded', brokerId: 'SYN3B-B40', shareBps: 4000, brokerCents: 3200, agencyCents: 4800 } },
  { insuredName: 'DELTA SYNTHETIC LIMO', policyNumberRaw: '6.17738E+08', paid: 9000, type: 'endorsement',
    expect: { status: 'unmatched', reason: 'scientific_notation_truncated' } },
  { insuredName: 'EPSILON SYNTHETIC SERVICES', policyNumberRaw: '45678', paid: 2500, type: 'continuation',
    expect: { status: 'matched', policyId: 'SYN3B-P-EPSILON', reason: 'leading_zeros_only', brokerId: 'UNASSIGNED', shareBps: 0, brokerCents: 0, agencyCents: 2500 } },
  { insuredName: 'ZETA SYNTHETIC LOGISTICS', policyNumberRaw: 'SYN-1006', paid: -4500, type: 'cancellation',
    expect: { status: 'matched', policyId: 'SYN3B-P-ZETA', brokerId: 'SYN3B-B50', shareBps: 3000, shareSource: 'policy', brokerCents: -1350, agencyCents: -3150 } },
  { insuredName: 'ALPHA SYNTHETIC TRUCKING', policyNumberRaw: 'SYN-1001', paid: null, payment: 30000, type: 'installment_payment',
    expect: { status: 'matched', policyId: 'SYN3B-P-ALPHA', brokerCents: 0, agencyCents: 0 } },
  { insuredName: 'NOBODY IN PARTICULAR', policyNumberRaw: 'NOPE-9999', paid: 1000, type: 'new_business',
    expect: { status: 'unmatched', reason: 'no_policy_found' } },
  { insuredName: 'THETA SYNTHETIC TRANSPORT', policyNumberRaw: 'SYN-1008', paid: 1500, type: 'endorsement',
    expect: { status: 'matched', policyId: 'SYN3B-P-THETA', reason: 'policy_not_active', brokerId: 'SYN3B-B50', shareBps: 5000, brokerCents: 750, agencyCents: 750 } },
];

/** Expected statement summary after automatic matching. */
export const EXPECTED_SUMMARY = {
  lineCount: 10, commissionLineCount: 9, matched: 6, ambiguous: 2, unmatched: 2,
  commissionCents: 41500, matchedCommissionCents: 19500, ambiguousCommissionCents: 12000, unmatchedCommissionCents: 10000,
  brokerCents: 8600, agencyCents: 10900, adjustmentsCents: -500, balanced: true,
};
export const ADJUSTMENTS = [{ label: 'Synthetic shared cost (TEST)', amountCents: -500 }];

const norm = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const nameNorm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Upsert the synthetic book (carriers, brokers, clients, policies). Merge-only; never deletes. */
export async function seedBook(db, FieldValue) {
  const now = FieldValue.serverTimestamp();
  const by = 'seed-dev-3b';
  const stamp = { synthetic: true, updatedAt: now, updatedBy: by };
  const b = db.batch();
  for (const [id, c] of Object.entries(CARRIERS)) {
    b.set(db.collection('carriers').doc(id), { ...c, commissionMethod: 'statement', defaultRateBps: null, aliases: [], status: 'active', contact: { name: '', phone: '', email: '', address: '', notes: 'Synthetic test carrier' }, ...stamp }, { merge: true });
    b.set(db.collection('carrierCodes').doc(c.code), { id }, { merge: true });
  }
  for (const [id, x] of Object.entries(BROKERS)) {
    b.set(db.collection('brokers').doc(id), { ...x, status: 'active', ...stamp }, { merge: true });
    b.set(db.collection('brokerCodes').doc(x.code), { id }, { merge: true });
  }
  for (const [id, c] of Object.entries(CLIENTS)) {
    b.set(db.collection('clients').doc(id), {
      name: c.name, externalId: id, classification: 'commercial', brokerId: c.brokerId, status: 'active',
      contact: { name: '', phone: '', email: '', address: '', notes: 'Synthetic test client' },
      normalizedName: nameNorm(c.name), searchTokens: [], ...stamp,
    }, { merge: true });
  }
  for (const [id, p] of Object.entries(POLICIES)) {
    b.set(db.collection('policies').doc(id), {
      clientId: p.clientId, carrierId: p.carrierId, wholesalerId: null, policyNumber: p.policyNumber, alternateNumbers: [],
      alternateNumbersNormalized: [], normalizedPolicyNumber: norm(p.policyNumber), policyType: 'Commercial Auto (TEST)', line: 'commercial',
      namedInsured: CLIENTS[p.clientId].name, brokerId: p.brokerId, brokerShareBps: p.brokerShareBps ?? null,
      effectiveDate: '2026-01-01', expirationDate: '2027-01-01', premiumCents: null, commissionRateBps: null,
      status: p.status ?? 'active', searchTokens: [], ...stamp,
    }, { merge: true });
    b.set(db.collection('policyKeys').doc(`${p.carrierId}__${norm(p.policyNumber)}`), { policyId: id }, { merge: true });
  }
  await b.commit();
}

/**
 * Create a synthetic extracted statement with the LINES above (no file attached), or reset one that has
 * never been approved or posted. A statement that has been approved, posted or reversed, or that any
 * ledger entry refers to, is never replaced: its records are part of the append-only audit trail.
 */
export async function writeStatement(db, FieldValue, statementId, label) {
  if (!statementId.startsWith('SYN3B-')) throw new Error('Synthetic statement IDs must start with SYN3B-');
  const ref = db.collection('statements').doc(statementId);
  const cur = await ref.get();
  if (cur.exists) {
    const s = cur.data();
    const touched = s.synthetic !== true || s.approval || s.posting || (s.reversals ?? []).length > 0 || (s.postingSeq ?? 0) > 0
      || Number(s.postedCents ?? 0) !== 0 || ['approved', 'posted'].includes(s.status);
    const ledger = await db.collection('ledger').where('statementId', '==', statementId).limit(1).get();
    if (touched || !ledger.empty) {
      throw new Error(`Refusing to replace statement ${statementId}: it has been approved, posted or reversed (or ledger entries refer to it). Its records are kept; use a new statement instead.`);
    }
  }
  const old = await ref.collection('lines').listDocuments();
  for (let i = 0; i < old.length; i += 400) { const b = db.batch(); old.slice(i, i + 400).forEach((d) => b.delete(d)); await b.commit(); }
  const b = db.batch();
  b.set(ref, {
    synthetic: true, status: 'needs_review', fileName: `${label} (synthetic, no file)`, fileType: 'pdf', size: 0, sha256: null,
    uploadPath: null, originalPath: null, method: 'synthetic', carrierName: CARRIERS[PAYER_ID].name, agencyCode: 'DEV001', officeCode: null,
    statementMonth: '2026-10', statementDate: '2026-10-31', pageCount: 1, payerId: PAYER_ID, payerNote: 'Synthetic test statement',
    adjustments: ADJUSTMENTS, statementIssues: [], postedCents: 0, pendingCents: 0, matching: null, possibleDuplicateOf: null,
    createdAt: FieldValue.serverTimestamp(), createdBy: 'seed-dev-3b', updatedAt: FieldValue.serverTimestamp(), updatedBy: 'seed-dev-3b',
  });
  LINES.forEach((l, i) => {
    b.set(ref.collection('lines').doc(String(i + 1).padStart(5, '0')), {
      lineNo: i + 1, page: 1, insuredName: l.insuredName, policyNumberRaw: l.policyNumberRaw, policyNumberNormalized: norm(l.policyNumberRaw),
      paymentReceivedCents: l.payment ?? null, paidCommissionCents: l.paid, rateBps: null, termCommissionCents: null,
      premiumForCommissionCents: null, transactionPremiumCents: null, feeCents: null, effectiveDate: '2026-10-01',
      transactionCodeRaw: l.type.toUpperCase(), transactionType: l.type, paymentMethod: '', kind: l.paid === null ? 'payment_only' : 'commission',
      rawText: JSON.stringify({ synthetic: true, ...l, expect: undefined }), issues: [],
      statementId, payerId: PAYER_ID, status: l.paid === null ? 'info' : 'pending', match: { status: 'not_started' }, synthetic: true,
    });
  });
  await b.commit();
  return ref;
}
