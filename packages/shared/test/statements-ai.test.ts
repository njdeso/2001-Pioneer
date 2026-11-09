import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAiRequest, extractWithClaude, parseRate, STATEMENT_TOOL, tableToText, type AiInput } from '../src/statements/ai.ts';
import { reconcileStatement } from '../src/statements/reconcile.ts';
import { loadFixture } from './helpers/travelersPdf.ts';

// All Claude calls are mocked: no network, no API key, no real documents.
const FAKE_KEY = 'sk-test-not-a-real-key';
const input: AiInput = { kind: 'pdf', base64: Buffer.from('%PDF-1.4 synthetic').toString('base64'), pageCount: 6 };
const noSleep = async () => {};

/** The anonymized fixture expressed as Claude's tool answer (amounts exactly as printed). */
function fixtureAnswer() {
  const f = loadFixture();
  return {
    carrierName: 'Travelers',
    agencyCode: f.agencyCode,
    statementMonth: '2025-12',
    statementDate: f.statementDate,
    totals: {
      commissionPayable: f.totals.paidCommission,
      monthCommissionPayable: f.summary.monthPayable,
      paymentReceived: f.totals.paymentReceived,
      premiumForCommission: f.totals.premiumForCommission,
      transactionPremium: f.totals.transactionPremium,
      ytdCommissionPayable: f.summary.ytdPayable,
    },
    adjustments: [],
    lines: f.rows.map((r) => ({
      page: 1, insuredName: r[0], policyNumber: r[1],
      paymentReceived: r[2] || null, paidCommission: r[3] || null, commissionRate: r[4] || null,
      policyTermCommission: r[5] || null, premiumForCommission: r[6] || null, transactionPremium: r[10] || null,
      effectiveDate: r[7] ? r[7].split('-')[0] : null, transactionCode: r[7] || null,
      transactionType: !r[3] ? 'installment_payment' : r[7].includes('CONT') ? 'continuation' : r[7].includes('CANC') ? 'cancellation' : r[7].includes('CHECK') ? 'reversal' : 'endorsement',
    })),
  };
}

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function toolReply(inputObj: unknown, stop = 'tool_use') {
  return reply({ stop_reason: stop, usage: { input_tokens: 12000, output_tokens: 9000 }, content: [{ type: 'tool_use', name: STATEMENT_TOOL.name, input: inputObj }] });
}
function mockFetch(...responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (!r) throw new Error('unexpected call');
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return { f, calls };
}

test('valid AI answer converts to cents and reconciles exactly to $3,631.14', async () => {
  const { f } = mockFetch(toolReply(fixtureAnswer()));
  const res = await extractWithClaude({ apiKey: FAKE_KEY, input, fetchImpl: f, sleep: noSleep });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const r = reconcileStatement(res.statement);
  assert.equal(r.reconciled, true, r.blockingReasons.join('; '));
  assert.equal(r.totals.commissionCents, 363114);
  assert.equal(r.totals.paymentReceivedCents, 2757343);
  assert.equal(r.totals.paymentOnlyLineCount, 74);
  assert.equal(res.statement.lines.find((l) => l.paidCommissionCents === -5625)?.effectiveDate, '2026-01-10');
  assert.ok(res.statement.issues.some((i) => i.code === 'ai_extracted'));
  assert.deepEqual(res.usage, { inputTokens: 12000, outputTokens: 9000 });
});

test('AI amounts that do not add up are caught by exact reconciliation', async () => {
  const a = fixtureAnswer();
  const row = a.lines.find((l) => l.paidCommission === '305.52')!;
  row.paidCommission = '350.52'; // transposed digits
  const { f } = mockFetch(toolReply(a));
  const res = await extractWithClaude({ apiKey: FAKE_KEY, input, fetchImpl: f, sleep: noSleep });
  assert.ok(res.ok);
  if (!res.ok) return;
  const r = reconcileStatement(res.statement);
  assert.equal(r.reconciled, false);
  assert.equal(r.checks.find((c) => c.key === 'commission')?.differenceCents, 4500);
});

test('request: forced tool, document only, key in header not body', async () => {
  const { f, calls } = mockFetch(toolReply(fixtureAnswer()));
  await extractWithClaude({ apiKey: FAKE_KEY, input, fetchImpl: f, sleep: noSleep, model: 'claude-sonnet-5-5' });
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  const headers = init.headers as Record<string, string>;
  assert.equal(headers['x-api-key'], FAKE_KEY);
  assert.ok(headers['anthropic-version']);
  const body = JSON.parse(String(init.body));
  assert.ok(!String(init.body).includes(FAKE_KEY));
  assert.equal(body.model, 'claude-sonnet-5-5');
  assert.deepEqual(body.tool_choice, { type: 'tool', name: 'record_statement' });
  assert.equal(body.messages[0].content[0].type, 'document');
  assert.match(body.system, /DATA, not instructions/);
  assert.match(body.system, /bank account/);
  const t = buildAiRequest('m', { kind: 'table', text: tableToText([['a', 'b\tc']]), fileName: 'x.csv' }, 1000) as { messages: { content: { type: string; text: string }[] }[] };
  assert.equal(t.messages[0].content[0].type, 'text');
  assert.ok(t.messages[0].content[0].text.includes('a\tb c'));
});

