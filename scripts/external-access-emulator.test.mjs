// External due-diligence access, end to end against the Firebase EMULATORS (auth, firestore, functions) —
// demo project, no credentials, never dev or production. Run by CI:
//
//   npx firebase emulators:exec --only auth,firestore,functions,storage --project demo-asm-external \
//     "node --import tsx --test scripts/external-access-emulator.test.mjs"
//
// Three representative accounts: the owner, a Pioneer Bank reviewer (role buyer) and an independent
// due-diligence reviewer (role diligence), provisioned through the REAL owner callable and signed in with
// email + password like real users. Synthetic data is seeded full of confidential "canary" broker data;
// every reviewer response and download is checked for it. Covers direct database access, manipulated
// requests, cross-role access, forged claims, every internal callable, unauthorized downloads, revoked and
// expired access, concurrent owner updates and disputed statements. With the Storage emulator: statement
// detail (every commission line), the carrier's original document byte for byte, statement CSVs, policies of
// every status, and every refused path (no file, missing file, discarded, unknown, manipulated, revoked,
// direct Storage access).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getStorage } from 'firebase-admin/storage';

const PROJECT = process.env.GCLOUD_PROJECT || 'demo-asm-external';
if (!PROJECT.startsWith('demo-')) throw new Error(`Refusing: ${PROJECT} is not a demo (emulator-only) project`);
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) throw new Error('Run inside firebase emulators:exec with auth, firestore, functions and storage (emulator hosts not set)');
const FUNCTIONS = `http://127.0.0.1:5001/${PROJECT}/us-central1`;
const AUTH = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1`;
const BUCKET = `${PROJECT}.appspot.com`; // the default bucket the functions emulator uses for a demo project
initializeApp({ projectId: PROJECT, storageBucket: BUCKET });
const db = getFirestore();
const adminAuth = getAuth();

const CANARY = {
  brokerName: 'Canary Broker Smithwick', brokerId: 'BRKCANARY7', brokerCode: 'CANBRK', note: 'CANARY-INTERNAL-NOTE',
  email: 'canary.staff@example.test', phone: '555-0199-CANARY', file: 'Canary-Broker-Statement.pdf', shareBps: 4321, brokerCents: 77777, advance: 'CANARY-ADVANCE',
};
const today = new Date().toISOString().slice(0, 10);
const inDays = (d) => new Date(Date.now() + d * 86400_000).toISOString().slice(0, 10);
const thisMonth = today.slice(0, 7);
const monthsAgo = (k) => { const [y, m] = thisMonth.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 - k, 1)); return d.toISOString().slice(0, 7); };

async function customToken(uid, claims) {
  const custom = await adminAuth.createCustomToken(uid, claims);
  const j = await (await fetch(`${AUTH}/accounts:signInWithCustomToken?key=emulator-key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }) })).json();
  if (!j.idToken) throw new Error(`emulator sign-in failed: ${JSON.stringify(j)}`);
  return j.idToken;
}
async function passwordSignIn(email, password) {
  const j = await (await fetch(`${AUTH}/accounts:signInWithPassword?key=emulator-key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) })).json();
  if (!j.idToken) { const e = new Error(j.error?.message ?? 'sign-in failed'); e.code = j.error?.message; throw e; }
  return j.idToken;
}
async function call(name, data, idToken) {
  const r = await fetch(`${FUNCTIONS}/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(idToken ? { authorization: `Bearer ${idToken}` } : {}) }, body: JSON.stringify({ data }) });
  const j = await r.json();
  if (j.error) { const e = new Error(j.error.message); e.status = j.error.status; throw e; }
  return j.result;
}
const refused = async (p) => { try { await p; return null; } catch (e) { return e.status; } };
const hash = async (col) => createHash('sha256').update(JSON.stringify((await db.collection(col).get()).docs.map((d) => [d.id, d.data()]).sort())).digest('hex');
const BUSINESS = ['carriers', 'brokers', 'clients', 'policies', 'ledger', 'statements', 'settings', 'brokerAdvances', 'buyoutSettlements'];

function assertNoLeak(payload, label) {
  const json = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const v of [CANARY.brokerName, CANARY.brokerId, CANARY.brokerCode, CANARY.note, CANARY.email, CANARY.phone, CANARY.file, CANARY.advance, 'UNASSIGNED']) assert.ok(!json.includes(v), `${label}: contains "${v}"`);
  for (const n of [CANARY.shareBps, CANARY.brokerCents, '777.77', '43.21']) assert.ok(!new RegExp(`(?<![0-9.])${String(n).replace('.', '\\.')}(?![0-9])`).test(json), `${label}: contains ${n}`);
  const keys = typeof payload === 'string' ? [] : [...json.matchAll(/"([^"]+)":/g)].map((m) => m[1]);
  for (const k of keys) assert.ok(!/broker|share|split|advance|buyout|note|email|phone|contact|approv|createdBy|updatedBy|fileName|agencyCents/i.test(k), `${label}: key ${k}`);
}

