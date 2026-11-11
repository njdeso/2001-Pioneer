// Customer & Policy Export, end to end against the Firebase EMULATORS (auth, firestore, functions) — demo
// project, no credentials, no network, never dev or production. Run by CI:
//
//   npx firebase emulators:exec --only auth,firestore,functions --project demo-asm-export \
//     "node --import tsx --test scripts/book-export-emulator.test.mjs"
//
// Seeds 1,600 synthetic customers and ~3,200 policies, calls the real callable over HTTP with emulated ID
// tokens, and opens the returned .xlsx files with exceljs: every record, A–Z, active-only by POLICY status,
// policy numbers and IDs as text cells, no financial data, admin and staff only, nothing changed but the
// audit log.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import ExcelJS from 'exceljs';

const PROJECT = process.env.GCLOUD_PROJECT || 'demo-asm-export';
if (!PROJECT.startsWith('demo-')) throw new Error(`Refusing: ${PROJECT} is not a demo (emulator-only) project`);
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('Run inside firebase emulators:exec (emulator hosts not set)');
const FUNCTIONS = `http://127.0.0.1:5001/${PROJECT}/us-central1`;
initializeApp({ projectId: PROJECT });
const db = getFirestore();

const N = 1600;
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
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
/** Call the export and open the workbook: { res, ws, rows (cell values, header first), cells (raw exceljs cells) }. */
async function exportXlsx(input, idToken) {
  const res = await call('exportBook', input, idToken);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(res.fileBase64, 'base64'));
  const ws = wb.worksheets[0];
  const rows = []; const cells = [];
  ws.eachRow({ includeEmpty: false }, (row) => { rows.push(row.values.slice(1)); const c = []; row.eachCell({ includeEmpty: true }, (x) => c.push(x)); cells.push(c); });
  return { res, ws, rows, cells };
}

let T = {}; let seeded = { clients: [], policies: [] }; let before_ = {};
before(async () => {
  const carriers = { CA: 'Synthetic Mutual (TEST)', CB: 'Other Synthetic Co (TEST)', W1: 'Synthetic MGA (TEST)' };
  const brokers = { B50: 'Test Broker Fifty', UNASSIGNED: 'Unassigned' };
  const writes = [];
  for (const [id, name] of Object.entries(carriers)) writes.push([`carriers/${id}`, { name, code: id, kind: id === 'W1' ? 'wholesaler' : 'carrier', status: 'active' }]);
  for (const [id, name] of Object.entries(brokers)) writes.push([`brokers/${id}`, { name, code: id, shareBps: 5000, status: 'active' }]);
  for (let i = 0; i < N; i++) {
    const id = `SYNX-C${String(i).padStart(5, '0')}`;
    // Customer status is deliberately unrelated to policy status: "active only" must follow the policies.
    const c = { name: `${['Zulu', 'alpha', 'Bravo', 'charlie', 'Delta'][i % 5]} Synthetic Customer ${N - i}`, externalId: i % 3 ? `00${i}` : '', classification: 'personal', brokerId: 'B50', status: i % 7 === 0 ? 'inactive' : 'active', synthetic: true };
    seeded.clients.push({ id, ...c }); writes.push([`clients/${id}`, c]);
    for (let k = 0; k < i % 5; k++) { // 0–4 policies; every 5th customer has none; i % 10 === 1: only a cancelled one
      const pid = `SYNX-P${i}-${k}`;
      const status = i % 10 === 1 ? 'cancelled' : k === 2 ? 'expired' : 'active';
      const p = { clientId: id, carrierId: k % 2 ? 'CB' : 'CA', wholesalerId: k === 3 ? 'W1' : null, policyNumber: k === 0 ? `000${i}` : k === 1 ? `61773${String(i).padStart(7, '0')}` : `SYN-${i}-${k}`, policyType: k % 2 ? 'Personal Auto' : 'Homeowners', line: 'personal', effectiveDate: '2026-01-15', expirationDate: '2027-01-15', status, brokerId: i % 6 ? 'B50' : 'UNASSIGNED',
        // financial fields present on the records — they must never reach the export
        premiumCents: 98765432, commissionRateBps: 1777, brokerShareBps: 4321, synthetic: true };
      seeded.policies.push({ id: pid, ...p }); writes.push([`policies/${pid}`, p]);
    }
  }
  for (let i = 0; i < writes.length; i += 450) { const b = db.batch(); for (const [path, v] of writes.slice(i, i + 450)) b.set(db.doc(path), v); await b.commit(); }
  T = { admin: await token('admin1', { role: 'admin' }), staff: await token('staff1', { role: 'staff' }), pioneer: await token('pioneer1', { role: 'pioneer' }), buyer: await token('buyer1', { role: 'buyer' }), none: await token('rando', {}) };
  before_ = { clients: await hash('clients'), policies: await hash('policies'), carriers: await hash('carriers'), brokers: await hash('brokers') };
});

const activeOf = (cid) => seeded.policies.filter((p) => p.clientId === cid && p.status === 'active').length;

