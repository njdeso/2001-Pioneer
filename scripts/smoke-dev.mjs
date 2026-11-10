#!/usr/bin/env node
// Live smoke test of the deployed functions in the DEVELOPMENT project only (pioneer-2001-dev).
//
//   1. Test AI connection   (checkAiConnection: key, Models API, model, tiny request)
//   2. AI reads a PDF       (synthetic non-Travelers statement → processStatement → reconciled exactly)
//   3. Interrupted upload   (register, upload never arrives, process fails "not_uploaded",
//                            re-register the same file → resumes into the SAME record → processes)
//   4. True duplicate       (same file again after it is stored → still reported as duplicate)
//   5. Stage 3B matching    (fresh synthetic statement SYN3B-AUTO-…: automatic matching of every
//                            scenario, broker percentages, negative commission, totals; manual assign /
//                            unmatch / re-run keeps manual / return to automatic; audit entries;
//                            extracted values and policies unchanged; nothing posted to the ledger)
//   6. Stage 3C posting     (same statement: approval blocked until ambiguous/unreviewed lines are
//                            resolved; staff cannot approve or post; approve; matching locked; concurrent
//                            and repeated posting post exactly once; ledger entries, allocations, suspense,
//                            adjustment; rolling-12-month report totals; reversal nets to zero; re-post;
//                            retained commission with idempotent request ID and reversal; audit trail)
//
// Synthetic data only: fictional carrier, insureds and policy numbers. Nothing is read from or
// written to production. Prints no API keys (the AI key never leaves Secret Manager).
//
// Credentials: Application Default Credentials for the pioneer-2001-dev deployer service account
// (in GitHub Actions, a short-lived Workload Identity Federation credential; no key file).
// SMOKE_SERVICE_ACCOUNT = that service account's email (used to sign the test user's custom token
// through the IAM signBlob API, which needs no private key).
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { exportedCallables } from './lib/callables.mjs';
import { getStorage } from 'firebase-admin/storage';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { assertDevProjectNumber } from './lib/dev-guard.mjs';
import { seedBook, writeStatement, LINES, EXPECTED_SUMMARY, PAYER_ID } from './lib/synthetic-3b.mjs';

const DEV = 'pioneer-2001-dev';
const PROD = 'pioneer-285cf';
const REGION = 'us-central1'; // must equal FUNCTIONS_REGION in functions/src/options.ts (checked in CI)
const MODEL = process.env.SMOKE_AI_MODEL || 'claude-sonnet-5-5';

// ---------------------------------------------------------------- guards
const rc = JSON.parse(readFileSync('.firebaserc', 'utf8'));
if (rc.projects?.dev !== DEV) throw new Error(`.firebaserc dev alias is ${rc.projects?.dev}, expected ${DEV}`);
const SA = process.env.SMOKE_SERVICE_ACCOUNT ?? '';
if (!SA.endsWith(`@${DEV}.iam.gserviceaccount.com`) || SA.includes(PROD)) {
  throw new Error(`Refusing: SMOKE_SERVICE_ACCOUNT must be a ${DEV} service account (got "${SA || 'nothing'}").`);
}
const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (credPath && existsSync(credPath)) {
  const c = JSON.parse(readFileSync(credPath, 'utf8'));
  if (c.type === 'service_account') throw new Error('Refusing: a downloaded service-account key was supplied; this test runs only with keyless credentials.');
  if (c.project_id && c.project_id !== DEV) throw new Error(`Refusing: credentials are for "${c.project_id}", not ${DEV}.`);
}

const credential = applicationDefault();
initializeApp({ credential, projectId: DEV, serviceAccountId: SA });
// Second, independent check: Google must report the dev project NUMBER for these credentials.
await assertDevProjectNumber(DEV, async () => (await credential.getAccessToken()).access_token);
const db = getFirestore();

// ---------------------------------------------------------------- reporting
const results = [];
const summary = (line) => { console.log(line); if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`); };
function record(name, pass, detail) { results.push({ name, pass }); summary(`| ${pass ? '✅' : '❌'} | ${name} | ${String(detail).replace(/\|/g, '/').replace(/\n/g, ' ')} |`); }

// ---------------------------------------------------------------- helpers
async function googleToken() { return (await credential.getAccessToken()).access_token; }

async function devWebConfig() {
  const h = { authorization: `Bearer ${await googleToken()}` };
  const list = await (await fetch(`https://firebase.googleapis.com/v1beta1/projects/${DEV}/webApps`, { headers: h })).json();
  const app = (list.apps ?? []).find((a) => a.state !== 'DELETED');
  if (!app) throw new Error(`No Firebase web app exists in ${DEV}. Add one in Firebase console → Project settings → Your apps → Web.`);
  const cfg = await (await fetch(`https://firebase.googleapis.com/v1beta1/projects/${DEV}/webApps/${app.appId}/config`, { headers: h })).json();
  if (!cfg.apiKey) throw new Error('Could not read the dev web app config.');
  return cfg;
}

async function adminIdToken(apiKey, uid = 'ci-smoke-admin', role = 'admin') {
  const custom = await getAuth().createCustomToken(uid, { role });
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }),
  });
  const j = await r.json();
  if (!j.idToken) throw new Error(`Sign-in for the smoke-test user failed: ${j.error?.message ?? r.status}`);
  return j.idToken;
}