const T = {}; const U = {};
const VIEWS = ['overview', 'statements', 'book', 'carriers', 'transactions'];
const EXPORTS = ['summary', 'statements', 'statementLines', 'book', 'transactions'];
/** A small, real PDF: the synthetic "carrier document" (no customer data). */
const ORIGINAL_PDF = Buffer.from([
  '%PDF-1.4', '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj', '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<<>>>>endobj',
  '4 0 obj<</Length 44>>stream', 'BT /F1 12 Tf 72 720 Td (SYNTHETIC CARRIER) Tj ET', 'endstream endobj',
  'trailer<</Root 1 0 R>>', '%%EOF', '',
].join('\n'), 'latin1');
const ORIGINAL_SHA = createHash('sha256').update(ORIGINAL_PDF).digest('hex');

before(async () => {
  const w = [];
  w.push(['settings/app', { agencyName: 'Synthetic Agency LLC', snapshotStartMonth: monthsAgo(11), snapshotMonths: 12, defaultBrokerShareBps: CANARY.shareBps, aiEnabled: false }]);
  w.push(['carriers/CA', { name: 'Synthetic Mutual (TEST)', code: 'SYM', kind: 'carrier', commissionMethod: 'statement', status: 'active', contact: { email: CANARY.email, phone: CANARY.phone }, agencyCodes: ['AG1'] }]);
  w.push(['carriers/W1', { name: 'Synthetic MGA (TEST)', code: 'SMGA', kind: 'wholesaler', commissionMethod: 'statement', status: 'active' }]);
  w.push([`brokers/${CANARY.brokerId}`, { name: CANARY.brokerName, code: CANARY.brokerCode, shareBps: CANARY.shareBps, status: 'active' }]);
  w.push(['brokers/UNASSIGNED', { name: 'Unassigned', code: 'UNASSIGNED', shareBps: 0, status: 'active' }]);
  w.push(['clients/C1', { name: 'ALPHA SYNTHETIC LLC', externalId: '1001', classification: 'commercial', brokerId: CANARY.brokerId, contact: { email: CANARY.email, phone: CANARY.phone }, status: 'active', normalizedName: 'ALPHA SYNTHETIC LLC', searchTokens: [] }]);
  w.push(['clients/C2', { name: 'Bravo Synthetic', externalId: '1002', classification: 'personal', brokerId: CANARY.brokerId, status: 'active' }]);
  w.push(['policies/P1', { clientId: 'C1', carrierId: 'CA', wholesalerId: null, policyNumber: 'SYN-001', alternateNumbers: [], line: 'commercial', policyType: 'BOP', namedInsured: '', status: 'active', premiumCents: 250000, commissionRateBps: 1500, brokerId: CANARY.brokerId, brokerShareBps: CANARY.shareBps }]);
  w.push(['policies/P2', { clientId: 'C2', carrierId: 'CA', wholesalerId: 'W1', policyNumber: 'SYN-002', line: 'personal', status: 'active', premiumCents: 120000, commissionRateBps: 1000, brokerId: CANARY.brokerId, brokerShareBps: CANARY.shareBps }]);
  w.push(['ledger/L1', { level: 'policy', payerId: 'CA', carrierId: 'CA', clientId: 'C1', policyId: 'P1', classification: 'renewal', amountCents: 150000, statementPeriod: monthsAgo(2), sourceType: 'statement', statementId: 'S1', postingStatus: 'posted', reversalOf: null, postingId: 'PST1', note: CANARY.note, brokerId: CANARY.brokerId, brokerShareBps: CANARY.shareBps, brokerCents: CANARY.brokerCents, agencyCents: 150000 - CANARY.brokerCents, approvedBy: 'owner1' }]);
  w.push(['policies/P3', { clientId: 'C2', carrierId: 'CA', policyNumber: 'SYN-003', line: 'personal', status: 'cancelled', premiumCents: 90000, commissionRateBps: 1000, brokerId: CANARY.brokerId, brokerShareBps: CANARY.shareBps }]);
  w.push(['statements/S1', { status: 'posted', statementMonth: monthsAgo(2), payerId: 'CA', statementTotalCents: 150000, postedCents: 150000, fileName: CANARY.file,
    originalPath: 'statements/S1/original.pdf', fileType: 'pdf', sha256: ORIGINAL_SHA,
    stated: { commissionPayableCents: 150000, monthCommissionPayableCents: 150000, premiumForCommissionCents: 1000000, transactionPremiumCents: null, feeCents: null, paymentReceivedCents: null },
    adjustments: [{ label: 'MVR/CLUE expense (statement page 1, line 3)', amountCents: -1914, source: { sheet: 'page 1', sheetRow: 3, kind: 'mvr', policyNumberRaw: 'MVRCLU', lineNo: null } }], approval: { email: CANARY.email, totals: { brokerCents: CANARY.brokerCents } }, posting: { brokerCents: CANARY.brokerCents }, reconciliation: { reconciled: true, checks: [{ key: 'commission', label: 'Paid commission (sum of lines)', statedCents: 150000, extractedCents: 150000, differenceCents: 0, ok: true, required: true }], totals: { commissionCents: 150000, adjustmentsCents: 0 }, blockingReasons: [] } }]);
  w.push(['statements/S2', { status: 'discrepancy', statementMonth: monthsAgo(1), payerId: 'CA', statementTotalCents: 390000, postedCents: 0, fileName: CANARY.file, reconciliation: { reconciled: false, checks: [{ key: 'monthPayable', label: 'Statement total', statedCents: 390000, extractedCents: 270000, differenceCents: -120000, ok: false, required: true }], totals: { commissionCents: 270000, adjustmentsCents: 0 }, blockingReasons: [`${CANARY.note} ${CANARY.brokerName}`] } }]);
  for (const [id, line] of [['00001', { lineNo: 1, policyNumberRaw: 'SYN-001', paidCommissionCents: 150000, premiumForCommissionCents: 1000000, rateBps: 1500, match: { status: 'matched', policyId: 'P1', clientId: 'C1', brokerId: CANARY.brokerId, brokerShareBps: CANARY.shareBps, brokerCents: CANARY.brokerCents, agencyCents: 150000 - CANARY.brokerCents, reasons: [CANARY.note] } }],
    ['00002', { lineNo: 2, policyNumberRaw: 'SYN-002', paidCommissionCents: 1914, premiumForCommissionCents: 0, rateBps: null, match: { status: 'unmatched', brokerId: CANARY.brokerId } }]]) {
    w.push([`statements/S1/lines/${id}`, { page: 1, insuredName: 'ALPHA SYNTHETIC LLC', transactionCodeRaw: 'REN', transactionType: 'renewal', effectiveDate: `${monthsAgo(2)}-01`, transactionPremiumCents: null, feeCents: null, termCommissionCents: null, paymentReceivedCents: null, kind: 'commission', rawText: `${CANARY.brokerName} ${CANARY.note}`, issues: [{ level: 'warning', code: 'x', text: CANARY.note }], ...line }]);
  }
  // A discarded upload with a stored file, and a statement whose recorded file is missing from storage.
  w.push(['statements/S3', { status: 'discarded', statementMonth: monthsAgo(3), payerId: 'CA', statementTotalCents: 1, postedCents: 0, originalPath: 'statements/S3/original.pdf', fileType: 'pdf', fileName: CANARY.file }]);
  w.push(['statements/S4', { status: 'needs_review', statementMonth: monthsAgo(3), payerId: 'CA', statementTotalCents: 5000, postedCents: 0, originalPath: 'statements/S4/original.pdf', fileType: 'pdf', fileName: CANARY.file, reconciliation: { reconciled: true, checks: [], totals: { commissionCents: 5000, adjustmentsCents: 0 } } }]);
  w.push(['statements/S2/lines/00001', { insuredName: 'X', paidCommissionCents: 100, match: { brokerId: CANARY.brokerId, brokerCents: CANARY.brokerCents }, rawText: CANARY.note }]);
  w.push(['brokerAdvances/A1', { brokerId: CANARY.brokerId, policyId: 'P1', amountPaidCents: 50000, note: CANARY.advance, status: 'active' }]);
  w.push(['buyoutSettlements/B1', { state: 'finalized', brokerId: CANARY.brokerId, note: CANARY.advance }]);
  const b = db.batch(); for (const [p, v] of w) b.set(db.doc(p), v); await b.commit();
  await getStorage().bucket().file('statements/S1/original.pdf').save(ORIGINAL_PDF, { contentType: 'application/pdf', resumable: false });
  await getStorage().bucket().file('statements/S3/original.pdf').save(ORIGINAL_PDF, { contentType: 'application/pdf', resumable: false });

  T.owner = await customToken('owner1', { role: 'admin', email: 'owner@example.test' });
  T.staff = await customToken('staff1', { role: 'staff' });
  T.none = await customToken('rando', {});
  // Owner provisions the two organizations through the real callable; the reviewers then set a password
  // (as they would from the emailed link) and sign in with email + password.
  for (const [k, email, role] of [['pioneer', 'reviewer@pioneer-bank.test', 'buyer'], ['diligence', 'analyst@dd-firm.test', 'diligence']]) {
    const r = await call('inviteExternalUser', { email, role, expiresOn: inDays(30) }, T.owner);
    assert.ok(r.uid && /^https?:\/\//.test(r.setupLink), 'invite returns the account and a one-time setup link');
    U[k] = { uid: r.uid, email, role, organization: r.organization };
    await adminAuth.updateUser(r.uid, { password: `Synthetic-${k}-Pass-1!` });
    T[k] = await passwordSignIn(email, `Synthetic-${k}-Pass-1!`);
  }
});

test('three accounts: owner, Pioneer Bank (buyer) and due-diligence (diligence) have separate roles and records', async () => {
  for (const k of ['pioneer', 'diligence']) {
    const user = await adminAuth.getUser(U[k].uid);
    assert.deepEqual(user.customClaims, { role: U[k].role });
    const rec = (await db.collection('externalAccess').doc(U[k].uid).get()).data();
    assert.equal(rec.status, 'active'); assert.equal(rec.role, U[k].role); assert.equal(rec.expiresOn, inDays(30));
  }
  assert.equal(U.pioneer.organization, 'Pioneer Bank — Buyer');
  assert.equal(U.diligence.organization, 'Independent Due Diligence Company — Reviewer');
  const audits = (await db.collection('auditLog').where('action', '==', 'external_invite').get()).docs;
  assert.equal(audits.length, 2);
});

test('each reviewer sees every acquisition view and download, live, with no broker information anywhere', async () => {
  const before_ = Object.fromEntries(await Promise.all(BUSINESS.map(async (c) => [c, await hash(c)])));
  for (const k of ['pioneer', 'diligence']) {
    for (const view of VIEWS) {
      const r = await call('getReviewerData', { view }, T[k]);
      assert.equal(r.role, U[k].role); assert.equal(r.organization, U[k].organization);
      assertNoLeak(r, `${k}/${view}`);
    }
    for (const kind of EXPORTS) {
      const r = await call('getReviewerExport', { kind }, T[k]);
      assert.match(r.downloadName, new RegExp(`^Due-diligence-${kind}-\\d{4}-\\d{2}-\\d{2}\\.csv$`));
      assert.ok(!r.csv.includes("'-"), `${k}/${kind}: negative amounts are numbers`);
      assertNoLeak(r.csv, `${k}/${kind} export`);
    }
  }
  const after = Object.fromEntries(await Promise.all(BUSINESS.map(async (c) => [c, await hash(c)])));
  assert.deepEqual(after, before_, 'reviewer access changed no business record');
  const views = (await db.collection('auditLog').where('action', '==', 'external_view').get()).docs.map((d) => d.data());
  assert.ok(views.length >= 20 && views.some((v) => v.entityId === U.pioneer.uid) && views.some((v) => v.entityId === U.diligence.uid), 'every reviewer access is in the audit log');
  assert.ok((await db.collection('externalAccess').doc(U.pioneer.uid).get()).get('lastAccessAtIso'));
});

test('disputed statements: shown as disputed with both figures, never in the posted totals', async () => {
  const { overview } = await call('getReviewerData', { view: 'overview' }, T.pioneer);
  assert.equal(overview.postedTotal.total, 150000, 'posted ledger only');
  const disputed = overview.notPosted.find((x) => x.status === 'disputed');
  assert.deepEqual([disputed.count, disputed.carrierTotalCents, disputed.extractedCents], [1, 390000, 270000]);
  const { statements } = await call('getReviewerData', { view: 'statements' }, T.diligence);
  const s2 = statements.find((x) => x.id === 'S2');
  assert.deepEqual([s2.status, s2.postedCents, s2.reconciled], ['disputed', 0, false]);
  assert.equal(statements.find((x) => x.id === 'S1').status, 'posted');
});

test('reviewers cannot call ANY internal callable (writes, approvals, posting, imports, broker data, downloads, provisioning)', async () => {
  const src = readFileSync('functions/src/index.ts', 'utf8');
  const all = [...src.matchAll(/^export\s*\{([^}]*)\}\s*from/gm)].flatMap((m) => m[1].split(',').map((x) => x.trim()).filter(Boolean));
  const reviewerOk = new Set(['getReviewerData', 'getReviewerExport', 'getReviewerStatementFile']);
  const internal = all.filter((n) => !reviewerOk.has(n));
  assert.ok(internal.length >= 40, `found ${internal.length} internal callables`);
  for (const k of ['pioneer', 'diligence']) {
    for (const name of internal) {
      const status = await refused(call(name, { id: 'P1', statementId: 'S1', uid: U[k].uid, email: U[k].email, role: 'admin', expiresOn: inDays(5), reason: 'escalate', data: {} }, T[k]));
      assert.equal(status, 'PERMISSION_DENIED', `${k} → ${name} answered ${status}`);
    }
  }
});

