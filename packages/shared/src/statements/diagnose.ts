import { ANTHROPIC_API_BASE, MODEL_ID_PATTERN, anthropicHeaders, cleanApiKey, explainApiError, readApiError, type ApiErrorInfo } from './anthropic.js';
import { extractWithClaude, type AiRequestFormat } from './ai.js';
import { reconcileStatement } from './reconcile.js';

/**
 * "Test AI connection": answers, in order, the questions behind the 401 / 400 / 404 failures.
 *
 *  1. Is a key configured, and is it well-formed?                       (no request)
 *  2. Does Anthropic accept the key?            GET /v1/models          (free, no tokens)
 *  3. Which models can THIS key use, and is the configured one of them? GET /v1/models/{id}
 *       – not in the key's list  → wrong/retired ID, or the account has no access to it
 *  4. Does a real extraction work?  Runs extractWithClaude — the exact code path statement
 *     processing uses (same request builder, structured-output format and fallback, answer
 *     parsing and validation) — on a 2-row synthetic statement, and reconciles the result.
 *       – catches billing (credit balance), permission, request-format and model-level 400s,
 *         and answers that do not validate.
 *     Cost: a few thousand tokens — about a cent. No statement data is sent.
 */

export type CheckState = 'pass' | 'fail' | 'warn' | 'skipped';

export interface AiDiagnosis {
  ok: boolean;
  checkedAt: string;
  model: string;
  key: { state: CheckState; length: number; hint: string | null; problems: string[] };
  auth: { state: CheckState; detail: string; error?: ApiErrorInfo };
  models: { state: CheckState; available: string[]; detail: string };
  model_: { state: CheckState; formatValid: boolean; availableToKey: boolean | null; displayName: string | null; detail: string };
  request: { state: CheckState; detail: string; error?: ApiErrorInfo; requestId?: string | null; requestFormat?: AiRequestFormat | null; lines?: number; reconciled?: boolean };
  summary: string;
}

export interface DiagnoseOptions {
  apiKey: string | null | undefined;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Skip step 4 (the only step that uses tokens). */
  skipRequest?: boolean;
}

async function timed(f: typeof fetch, url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await f(url, { ...init, signal: ctl.signal }); } finally { clearTimeout(t); }
}