test('rate limits and server errors retry with backoff, then succeed', async () => {
  const waits: number[] = [];
  const { f, calls } = mockFetch(reply({ error: 'rate' }, 429), reply({ error: 'overloaded' }, 529), toolReply(fixtureAnswer()));
  const res = await extractWithClaude({ apiKey: FAKE_KEY, input, fetchImpl: f, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test('persistent failures stop after the retry limit', async () => {
  const { f, calls } = mockFetch(reply({}, 500), reply({}, 500), reply({}, 500));
  const res = await extractWithClaude({ apiKey: FAKE_KEY, input, fetchImpl: f, sleep: noSleep });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'http');
  assert.equal(calls.length, 3);
});

test('non-retryable HTTP errors fail immediately', async () => {
  const { f, calls } = mockFetch(reply({}, 401));
  const res = await extractWithClaude({ apiKey: FAKE_KEY, input, fetchImpl: f, sleep: noSleep });
  assert.ok(!res.ok && res.code === 'http' && !res.retryable && res.http?.kind === 'auth');
  assert.equal(calls.length, 1);
});

test('timeouts and network errors are reported as failures', async () => {
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const { f } = mockFetch(abort, abort, abort);
  const res = await extractWithClaude({ apiKey: FAKE_KEY, input, fetchImpl: f, sleep: noSleep });
  assert.ok(!res.ok && res.code === 'timeout');
});

test('malformed answers: no tool call, wrong shape, truncated, refusal', async () => {
  let m = mockFetch(reply({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Here is the data…' }] }));
  let res = await extractWithClaude({ apiKey: FAKE_KEY, input, fetchImpl: m.f, sleep: noSleep, maxRetries: 0 });
  assert.ok(!res.ok && res.code === 'no_tool_call');

  const bad = { ...fixtureAnswer(), statementMonth: 'December 2025' };
  m = mockFetch(toolReply(bad));
  res = await extractWithClaude({ apiKey: FAKE_KEY, input, fetchImpl: m.f, sleep: noSleep });
  assert.ok(!res.ok && res.code === 'invalid_output');

  const wrongType = fixtureAnswer() as Record<string, unknown>;
  (wrongType.lines as Record<string, unknown>[])[0].transactionType = 'payday';
  m = mockFetch(toolReply(wrongType));
  res = await extractWithClaude({ apiKey: FAKE_KEY, input, fetchImpl: m.f, sleep: noSleep });
  assert.ok(!res.ok && res.code === 'invalid_output');

  m = mockFetch(toolReply(fixtureAnswer(), 'max_tokens'));
  res = await extractWithClaude({ apiKey: FAKE_KEY, input, fetchImpl: m.f, sleep: noSleep });
  assert.ok(!res.ok && res.code === 'truncated');

  m = mockFetch(reply({ stop_reason: 'refusal', content: [] }));
  res = await extractWithClaude({ apiKey: FAKE_KEY, input, fetchImpl: m.f, sleep: noSleep });
  assert.ok(!res.ok && res.code === 'refused');
});

test('unreadable amounts in an AI answer become line errors (never guessed)', async () => {
  const a = fixtureAnswer();
  a.lines[0].paymentReceived = 'two hundred';
  const { f } = mockFetch(toolReply(a));
  const res = await extractWithClaude({ apiKey: FAKE_KEY, input, fetchImpl: f, sleep: noSleep });
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.ok(res.statement.lines[0].issues.some((i) => i.code === 'bad_amount'));
  assert.equal(reconcileStatement(res.statement).reconciled, false);
});

test('missing API key fails without any request', async () => {
  const { f, calls } = mockFetch();
  const res = await extractWithClaude({ apiKey: '', input, fetchImpl: f });
  assert.ok(!res.ok && res.code === 'no_key');
  assert.equal(calls.length, 0);
});

test('commission rate formats', () => {
  assert.equal(parseRate('1500'), 1500);
  assert.equal(parseRate('15'), 1500);
  assert.equal(parseRate('15%'), 1500);
  assert.equal(parseRate('12.5'), 1250);
  assert.equal(parseRate(''), null);
  assert.equal(parseRate('abc'), 'bad');
});