test('forged claims, cross-role tokens, staff, no-role and signed-out callers get no reviewer data', async () => {
  // A token claiming "buyer" for an account the owner never invited.
  assert.equal(await refused(call('getReviewerData', { view: 'overview' }, await customToken('forger', { role: 'buyer' }))), 'PERMISSION_DENIED');
  // The Pioneer account presenting a "diligence" claim (cross-role): its owner record says buyer.
  assert.equal(await refused(call('getReviewerData', { view: 'overview' }, await customToken(U.pioneer.uid, { role: 'diligence' }))), 'PERMISSION_DENIED');
  assert.equal(await refused(call('getReviewerData', { view: 'overview' }, T.staff)), 'PERMISSION_DENIED');
  assert.equal(await refused(call('getReviewerData', { view: 'overview' }, T.none)), 'PERMISSION_DENIED');
  assert.equal(await refused(call('getReviewerData', { view: 'overview' }, null)), 'UNAUTHENTICATED');
  // The owner can preview exactly what reviewers see.
  const p = await call('getReviewerData', { view: 'book' }, T.owner);
  assert.equal(p.organization, 'Owner preview'); assertNoLeak(p, 'owner preview');
});

test('manipulated requests are rejected before any data is read', async () => {
  for (const data of [{ view: 'brokers' }, { view: 'buyout' }, { view: 'overview', fields: ['brokerId'] }, { view: 'overview', collection: 'brokers' }, { view: '../brokers' }, {}, null]) {
    assert.equal(await refused(call('getReviewerData', data, T.pioneer)), 'INVALID_ARGUMENT', JSON.stringify(data));
  }
  for (const data of [{ kind: 'ledger' }, { kind: 'brokers' }, { kind: 'summary', variant: 'accounting' }]) {
    assert.equal(await refused(call('getReviewerExport', data, T.diligence)), 'INVALID_ARGUMENT', JSON.stringify(data));
  }
});