/**
 * Deployed functions as Google reports them: name → { region, url }. The smoke test calls the URL
 * Google returns instead of guessing it, and checks the region matches the one the app is built for.
 */
async function deployedFunctions() {
  const h = { authorization: `Bearer ${await googleToken()}` };
  const out = new Map();
  let pageToken = '';
  do {
    const r = await fetch(`https://cloudfunctions.googleapis.com/v2/projects/${DEV}/locations/-/functions?pageSize=200${pageToken ? `&pageToken=${pageToken}` : ''}`, { headers: h });
    const j = await r.json();
    if (!r.ok) throw new Error(`Listing deployed functions failed: HTTP ${r.status} ${j.error?.message ?? ''}`);
    for (const f of j.functions ?? []) {
      const [, , , region, , name] = f.name.split('/'); // projects/P/locations/REGION/functions/NAME
      out.set(name, { region, url: f.url ?? f.serviceConfig?.uri, state: f.state, service: f.serviceConfig?.service ?? null, updated: f.updateTime ?? null });
    }
    pageToken = j.nextPageToken ?? '';
  } while (pageToken);
  return out;
}

let ID_TOKEN = '';
let STAFF_TOKEN = '';
let WEB_API_KEY = '';
let FUNCTIONS = new Map();
/** Does the Cloud Run service behind a function allow public invocation (allUsers → run.invoker)? */
async function invokerStatus(fn) {
  if (!fn.service) return 'unknown (no service name)';
  const r = await fetch(`https://run.googleapis.com/v2/${fn.service}:getIamPolicy`, { headers: { authorization: `Bearer ${await googleToken()}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return `could not read IAM policy (HTTP ${r.status} ${j.error?.message ?? ''})`;
  const inv = (j.bindings ?? []).find((b) => b.role === 'roles/run.invoker');
  return inv?.members?.includes('allUsers') ? 'allUsers can invoke' : `no public invoker (run.invoker: ${inv?.members?.join(', ') || 'none'})`;
}

/** Firebase callable protocol: POST JSON {"data": …} with the user's Firebase ID token as Bearer. */
async function call(name, data, attempt = 1, token = ID_TOKEN) {
  const fn = FUNCTIONS.get(name);
  if (!fn) throw new Error(`${name} is not deployed in ${DEV}.`);
  if (fn.region !== REGION) throw new Error(`${name} is deployed in ${fn.region}, but the app calls ${REGION}.`);
  // A function created moments ago can answer 401/403 from Cloud Run until its public-invoker IAM
  // binding propagates (usually under 2 minutes). Wait for that, up to ~4 minutes, then report the
  // actual IAM policy instead of retrying forever. Callable errors (JSON) are never retried.
  const r0 = await fetch(fn.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ data }), signal: AbortSignal.timeout(560_000) });
  if ((r0.status === 401 || r0.status === 403) && !(r0.headers.get('content-type') ?? '').includes('json')) {
    if (attempt < 9) { await new Promise((res) => setTimeout(res, 30_000)); return call(name, data, attempt + 1, token); }
    throw new Error(`${name}: Cloud Run still answers HTTP ${r0.status} after ${attempt} tries; IAM: ${await invokerStatus(fn)}`);
  }
  if (attempt > 1) summary(`\n_${name} became callable after ${attempt - 1} wait(s) of 30 s (new-function IAM propagation)._\n`);
  return parseCallable(name, r0);
}

async function parseCallable(name, r) {
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { throw new Error(`${name}: HTTP ${r.status}, not a callable JSON response (${text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)})`); }
  if (j.error) throw new Error(`${name}: ${j.error.status ?? r.status} ${j.error.message}`);
  return j.result;
}

async function syntheticStatement(label) {
  const run = `${label}-${randomUUID().slice(0, 8)}`;
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let y = 740;
  const line = (t, f = font, size = 10) => { page.drawText(t, { x: 40, y, size, font: f }); y -= 18; };
  line('SYNTHETIC MUTUAL INSURANCE COMPANY', bold, 14);
  line('AGENT COMMISSION STATEMENT - TEST DATA ONLY, NOT A REAL STATEMENT');
  line('Agency: DEV TEST AGENCY        Agency code: DEV001');
  line('Statement period: October 2026        Statement date: 10/31/2026');
  line(`Reference: ${run}`);
  y -= 10;
  const cols = [40, 200, 300, 380, 460, 510];
  const row = (cells, f = font) => { cells.forEach((c, i) => page.drawText(c, { x: cols[i], y, size: 9, font: f })); y -= 16; };
  row(['INSURED', 'POLICY NUMBER', 'EFFECTIVE', 'PREMIUM', 'RATE', 'COMMISSION'], bold);
  row(['TEST INSURED ALPHA', 'SM-100001', '10/01/2026', '1,200.00', '15%', '180.00']);
  row(['TEST INSURED BETA', 'SM-100002', '10/05/2026', '800.00', '10%', '80.00']);
  row(['TEST INSURED GAMMA', 'SM-100003', '10/12/2026', '-300.00', '15%', '-45.00']);
  y -= 6;
  row(['TOTAL COMMISSION PAYABLE', '', '', '1,700.00', '', '215.00'], bold);
  const bytes = Buffer.from(await pdf.save());
  return { bytes, fileName: `SMOKE-${run}.pdf`, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function putFile(bucket, path, bytes) {
  await getStorage().bucket(bucket).file(path).save(bytes, { contentType: 'application/pdf', resumable: false });
}

const readOk = (p) => p && (p.status === 'needs_review' || p.status === 'discrepancy') && p.lines === 3 && p.reconciled === true;
const describe = (p) => p.status === 'extraction_failed' ? `extraction_failed: ${p.failure?.code} — ${p.failure?.message}` : `${p.status}, ${p.lines} lines, reconciled=${p.reconciled}`;

// ---------------------------------------------------------------- Stage 3B matching
const $ = (c) => (c === null || c === undefined ? '—' : `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toFixed(2)}`);
const stable = (o) => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
const extractedOnly = (d) => { const { match, ...rest } = d; return stable(rest); };

async function stage3b() {
  summary('\n#### Stage 3B — commission matching (synthetic data)\n');
  summary('| | Check | Result |');
  summary('|---|---|---|');
  // Nothing from earlier runs is deleted. The ledger is append-only, also in dev: every run posts to a
  // NEW statement (SYN3B-AUTO-<timestamp>) and reverses everything it posts, so earlier postings,
  // their reversals and manual tests on these statements stay intact and dev totals still net to zero.
  // The read-only ledger audit (scripts/audit-dev-ledger.mts) runs before and after this test.
  await seedBook(db, FieldValue);
  const sid = `SYN3B-AUTO-${Date.now()}`;
  const ref = await writeStatement(db, FieldValue, sid, 'Stage 3B automated test');

  const ledgerBefore = (await db.collection('ledger').count().get()).data().count;
  const policiesBefore = stable((await db.collection('policies').where('synthetic', '==', true).get()).docs.map((d) => [d.id, d.data()]));
  const linesBefore = new Map((await ref.collection('lines').get()).docs.map((d) => [d.id, extractedOnly(d.data())]));
  const lineMatch = async (id) => (await ref.collection('lines').doc(id).get()).get('match');

  // 1. Automatic matching
  const run1 = await call('runStatementMatching', { statementId: sid });
  const after1 = new Map((await ref.collection('lines').get()).docs.map((d) => [d.id, d.get('match')]));
  LINES.forEach((l, i) => {
    const id = String(i + 1).padStart(5, '0');
    const m = after1.get(id) ?? {};
    const e = l.expect;
    const errs = [];
    if (m.status !== e.status) errs.push(`status ${m.status}`);
    if (e.policyId && m.policyId !== e.policyId) errs.push(`policy ${m.policyId}`);
    if (e.reason && !(m.reasons ?? []).includes(e.reason)) errs.push(`reasons ${(m.reasons ?? []).join(',')}`);
    if (e.confidence && m.confidence !== e.confidence) errs.push(`confidence ${m.confidence}`);
    if (e.brokerId && m.brokerId !== e.brokerId) errs.push(`broker ${m.brokerId}`);
    if (e.shareBps !== undefined && m.brokerShareBps !== e.shareBps) errs.push(`share ${m.brokerShareBps}`);
    if (e.shareSource && m.brokerShareSource !== e.shareSource) errs.push(`share source ${m.brokerShareSource}`);
    if (e.brokerCents !== undefined && (m.brokerCents !== e.brokerCents || m.agencyCents !== e.agencyCents)) errs.push(`split ${$(m.brokerCents)}/${$(m.agencyCents)}`);
    const split = m.status === 'matched' ? ` · broker ${$(m.brokerCents)} (${(m.brokerShareBps ?? 0) / 100}%${m.brokerShareSource === 'policy' ? ' policy' : ''}) / agency ${$(m.agencyCents)}` : '';
    record(`Auto: line ${i + 1} "${l.policyNumberRaw}" ${$(l.paid)}`, errs.length === 0,
      `${m.status}${m.policyId ? ` → ${m.policyId}` : ''}${split}; ${(m.reasons ?? []).join(', ')}${errs.length ? ` — EXPECTED ${e.status}${e.policyId ? ` ${e.policyId}` : ''}: ${errs.join('; ')}` : ''}`);
  });
  const sumErrs = Object.entries(EXPECTED_SUMMARY).filter(([k, v]) => run1[k] !== v).map(([k, v]) => `${k} ${run1[k]} ≠ ${v}`);
  record('Auto: statement totals and balance', sumErrs.length === 0,
    `commission ${$(run1.commissionCents)} = matched ${$(run1.matchedCommissionCents)} + ambiguous ${$(run1.ambiguousCommissionCents)} + unmatched ${$(run1.unmatchedCommissionCents)}; broker ${$(run1.brokerCents)} + agency ${$(run1.agencyCents)}; balanced=${run1.balanced}${sumErrs.length ? ` — ${sumErrs.join('; ')}` : ''}`);

  // 2. Manual: confirm the ambiguous line 2 by assigning its policy
  const a = await call('setLineMatch', { action: 'assign', statementId: sid, lineId: '00002', policyId: 'SYN3B-P-BETA', note: 'smoke test: confirm ambiguous line' });
  record('Manual: assign ambiguous line 2 to its policy', a.match.status === 'matched' && a.match.method === 'manual' && a.match.brokerId === 'SYN3B-B40' && a.match.brokerCents === 2000 && a.match.agencyCents === 3000,
    `${a.match.status} (${a.match.method}) → ${a.match.policyId}; broker ${$(a.match.brokerCents)} (40%) / agency ${$(a.match.agencyCents)}`);
  // 3. Manual: mark line 1 unmatched
  const u = await call('setLineMatch', { action: 'unmatch', statementId: sid, lineId: '00001', note: 'smoke test: unmatch' });
  record('Manual: mark line 1 unmatched', u.match.status === 'unmatched' && u.match.method === 'manual' && u.match.brokerCents === 0, `${u.match.status} (${u.match.method})`);
  // 4. Re-running automatic matching keeps both manual decisions
  const run2 = await call('runStatementMatching', { statementId: sid });
  const [m1, m2] = [await lineMatch('00001'), await lineMatch('00002')];
  record('Re-run automatic matching keeps manual decisions', run2.keptManual === 2 && m1.status === 'unmatched' && m1.method === 'manual' && m2.status === 'matched' && m2.method === 'manual',
    `kept ${run2.keptManual} manual; line 1 ${m1.status}/${m1.method}, line 2 ${m2.status}/${m2.method}`);
  // 5. Manual: return line 1 to automatic
  const v = await call('setLineMatch', { action: 'auto', statementId: sid, lineId: '00001', note: 'smoke test: revert' });
  record('Manual: return line 1 to automatic matching', v.match.status === 'matched' && v.match.method === 'auto' && v.match.policyId === 'SYN3B-P-ALPHA', `${v.match.status} (${v.match.method}) → ${v.match.policyId}`);
  const s = v.summary;
  record('Totals after manual changes', s.matched === 7 && s.matchedCommissionCents === 24500 && s.brokerCents === 10600 && s.agencyCents === 13900 && s.balanced === true,
    `matched ${s.matched}, ${$(s.matchedCommissionCents)}; broker ${$(s.brokerCents)}, agency ${$(s.agencyCents)}; balanced=${s.balanced}`);

  // 6. Audit trail
  const auditFor = async (entityId) => (await db.collection('auditLog').where('entityId', '==', entityId).get()).docs.map((d) => d.data());
  const a2 = await auditFor(`${sid}/00002`);
  const a1 = await auditFor(`${sid}/00001`);
  const aS = await auditFor(sid);
  const assign = a2.find((x) => x.action === 'match_manual_assign');
  const auditOk = !!assign && assign.changes?.status?.before === 'ambiguous' && assign.changes?.status?.after === 'matched' && /confirm ambiguous/.test(assign.summary)
    && a1.some((x) => x.action === 'match_manual_unmatch') && a1.some((x) => x.action === 'match_revert_auto')
    && aS.filter((x) => x.action === 'match_auto_run').length === 2;
  record('Audit log records every change with before/after and note', auditOk,
    `line 2: ${a2.map((x) => x.action).join(', ')}; line 1: ${a1.map((x) => x.action).join(', ')}; statement: ${aS.filter((x) => x.action === 'match_auto_run').length} automatic runs`);

  // 7. Data protection
  const linesAfter = new Map((await ref.collection('lines').get()).docs.map((d) => [d.id, extractedOnly(d.data())]));
  const unchanged = [...linesBefore].every(([id, h]) => linesAfter.get(id) === h);
  record('Extracted line values never changed', unchanged && linesAfter.size === linesBefore.size, `${linesAfter.size} lines compared field by field`);
  const policiesAfter = stable((await db.collection('policies').where('synthetic', '==', true).get()).docs.map((d) => [d.id, d.data()]));
  record('Clients and policies not modified by matching', policiesAfter === policiesBefore, 'synthetic policies compared field by field');
  const ledgerAfter = (await db.collection('ledger').count().get()).data().count;
  const ledgerForStmt = (await db.collection('ledger').where('statementId', '==', sid).count().get()).data().count;
  const stmt = (await ref.get()).data();
  record('Nothing posted to financial reports', ledgerAfter === ledgerBefore && ledgerForStmt === 0 && (stmt.postedCents ?? 0) === 0,
    `ledger entries ${ledgerBefore} → ${ledgerAfter}; for this statement ${ledgerForStmt}; posted ${$(stmt.postedCents ?? 0)}`);
  return { sid, ref, policiesBefore, linesBefore };
}

// ---------------------------------------------------------------- Stage 3C posting
const WINDOW = { start: '2025-11', end: '2026-10' }; // rolling 12 months ending with the synthetic statement month
async function windowTotals() {
  const docs = (await db.collection('ledger').where('statementPeriod', '>=', WINDOW.start).where('statementPeriod', '<=', WINDOW.end).get()).docs.map((d) => d.data());
  const counted = docs.filter((e) => e.postingStatus === 'posted' || e.postingStatus === 'reversed');
  return { amount: counted.reduce((s, e) => s + e.amountCents, 0), broker: counted.reduce((s, e) => s + (e.brokerCents ?? 0), 0), count: counted.length };
}
async function expectRejected(promise) {
  try { await promise; return { rejected: false, message: 'succeeded' }; } catch (e) { return { rejected: true, message: e instanceof Error ? e.message : String(e) }; }
}

async function stage3c({ sid, ref, policiesBefore, linesBefore }) {
  summary('\n#### Stage 3C — approval, posting, reversal, retained commission (synthetic data)\n');
  summary('| | Check | Result |');
  summary('|---|---|---|');
  const ledgerFor = async (q = sid) => (await db.collection('ledger').where('statementId', '==', q).get()).docs.map((d) => ({ id: d.id, ...d.data() }));

  // 1. Approval is blocked while lines are ambiguous or unreviewed
  const blocked = await expectRejected(call('approveStatement', { statementId: sid }));
  record('Approval blocked by ambiguous and unreviewed lines', blocked.rejected && /ambiguous/.test(blocked.message) && /not yet reviewed/.test(blocked.message), blocked.message.slice(0, 220));

  // 2. Resolve: line 5 (truncated number) matched by the owner; lines 3 and 9 marked unmatched → suspense
  await call('setLineMatch', { action: 'assign', statementId: sid, lineId: '00005', policyId: 'SYN3B-P-DELTA', note: 'smoke: truncated number identified' });
  await call('setLineMatch', { action: 'unmatch', statementId: sid, lineId: '00003', note: 'smoke: other carrier — to suspense' });
  await call('setLineMatch', { action: 'unmatch', statementId: sid, lineId: '00009', note: 'smoke: unknown policy — to suspense' });

  // 3. Authorization: staff cannot approve
  const staffApprove = await expectRejected(call('approveStatement', { statementId: sid }, 1, STAFF_TOKEN));
  record('Staff cannot approve', staffApprove.rejected && /permission/i.test(staffApprove.message), staffApprove.message.slice(0, 160));

  // 4. Approve. If a statement from the same carrier and month is already posted (e.g. a manual test
  //    posting in dev), approval must first require the "separate statement" confirmation.
  const before = await windowTotals();
  const otherPosted = (await db.collection('statements').where('payerId', '==', PAYER_ID).where('statementMonth', '==', '2026-10').where('status', '==', 'posted').get()).docs.map((d) => d.id).filter((id) => id !== sid);
  if (otherPosted.length) {
    const dup = await expectRejected(call('approveStatement', { statementId: sid, note: 'smoke test approval' }));
    record('Another posted statement for this carrier and month requires "separate statement" confirmation', dup.rejected && /separate statement|duplicate/i.test(dup.message), `${otherPosted.join(', ')}: ${dup.message.slice(0, 160)}`);
  }
  const confirm = otherPosted.length > 0;
  const ap = await call('approveStatement', { statementId: sid, note: 'smoke test approval', confirmNotDuplicate: confirm });
  const expected = { entries: 10, amountCents: 41000, brokerCents: 14200, agencyCents: 26800, suspenseCents: 8000, adjustmentsCents: -500 };
  const apErr = Object.entries(expected).filter(([k, v]) => ap.totals[k] !== v).map(([k, v]) => `${k} ${ap.totals[k]} ≠ ${v}`);
  record('Approve: plan totals', ap.status === 'approved' && apErr.length === 0,
    `${ap.totals.entries} entries, ${$(ap.totals.amountCents)}; broker ${$(ap.totals.brokerCents)}, agency ${$(ap.totals.agencyCents)}, suspense ${$(ap.totals.suspenseCents)}, adjustments ${$(ap.totals.adjustmentsCents)}${apErr.length ? ` — ${apErr.join('; ')}` : ''}`);
  const locked = await expectRejected(call('setLineMatch', { action: 'unmatch', statementId: sid, lineId: '00001' }));
  record('Matching is locked after approval', locked.rejected, locked.message.slice(0, 160));
  const staffPost = await expectRejected(call('postStatement', { statementId: sid }, 1, STAFF_TOKEN));
  record('Staff cannot post', staffPost.rejected && /permission/i.test(staffPost.message), staffPost.message.slice(0, 160));

  // 5. Post twice at the same time: exactly one succeeds
  const both = await Promise.allSettled([call('postStatement', { statementId: sid }), call('postStatement', { statementId: sid })]);
  const ok = both.filter((r) => r.status === 'fulfilled').length;
  let entries = await ledgerFor();
  record('Concurrent posting posts exactly once', ok === 1 && entries.length === 10, `${ok} of 2 calls succeeded; ${entries.length} ledger entries`);
  const again = await expectRejected(call('postStatement', { statementId: sid }));
  entries = await ledgerFor();
  record('Posting again is refused (no duplicate entries)', again.rejected && entries.length === 10, `${again.message.slice(0, 120)}; ${entries.length} entries`);

  // 6. Ledger content
  const sum = (f) => entries.reduce((s, e) => s + f(e), 0);
  const byLine = Object.fromEntries(entries.map((e) => [e.lineId ?? e.id, e]));
  const susp = entries.filter((e) => e.level === 'suspense');
  const adj = entries.filter((e) => e.level === 'carrier');
  const l7 = byLine['00007'];
  const l5 = byLine['00005'];
  const contentOk = sum((e) => e.amountCents) === 41000 && sum((e) => e.brokerCents) === 14200 && sum((e) => e.agencyCents) === 26800
    && entries.every((e) => e.brokerCents + e.agencyCents === e.amountCents && e.statementPeriod === '2026-10' && e.postingStatus === 'posted' && e.postingId === `${sid}__p1`)
    && susp.length === 2 && susp.every((e) => e.policyId === null && e.brokerCents === 0)
    && adj.length === 1 && adj[0].amountCents === -500 && adj[0].agencyCents === -500
    && l7?.brokerShareBps === 3000 && l7?.brokerShareSource === 'policy' && l7?.brokerCents === -1350 && l7?.agencyCents === -3150 && l7?.classification === 'cancellation'
    && l5?.policyId === 'SYN3B-P-DELTA' && l5?.brokerCents === 3600 && l5?.matchMethod === 'manual';
  record('Ledger entries: amounts, allocations, suspense, adjustment, chargeback, period', contentOk,
    `sum ${$(sum((e) => e.amountCents))}, broker ${$(sum((e) => e.brokerCents))}, agency ${$(sum((e) => e.agencyCents))}; suspense ${susp.length}; adjustment ${adj.length}; line 7 ${$(l7?.brokerCents)}/${$(l7?.agencyCents)} @${(l7?.brokerShareBps ?? 0) / 100}% ${l7?.brokerShareSource}`);
  const stmtPosted = (await ref.get()).data();
  record('Statement marked posted', stmtPosted.status === 'posted' && stmtPosted.postedCents === 41000, `${stmtPosted.status}, posted ${$(stmtPosted.postedCents)}`);

  // 7. Reports: the rolling-12-month window moves by exactly the posted amounts
  const afterPost = await windowTotals();
  record('Rolling-12-month report includes the posting', afterPost.amount - before.amount === 41000 && afterPost.broker - before.broker === 14200,
    `window ${WINDOW.start}–${WINDOW.end}: ${$(before.amount)} → ${$(afterPost.amount)} (+${$(afterPost.amount - before.amount)}); broker +${$(afterPost.broker - before.broker)}`);

  // 8. Reversal
  const staffRev = await expectRejected(call('reverseStatementPosting', { statementId: sid, reason: 'smoke' }, 1, STAFF_TOKEN));
  record('Staff cannot reverse', staffRev.rejected && /permission/i.test(staffRev.message), staffRev.message.slice(0, 120));
  const rv = await call('reverseStatementPosting', { statementId: sid, reason: 'smoke test: reversal' });
  entries = await ledgerFor();
  const originals = entries.filter((e) => !e.reversalOf);
  const revs = entries.filter((e) => e.reversalOf);
  const net = entries.reduce((s, e) => s + e.amountCents, 0);
  const pairsOk = revs.length === 10 && originals.every((o) => o.postingStatus === 'reversed' && revs.some((r) => r.reversalOf === o.id && r.amountCents === -o.amountCents && r.brokerCents === -o.brokerCents));
  const afterRev = await windowTotals();
  const stmtRev = (await ref.get()).data();
  record('Reversal: exact negative twins, report nets to zero, statement back in review', rv.reversedEntries === 10 && pairsOk && net === 0 && afterRev.amount === before.amount && afterRev.broker === before.broker && stmtRev.status === 'needs_review' && stmtRev.postedCents === 0,
    `${revs.length} reversals; net ${$(net)}; window ${$(afterRev.amount)} (before posting ${$(before.amount)}); statement ${stmtRev.status}`);
  const revAgain = await expectRejected(call('reverseStatementPosting', { statementId: sid, reason: 'again' }));
  record('Reversing again is refused', revAgain.rejected, revAgain.message.slice(0, 120));

  // 9. Correct and post again (next posting number, new entry IDs), then reverse to leave dev net zero
  await call('approveStatement', { statementId: sid, note: 'smoke: re-approval', confirmNotDuplicate: confirm });
  const p2 = await call('postStatement', { statementId: sid });
  const second = (await ledgerFor()).filter((e) => e.postingId === `${sid}__p2` && !e.reversalOf);
  record('Re-post after reversal uses posting 2 with new entries', p2.postingId === `${sid}__p2` && second.length === 10 && second.reduce((s, e) => s + e.amountCents, 0) === 41000, `${p2.postingId}: ${second.length} entries, ${$(second.reduce((s, e) => s + e.amountCents, 0))}`);
  await call('reverseStatementPosting', { statementId: sid, reason: 'smoke test: cleanup' });

  // 10. Retained commission
  const requestId = `syn3b-smoke-${randomUUID()}`;
  const staffRet = await expectRejected(call('recordRetainedCommission', { requestId, policyId: 'SYN3B-P-ZETA', statementPeriod: '2026-10', amountCents: 10000, classification: 'new_business', note: 'smoke' }, 1, STAFF_TOKEN));
  const r1 = await call('recordRetainedCommission', { requestId, policyId: 'SYN3B-P-ZETA', statementPeriod: '2026-10', amountCents: 10000, transactionDate: '2026-10-05', classification: 'new_business', note: 'smoke: synthetic bind document' });
  const r2 = await call('recordRetainedCommission', { requestId, policyId: 'SYN3B-P-ZETA', statementPeriod: '2026-10', amountCents: 10000, transactionDate: '2026-10-05', classification: 'new_business', note: 'smoke: synthetic bind document' });
  const retDoc = (await db.collection('ledger').doc(r1.entryId).get()).data();
  record('Retained commission: policy 30 % split, idempotent request, staff refused',
    staffRet.rejected && r1.duplicate === false && r2.duplicate === true && r2.entryId === r1.entryId && retDoc.sourceType === 'retained' && retDoc.brokerCents === 3000 && retDoc.agencyCents === 7000 && retDoc.brokerShareSource === 'policy',
    `entry ${r1.entryId}: ${$(retDoc.amountCents)} → broker ${$(retDoc.brokerCents)} / agency ${$(retDoc.agencyCents)}; second request duplicate=${r2.duplicate}; staff refused=${staffRet.rejected}`);
  const rr = await call('reverseLedgerEntry', { entryId: r1.entryId, reason: 'smoke test: retained reversal' });
  const rrDoc = (await db.collection('ledger').doc(rr.reversalId).get()).data();
  const rrAgain = await expectRejected(call('reverseLedgerEntry', { entryId: r1.entryId, reason: 'again' }));
  const stmtEntryRev = await expectRejected(call('reverseLedgerEntry', { entryId: second[0].id, reason: 'not allowed' }));
  record('Retained reversal nets to zero; double reversal and single statement-entry reversal refused',
    rrDoc.amountCents === -10000 && rrDoc.brokerCents === -3000 && rrAgain.rejected && stmtEntryRev.rejected, `reversal ${$(rrDoc.amountCents)}; again refused=${rrAgain.rejected}; statement entry refused=${stmtEntryRev.rejected}`);

  // 11. Audit trail and data protection
  const audit = (await db.collection('auditLog').where('entityId', '==', sid).get()).docs.map((d) => d.get('action'));
  const count = (a) => audit.filter((x) => x === a).length;
  const retAudit = (await db.collection('auditLog').where('entityId', '==', r1.entryId).get()).docs.map((d) => d.get('action'));
  record('Audit: approvals, postings, reversals, retained', count('statement_approve') === 2 && count('statement_post') === 2 && count('statement_reverse') === 2 && retAudit.includes('retained_record') && retAudit.includes('ledger_reverse'),
    `approve ${count('statement_approve')}, post ${count('statement_post')}, reverse ${count('statement_reverse')}; retained: ${retAudit.join(', ')}`);
  const linesNow = new Map((await ref.collection('lines').get()).docs.map((d) => [d.id, extractedOnly(d.data())]));
  const policiesNow = stable((await db.collection('policies').where('synthetic', '==', true).get()).docs.map((d) => [d.id, d.data()]));
  record('Extracted lines and policies unchanged by posting', [...linesBefore].every(([id, h]) => linesNow.get(id) === h) && policiesNow === policiesBefore, `${linesNow.size} lines and synthetic policies compared field by field`);
  const finalWindow = await windowTotals();
  record('Dev reports left net zero for this run', finalWindow.amount === before.amount && finalWindow.broker === before.broker, `window ${$(finalWindow.amount)} (start ${$(before.amount)})`);
}

// ---------------------------------------------------------------- run
summary(`### Live smoke test — ${DEV}\n`);
summary('| | Check | Result |');
summary('|---|---|---|');
try {
  const cfg = await devWebConfig();
  record('Dev web app found', true, `appId ${cfg.appId}, bucket ${cfg.storageBucket}`);
  FUNCTIONS = await deployedFunctions();
  const needed = ['checkAiConnection', 'registerStatementUpload', 'processStatement'];
  const where = needed.map((n) => `${n}: ${FUNCTIONS.get(n)?.region ?? 'MISSING'}`).join(', ');
  record(`Functions deployed in ${REGION}`, needed.every((n) => FUNCTIONS.get(n)?.region === REGION && FUNCTIONS.get(n)?.state === 'ACTIVE'), where);
  ID_TOKEN = await adminIdToken(cfg.apiKey);
  WEB_API_KEY = cfg.apiKey;
  STAFF_TOKEN = await adminIdToken(cfg.apiKey, 'ci-smoke-staff', 'staff');
  record('Signed in as synthetic admin', true, 'ci-smoke-admin (role admin, dev only)');

  // 0a. Every callable is reachable FROM THE BROWSER: the CORS preflight the dev site sends must be
  //     answered 204 with Access-Control-Allow-Origin. A function without public invocation answers 403
  //     with no CORS headers, which the browser reports as a network error (regression: saveSettings).
  {
    const ORIGIN = 'https://deploy-dev--2001-pioneer.netlify.app';
    const names = exportedCallables();
    const probe = async (fn) => {
      const r = await fetch(`https://${REGION}-${DEV}.cloudfunctions.net/${fn}`, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
      return { fn, status: r.status, acao: r.headers.get('access-control-allow-origin') };
    };
    let bad = [];
    for (let attempt = 1; attempt <= 12; attempt++) { // IAM changes can take a minute or two to apply
      bad = (await Promise.all(names.map(probe))).filter((x) => !(x.status === 204 && (x.acao === ORIGIN || x.acao === '*')));
      if (!bad.length || attempt === 12) break;
      await new Promise((res) => setTimeout(res, 15_000));
    }
    record('Every callable answers the browser CORS preflight from the dev site', bad.length === 0,
      bad.length ? `${bad.length} of ${names.length} not reachable: ${bad.map((x) => `${x.fn} ${x.status}`).join(', ')}` : `${names.length} of ${names.length}: 204 with allow-origin`);
  }

  // 0b. Settings persistence through the real saveSettings callable: change the reporting window,
  //     read it back, then restore the original values (also read back). Dev project only.
  {
    const ref = db.collection('settings').doc('app');
    const orig = (await ref.get()).data() ?? {};
    const body = (start) => ({
      agencyName: orig.agencyName ?? 'Central Insurance Agency', snapshotStartMonth: start, snapshotMonths: Number(orig.snapshotMonths ?? 12),
      revenueBasis: 'statementPeriod', defaultBrokerShareBps: Number(orig.defaultBrokerShareBps ?? 5000),
      aiEnabled: !!orig.aiEnabled, aiModel: orig.aiModel ?? MODEL, aiMonthlyCallLimit: Number(orig.aiMonthlyCallLimit ?? 100),
    });
    const origStart = orig.snapshotStartMonth ?? '2025-11';
    const temp = origStart === '2024-06' ? '2024-07' : '2024-06';
    let changed = null; let restored = null; let err = '';
    try {
      await call('saveSettings', body(temp));
      changed = (await ref.get()).get('snapshotStartMonth');
    } catch (e) { err = e instanceof Error ? e.message : String(e); }
    finally {
      try { await call('saveSettings', body(origStart)); restored = (await ref.get()).get('snapshotStartMonth'); } catch (e) { err += ` restore: ${e instanceof Error ? e.message : String(e)}`; }
    }
    const audits = await db.collection('auditLog').where('entityType', '==', 'settings').where('entityId', '==', 'app').get();
    record('Settings save persists (change window, read back, restore)', changed === temp && restored === origStart && audits.size >= 2,
      `saved ${temp} → read ${changed}; restored ${origStart} → read ${restored}; settings audit entries ${audits.size}${err ? `; ${err}` : ''}`);
  }

  // Dev settings for the test: AI on, current model, enough monthly calls. Dev project only.
  const settingsRef = db.collection('settings').doc('app');
  const cur = (await settingsRef.get()).data() ?? {};
  await settingsRef.set({ aiEnabled: true, aiModel: MODEL, aiMonthlyCallLimit: Math.max(Number(cur.aiMonthlyCallLimit ?? 0), 200) }, { merge: true });

  // 1. Test AI connection
  const d = await call('checkAiConnection', { model: MODEL });
  record('Test AI connection', d.ok === true,
    `${d.summary} [key: ${d.key.state}, ${d.key.length} chars${d.key.problems.length ? `, ${d.key.problems.join(' ')}` : ''}; auth: ${d.auth.state}; model: ${d.model_.state}; request: ${d.request.state}${d.request.error ? ` HTTP ${d.request.error.status} ${d.request.error.errorType ?? ''} ${d.request.error.apiMessage ?? ''}` : ''}]`);
  if (d.models?.available?.length) summary(`\nModels available to the dev key: ${d.models.available.join(', ')}\n`);

  if (d.ok) {
    // 2. AI reads a PDF
    const a = await syntheticStatement('read');
    const ra = await call('registerStatementUpload', { fileName: a.fileName, sha256: a.sha256, size: a.bytes.length });
    await putFile(cfg.storageBucket, ra.uploadPath, a.bytes);
    const pa = await call('processStatement', { statementId: ra.statementId, method: 'auto' });
    record('AI reads a PDF and reconciles to the cent', readOk(pa), `${describe(pa)} (statement ${ra.statementId})`);

    // 3. Interrupted upload → resume into the same record
    const b = await syntheticStatement('resume');
    const r1 = await call('registerStatementUpload', { fileName: b.fileName, sha256: b.sha256, size: b.bytes.length });
    const p1 = await call('processStatement', { statementId: r1.statementId, method: 'auto' });
    record('Upload that never arrived is reported', p1.status === 'extraction_failed' && p1.failure?.code === 'not_uploaded', describe(p1));
    const r2 = await call('registerStatementUpload', { fileName: b.fileName, sha256: b.sha256, size: b.bytes.length });
    record('Re-upload resumes the same record (not "duplicate")', r2.duplicate === false && r2.resumed === true && r2.statementId === r1.statementId,
      `duplicate=${r2.duplicate}, resumed=${r2.resumed}, same record=${r2.statementId === r1.statementId}`);
    if (r2.uploadPath) {
      await putFile(cfg.storageBucket, r2.uploadPath, b.bytes);
      const p2 = await call('processStatement', { statementId: r1.statementId, method: 'auto' });
      record('Recovered statement processes', readOk(p2), `${describe(p2)} (statement ${r1.statementId})`);
    }

    // 4. A stored file is still a duplicate
    const r3 = await call('registerStatementUpload', { fileName: b.fileName, sha256: b.sha256, size: b.bytes.length });
    record('Stored file is still blocked as a duplicate', r3.duplicate === true, `duplicate=${r3.duplicate}`);
  }
  // Stage 3B does not use Claude, so it runs even if the AI checks failed.
  let ctx3b = null;
  try { ctx3b = await stage3b(); } catch (err) { record('Stage 3B matching run', false, err instanceof Error ? err.message : String(err)); }
  if (ctx3b) { try { await stage3c(ctx3b); } catch (err) { record('Stage 3C posting run', false, err instanceof Error ? err.message : String(err)); } }
} catch (err) {
  record('Smoke test run', false, err instanceof Error ? err.message : String(err));
}

const failed = results.filter((r) => !r.pass).length;
summary(`\n**${results.length - failed} of ${results.length} checks passed.**`);
process.exit(failed ? 1 : 0);
