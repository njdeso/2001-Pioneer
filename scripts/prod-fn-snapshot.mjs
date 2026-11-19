#!/usr/bin/env node
// Read-only snapshot and comparison of the PRODUCTION Cloud Functions (pioneer-285cf), used by
// .github/workflows/deploy-prod-functions.yml before and after deploying the target functions.
//
//   node scripts/prod-fn-snapshot.mjs snapshot <raw.json>
//   node scripts/prod-fn-snapshot.mjs dotenv   <raw.json> <out .env file>
//   node scripts/prod-fn-snapshot.mjs compare  <before.json> <after.json> <report.md> [--deployed]
//
// Reads only: `gcloud functions list` (metadata) and, for the target functions, the Cloud Run invoker
// policy. It never reads a secret value, never reads Firestore or Storage, and writes nothing to Google.
//
// The raw snapshot contains environment-variable VALUES (e.g. OWNER_EMAILS). It is written only to the
// runner's temporary directory and is never uploaded: this repository is public, so its Actions logs and
// artifacts are too. The compare report lists names and "same / changed" only, never values.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const PROJECT = process.env.PROD_PROJECT_ID;
const REGION = process.env.REGION ?? 'us-central1';
const TARGETS = (process.env.TARGET_FUNCTIONS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const die = (m) => { console.error(`::error::${m}`); process.exit(1); };

if (PROJECT !== 'pioneer-285cf') die(`PROD_PROJECT_ID must be pioneer-285cf (got ${PROJECT ?? 'unset'})`);
if (!TARGETS.length) die('TARGET_FUNCTIONS is empty');

// Names Firebase/Cloud Functions set themselves; they are never written to a .env file.
const RESERVED = /^(FIREBASE_|X_GOOGLE_|EXT_)|^(GCLOUD_PROJECT|EVENTARC_CLOUD_EVENT_SOURCE|FUNCTION_TARGET|FUNCTION_SIGNATURE_TYPE|FUNCTION_NAME|FUNCTION_REGION|FUNCTION_IDENTITY|FUNCTION_MEMORY_MB|FUNCTION_TIMEOUT_SEC|ENTRY_POINT|GCP_PROJECT|K_SERVICE|K_REVISION|K_CONFIGURATION|PORT|LOG_EXECUTION_ID)$/;

const gcloud = (args) => execFileSync('gcloud', [...args, '--project', PROJECT, '--format=json', '--quiet'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
const base = (n) => String(n).split('/').pop();

function snapshot() {
  const list = JSON.parse(gcloud(['functions', 'list', '--regions', REGION]));
  const fns = {};
  for (const f of list) {
    const s = f.serviceConfig ?? {};
    const name = base(f.name);
    fns[name] = {
      state: f.state ?? null,
      updateTime: f.updateTime ?? null,
      environment: f.environment ?? null,
      revision: s.revision ?? null,
      service: s.service ? base(s.service) : null,
      runtime: f.buildConfig?.runtime ?? null,
      memory: s.availableMemory ?? null,
      cpu: s.availableCpu ?? null,
      timeout: s.timeoutSeconds ?? null,
      maxInstances: s.maxInstanceCount ?? null,
      minInstances: s.minInstanceCount ?? 0,
      concurrency: s.maxInstanceRequestConcurrency ?? null,
      serviceAccount: s.serviceAccountEmail ?? null,
      ingress: s.ingressSettings ?? null,
      env: s.environmentVariables ?? {},
      secrets: (s.secretEnvironmentVariables ?? []).map((x) => ({ key: x.key, secret: x.secret, version: String(x.version ?? '') })).sort((a, b) => a.key.localeCompare(b.key)),
    };
  }
  for (const t of TARGETS) {
    if (!fns[t]) die(`Target function ${t} does not exist in ${PROJECT}/${REGION}. This workflow only updates existing functions; it never creates one.`);
    const svc = fns[t].service ?? t.toLowerCase();
    const pol = JSON.parse(gcloud(['run', 'services', 'get-iam-policy', svc, '--region', REGION]));
    fns[t].invokerPublic = (pol.bindings ?? []).some((b) => b.role === 'roles/run.invoker' && (b.members ?? []).includes('allUsers'));
  }
  return { project: PROJECT, region: REGION, takenAt: new Date().toISOString(), targets: TARGETS, functions: fns };
}

const cmd = process.argv[2];

if (cmd === 'snapshot') {
  const out = process.argv[3] ?? die('snapshot needs an output path');
  const snap = snapshot();
  writeFileSync(out, JSON.stringify(snap, null, 2), { mode: 0o600 });
  const n = Object.keys(snap.functions).length;
  console.log(`Snapshot of ${n} functions in ${PROJECT}/${REGION} written (values kept on the runner only).`);
  for (const t of TARGETS) {
    const f = snap.functions[t];
    console.log(`  ${t}: ${f.state}, last deployed ${f.updateTime}, revision ${f.revision}, env names [${Object.keys(f.env).sort().join(', ')}], secrets [${f.secrets.map((s) => s.key).join(', ')}], public invoker ${f.invokerPublic}`);
  }
} else if (cmd === 'dotenv') {
  // Rebuild functions/.env.pioneer-285cf from the values production ALREADY uses, so the deploy keeps
  // every user-defined variable exactly as it is (Firebase replaces a function's variables with the file).
  const snap = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const out = process.argv[4] ?? die('dotenv needs an output path');
  const userVars = (t) => Object.fromEntries(Object.entries(snap.functions[t].env).filter(([k]) => !RESERVED.test(k)).sort(([a], [b]) => a.localeCompare(b)));
  const first = userVars(TARGETS[0]);
  for (const t of TARGETS.slice(1)) {
    if (JSON.stringify(userVars(t)) !== JSON.stringify(first)) die(`${t} and ${TARGETS[0]} have different environment variables in production. Stopping: deploying would make them equal.`);
  }
  if (!('OWNER_EMAILS' in first)) die('OWNER_EMAILS is not set on the production functions. Stopping rather than deploying without it.');
  const lines = [];
  for (const [k, v] of Object.entries(first)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k)) die(`Unexpected environment variable name ${k}`);
    if (/[\r\n"\\]/.test(v)) die(`Environment variable ${k} contains a quote, backslash or newline; write the .env file by hand instead.`);
    // Mask the value (and each comma-separated part) in all later log output.
    for (const part of [v, ...v.split(',')].map((p) => p.trim()).filter(Boolean)) console.log(`::add-mask::${part}`);
    lines.push(`${k}="${v}"`);
  }
  writeFileSync(out, lines.join('\n') + '\n', { mode: 0o600 });
  console.log(`Wrote ${lines.length} existing production variable(s) to the deploy's .env file: ${Object.keys(first).join(', ')} (values not shown).`);
} else if (cmd === 'compare') {
  const [b, a, reportPath] = [process.argv[3], process.argv[4], process.argv[5]].map((p) => p ?? die('compare needs <before> <after> <report>'));
  const deployed = process.argv.includes('--deployed');
  const before = JSON.parse(readFileSync(b, 'utf8')).functions;
  const after = JSON.parse(readFileSync(a, 'utf8')).functions;
  const errors = [];
  const warnings = [];
  const rows = [];
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const n of names) {
    if (!before[n]) { errors.push(`${n} was CREATED`); rows.push([n, 'created', '✗']); continue; }
    if (!after[n]) { errors.push(`${n} was DELETED`); rows.push([n, 'deleted', '✗']); continue; }
    const B = before[n]; const A = after[n];
    if (!TARGETS.includes(n)) {
      const ok = B.updateTime === A.updateTime && B.revision === A.revision && same(B.env, A.env) && same(B.secrets, A.secrets);
      if (!ok) errors.push(`${n} is not a target but changed (last deployed ${B.updateTime} → ${A.updateTime})`);
      rows.push([n, ok ? 'unchanged' : 'CHANGED', ok ? '✓' : '✗']);
      continue;
    }
    const checks = [];
    const chk = (label, ok, warnOnly = false) => { checks.push(`${label} ${ok ? 'same' : 'CHANGED'}`); if (!ok) (warnOnly ? warnings : errors).push(`${n}: ${label} changed`); };
    if (deployed) {
      if (A.revision === B.revision && A.updateTime === B.updateTime) errors.push(`${n}: was not redeployed (same revision ${A.revision})`);
      if (A.state !== 'ACTIVE') errors.push(`${n}: state is ${A.state}, expected ACTIVE`);
    } else if (A.revision !== B.revision || A.updateTime !== B.updateTime) {
      errors.push(`${n}: changed during a dry run`);
    }
    chk('runtime', A.runtime === B.runtime);
    chk('memory', A.memory === B.memory);
    chk('cpu', A.cpu === B.cpu);
    chk('timeout', A.timeout === B.timeout);
    chk('maxInstances', A.maxInstances === B.maxInstances, true);
    chk('minInstances', A.minInstances === B.minInstances);
    chk('concurrency', A.concurrency === B.concurrency, true);
    chk('serviceAccount', A.serviceAccount === B.serviceAccount);
    chk('ingress', A.ingress === B.ingress);
    const userEnv = (f) => Object.fromEntries(Object.entries(f.env).filter(([k]) => !RESERVED.test(k)));
    chk('env names (user-defined)', same(Object.keys(userEnv(A)).sort(), Object.keys(userEnv(B)).sort()));
    chk('env values (user-defined)', same(userEnv(A), userEnv(B)));
    chk('env names (set by Firebase)', same(Object.keys(A.env).sort(), Object.keys(B.env).sort()), true);
    chk('secret bindings', same(A.secrets.map((s) => [s.key, s.secret]), B.secrets.map((s) => [s.key, s.secret])));
    chk('secret version', same(A.secrets.map((s) => s.version), B.secrets.map((s) => s.version)), true);
    if (B.invokerPublic && !A.invokerPublic) errors.push(`${n}: browser access (allUsers invoker) was lost`);
    checks.push(`public invoker ${A.invokerPublic ? 'kept' : 'MISSING'}`);
    rows.push([n, `${deployed ? `redeployed ${B.updateTime} → ${A.updateTime}` : 'dry run: unchanged'}; ${checks.join(', ')}`, errors.some((e) => e.startsWith(`${n}:`)) ? '✗' : '✓']);
  }

  const md = [
    `### Production functions after ${deployed ? 'deploy' : 'dry run'} (${names.length} functions, ${PROJECT}/${REGION})`,
    '',
    '| Function | Result | |',
    '|---|---|---|',
    ...rows.map((r) => `| ${r.join(' | ')} |`),
    '',
    ...(warnings.length ? ['**Warnings**', ...warnings.map((w) => `- ${w}`), ''] : []),
    ...(errors.length ? ['**Errors**', ...errors.map((e) => `- ${e}`), ''] : ['All checks passed.', '']),
  ].join('\n');
  writeFileSync(reportPath, md);
  console.log(md);
  for (const w of warnings) console.log(`::warning::${w}`);
  if (errors.length) { for (const e of errors) console.log(`::error::${e}`); process.exit(1); }
} else {
  die('usage: prod-fn-snapshot.mjs snapshot|dotenv|compare …');
}
