/**
 * Low-level Anthropic Messages / Models API helpers (server side only).
 *
 * Why this exists: the original client threw away Anthropic's error body and reported only
 * "HTTP 400" / "HTTP 404", which made 401/400/404 failures impossible to tell apart. Anthropic
 * returns a JSON body on every error:
 *     { "type": "error", "error": { "type": "<error type>", "message": "<reason>" }, "request_id": "req_…" }
 * and a `request-id` response header. These helpers read that body, classify it, and turn it
 * into a plain-English explanation. Error bodies never contain the submitted document, but the
 * message is still truncated and scrubbed of anything that looks like a key before it is stored.
 */

export const ANTHROPIC_API_BASE = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';

/** Shape check only — whether a model exists for an account is decided by the Models API. */
export const MODEL_ID_PATTERN = /^claude-[a-z0-9][a-z0-9.-]{2,62}$/;

export type ApiErrorKind =
  | 'auth' | 'permission' | 'model_not_found' | 'billing' | 'invalid_request'
  | 'too_large' | 'rate_limited' | 'overloaded' | 'server' | 'unknown';

export interface ApiErrorInfo {
  status: number;
  kind: ApiErrorKind;
  /** Anthropic's error.type, e.g. authentication_error, invalid_request_error, not_found_error. */
  errorType: string | null;
  /** Anthropic's error.message (truncated, scrubbed). */
  apiMessage: string | null;
  /** Quote this to Anthropic support. */
  requestId: string | null;
  retryAfterMs: number | null;
  retryable: boolean;
}

const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

/** Remove anything key-like and cap the length before an API message is logged or stored. */
export function scrubApiText(s: string, max = 400): string {
  return s.replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-…').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Normalise a key read from Secret Manager. Secrets set by pasting into a terminal very often
 * carry a trailing newline or spaces; sent as-is in the x-api-key header they produce HTTP 401.
 */
export function cleanApiKey(raw: string | null | undefined): { key: string; problems: string[]; hint: string | null; length: number } {
  const problems: string[] = [];
  const original = raw ?? '';
  let key = original.trim();
  if (key !== original) problems.push('The stored key had leading/trailing whitespace or a newline (removed automatically).');
  if (/^["'].*["']$/.test(key)) {
    key = key.slice(1, -1).trim();
    problems.push('The stored key was wrapped in quotation marks (removed automatically).');
  }
  if (/\s/.test(key)) problems.push('The key contains spaces or line breaks inside it — it was probably pasted incorrectly.');
  if (key && !key.startsWith('sk-ant-')) problems.push('The key does not start with "sk-ant-", so it is probably not an Anthropic API key.');
  return { key, problems, hint: key.length >= 8 ? `…${key.slice(-4)}` : null, length: key.length };
}

export function classifyApiError(status: number, errorType: string | null, apiMessage: string | null): ApiErrorKind {
  const msg = (apiMessage ?? '').toLowerCase();
  if (status === 401 || errorType === 'authentication_error') return 'auth';
  if (status === 403 || errorType === 'permission_error') return 'permission';
  if (status === 402 || errorType === 'billing_error' || /credit balance|billing|purchase credits|plans? & billing/.test(msg)) return 'billing';
  // On /v1/messages and /v1/models/{id} the only resource that can be "not found" is the model.
  if (status === 404 || errorType === 'not_found_error') return 'model_not_found';
  if (status === 413 || errorType === 'request_too_large') return 'too_large';
  if (status === 429 || errorType === 'rate_limit_error') return 'rate_limited';
  if (status === 529 || errorType === 'overloaded_error') return 'overloaded';
  if (status === 400 || errorType === 'invalid_request_error') return 'invalid_request';
  if (status >= 500) return 'server';
  return 'unknown';
}

/** Read Anthropic's error response. Never throws. */
export async function readApiError(res: Response): Promise<ApiErrorInfo> {
  let errorType: string | null = null;
  let apiMessage: string | null = null;
  let requestId: string | null = res.headers.get('request-id') ?? res.headers.get('x-request-id');
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text) as { error?: { type?: unknown; message?: unknown } | string; request_id?: unknown };
      if (j && typeof j.error === 'object' && j.error) {
        if (typeof j.error.type === 'string') errorType = j.error.type;
        if (typeof j.error.message === 'string') apiMessage = scrubApiText(j.error.message);
      } else if (typeof j?.error === 'string') {
        apiMessage = scrubApiText(j.error);
      }
      if (!requestId && typeof j?.request_id === 'string') requestId = j.request_id;
    } catch {
      if (text.trim()) apiMessage = scrubApiText(text, 200);
    }
  } catch { /* body unreadable */ }
  const ra = Number(res.headers.get('retry-after'));
  const retryAfterMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60_000) : null;
  return {
    status: res.status,
    kind: classifyApiError(res.status, errorType, apiMessage),
    errorType,
    apiMessage,
    requestId,
    retryAfterMs,
    retryable: RETRY_STATUS.has(res.status),
  };
}

/** Plain-English explanation for the person running the app. */
export function explainApiError(e: ApiErrorInfo, model: string): string {
  const detail = `HTTP ${e.status}${e.errorType ? ` ${e.errorType}` : ''}${e.apiMessage ? `: ${e.apiMessage}` : ''}`;
  const ref = e.requestId ? ` (Anthropic request ${e.requestId})` : '';
  switch (e.kind) {
    case 'auth':
      return `Anthropic rejected the API key (${detail}). The ANTHROPIC_API_KEY secret is invalid, revoked, or belongs to a deleted workspace. Run "Test AI connection" in Settings; if it still fails, create a new key in the Anthropic Console, store it with firebase functions:secrets:set, and redeploy the functions so they pick up the new version.${ref}`;
    case 'permission':
      return `This API key is not allowed to use ${model} or this feature (${detail}). Check the key's workspace permissions in the Anthropic Console.${ref}`;
    case 'billing':
      return `Anthropic refused the request for a billing reason (${detail}). Add credits or a payment method under Plans & Billing in the Anthropic Console, then retry.${ref}`;
    case 'model_not_found':
      return `The model "${model}" is not available to this API key (${detail}). Either the model ID is wrong or retired, or this account does not have access to it. Use "Test AI connection" in Settings to see the models this key can use, and pick one of those.${ref}`;
    case 'too_large':
      return `The statement is too large for one Claude request (${detail}). Split the PDF into smaller files and upload them separately.${ref}`;
    case 'invalid_request':
      return `Anthropic rejected the request as invalid (${detail}).${ref}`;
    case 'rate_limited':
      return `Anthropic's rate limit was hit (${detail}). Wait a minute and retry.${ref}`;
    case 'overloaded':
    case 'server':
      return `Anthropic's service had a temporary problem (${detail}). Retry in a few minutes.${ref}`;
    default:
      return `The Claude API returned an error (${detail}).${ref}`;
  }
}

export function anthropicHeaders(apiKey: string): Record<string, string> {
  return { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION };
}
