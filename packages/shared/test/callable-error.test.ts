import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callableUrl, classifyProbe, describeCallableError, isTransportError, PROBE_SAFE_FUNCTIONS } from '../src/callableError.ts';

const T = { name: 'approveStatement', projectId: 'pioneer-2001-dev', region: 'us-central1', build: 'a1b2c3d' };

test('regression: a bare SDK "not-found [404]" names the function, its URL, the build, and says nothing changed', () => {
  for (const message of ['not-found [404]', 'not-found', 'FirebaseError: not-found', '']) {
    const m = describeCallableError({ code: 'functions/not-found', message }, T);
    assert.match(m, /"approveStatement" was not found \(HTTP 404\)/);
    assert.ok(m.includes('https://us-central1-pioneer-2001-dev.cloudfunctions.net/approveStatement'));
    assert.match(m, /nothing was changed/);
    assert.match(m, /build a1b2c3d/);
  }
});

test('a server refusal with its own message is shown unchanged, colons included', () => {
  assert.equal(describeCallableError({ code: 'functions/not-found', message: 'Statement not found.' }, T), 'Statement not found.');
  assert.equal(describeCallableError({ code: 'functions/failed-precondition', message: 'Not ready: Matching has not been run.' }, T), 'Not ready: Matching has not been run.');
  assert.equal(describeCallableError({ code: 'functions/failed-precondition', message: 'FirebaseError: Not ready: x' }, T), 'Not ready: x');
});

test('transport vs server errors', () => {
  assert.equal(isTransportError({ code: 'functions/not-found', message: 'not-found [404]' }), true);
  assert.equal(isTransportError({ code: 'functions/internal', message: 'internal' }), true);
  assert.equal(isTransportError({ code: 'functions/internal', message: 'INTERNAL' }), false, 'firebase-functions unexpected error');
  assert.equal(isTransportError({ code: 'functions/not-found', message: 'Policy not found.' }), false);
  assert.match(describeCallableError({ code: 'functions/internal', message: 'internal' }, T), /Could not reach the server function "approveStatement"/);
  assert.match(describeCallableError({ code: 'functions/internal', message: 'INTERNAL' }, T), /unexpected error/);
  assert.match(describeCallableError({ code: 'functions/deadline-exceeded', message: 'deadline-exceeded' }, T), /did not answer in time/);
  assert.equal(describeCallableError({ code: 'functions/unauthenticated', message: 'unauthenticated' }, T), 'Your sign-in has expired. Sign in again.');
});

test('probe classification: deployed functions refuse the probe input; missing ones are 404 without a server message', () => {
  assert.equal(classifyProbe({ code: 'functions/invalid-argument', message: 'Please correct the highlighted fields.' }), 'reachable');
  assert.equal(classifyProbe({ code: 'functions/permission-denied', message: 'Admins only.' }), 'reachable');
  assert.equal(classifyProbe({ code: 'functions/not-found', message: 'not-found [404]' }), 'missing');
  assert.equal(classifyProbe({ code: 'functions/not-found', message: 'Statement not found.' }), 'reachable');
  assert.equal(classifyProbe({ code: 'functions/internal', message: 'internal' }), 'unreachable');
  assert.equal(classifyProbe(null), 'reachable');
  assert.equal(callableUrl(T), 'https://us-central1-pioneer-2001-dev.cloudfunctions.net/approveStatement');
  assert.ok(PROBE_SAFE_FUNCTIONS.includes('approveStatement'));
});
