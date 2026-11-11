/**
 * Turning Firebase callable failures into messages a person can act on.
 *
 * The Firebase web SDK reports two very different situations with the same error code:
 *   - the server function ran and refused (HttpsError): the error carries the server's own message
 *     ("Statement not found.", "Not ready: …") — show it as is;
 *   - the request never reached a function (HTTP 404 from Google's front end, network failure,
 *     timeout): the error carries only the SDK's default text, e.g. "not-found", "not-found [404]",
 *     "internal". A bare "not-found [404]" says nothing about WHICH function or WHERE, so we replace it
 *     with the function name, its URL and the web-app build, and say that nothing reached the server.
 */

export interface CallableErrorLike { code?: unknown; message?: unknown }
export interface CallableTarget { name: string; projectId: string; region: string; build?: string | null }

export const callableUrl = (t: Pick<CallableTarget, 'name' | 'projectId' | 'region'>) => `https://${t.region}-${t.projectId}.cloudfunctions.net/${t.name}`;

/** "functions/not-found" → "not-found". */
export function shortCode(code: unknown): string {
  return String(code ?? '').replace(/^functions\//, '');
}

function rawMessage(err: CallableErrorLike): string {
  // Strip only the SDK's class prefix; server messages can legitimately contain colons ("Not ready: …").
  return String(err.message ?? '').replace(/^FirebaseError:\s*/, '').trim();
}

/**
 * True when the message is just the SDK's default for the code (no server message): the request did
 * not get an answer from the function itself. firebase-functions answers unexpected server errors with
 * "INTERNAL" in capitals, which is NOT a transport error.
 */
export function isTransportError(err: CallableErrorLike): boolean {
  const code = shortCode(err.code);
  const m = rawMessage(err);
  if (!m) return true;
  return new RegExp(`^${code.replace(/[-]/g, '\\-')}(?: \\[\\d{1,3}\\])?$`).test(m);
}

export function describeCallableError(err: CallableErrorLike, t: CallableTarget): string {
  const code = shortCode(err.code);
  const m = rawMessage(err);
  const where = callableUrl(t);
  const build = t.build ? ` Web app build ${t.build}.` : '';
  if (!isTransportError(err)) {
    if (m === 'INTERNAL') return `The server function "${t.name}" hit an unexpected error. Reload the page to see the current state before trying again.${build}`;
    return m || 'Request failed.';
  }
  switch (code) {
    case 'not-found':
      return `The server function "${t.name}" was not found (HTTP 404) at ${where}. The request did not reach the server, so nothing was changed. This page may be an outdated build or point at the wrong server: reload it; if this happens again, send this message.${build}`;
    case 'internal':
      return `Could not reach the server function "${t.name}" at ${where} (network error, or the browser blocked the request). Nothing was changed. Check the connection and reload the page.${build}`;
    case 'unavailable':
    case 'deadline-exceeded':
      return `The server function "${t.name}" did not answer in time (${code}). Reload the page to see whether the change was saved before trying again.${build}`;
    case 'unauthenticated':
      return 'Your sign-in has expired. Sign in again.';
    case 'permission-denied':
      return 'You do not have permission to do this.';
    default:
      return `The server function "${t.name}" failed (${code || 'unknown error'}) at ${where}.${build}`;
  }
}

export type ProbeResult = 'reachable' | 'missing' | 'unreachable';

/**
 * Classify the answer to a probe call made with deliberately invalid input ({ probe: true }). Every
 * probed function checks the sign-in and then rejects the input before reading or writing anything,
 * so a deployed function answers invalid-argument (or permission-denied / unauthenticated).
 */
export function classifyProbe(err: CallableErrorLike | null): ProbeResult {
  if (!err) return 'reachable';
  if (!isTransportError(err)) return 'reachable';
  const code = shortCode(err.code);
  if (code === 'not-found') return 'missing';
  if (code === 'unauthenticated' || code === 'permission-denied' || code === 'invalid-argument' || code === 'failed-precondition') return 'reachable';
  return 'unreachable';
}

/** Functions that check the sign-in and validate input before any read or write: safe to probe. */
export const PROBE_SAFE_FUNCTIONS = [
  'runStatementMatching', 'setLineMatch', 'approveStatement', 'unapproveStatement', 'postStatement',
  'reverseStatementPosting', 'recordRetainedCommission', 'reverseLedgerEntry',
  'checkStatementDuplicates', 'setStatementClassification', 'confirmSeparateStatement',
] as const;