export async function diagnoseAnthropic(opts: DiagnoseOptions): Promise<AiDiagnosis> {
  const f = opts.fetchImpl ?? fetch;
  const ms = opts.timeoutMs ?? 30_000;
  const model = (opts.model ?? '').trim();
  const k = cleanApiKey(opts.apiKey);
  const d: AiDiagnosis = {
    ok: false,
    checkedAt: new Date().toISOString(),
    model,
    key: { state: 'pass', length: k.length, hint: k.hint, problems: k.problems },
    auth: { state: 'skipped', detail: '' },
    models: { state: 'skipped', available: [], detail: '' },
    model_: { state: 'skipped', formatValid: MODEL_ID_PATTERN.test(model), availableToKey: null, displayName: null, detail: '' },
    request: { state: 'skipped', detail: '' },
    summary: '',
  };
  const done = (summary: string) => { d.summary = summary; return d; };

  // 1. Key present / well-formed
  if (!k.key) {
    d.key.state = 'fail';
    return done('No API key is configured. Store it with: firebase functions:secrets:set ANTHROPIC_API_KEY, then redeploy the functions.');
  }
  if (k.problems.length) d.key.state = 'warn';
  const headers = anthropicHeaders(k.key);

  // 2 + 3a. Authenticate and list the models this key can use
  try {
    const ids: string[] = [];
    let after: string | null = null;
    for (let page = 0; page < 5; page++) {
      const url = `${ANTHROPIC_API_BASE}/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
      const res = await timed(f, url, { method: 'GET', headers }, ms);
      if (!res.ok) {
        const e = await readApiError(res);
        d.auth = { state: e.kind === 'auth' ? 'fail' : 'warn', detail: explainApiError(e, model), error: e };
        if (e.kind === 'auth') return done(`Authentication failed: Anthropic does not accept the stored key (HTTP ${e.status}). This is the cause of the 401 errors. Create a new key, store it as a new secret version, and redeploy.`);
        break;
      }
      const j = (await res.json()) as { data?: { id?: string }[]; has_more?: boolean; last_id?: string };
      for (const m of j.data ?? []) if (typeof m.id === 'string') ids.push(m.id);
      if (!j.has_more || !j.last_id) break;
      after = j.last_id;
    }
    if (d.auth.state === 'skipped') d.auth = { state: 'pass', detail: 'Anthropic accepted the API key.' };
    if (ids.length) d.models = { state: 'pass', available: ids, detail: `${ids.length} models are available to this key.` };
  } catch (err) {
    const aborted = (err as { name?: string })?.name === 'AbortError';
    d.auth = { state: 'fail', detail: aborted ? 'The Anthropic API did not answer in time.' : 'Could not reach api.anthropic.com from the Cloud Function (network error).' };
    return done(d.auth.detail);
  }

  // 3b. Is the configured model available to this key?
  if (!d.model_.formatValid) {
    d.model_ = { ...d.model_, state: 'fail', availableToKey: false, detail: `"${model}" is not a valid model ID format.` };
    return done(`The configured model "${model}" is not a valid model ID. Choose one of the models listed for this key.`);
  }
  try {
    const res = await timed(f, `${ANTHROPIC_API_BASE}/v1/models/${encodeURIComponent(model)}`, { method: 'GET', headers }, ms);
    if (res.ok) {
      const j = (await res.json()) as { id?: string; display_name?: string };
      d.model_ = { ...d.model_, state: 'pass', availableToKey: true, displayName: j.display_name ?? null, detail: `${model} is available to this key${j.id && j.id !== model ? ` (resolves to ${j.id})` : ''}.` };
    } else {
      const e = await readApiError(res);
      if (e.kind === 'model_not_found') {
        d.model_ = { ...d.model_, state: 'fail', availableToKey: false, detail: `Anthropic does not know "${model}" for this key (HTTP 404 ${e.errorType ?? ''}).` };
        const suggestions = d.models.available.filter((id) => /sonnet/.test(id)).slice(0, 5);
        return done(`The model "${model}" is not available to this API key — this is what causes HTTP 404. The ID is wrong, retired, or not enabled for this account.${suggestions.length ? ` Models this key can use include: ${suggestions.join(', ')}.` : ''}`);
      }
      d.model_ = { ...d.model_, state: 'warn', detail: explainApiError(e, model) };
    }
  } catch {
    d.model_ = { ...d.model_, state: 'warn', detail: 'Could not look up the model (network error); continuing with a test request.' };
  }

  // 4. A real, statement-shaped request with the production schema (synthetic data only)
  if (opts.skipRequest) {
    d.ok = d.auth.state === 'pass' && d.model_.state === 'pass';
    return done(d.ok ? 'Key and model are valid (test request skipped).' : 'See the checks above.');
  }
  const res = await extractWithClaude({
    apiKey: k.key,
    model,
    fetchImpl: f,
    input: {
      kind: 'table',
      fileName: 'connection-test.csv',
      text: 'SYNTHETIC TEST CARRIER - COMMISSION STATEMENT - OCTOBER 2026\nNAME OF INSURED\tPOLICY NUMBER\tPAID COMMISSION\nTEST INSURED A\tTST0001\t10.00\nTEST INSURED B\tTST0002\t5.25\nTOTAL COMMISSION\t\t15.25',
    },
    maxTokens: 4096,
    maxRetries: 0,
    timeoutMs: 85_000,
    deadlineMs: 90_000,
  });
  if (!res.ok) {
    const e = res.http;
    d.request = { state: 'fail', detail: e ? explainApiError(e, model) : res.message, error: e, requestId: e?.requestId ?? null, requestFormat: res.requestFormat ?? null };
    if (e) {
      const why = e.kind === 'billing' ? 'a billing problem on the Anthropic account (this is a common cause of HTTP 400)'
        : e.kind === 'invalid_request' ? `Anthropic rejected the request format: ${e.apiMessage ?? 'no reason given'}`
        : e.kind;
      return done(`The key and model are valid, but a test extraction failed with HTTP ${e.status}: ${why}.`);
    }
    return done(`The key and model are valid, but a test extraction failed: ${res.message}`);
  }
  const rec = reconcileStatement(res.statement);
  const lines = res.statement.lines.length;
  d.request = {
    state: lines === 2 && rec.reconciled ? 'pass' : 'fail',
    requestId: res.requestId,
    requestFormat: res.requestFormat,
    lines,
    reconciled: rec.reconciled,
    detail: `Extraction ran (${res.requestFormat === 'json_schema' ? 'structured output' : 'tool, auto choice'}): ${lines} of 2 synthetic rows read; ${rec.reconciled ? 'reconciled to the cent' : 'did not reconcile'}.`,
  };
  if (d.request.state !== 'pass') return done(`Claude answered, but the synthetic statement was not read correctly: ${d.request.detail}`);

  d.ok = true;
  return done(`AI connection works: key accepted, ${model} available, and a test statement was extracted and reconciled to the cent using the same code as statement processing.`);
}
