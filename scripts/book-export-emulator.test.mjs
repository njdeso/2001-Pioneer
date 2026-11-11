// Customer & Policy Export, end to end against the Firebase EMULATORS (auth, firestore, functions) — demo
// project, no credentials, no network, never dev or production. Run by CI:
//
//   npx firebase emulators:exec --only auth,firestore,functions --project demo-asm-export \
//     "node --test scripts/book-export-emulator.test.mjs"
//
// Seeds 1,250 synthetic customers and ~2,800 policies, then calls the deployed-style callables over HTTP
// with real (emulated) ID tokens: every record is exported, sorted, in both formats and scopes; policy
// numbers stay text; no financial columns; admin and staff only; nothing but the audit log and the file
// tracking document is written.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { parseCsv } from '../packages/shared/src/csv.ts';

const PROJECT = process.env.GCLOUD_PROJECT || 'demo-asm-export';
if (!PROJECT.startsWith('demo-')) throw new Error(`Refusing: ${PROJECT} is not a demo (emulator-only) project`);
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('Run inside firebase emulators:exec (emulator hosts not set)');
const FUNCTIONS = `http://127.0.0.1:5001/${PROJECT}/us-central1`;
initializeApp({ projectId: PROJECT });
const db = getFirestore();

const N = 1250;
const unwrap = (c) => (/^="(.*)"$/s.exec(c)?.[1].replace(/""/g, '"') ?? c);
const hash = async (col) => createHash('sha256').update(JSON.stringify((await db.collection(col).get()).docs.map((d) => [d.id, d.data()]).sort())).digest('hex');

async function token(uid, claims) {
  const custom = await getAuth().createCustomToken(uid, claims);
  const r = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=emulator-key`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }),
  });
  const j = await r.json();
  if (!j.idToken) throw new Error(`emulator sign-in failed: ${JSON.stringify(j)}`);
  return j.idToken;
}
async function call(name, data, idToken) {
  const r = await fetch(`${FUNCTIONS}/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(idToken ? { authorization: `Bearer ${idToken}` } : {}) }, body: JSON.stringify({ data }) });
  const j = await r.json();
  if (j.error) { const e = new Error(j.error.message); e.status = j.error.status; throw e; }
  return j.result;
}
const refused = async (p) => { try { await p; return null; } catch (e) { return e.status; } };

let T = {}; let seeded = { clients: [], policies: [] }; let before_ = {};
before(async () => {
  const carriers = { CA: 'Synthetic Mutual (TEST)', CB: 'Other Synthetic Co (TEST)', W1: 'Synthetic MGA (TEST)' };
  const brokers = { B50: 'Test Broker Fifty', UNASSIGNED: 'Unassigned' };
  const writes = [];
  for (const [id, name] of Object.entries(carriers)) writes.push([`carriers/${id}`, { name, code: id, kind: id === 'W1' ? 'wholesaler' : 'carrier', status: 'active' }]);
  for (const [id, name] of Object.entries(brokers)) writes.push([`brokers/${id}`, { name, code: id, shareBps: 5000, status: 'active' }]);
  for (let i = 0; i < N; i++) {
    const id = `SYNX-C${String(i).padStart(5, '0')}`;
    const c = { name: `${['Zulu', 'alpha', 'Bravo', 'charlie', 'Delta'][i % 5]} Synthetic Customer ${N - i}`, externalId: i % 3 ? `00${i}` : '', classification: i % 2 ? 'personal' : 'commercial', brokerId: i % 6 ? 'B50' : 'UNASSIGNED', status: i % 7 === 0 ? 'inactive' : 'active', synthetic: true };
    seeded.clients.push({ id, ...c }); writes.push([`clients/${id}`, c]);
    for (let k = 0; k < i % 5; k++) { // 0–4 policies; every 5th customer has none
      const pid = `SYNX-P${i}-${k}`;
      const p = { clientId: id, carrierId: k % 2 ? 'CB' : 'CA', wholesalerId: k === 3 ? 'W1' : null, policyNumber: k === 0 ? `000${i}` : k === 1 ? `61773${String(i).padStart(7, '0')}` : `SYN-${i}-${k}`, policyType: k % 2 ? 'Personal Auto' : 'Homeowners', line: 'personal', effectiveDate: '2026-01-01', expirationDate: '2027-01-01', status: k === 2 ? 'cancelled' : 'active', brokerId: 'B50',
        // financial fields present on the records — they must never reach the export
        premiumCents: 98765432, commissionRateBps: 1777, brokerShareBps: 4321, synthetic: true };
      seeded.policies.push({ id: pid, ...p }); writes.push([`policies/${pid}`, p]);
    }
  }
  for (let i = 0; i < writes.length; i += 450) { const b = db.batch(); for (const [path, v] of writes.slice(i, i + 450)) b.set(db.doc(path), v); await b.commit(); }
  T = { admin: await token('admin1', { role: 'admin' }), staff: await token('staff1', { role: 'staff' }), pioneer: await token('pioneer1', { role: 'pioneer' }), buyer: await token('buyer1', { role: 'buyer' }), none: await token('rando', {}) };
  before_ = { clients: await hash('clients'), policies: await hash('policies'), carriers: await hash('carriers'), brokers: await hash('brokers') };
});

