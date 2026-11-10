#!/usr/bin/env node
// CI regression check (run after `npm run build`): every deployed function's endpoint matches what
// the web app and the smoke test call.
//
//  - Loads the built bundle (functions/lib/index.js) and reads each export's Firebase endpoint
//    manifest — the same data `firebase deploy` uses — so a global option that is silently ignored
//    (the cause of the us-central1 vs us-east4 HTTP 404) fails here instead of in a live test.
//  - Every function must be a callable (onCall), in FUNCTIONS_REGION, with maxInstances 5.
//  - The web app default region, the Netlify preview region, the env examples and the smoke test
//    must all equal FUNCTIONS_REGION.
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const errors = [];
const need = (cond, msg) => { if (!cond) errors.push(msg); };

const opts = readFileSync('functions/src/options.ts', 'utf8');
const REGION = (/FUNCTIONS_REGION = '([a-z0-9-]+)'/.exec(opts) ?? [])[1];
need(Boolean(REGION), 'functions/src/options.ts must define FUNCTIONS_REGION');
const firstCode = readFileSync('functions/src/index.ts', 'utf8').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('//'));
need(firstCode === "import './options.js';", "functions/src/index.ts must import './options.js' before anything else");

// 1. The built functions, as Firebase will deploy them
const bundle = 'functions/lib/index.js';
if (!existsSync(bundle)) {
  errors.push(`${bundle} not found — run npm run build first`);
} else {
  let mod = {};
  try { mod = await import(pathToFileURL(bundle).href); } catch (e) { errors.push(`could not load ${bundle}: ${e.message.split('\n')[0]}`); }
  const names = Object.keys(mod).filter((k) => mod[k] && typeof mod[k] === 'function' && mod[k].__endpoint);
  need(names.length >= 15, `expected the callable functions to be exported (found ${names.length})`);
  for (const n of names) {
    const e = mod[n].__endpoint;
    const region = [].concat(e.region ?? ['us-central1 (default)']);
    need(region.length === 1 && region[0] === REGION, `${n}: deploys to ${region.join(',')}, expected ${REGION}`);
    need(e.maxInstances === 5, `${n}: maxInstances is ${e.maxInstances ?? 'unset'}, expected 5 (global options not applied?)`);
    need(Boolean(e.callableTrigger), `${n}: is not a callable (onCall) function`);
    need(e.platform === 'gcfv2', `${n}: is not a 2nd-gen function`);
  }
  for (const n of ['checkAiConnection', 'registerStatementUpload', 'processStatement']) need(names.includes(n), `${n} is not exported`);
  if (!errors.length) console.log(`${names.length} functions: all callable, 2nd gen, ${REGION}, maxInstances 5.`);
}

// 2. Everything that calls the functions uses the same region
const firebaseTs = readFileSync('apps/admin/src/firebase.ts', 'utf8');
need(firebaseTs.includes(`env.VITE_FUNCTIONS_REGION || '${REGION}'`), `apps/admin/src/firebase.ts default region must be ${REGION}`);
const toml = readFileSync('netlify.toml', 'utf8');
const tomlRegions = [...toml.matchAll(/VITE_FUNCTIONS_REGION = "([^"]+)"/g)].map((m) => m[1]);
need(tomlRegions.length > 0 && tomlRegions.every((r) => r === REGION), `netlify.toml VITE_FUNCTIONS_REGION must be ${REGION} (found ${tomlRegions.join(', ') || 'none'})`);
for (const f of ['.env.example', 'apps/admin/.env.dev.example']) {
  need(readFileSync(f, 'utf8').includes(`VITE_FUNCTIONS_REGION=${REGION}`), `${f} must set VITE_FUNCTIONS_REGION=${REGION}`);
}
const smoke = readFileSync('scripts/smoke-dev.mjs', 'utf8');
need(smoke.includes(`const REGION = '${REGION}'`), `scripts/smoke-dev.mjs REGION must be ${REGION}`);
// Callable protocol in the smoke test: POST, JSON {data}, Firebase ID token as Bearer, URL from the Functions API.
need(/method: 'POST'/.test(smoke) && /JSON\.stringify\(\{ data \}\)/.test(smoke) && /authorization: `Bearer \$\{(ID_TOKEN|token)\}`/.test(smoke),
  'smoke test must use the callable protocol (POST, {"data": …}, Bearer ID token)');
need(/cloudfunctions\.googleapis\.com\/v2\/projects/.test(smoke) && /fetch\(fn\.url/.test(smoke), 'smoke test must call the URL reported by the Cloud Functions API');

if (errors.length) {
  console.error('Function endpoint check FAILED:\n - ' + errors.join('\n - '));
  process.exit(1);
}
console.log(`Function endpoint check passed: functions, web app, Netlify previews, env examples and smoke test all use ${REGION}.`);
process.exit(0);
