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
import { getStorage } from 'firebase-admin/storage';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { assertDevProjectNumber } from './lib/dev-guard.mjs';
import { seedBook, writeStatement, LINES, EXPECTED_SUMMARY } from './lib/synthetic-3b.mjs';

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

async function adminIdToken(apiKey) {
  const custom = await getAuth().createCustomToken('ci-smoke-admin', { role: 'admin' });
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
async function call(name, data, attempt = 1) {
  const fn = FUNCTIONS.get(name);
  if (!fn) throw new Error(`${name} is not deployed in ${DEV}.`);
  if (fn.region !== REGION) throw new Error(`${name} is deployed in ${fn.region}, but the app calls ${REGION}.`);
  // A function created moments ago can answer 401/403 from Cloud Run until its public-invoker IAM
  // binding propagates (usually under 2 minutes). Wait for that, up to ~4 minutes, then report the
  // actual IAM policy instead of retrying forever. Callable errors (JSON) are never retried.
  const r0 = await fetch(fn.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ID_TOKEN}` }, body: JSON.stringify({ data }), signal: AbortSignal.timeout(560_000) });
  if ((r0.status === 401 || r0.status === 403) && !(r0.headers.get('content-type') ?? '').includes('json')) {
    if (attempt < 9) { await new Promise((res) => setTimeout(res, 30_000)); return call(name, data, attempt + 1); }
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
  // Clean up earlier automated statements (synthetic, dev only), then build a fresh one.
  const old = await db.collection('statements').where('synthetic', '==', true).get();
  for (const d of old.docs.filter((x) => x.id.startsWith('SYN3B-AUTO-'))) {
    for (const l of await d.ref.collection('lines').listDocuments()) await l.delete();
    await d.ref.delete();
  }
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
  record('Signed in as synthetic admin', true, 'ci-smoke-admin (role admin, dev only)');

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
  try { await stage3b(); } catch (err) { record('Stage 3B matching run', false, err instanceof Error ? err.message : String(err)); }
} catch (err) {
  record('Smoke test run', false, err instanceof Error ? err.message : String(err));
}

const failed = results.filter((r) => !r.pass).length;
summary(`\n**${results.length - failed} of ${results.length} checks passed.**`);
process.exit(failed ? 1 : 0);