test(`Folder Checklist, all records: all ${N} customers, A–Z, from every record (not a screen page)`, async () => {
  const t0 = Date.now();
  const { res, ws, rows, cells } = await exportXlsx({ format: 'folder_checklist', scope: 'all' }, T.admin);
  assert.deepEqual(rows[0], ['No.', 'Customer Name', 'Customer ID', 'Active Policies', 'File Located', 'File Reviewed', 'Ready for Pioneer', 'Box Number']);
  assert.equal(rows.length - 1, N); assert.equal(res.customers, N); assert.equal(res.totalClientRecords, N);
  assert.equal(new Set(rows.slice(1).map((r) => r[2])).size, N);
  const names = rows.slice(1).map((r) => r[1]);
  assert.deepEqual(names, [...names].sort(collator.compare));
  const one = cells[rows.findIndex((r) => r[2] === '001')];
  assert.equal(one[2].value, '001'); assert.equal(one[2].numFmt, '@');
  assert.ok(one.slice(4, 8).every((c) => c.value === null && c.border?.top), 'blank, bordered boxes to mark by hand');
  assert.equal(ws.pageSetup.printTitlesRow, '1:1');
  console.log(`checklist of ${N} customers in ${Date.now() - t0} ms (${(res.fileBase64.length * 0.75 / 1024).toFixed(0)} KB xlsx)`);
});

test('Folder Checklist, active only: exactly the customers with at least one active POLICY, with the right counts', async () => {
  const { res, rows } = await exportXlsx({ format: 'folder_checklist', scope: 'active' }, T.staff);
  const expected = seeded.clients.filter((c) => activeOf(c.id) > 0);
  assert.equal(rows.length - 1, expected.length); assert.equal(res.customers, expected.length);
  const byId = new Map(seeded.clients.map((c) => [c.externalId || c.id, c]));
  for (const r of rows.slice(1)) assert.equal(r[3], activeOf(byId.get(r[2]).id));
  // inactive customer WITH active policies is included; active customer with only a cancelled policy is not
  assert.ok(rows.some((r) => r[2] === '007' && r[3] === 2), 'C7: customer status inactive, two active policies');
  assert.ok(!rows.some((r) => r[2] === '0011'), 'C11: only a cancelled policy');
});

test('Policy Detail, all records and active only: every policy, numbers as text, real dates', async () => {
  const all = await exportXlsx({ format: 'policy_detail', scope: 'all' }, T.admin);
  assert.deepEqual(all.rows[0], ['Customer Name', 'Policy Number', 'Carrier', 'Policy Type', 'Effective Date', 'Expiration Date', 'Policy Status', 'Broker']);
  assert.equal(all.rows.length - 1, seeded.policies.length);
  assert.deepEqual(all.rows.slice(1).map((r) => r[1]).sort(), seeded.policies.map((p) => p.policyNumber).sort(), 'exactly the stored policy numbers, as text');
  assert.ok(all.cells.slice(1).every((c) => typeof c[1].value === 'string' && c[1].numFmt === '@'));
  assert.ok(all.rows.some((r) => r[1] === '0002'), 'leading zeros'); assert.ok(all.rows.some((r) => r[1] === '617730000002'), 'long numbers');
  assert.ok(all.cells[1][4].value instanceof Date);
  const act = await exportXlsx({ format: 'policy_detail', scope: 'active' }, T.admin);
  assert.equal(act.rows.length - 1, seeded.policies.filter((p) => p.status === 'active').length);
  assert.ok(act.rows.slice(1).every((r) => r[6] === 'Active'));
});

test('no financial data in either export, even though the records carry premium, rate and broker share', async () => {
  for (const format of ['folder_checklist', 'policy_detail']) {
    const { rows } = await exportXlsx({ format, scope: 'all' }, T.admin);
    assert.doesNotMatch(rows[0].join('|'), /commission|premium|rate|share|compensation|amount/i);
    assert.doesNotMatch(JSON.stringify(rows), /98765432|987654\.32|1777|4321/);
  }
});

test('only admin and staff: Pioneer, buyer, no-role and signed-out users are refused; bad input rejected', async () => {
  const input = { format: 'folder_checklist', scope: 'all' };
  assert.equal(await refused(call('exportBook', input, T.pioneer)), 'PERMISSION_DENIED');
  assert.equal(await refused(call('exportBook', input, T.buyer)), 'PERMISSION_DENIED');
  assert.equal(await refused(call('exportBook', input, T.none)), 'PERMISSION_DENIED');
  assert.equal(await refused(call('exportBook', input, null)), 'UNAUTHENTICATED');
  assert.equal(await refused(call('exportBook', { format: 'everything', scope: 'all' }, T.admin)), 'INVALID_ARGUMENT');
  assert.equal(await refused(call('exportBook', { ...input, includeFinancials: true }, T.admin)), 'INVALID_ARGUMENT');
});

test('exports change nothing: customer, policy, carrier and broker records identical; only audit entries added; no ledger', async () => {
  assert.deepEqual({ clients: await hash('clients'), policies: await hash('policies'), carriers: await hash('carriers'), brokers: await hash('brokers') }, before_);
  assert.equal((await db.collection('ledger').get()).size, 0);
  assert.equal((await db.collection('fileTracking').get()).size, 0);
  const audits = (await db.collection('auditLog').where('action', '==', 'export_book').get()).docs.map((d) => d.data());
  assert.equal(audits.length, 6, 'one audit entry per successful export (6), none for refused calls');
  assert.ok(audits.every((a) => /\d+ customers, \d+ (active )?policies, \d+ rows/.test(a.summary) && !/Synthetic Customer/.test(a.summary)), 'audit records counts, not customer data');
  assert.ok(audits.some((a) => a.actorRole === 'staff' || a.actorUid === 'staff1' || JSON.stringify(a).includes('staff1')));
});
