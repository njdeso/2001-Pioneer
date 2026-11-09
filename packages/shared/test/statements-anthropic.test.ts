import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractWithClaude, maxTokensLimitFrom, type AiInput } from '../src/statements/ai.ts';
import { cleanApiKey, classifyApiError, readApiError } from '../src/statements/anthropic.ts';
import { diagnoseAnthropic } from '../src/statements/diagnose.ts';

// All network calls are mocked. Error bodies follow Anthropic's documented error shape.
const KEY = 'sk-ant-api03-test-not-real-0000';
const input: AiInput = { kind: 'pdf', base64: Buffer.from('%PDF-1.4 synthetic').toString('base64'), pageCount: 2 };
const noSleep = async () => {};

function apiError(status: number, type: string, message: string, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ type: 'error', error: { type, message }, request_id: 'req_test123' }), {
    status, headers: { 'content-type': 'application/json', 'request-id': 'req_test123', ...headers },
  });
}
function ok(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_ok' } });
}
function mock(...responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (!r) throw new Error(`unexpected call to ${url}`);
    return r;
  }) as unknown as typeof fetch;
  return { f, calls };
}
const body = (c: { init: RequestInit }) => JSON.parse(String(c.init.body));
const header = (c: { init: RequestInit }, h: string) => (c.init.headers as Record<string, string>)[h];

// ---- error reading / classification -------------------------------------------------------

test('401: the key problem is reported with Anthropic\'s reason and request id, not just a status', async () => {
  const { f, calls } = mock(apiError(401, 'authentication_error', 'invalid x-api-key'));
  const res = await extractWithClaude({ apiKey: KEY, input, fetchImpl: f, sleep: noSleep });
  assert.equal(calls.length, 1);
  assert.ok(!res.ok && res.code === 'http' && res.http);
  if (res.ok || !res.http) return;
  assert.equal(res.http.kind, 'auth');
  assert.equal(res.http.errorType, 'authentication_error');
  assert.equal(res.http.requestId, 'req_test123');
  assert.match(res.message, /rejected the API key/);
  assert.match(res.message, /invalid x-api-key/);
});

