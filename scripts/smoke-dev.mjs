#!/usr/bin/env node
// Live smoke test of the deployed functions in the DEVELOPMENT project only (pioneer-2001-dev).
//
//   1. Test AI connection   (checkAiConnection: key, Models API, model, tiny request)
//   2. AI reads a PDF       (synthetic non-Travelers statement → processStatement → reconciled exactly)
//   3. Interrupted upload   (register, upload never arrives, process fails "not_uploaded",
//                            re-register the same file → resumes into the SAME record → processes)
//   4. True duplicate       (same file again after it is stored → still reported as duplicate)
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
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const DEV = 'pioneer-2001-dev';
const PROD = 'pioneer-285cf';
const REGION = 'us-east4';
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

let ID_TOKEN = '';
async function call(name, data) {
  const r = await fetch(`https://${REGION}-${DEV}.cloudfunctions.net/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ID_TOKEN}` },
    body: JSON.stringify({ data }),
    signal: AbortSignal.timeout(560_000),
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { throw new Error(`${name}: HTTP ${r.status} ${text.slice(0, 200)}`); }
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

// ---------------------------------------------------------------- run
summary(`### Live smoke test — ${DEV}\n`);
summary('| | Check | Result |');
summary('|---|---|---|');
try {
  const cfg = await devWebConfig();
  record('Dev web app found', true, `appId ${cfg.appId}, bucket ${cfg.storageBucket}`);
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
} catch (err) {
  record('Smoke test run', false, err instanceof Error ? err.message : String(err));
}

const failed = results.filter((r) => !r.pass).length;
summary(`\n**${results.length - failed} of ${results.length} checks passed.**`);
process.exit(failed ? 1 : 0);
