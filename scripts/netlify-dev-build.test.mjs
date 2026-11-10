// node --test scripts/netlify-dev-build.test.mjs — no network: Firebase is mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePreviewEnv, PreviewConfigError } from './netlify-dev-build.mjs';

const DEV_APP = '1:994437988131:web:9043d3983903977b799696';
const ok = { CONTEXT: 'deploy-preview', DEV_FIREBASE_API_KEY: 'dev-key-synthetic', DEV_FIREBASE_APP_ID: DEV_APP };
const firebase = (projectId, status = 200) => async () => new Response(JSON.stringify(status === 200 ? { projectId } : { error: { message: 'API key not valid' } }), { status });
const refuses = async (env, f, re) => assert.rejects(resolvePreviewEnv(env, f), (e) => e instanceof PreviewConfigError && re.test(e.message));

test('missing dev values: explicit error, never a fallback', async () => {
  await refuses({ CONTEXT: 'deploy-preview' }, firebase('pioneer-2001-dev'), /DEV_FIREBASE_API_KEY and DEV_FIREBASE_APP_ID are not set.*NOT built.*never falls back/);
  await refuses({ ...ok, DEV_FIREBASE_APP_ID: '' }, firebase('pioneer-2001-dev'), /DEV_FIREBASE_APP_ID is not set/);
  // Production values present in the environment are never used as a substitute.
  await refuses({ CONTEXT: 'deploy-preview', VITE_FIREBASE_API_KEY: 'prod-key', VITE_FIREBASE_APP_ID: '1:1:web:1' }, firebase('pioneer-285cf'), /not set/);
});

test('only preview and branch-deploy contexts', async () => {
  await refuses({ ...ok, CONTEXT: 'production' }, firebase('pioneer-2001-dev'), /only for Netlify previews/);
  await refuses({ ...ok, CONTEXT: undefined }, firebase('pioneer-2001-dev'), /only for Netlify previews/);
});

test('an app ID or API key from another project is refused', async () => {
  await refuses({ ...ok, DEV_FIREBASE_APP_ID: '1:111111111111:web:abc' }, firebase('pioneer-2001-dev'), /not a pioneer-2001-dev web app ID/);
  await refuses(ok, firebase('pioneer-285cf'), /belongs to project "pioneer-285cf"/);
  await refuses(ok, firebase('pioneer-2001-dev', 400), /Firebase rejected DEV_FIREBASE_API_KEY/);
  await refuses(ok, async () => { throw new Error('offline'); }, /network error/);
  await refuses({ ...ok, VITE_FIREBASE_API_KEY: 'dev-key-synthetic' }, firebase('pioneer-2001-dev'), /equals the VITE_FIREBASE_API_KEY used for production/);
});

test('regression: Firebase reports the dev project by NUMBER (994437988131) — accepted', async () => {
  // Exact production failure: "DEV_FIREBASE_API_KEY belongs to project '994437988131', not pioneer-2001-dev."
  const env = await resolvePreviewEnv(ok, firebase('994437988131'));
  assert.equal(env.VITE_FIREBASE_PROJECT_ID, 'pioneer-2001-dev');
  // Numeric JSON value, in case the API ever returns a number instead of a string.
  const asNumber = async () => new Response(JSON.stringify({ projectId: 994437988131 }), { status: 200 });
  assert.equal((await resolvePreviewEnv(ok, asNumber)).VITE_FIREBASE_PROJECT_ID, 'pioneer-2001-dev');
});

test('regression: any other project, by ID or number, is still refused', async () => {
  await refuses(ok, firebase('pioneer-285cf'), /belongs to project "pioneer-285cf"/);
  await refuses(ok, firebase('123456789012'), /belongs to project "123456789012"/);       // another project number (e.g. production's)
  await refuses(ok, firebase('9944379881310'), /belongs to project "9944379881310"/);     // near miss
  await refuses(ok, firebase('99443798813'), /belongs to project "99443798813"/);
  await refuses(ok, firebase(''), /belongs to project "unknown"/);
  await refuses(ok, async () => new Response(JSON.stringify({}), { status: 200 }), /belongs to project "unknown"/);
});

test('valid dev values produce an explicit dev-only build environment', async () => {
  const env = await resolvePreviewEnv({ ...ok, VITE_FIREBASE_PROJECT_ID: 'pioneer-285cf' }, firebase('pioneer-2001-dev'));
  assert.equal(env.VITE_FIREBASE_PROJECT_ID, 'pioneer-2001-dev');
  assert.equal(env.VITE_FIREBASE_API_KEY, 'dev-key-synthetic');
  assert.equal(env.VITE_FIREBASE_APP_ID, DEV_APP);
  assert.equal(env.VITE_FIREBASE_STORAGE_BUCKET, 'pioneer-2001-dev.firebasestorage.app');
  assert.equal(env.VITE_FUNCTIONS_REGION, 'us-central1');
  assert.equal(env.VITE_DEPLOY_CONTEXT, 'deploy-preview');
});