test(`Customer Summary, all customers: all ${N} customers, alphabetical, from every record (not a screen page)`, async () => {
  const t0 = Date.now();
  const r = await call('exportBook', { format: 'customer_summary', scope: 'all', includeFileTracking: false }, T.admin);
  const rows = parseCsv(r.csv.slice(1));
  assert.equal(r.csv[0], '﻿');
  assert.equal(r.customers, N); assert.equal(rows.length - 1, N); assert.equal(r.totalClientRecords, N);
  assert.equal(new Set(rows.slice(1).map((x) => unwrap(x[2]))).size, N);
  const names = rows.slice(1).map((x) => x[0]);
  assert.deepEqual(names, [...names].sort(new Intl.Collator('en', { sensitivity: 'base', numeric: true }).compare));
  assert.equal(rows.slice(1).reduce((s, x) => s + Number(x[6]), 0), seeded.policies.length);
  console.log(`exported ${N} customers in ${Date.now() - t0} ms (${(r.csv.length / 1024).toFixed(0)} KB)`);
});

test('Policy Detail, all customers: every policy plus each customer without one; numbers kept as text', async () => {
  const r = await call('exportBook', { format: 'policy_detail', scope: 'all', includeFileTracking: false }, T.staff);
  const rows = parseCsv(r.csv.slice(1)).slice(1);
  const noPolicy = seeded.clients.filter((c) => !seeded.policies.some((p) => p.clientId === c.id)).length;
  assert.equal(r.policies, seeded.policies.length);
  assert.equal(rows.length, seeded.policies.length + noPolicy);
  const numbers = rows.map((x) => unwrap(x[5])).filter(Boolean);
  assert.deepEqual([...numbers].sort(), seeded.policies.map((p) => p.policyNumber).sort(), 'exactly the stored policy numbers');
  assert.ok(rows.some((x) => x[5] === '="0001"'), 'leading zeros');
  assert.ok(rows.some((x) => x[5] === '="617730000001"'), 'long numbers as text');
});

test('active customers only', async () => {
  const active = seeded.clients.filter((c) => c.status === 'active');
  const r = await call('exportBook', { format: 'customer_summary', scope: 'active', includeFileTracking: false }, T.admin);
  assert.equal(r.customers, active.length);
  const p = await call('exportBook', { format: 'policy_detail', scope: 'active', includeFileTracking: false }, T.admin);
  assert.equal(p.policies, seeded.policies.filter((x) => active.some((c) => c.id === x.clientId)).length);
  assert.ok(parseCsv(p.csv.slice(1)).slice(1).every((x) => x[3] === 'Active'));
});

test('no financial data in either format, even though the records carry premium, rate and broker share', async () => {
  for (const format of ['customer_summary', 'policy_detail']) {
    const { csv } = await call('exportBook', { format, scope: 'all', includeFileTracking: true }, T.admin);
    assert.doesNotMatch(parseCsv(csv.slice(1))[0].join('|'), /commission|premium|rate|share|compensation|amount/i);
    assert.doesNotMatch(csv, /98765432|987654\.32|1777|4321/);
  }
});

test('only admin and staff: Pioneer, buyer, no-role and signed-out users are refused', async () => {
  const input = { format: 'customer_summary', scope: 'all', includeFileTracking: false };
  assert.equal(await refused(call('exportBook', input, T.pioneer)), 'PERMISSION_DENIED');
  assert.equal(await refused(call('exportBook', input, T.buyer)), 'PERMISSION_DENIED');
  assert.equal(await refused(call('exportBook', input, T.none)), 'PERMISSION_DENIED');
  assert.equal(await refused(call('exportBook', input, null)), 'UNAUTHENTICATED');
  assert.equal(await refused(call('setFileTracking', { clientId: 'SYNX-C00001', fileReviewed: true, reviewStatus: 'reviewed', boxNumber: '1', transferDate: null }, T.pioneer)), 'PERMISSION_DENIED');
  assert.equal(await refused(call('exportBook', { format: 'everything', scope: 'all' }, T.admin)), 'INVALID_ARGUMENT');
});

test('physical file tracking: saved separately, exported when asked; customer records unchanged', async () => {
  await call('setFileTracking', { clientId: 'SYNX-C00001', fileReviewed: true, reviewStatus: 'reviewed', boxNumber: '007', transferDate: '2026-12-01' }, T.staff);
  assert.equal(await refused(call('setFileTracking', { clientId: 'NO-SUCH-CLIENT', fileReviewed: false, reviewStatus: 'not_started', boxNumber: '', transferDate: null }, T.admin)), 'NOT_FOUND');
  const r = await call('exportBook', { format: 'customer_summary', scope: 'all', includeFileTracking: true }, T.admin);
  const rows = parseCsv(r.csv.slice(1));
  assert.deepEqual(rows[0].slice(-4), ['File Reviewed', 'Review Status', 'Box Number', 'Transfer Date']);
  assert.deepEqual(rows.find((x) => unwrap(x[2]) === 'SYNX-C00001').slice(-4), ['Yes', 'Reviewed', '="007"', '2026-12-01']);
  const t = (await db.doc('fileTracking/SYNX-C00001').get()).data();
  assert.equal(t.boxNumber, '007');
});

test('exports change nothing: customer, policy, carrier and broker records identical; only audit entries added; no ledger', async () => {
  assert.deepEqual({ clients: await hash('clients'), policies: await hash('policies'), carriers: await hash('carriers'), brokers: await hash('brokers') }, before_);
  assert.equal((await db.collection('ledger').get()).size, 0);
  const audits = (await db.collection('auditLog').where('action', '==', 'export_book').get()).docs.map((d) => d.data());
  assert.ok(audits.length >= 6);
  assert.ok(audits.every((a) => /customers, \d+ policies/.test(a.summary) && !/Synthetic Customer/.test(a.summary)), 'audit records counts, not customer data');
});