test('direct database access with a reviewer\'s own ID token is refused for every collection', async () => {
  for (const col of ['clients', 'policies', 'brokers', 'ledger', 'statements', 'settings', 'brokerAdvances', 'buyoutSettlements', 'auditLog', 'externalAccess']) {
    const r = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/${PROJECT}/databases/(default)/documents/${col}`, { headers: { authorization: `Bearer ${T.pioneer}` } });
    assert.equal(r.status, 403, `${col}: HTTP ${r.status}`);
  }
  const r = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/${PROJECT}/databases/(default)/documents/externalAccess/${U.diligence.uid}`, { method: 'PATCH', headers: { authorization: `Bearer ${T.diligence}`, 'content-type': 'application/json' }, body: JSON.stringify({ fields: { role: { stringValue: 'admin' } } }) });
  assert.equal(r.status, 403, 'cannot rewrite their own access record');
});

test('provisioning guards: only the owner provisions; owner and internal accounts cannot be made external; one organization per account', async () => {
  assert.equal(await refused(call('inviteExternalUser', { email: 'self@example.test', role: 'buyer', expiresOn: inDays(5) }, T.pioneer)), 'PERMISSION_DENIED');
  assert.equal(await refused(call('inviteExternalUser', { email: 'owner@example.test', role: 'buyer', expiresOn: inDays(5) }, T.owner)), 'FAILED_PRECONDITION');
  const staffUser = await adminAuth.createUser({ email: 'staff-person@example.test' });
  await adminAuth.setCustomUserClaims(staffUser.uid, { role: 'staff' });
  assert.equal(await refused(call('inviteExternalUser', { email: 'staff-person@example.test', role: 'diligence', expiresOn: inDays(5) }, T.owner)), 'FAILED_PRECONDITION');
  assert.equal(await refused(call('inviteExternalUser', { email: U.pioneer.email, role: 'diligence', expiresOn: inDays(5) }, T.owner)), 'FAILED_PRECONDITION', 'a Pioneer account cannot also be the diligence company');
  assert.equal(await refused(call('inviteExternalUser', { email: 'x@example.test', role: 'admin', expiresOn: inDays(5) }, T.owner)), 'INVALID_ARGUMENT');
  assert.equal(await refused(call('inviteExternalUser', { email: 'x@example.test', role: 'buyer', expiresOn: inDays(-1) }, T.owner)), 'INVALID_ARGUMENT');
  assert.equal(await refused(call('inviteExternalUser', { email: 'x@example.test', role: 'buyer', expiresOn: inDays(400) }, T.owner)), 'INVALID_ARGUMENT');
  assert.equal(await refused(call('claimOwner', {}, T.pioneer)), 'PERMISSION_DENIED', 'a reviewer cannot claim the owner role');
});