test('400 credit balance is classified as billing, distinct from a bad request', async () => {
  const { f } = mock(apiError(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'));
  const res = await extractWithClaude({ apiKey: KEY, input, fetchImpl: f, sleep: noSleep });
  assert.ok(!res.ok && res.http?.kind === 'billing' && !res.retryable);
  if (!res.ok) assert.match(res.message, /billing/i);
});

test('404 not_found_error on the model is reported as model not available to this key', async () => {
  const { f } = mock(apiError(404, 'not_found_error', 'model: claude-sonnet-4-5-20250929'));
  const res = await extractWithClaude({ apiKey: KEY, model: 'claude-sonnet-4-5-20250929', input, fetchImpl: f, sleep: noSleep });
  assert.ok(!res.ok && res.http?.kind === 'model_not_found');
  if (!res.ok) assert.match(res.message, /not available to this API key/);
});

test('400 with another reason surfaces the exact Anthropic message', async () => {
  const { f } = mock(apiError(400, 'invalid_request_error', 'messages.0.content.0.document: PDF has too many pages'));
  const res = await extractWithClaude({ apiKey: KEY, input, fetchImpl: f, sleep: noSleep });
  assert.ok(!res.ok && res.http?.kind === 'invalid_request');
  if (!res.ok) assert.match(res.message, /too many pages/);
});

test('non-JSON error bodies and odd shapes never throw', async () => {
  const r = await readApiError(new Response('<html>Bad gateway</html>', { status: 502 }));
  assert.equal(r.kind, 'server');
  assert.ok(r.retryable);
  assert.match(r.apiMessage ?? '', /Bad gateway/);
  assert.equal(classifyApiError(529, null, null), 'overloaded');
  assert.equal(classifyApiError(413, 'request_too_large', null), 'too_large');
  assert.equal(classifyApiError(403, 'permission_error', null), 'permission');
});

test('anything key-like in an error message is scrubbed', async () => {
  const r = await readApiError(apiError(401, 'authentication_error', 'bad key sk-ant-api03-SECRETSECRET'));
  assert.ok(!(r.apiMessage ?? '').includes('SECRETSECRET'));
});

// ---- key and model hygiene ---------------------------------------------------------------

test('a key stored with a trailing newline is trimmed before it is sent', async () => {
  const { f, calls } = mock(apiError(500, 'api_error', 'x'), apiError(500, 'api_error', 'x'), apiError(500, 'api_error', 'x'));
  await extractWithClaude({ apiKey: `${KEY}\n`, input, fetchImpl: f, sleep: noSleep });
  assert.equal(header(calls[0], 'x-api-key'), KEY);
  assert.equal(header(calls[0], 'anthropic-version'), '2023-06-01');
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  const c = cleanApiKey(` "${KEY}"\r\n`);
  assert.equal(c.key, KEY);
  assert.equal(c.problems.length, 2);
  assert.ok(cleanApiKey('not-a-key').problems.some((p) => /sk-ant-/.test(p)));
});

test('an invalid model ID fails before any request is made', async () => {
  const { f, calls } = mock();
  const res = await extractWithClaude({ apiKey: KEY, model: 'Sonnet 4.5', input, fetchImpl: f, sleep: noSleep });
  assert.ok(!res.ok && res.code === 'bad_model');
  assert.equal(calls.length, 0);
});

// ---- request-shape fallbacks -------------------------------------------------------------

test('max_tokens above the model limit: retried once with the limit Anthropic reports', async () => {
  assert.equal(maxTokensLimitFrom('max_tokens: 32000 > 16384, which is the maximum allowed number of output tokens for claude-x'), 16384);
  const { f, calls } = mock(
    apiError(400, 'invalid_request_error', 'max_tokens: 32000 > 16384, which is the maximum allowed number of output tokens for claude-x'),
    apiError(401, 'authentication_error', 'stop here'),
  );
  await extractWithClaude({ apiKey: KEY, input, fetchImpl: f, sleep: noSleep });
  assert.equal(calls.length, 2);
  assert.equal(body(calls[0]).max_tokens, 32000);
  assert.equal(body(calls[1]).max_tokens, 16384);
});

test('a model that rejects a forced tool choice is retried once with tool_choice auto', async () => {
  const { f, calls } = mock(
    apiError(400, 'invalid_request_error', 'Thinking may not be enabled when tool_choice forces tool use.'),
    apiError(401, 'authentication_error', 'stop here'),
  );
  await extractWithClaude({ apiKey: KEY, input, fetchImpl: f, sleep: noSleep });
  assert.deepEqual(body(calls[0]).tool_choice, { type: 'tool', name: 'record_statement' });
  assert.deepEqual(body(calls[1]).tool_choice, { type: 'auto' });
});

// ---- time budget -------------------------------------------------------------------------

test('retries stop inside the time budget so the Cloud Function is never killed mid-run', async () => {
  let t = 0;
  // Each call hangs until the client aborts it: at the per-attempt timeout or the time left, whichever is first.
  const slow = (async () => { t += Math.min(240_000, 450_000 - t); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }) as unknown as typeof fetch;
  const res = await extractWithClaude({ apiKey: KEY, input, fetchImpl: slow, sleep: async (ms) => { t += ms; }, now: () => t, deadlineMs: 450_000 });
  assert.ok(!res.ok && res.code === 'timeout');
  assert.ok(t < 540_000, `used ${t} ms`);
});

test('retry-after from a 429 is respected', async () => {
  const waits: number[] = [];
  const { f } = mock(apiError(429, 'rate_limit_error', 'slow down', { 'retry-after': '7' }), apiError(401, 'authentication_error', 'stop'));
  await extractWithClaude({ apiKey: KEY, input, fetchImpl: f, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(waits, [7000]);
});

// ---- connection diagnosis ----------------------------------------------------------------

const modelsList = (ids: string[]) => ok({ data: ids.map((id) => ({ id, type: 'model' })), has_more: false, last_id: ids.at(-1) ?? null });

test('diagnosis: missing key', async () => {
  const d = await diagnoseAnthropic({ apiKey: '', model: 'claude-sonnet-5-5', fetchImpl: mock().f });
  assert.equal(d.ok, false);
  assert.equal(d.key.state, 'fail');
});

test('diagnosis: rejected key stops at authentication', async () => {
  const { f, calls } = mock(apiError(401, 'authentication_error', 'invalid x-api-key'));
  const d = await diagnoseAnthropic({ apiKey: KEY, model: 'claude-sonnet-5-5', fetchImpl: f });
  assert.equal(d.auth.state, 'fail');
  assert.match(d.summary, /401/);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\/models\?limit=1000$/);
});

test('diagnosis: model not available to this key, with the models it can use', async () => {
  const { f } = mock(modelsList(['claude-sonnet-5-5', 'claude-opus-5-5']), apiError(404, 'not_found_error', 'model: claude-sonnet-4-5-20250929'));
  const d = await diagnoseAnthropic({ apiKey: KEY, model: 'claude-sonnet-4-5-20250929', fetchImpl: f });
  assert.equal(d.auth.state, 'pass');
  assert.equal(d.model_.availableToKey, false);
  assert.match(d.summary, /claude-sonnet-5-5/);
  assert.deepEqual(d.models.available, ['claude-sonnet-5-5', 'claude-opus-5-5']);
});

test('diagnosis: valid key and model but no credit is reported as billing', async () => {
  const { f } = mock(modelsList(['claude-sonnet-5-5']), ok({ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }),
    apiError(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.'));
  const d = await diagnoseAnthropic({ apiKey: KEY, model: 'claude-sonnet-5-5', fetchImpl: f });
  assert.equal(d.model_.state, 'pass');
  assert.equal(d.request.state, 'fail');
  assert.equal(d.request.error?.kind, 'billing');
  assert.match(d.summary, /billing/);
});

test('diagnosis: all checks pass with the production request shape and synthetic data only', async () => {
  const { f, calls } = mock(modelsList(['claude-sonnet-5-5']), ok({ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }),
    ok({ stop_reason: 'max_tokens', content: [{ type: 'tool_use', name: 'record_statement', input: {} }] }));
  const d = await diagnoseAnthropic({ apiKey: KEY, model: 'claude-sonnet-5-5', fetchImpl: f });
  assert.equal(d.ok, true);
  const req = body(calls[2]);
  assert.equal(req.max_tokens, 64);
  assert.deepEqual(req.tool_choice, { type: 'tool', name: 'record_statement' });
  assert.match(JSON.stringify(req.messages), /TEST INSURED A/);
});
