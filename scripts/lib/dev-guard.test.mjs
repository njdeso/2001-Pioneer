// node --test scripts/lib/dev-guard.test.mjs (run from the repo root; no network, Google is mocked)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertDevAlias, assertDevProjectNumber, NotDevError } from './dev-guard.mjs';

const google = (projectId, projectNumber, status = 200) => async () => new Response(JSON.stringify(status === 200 ? { projectId, projectNumber } : { error: { message: 'denied' } }), { status });
const token = async () => 'test-token';

test('the prod alias and the production project ID are refused', () => {
  assert.throws(() => assertDevAlias('prod'), (e) => e instanceof NotDevError && /pioneer-285cf/.test(e.message));
  assert.throws(() => assertDevAlias('pioneer-285cf'), NotDevError);
  assert.throws(() => assertDevAlias('some-other-project'), NotDevError);
  assert.equal(assertDevAlias('dev'), 'pioneer-2001-dev');
});

test('the project number must be the dev project number, confirmed by Google', async () => {
  await assert.doesNotReject(assertDevProjectNumber('pioneer-2001-dev', token, google('pioneer-2001-dev', '994437988131')));
  // Credentials that actually resolve to another project (e.g. production) are refused.
  await assert.rejects(assertDevProjectNumber('pioneer-2001-dev', token, google('pioneer-285cf', '123456789012')), /not pioneer-2001-dev/);
  await assert.rejects(assertDevProjectNumber('pioneer-2001-dev', token, google('pioneer-2001-dev', '123456789012')), /number 123456789012/);
  // Cannot confirm → refuse.
  await assert.rejects(assertDevProjectNumber('pioneer-2001-dev', token, google(null, null, 403)), /could not confirm/);
});

test('demo- projects are allowed only against the emulator', async () => {
  const saved = process.env.FIRESTORE_EMULATOR_HOST;
  delete process.env.FIRESTORE_EMULATOR_HOST;
  await assert.rejects(assertDevProjectNumber('demo-asm', token, google('x', '1')), /only allowed against the emulator/);
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
  await assert.doesNotReject(assertDevProjectNumber('demo-asm', token, google('x', '1')));
  if (saved === undefined) delete process.env.FIRESTORE_EMULATOR_HOST; else process.env.FIRESTORE_EMULATOR_HOST = saved;
});