test('concurrent owner updates: owner edits while reviewers read; both succeed and reviewers see the update', async () => {
  const client = (await db.doc('clients/C2').get()).data();
  const data = { name: 'Bravo Synthetic Renamed', externalId: client.externalId, classification: client.classification, brokerId: CANARY.brokerId, contact: {}, status: 'active' };
  const results = await Promise.allSettled([
    call('saveClient', { id: 'C2', data }, T.owner),
    ...Array.from({ length: 4 }, (_, i) => call('getReviewerData', { view: 'book' }, i % 2 ? T.pioneer : T.diligence)),
  ]);
  assert.ok(results.every((r) => r.status === 'fulfilled'), JSON.stringify(results.filter((r) => r.status === 'rejected').map((r) => r.reason?.message)));
  const { book } = await call('getReviewerData', { view: 'book' }, T.pioneer);
  assert.ok(book.clients.some((c) => c.name === 'Bravo Synthetic Renamed'), 'reviewer sees the owner\'s update live');
  assertNoLeak(book, 'book after update');
});

test('expired access is refused at the next request', async () => {
  const ref = db.collection('externalAccess').doc(U.pioneer.uid);
  await ref.update({ expiresOn: inDays(-1) });
  assert.equal(await refused(call('getReviewerData', { view: 'overview' }, T.pioneer)), 'PERMISSION_DENIED');
  await ref.update({ expiresOn: inDays(30) });
  await call('getReviewerData', { view: 'carriers' }, T.pioneer);
});

