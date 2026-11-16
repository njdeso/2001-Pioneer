// External due-diligence access, end to end against the Firebase EMULATORS (auth, firestore, functions) —
// demo project, no credentials, never dev or production. Run by CI:
//
//   npx firebase emulators:exec --only auth,firestore,functions --project demo-asm-external \
//     "node --import tsx --test scripts/external-access-emulator.test.mjs"
//
// Three representative accounts: the owner, a Pioneer Bank reviewer (role buyer) and an independent
// due-diligence reviewer (role diligence), provisioned through the REAL owner callable and signed in with
// email + password like real users. Synthetic data is seeded full of confidential "canary" broker data;
// every reviewer response and download is checked for it. Covers direct database access, manipulated
// requests, cross-role access, forged claims, every internal callable, unauthorized downloads, revoked and
// expired access, concurrent owner updates and disputed statements.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

const PROJECT = process.env.GCLOUD_PROJECT || 'demo-asm-external';
if (!PROJECT.startsWith('demo-')) throw new Error(`Refusing: ${PROJECT} is not a demo (emulator-only) project`);
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('Run inside firebase emulators:exec (emulator hosts not set)');
const FUNCTIONS = `http://127.0.0.1:5001/${PROJECT}/us-central1`;
const AUTH = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1`;
initializeApp({ projectId: PROJECT });
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
const EXPORTS = ['summary', 'statements', 'book', 'transactions'];

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
  w.push(['statements/S1', { status: 'posted', statementMonth: monthsAgo(2), payerId: 'CA', statementTotalCents: 150000, postedCents: 150000, fileName: CANARY.file, approval: { email: CANARY.email, totals: { brokerCents: CANARY.brokerCents } }, posting: { brokerCents: CANARY.brokerCents }, reconciliation: { reconciled: true, checks: [{ key: 'commission', label: 'Paid commission (sum of lines)', statedCents: 150000, extractedCents: 150000, differenceCents: 0, ok: true, required: true }], totals: { commissionCents: 150000, adjustmentsCents: 0 }, blockingReasons: [] } }]);
  w.push(['statements/S2', { status: 'discrepancy', statementMonth: monthsAgo(1), payerId: 'CA', statementTotalCents: 390000, postedCents: 0, fileName: CANARY.file, reconciliation: { reconciled: false, checks: [{ key: 'monthPayable', label: 'Statement total', statedCents: 390000, extractedCents: 270000, differenceCents: -120000, ok: false, required: true }], totals: { commissionCents: 270000, adjustmentsCents: 0 }, blockingReasons: [`${CANARY.note} ${CANARY.brokerName}`] } }]);
  w.push(['statements/S2/lines/00001', { insuredName: 'X', paidCommissionCents: 100, match: { brokerId: CANARY.brokerId, brokerCents: CANARY.brokerCents }, rawText: CANARY.note }]);
  w.push(['brokerAdvances/A1', { brokerId: CANARY.brokerId, policyId: 'P1', amountPaidCents: 50000, note: CANARY.advance, status: 'active' }]);
  w.push(['buyoutSettlements/B1', { state: 'finalized', brokerId: CANARY.brokerId, note: CANARY.advance }]);
  const b = db.batch(); for (const [p, v] of w) b.set(db.doc(p), v); await b.commit();

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
      assertNoLeak(r.csv, `${k}/${kind} export`);
    }
  }
  const after = Object.fromEntries(await Promise.all(BUSINESS.map(async (c) => [c, await hash(c)])));
  assert.deepEqual(after, before_, 'reviewer access changed no business record');
  const views = (await db.collection('auditLog').where('action', '==', 'external_view').get()).docs.map((d) => d.data());
  assert.ok(views.length >= 18 && views.some((v) => v.entityId === U.pioneer.uid) && views.some((v) => v.entityId === U.diligence.uid), 'every reviewer access is in the audit log');
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
  const reviewerOk = new Set(['getReviewerData', 'getReviewerExport']);
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

test('revocation is immediate: the still-valid old token is refused, sign-in is disabled, the claim is removed, and it is audited', async () => {
  await call('revokeExternalUser', { uid: U.diligence.uid, reason: 'Engagement ended (test)' }, T.owner);
  // (PERMISSION_DENIED from the access record; UNAUTHENTICATED if the platform also rejects the disabled account's token)
  assert.ok(['PERMISSION_DENIED', 'UNAUTHENTICATED'].includes(await refused(call('getReviewerData', { view: 'overview' }, T.diligence))), 'old ID token no longer works');
  assert.ok(['PERMISSION_DENIED', 'UNAUTHENTICATED'].includes(await refused(call('getReviewerExport', { kind: 'book' }, T.diligence))));
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