test('statement detail: every commission line at the FULL carrier commission (a broker services P1), premiums, rates and adjustments; no broker data', async () => {
  for (const k of ['pioneer', 'diligence']) {
    const { statement: d } = await call('getReviewerData', { view: 'statement', statementId: 'S1' }, T[k]);
    assertNoLeak(d, `${k}/statement S1`);
    assert.deepEqual(d.lines.map((l) => [l.lineNo, l.policyNumber, l.commissionCents, l.premiumForCommissionCents, l.rateBps, l.matched]), [[1, 'SYN-001', 150000, 1000000, 1500, true], [2, 'SYN-002', 1914, 0, null, false]]);
    assert.equal(d.lines[0].matchedClient, 'Alpha Synthetic LLC');
    assert.deepEqual(d.adjustments, [{ label: 'MVR/CLUE expense (statement page 1, line 3)', kind: 'MVR / CLUE charge', amountCents: -1914 }]);
    assert.deepEqual([d.statement.status, d.statement.hasOriginal, d.statement.fileType, d.carrierPrinted.premiumForCommissionCents], ['posted', true, 'pdf', 1000000]);
    for (const key of ['issues', 'rawText', 'match', 'brokerCents', 'originalPath', 'fileName']) assert.ok(!JSON.stringify(d).includes(`"${key}"`), `${k}: no ${key}`);
  }
  const { statements } = await call('getReviewerData', { view: 'statements' }, T.pioneer);
  assert.deepEqual(statements.map((x) => [x.id, x.hasOriginal]).sort(), [['S1', true], ['S2', false], ['S4', true]], 'discarded S3 is not listed');
});

test('original statement file: the carrier\'s document byte for byte, for both organizations, audited, nothing changed', async () => {
  const before_ = Object.fromEntries(await Promise.all(BUSINESS.map(async (c) => [c, await hash(c)])));
  const before = await getStorage().bucket().file('statements/S1/original.pdf').getMetadata().then(([m]) => [m.md5Hash, m.generation]);
  for (const k of ['pioneer', 'diligence']) {
    const r = await call('getReviewerStatementFile', { statementId: 'S1' }, T[k]);
    const bytes = Buffer.from(r.base64, 'base64');
    assert.ok(bytes.equals(ORIGINAL_PDF), `${k}: identical bytes`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), ORIGINAL_SHA);
    assert.deepEqual([r.sha256, r.size, r.contentType], [ORIGINAL_SHA, ORIGINAL_PDF.length, 'application/pdf']);
    assert.equal(r.downloadName, `Synthetic Mutual (TEST) ${monthsAgo(2)} commission statement.pdf`, 'neutral name, not the uploaded file name');
    const { base64, ...rest } = r;
    assertNoLeak(rest, `${k}/original`);
  }
  assert.deepEqual(await getStorage().bucket().file('statements/S1/original.pdf').getMetadata().then(([m]) => [m.md5Hash, m.generation]), before, 'the stored original is unchanged');
  assert.deepEqual(Object.fromEntries(await Promise.all(BUSINESS.map(async (c) => [c, await hash(c)]))), before_, 'no business record changed');
  const audits = (await db.collection('auditLog').where('action', '==', 'external_view').get()).docs.map((d) => d.data().summary);
  assert.ok(audits.filter((x) => /viewed original statement S1$/.test(x)).length >= 2, 'each original access is audited');
  // The owner preview can open it too.
  assert.ok(Buffer.from((await call('getReviewerStatementFile', { statementId: 'S1' }, T.owner)).base64, 'base64').equals(ORIGINAL_PDF));
});

test('original file and statement detail refused for: no stored file, missing file, discarded, unknown, manipulated requests and every non-reviewer', async () => {
  const notFound = async (data) => { try { await call('getReviewerStatementFile', data, T.pioneer); return null; } catch (e) { return [e.status, e.message]; } };
  assert.deepEqual(await notFound({ statementId: 'S2' }), ['NOT_FOUND', 'The original file was never stored for this statement (the upload did not complete), so it cannot be shown. Upload the statement again if you need the file.']);
  assert.deepEqual(await notFound({ statementId: 'S4' }), ['NOT_FOUND', 'The original file is recorded for this statement but is missing from storage. Contact the agency.']);
  assert.deepEqual(await notFound({ statementId: 'S3' }), ['NOT_FOUND', 'This statement is not available.'], 'a discarded upload is not part of the record, though its file exists');
  assert.deepEqual(await notFound({ statementId: 'NOPE' }), ['NOT_FOUND', 'This statement is not available.']);
  for (const data of [{}, null, { statementId: 'statements/S1/original.pdf' }, { statementId: '../S1' }, { statementId: 'S1', path: 'statements/S3/original.pdf' }, { statementId: 'S1', bucket: 'other' }]) {
    assert.equal(await refused(call('getReviewerStatementFile', data, T.pioneer)), 'INVALID_ARGUMENT', JSON.stringify(data));
  }
  assert.equal(await refused(call('getReviewerData', { view: 'statement', statementId: 'S3' }, T.pioneer)), 'NOT_FOUND');
  assert.equal(await refused(call('getReviewerData', { view: 'statement', statementId: 'S1', fields: ['match'] }, T.pioneer)), 'INVALID_ARGUMENT');
  assert.equal(await refused(call('getReviewerExport', { kind: 'statement', statementId: 'S3' }, T.pioneer)), 'NOT_FOUND');
  const forged = await customToken('forger2', { role: 'diligence' });
  for (const t of [T.staff, T.none, forged, await customToken(U.pioneer.uid, { role: 'diligence' })]) {
    assert.equal(await refused(call('getReviewerStatementFile', { statementId: 'S1' }, t)), 'PERMISSION_DENIED');
    assert.equal(await refused(call('getReviewerData', { view: 'statement', statementId: 'S1' }, t)), 'PERMISSION_DENIED');
    assert.equal(await refused(call('getReviewerExport', { kind: 'statementLines' }, t)), 'PERMISSION_DENIED');
  }
  assert.equal(await refused(call('getReviewerStatementFile', { statementId: 'S1' }, null)), 'UNAUTHENTICATED');
});

test('direct Storage access with a reviewer\'s own ID token is refused (download and upload)', async () => {
  const obj = `http://${process.env.FIREBASE_STORAGE_EMULATOR_HOST}/v0/b/${BUCKET}/o/${encodeURIComponent('statements/S1/original.pdf')}`;
  for (const k of ['pioneer', 'diligence']) {
    const get = await fetch(`${obj}?alt=media`, { headers: { authorization: `Firebase ${T[k]}` } });
    assert.equal(get.status, 403, `${k} download: HTTP ${get.status}`);
    const up = await fetch(`http://${process.env.FIREBASE_STORAGE_EMULATOR_HOST}/v0/b/${BUCKET}/o?name=${encodeURIComponent('statements/S1/original.pdf')}`, { method: 'POST', headers: { authorization: `Firebase ${T[k]}`, 'content-type': 'application/pdf' }, body: Buffer.from('%PDF-1.4 replaced') });
    assert.equal(up.status, 403, `${k} upload: HTTP ${up.status}`);
  }
  const [still] = await getStorage().bucket().file('statements/S1/original.pdf').download();
  assert.ok(still.equals(ORIGINAL_PDF), 'the original is unchanged');
});

test('statement CSVs: one statement and all statements, lines and adjustments, no broker data; policies of every status, labelled', async () => {
  const one = await call('getReviewerExport', { kind: 'statement', statementId: 'S1' }, T.pioneer);
  assert.match(one.downloadName, /^Due-diligence-statement-Synthetic-Mutual-TEST-\d{4}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/);
  assertNoLeak(one.csv, 'statement CSV');
  assert.match(one.csv, /\r\n1,1,ALPHA SYNTHETIC LLC,SYN-001,REN,renewal,[0-9-]+,10000\.00,,15\.00,1500\.00,/);
  assert.match(one.csv, /MVR \/ CLUE charge,-19\.14\r\n/);
  const all = await call('getReviewerExport', { kind: 'statementLines' }, T.diligence);
  assertNoLeak(all.csv, 'all lines CSV');
  assert.equal(all.csv.split('\r\n').filter((r) => r.includes(',Commission line,')).length, 3, 'S1 (2 lines) + S2 (1) + S4 (none); discarded S3 excluded');
  const { book } = await call('getReviewerData', { view: 'book' }, T.pioneer);
  assert.deepEqual(book.policies.map((p) => [p.policyNumber, p.statusLabel]), [['SYN-001', 'Active'], ['SYN-002', 'Active'], ['SYN-003', 'Cancelled']]);
  assert.deepEqual(book.policiesByStatus, { active: 2, cancelled: 1 });
  const csv = (await call('getReviewerExport', { kind: 'book' }, T.pioneer)).csv;
  assert.match(csv, /SYN-003,.*,Cancelled,/);
  assertNoLeak(csv, 'book CSV');
});

test('revocation is immediate: the still-valid old token is refused, sign-in is disabled, the claim is removed, and it is audited', async () => {
  await call('revokeExternalUser', { uid: U.diligence.uid, reason: 'Engagement ended (test)' }, T.owner);
  // (PERMISSION_DENIED from the access record; UNAUTHENTICATED if the platform also rejects the disabled account's token)
  assert.ok(['PERMISSION_DENIED', 'UNAUTHENTICATED'].includes(await refused(call('getReviewerData', { view: 'overview' }, T.diligence))), 'old ID token no longer works');
  assert.ok(['PERMISSION_DENIED', 'UNAUTHENTICATED'].includes(await refused(call('getReviewerExport', { kind: 'book' }, T.diligence))));
  assert.ok(['PERMISSION_DENIED', 'UNAUTHENTICATED'].includes(await refused(call('getReviewerData', { view: 'statement', statementId: 'S1' }, T.diligence))), 'statement detail refused');
  assert.ok(['PERMISSION_DENIED', 'UNAUTHENTICATED'].includes(await refused(call('getReviewerStatementFile', { statementId: 'S1' }, T.diligence))), 'original file refused');
  assert.ok(['PERMISSION_DENIED', 'UNAUTHENTICATED'].includes(await refused(call('getReviewerExport', { kind: 'statement', statementId: 'S1' }, T.diligence))), 'statement CSV refused');
  assert.ok(['PERMISSION_DENIED', 'UNAUTHENTICATED'].includes(await refused(call('getReviewerExport', { kind: 'statementLines' }, T.diligence))), 'all-lines CSV refused');
  await assert.rejects(passwordSignIn(U.diligence.email, 'Synthetic-diligence-Pass-1!'), /USER_DISABLED/);
  const user = await adminAuth.getUser(U.diligence.uid);
  assert.equal(user.disabled, true); assert.deepEqual(user.customClaims ?? {}, {});
  const rec = (await db.collection('externalAccess').doc(U.diligence.uid).get()).data();
  assert.equal(rec.status, 'revoked'); assert.equal(rec.revokeReason, 'Engagement ended (test)');
  assert.equal((await db.collection('auditLog').where('action', '==', 'external_revoke').get()).size, 1);
  // The other organization is unaffected.
  await call('getReviewerData', { view: 'overview' }, T.pioneer);
  // Reviewers cannot revoke or re-invite anyone (including restoring themselves).
  assert.equal(await refused(call('revokeExternalUser', { uid: U.pioneer.uid, reason: 'nope' }, T.pioneer)), 'PERMISSION_DENIED');
});
