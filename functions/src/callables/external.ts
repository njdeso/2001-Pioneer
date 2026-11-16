import { createHash } from 'node:crypto';
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getStorage } from 'firebase-admin/storage';
import {
  EXTERNAL_ROLE_LABELS, externalAccessDecision, externalInviteInput, externalRevokeInput, guardReviewerPayload, isExternalRole,
  reviewerBook, reviewerBookCsv, reviewerCarriers, reviewerExportInput, reviewerOverview, reviewerStatements, reviewerStatementsCsv,
  reviewerSummaryCsv, reviewerTransactions, reviewerTransactionsCsv, reviewerViewInput, reviewerSettings,
  reviewerStatementDetail, reviewerStatementDetailCsv, reviewerStatementLinesCsv, reviewerFileInput, reviewerOriginalName, originalFileAccess,
  type ExternalAccessRecord, type ExternalRole, type ReportEntry, type ReviewerStatementDetail, type ReviewerViewRequest,
} from '@asm/shared';
import { audit, auth, db, FieldValue, parse, requireRole, type Actor } from '../lib/core.js';
import { OWNER_EMAILS } from './admin.js';

/**
 * External due-diligence access: owner-controlled provisioning, and read-only allowlisted reviewer data.
 *
 * Provisioning (owner only): inviteExternalUser / revokeExternalUser. The custom claim (role buyer |
 * diligence) is set only here, through the Admin SDK; the access record externalAccess/{uid} is the source
 * of truth checked on every reviewer request (status, role, expiry), so revocation is immediate.
 *
 * Reviewer data (getReviewerData / getReviewerExport / getReviewerStatementFile): external users have no
 * Firestore or Storage access.
 * These callables read ONLY allowlisted fields (Firestore field selection, so broker IDs, shares and
 * amounts, notes, contact details and audit fields are never even loaded), build the views in
 * @asm/shared external/reviewerViews.ts, and pass every response through guardReviewerPayload (fail closed).
 * Broker records are read only as IDs and codes, for that guard. Nothing here writes business data.
 * Original statement files are returned byte for byte (the carrier's document, unchanged) by
 * getReviewerStatementFile — as bytes in the response, never as a link that could be passed on.
 */

const DENIED = 'Access is not authorized or has ended. Contact the agency owner.';
const today = () => new Date().toISOString().slice(0, 10);

interface ReviewerCaller { uid: string; email: string; role: ExternalRole | 'admin' }

/** Owner (admin) for a preview, or an external user with an active, unexpired access record of the same role. */
async function requireReviewer(req: CallableRequest<unknown>): Promise<ReviewerCaller> {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const role = req.auth.token.role;
  const email = String(req.auth.token.email ?? '');
  if (role === 'admin') return { uid: req.auth.uid, email, role: 'admin' };
  if (!isExternalRole(role)) throw new HttpsError('permission-denied', DENIED);
  const rec = await db.collection('externalAccess').doc(req.auth.uid).get();
  const d = externalAccessDecision(role, rec.exists ? (rec.data() as ExternalAccessRecord) : null, today());
  if (!d.ok) {
    logger.warn('external access refused', { uid: req.auth.uid, reason: d.reason }); // ids only
    throw new HttpsError('permission-denied', DENIED);
  }
  return { uid: req.auth.uid, email, role };
}

// ---- allowlisted reads (field selection: nothing else is loaded) ----
type Doc = Record<string, unknown> & { id: string };
const read = async (col: string, fields: string[]): Promise<Doc[]> =>
  (await db.collection(col).select(...fields).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const CARRIER_FIELDS = ['name', 'kind', 'commissionMethod', 'status'];
const CLIENT_FIELDS = ['name', 'classification', 'status'];
const POLICY_FIELDS = ['clientId', 'carrierId', 'wholesalerId', 'policyNumber', 'alternateNumbers', 'line', 'policyType', 'namedInsured', 'effectiveDate', 'expirationDate', 'status', 'premiumCents', 'commissionRateBps'];
const LEDGER_FIELDS = ['amountCents', 'statementPeriod', 'postingStatus', 'payerId', 'carrierId', 'clientId', 'policyId', 'sourceType', 'level', 'classification', 'transactionDate', 'reversalOf', 'statementId', 'postingId'];
// originalPath is loaded only to say whether the original exists (hasOriginal); it is never returned.
const STATEMENT_FIELDS = ['status', 'statementMonth', 'statementDate', 'payerId', 'statementTotalCents', 'postedCents', 'reconciliation.reconciled', 'reconciliation.checks', 'reconciliation.totals.commissionCents', 'reconciliation.totals.adjustmentsCents', 'originalPath', 'fileType'];
const STATEMENT_DETAIL_FIELDS = [...STATEMENT_FIELDS, 'stated', 'adjustments'];
/** Statement line fields shared with reviewers. Not loaded: match details beyond the policy, broker data, raw text, notes and checks. */
const LINE_FIELDS = ['lineNo', 'page', 'insuredName', 'policyNumberRaw', 'transactionCodeRaw', 'transactionType', 'effectiveDate', 'premiumForCommissionCents', 'transactionPremiumCents', 'rateBps', 'paidCommissionCents', 'termCommissionCents', 'feeCents', 'paymentReceivedCents', 'match.policyId'];
const MAX_ORIGINAL_BYTES = 20 * 1024 * 1024; // the upload limit (storage rules)
const CONTENT_TYPE: Record<string, string> = { pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv' };
const settingsDoc = async () => {
  const snap = await db.collection('settings').doc('app').get();
  return reviewerSettings(snap.exists ? snap.data() : null);
};
const ledger = async () => (await read('ledger', LEDGER_FIELDS)) as unknown as ReportEntry[];
const readOne = async (col: string, id: string, fields: string[]): Promise<Doc | null> => {
  const snap = await db.collection(col).where('__name__', '==', db.collection(col).doc(id)).select(...fields).get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
};
const statementLines = async (id: string): Promise<Doc[]> =>
  (await db.collection('statements').doc(id).collection('lines').select(...LINE_FIELDS).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
/** One statement in detail; null for a missing or discarded statement (not part of the record). */
async function statementDetail(id: string, ctx?: { carriers: Doc[]; policies: Doc[]; clients: Doc[] }): Promise<ReviewerStatementDetail | null> {
  const st = await readOne('statements', id, STATEMENT_DETAIL_FIELDS);
  if (!st) return null;
  const [lines, carriers, policies, clients] = await Promise.all([
    statementLines(id),
    ctx?.carriers ?? read('carriers', CARRIER_FIELDS), ctx?.policies ?? read('policies', ['policyNumber', 'clientId']), ctx?.clients ?? read('clients', ['name']),
  ]);
  return reviewerStatementDetail({ statement: st, lines, carriers, policies, clients });
}
const brokerIdentifiers = async () => (await db.collection('brokers').select('code').get()).docs.flatMap((d) => [d.id, String(d.get('code') ?? '')]);

async function buildView(view: string, statementId?: string) {
  if (view === 'statement') {
    const detail = await statementDetail(String(statementId));
    if (!detail) throw new HttpsError('not-found', 'This statement is not available.');
    return { statement: detail };
  }
  const settings = await settingsDoc();
  const win = { start: settings.snapshotStartMonth, months: settings.snapshotMonths };
  switch (view) {
    case 'carriers': return { carriers: reviewerCarriers(await read('carriers', CARRIER_FIELDS)) };
    case 'statements': {
      const [statements, carriers] = await Promise.all([read('statements', STATEMENT_FIELDS), read('carriers', CARRIER_FIELDS)]);
      return { statements: reviewerStatements(statements, carriers) };
    }
    case 'book': {
      const [clients, policies, carriers, entries] = await Promise.all([read('clients', CLIENT_FIELDS), read('policies', POLICY_FIELDS), read('carriers', CARRIER_FIELDS), ledger()]);
      return { settings, book: reviewerBook({ clients, policies, carriers, entries, ...win }) };
    }
    case 'transactions': {
      const [clients, policies, carriers, entries] = await Promise.all([read('clients', CLIENT_FIELDS), read('policies', POLICY_FIELDS), read('carriers', CARRIER_FIELDS), ledger()]);
      return { settings, transactions: reviewerTransactions({ entries, carriers, clients, policies, ...win }) };
    }
    case 'overview': {
      const [rawSettings, entries, carriers, policies, statements] = await Promise.all([
        db.collection('settings').doc('app').get().then((s) => (s.exists ? { agencyName: s.get('agencyName'), snapshotStartMonth: s.get('snapshotStartMonth'), snapshotMonths: s.get('snapshotMonths') } : null)),
        ledger(), read('carriers', CARRIER_FIELDS), read('policies', ['clientId', 'carrierId', 'wholesalerId', 'policyNumber', 'status']), read('statements', STATEMENT_FIELDS),
      ]);
      return { overview: reviewerOverview({ settings: rawSettings, entries, carriers, policies, statements }) };
    }
    default: throw new HttpsError('invalid-argument', 'Unknown view.');
  }
}

/** Guard the payload and record the access (external callers only). */
async function deliver<T>(caller: ReviewerCaller, what: string, payload: T): Promise<T> {
  try {
    guardReviewerPayload(payload, await brokerIdentifiers());
  } catch (err) {
    logger.error('reviewer payload blocked', { what, guard: String((err as Error).message).slice(0, 200) }); // field path only, never values
    throw new HttpsError('internal', 'The data could not be prepared. The agency owner has been notified in the logs.');
  }
  if (caller.role !== 'admin') {
    const b = db.batch();
    const actor: Actor = { uid: caller.uid, email: caller.email, role: caller.role };
    audit(b, actor, { action: 'external_view', entityType: 'externalAccess', entityId: caller.uid, summary: `${EXTERNAL_ROLE_LABELS[caller.role]} viewed ${what}` });
    b.update(db.collection('externalAccess').doc(caller.uid), { lastAccessAt: FieldValue.serverTimestamp(), lastAccessAtIso: new Date().toISOString() });
    await b.commit();
  }
  return payload;
}

export const getReviewerData = onCall({ memory: '512MiB', timeoutSeconds: 120 }, async (req) => {
  const caller = await requireReviewer(req);
  const input: ReviewerViewRequest = parse(reviewerViewInput, req.data);
  const statementId = input.view === 'statement' ? input.statementId : undefined;
  const payload = { role: caller.role, organization: caller.role === 'admin' ? 'Owner preview' : EXTERNAL_ROLE_LABELS[caller.role], view: input.view, ...(await buildView(input.view, statementId)) };
  return deliver(caller, statementId ? `statement ${statementId}` : input.view, payload);
});

export const getReviewerExport = onCall({ memory: '512MiB', timeoutSeconds: 120 }, async (req) => {
  const caller = await requireReviewer(req);
  const input = parse(reviewerExportInput, req.data);
  const kind = input.kind;
  const at = new Date().toISOString();
  const date = at.slice(0, 10);
  let csv: string;
  let name = `Due-diligence-${kind}-${date}.csv`;
  if (input.kind === 'statement') {
    const [settings, detail] = await Promise.all([settingsDoc(), statementDetail(input.statementId)]);
    if (!detail) throw new HttpsError('not-found', 'This statement is not available.');
    csv = reviewerStatementDetailCsv(detail, settings.agencyName, at);
    name = `Due-diligence-statement-${(detail.statement.payer + ' ' + (detail.statement.statementMonth ?? '')).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${date}.csv`;
  } else if (kind === 'statementLines') {
    const [settings, statements, carriers, policies, clients] = await Promise.all([settingsDoc(), read('statements', STATEMENT_FIELDS), read('carriers', CARRIER_FIELDS), read('policies', ['policyNumber', 'clientId']), read('clients', ['name'])]);
    const listed = reviewerStatements(statements, carriers); // discarded uploads excluded; newest first
    const details = (await Promise.all(listed.map((x) => statementDetail(x.id, { carriers, policies, clients })))).filter((x): x is ReviewerStatementDetail => !!x);
    csv = reviewerStatementLinesCsv(details, settings.agencyName, at);
  } else if (kind === 'summary') {
    const { overview } = (await buildView('overview')) as { overview: ReturnType<typeof reviewerOverview> };
    if (overview.status === 'CHECKS_FAILED' || overview.status === 'NO_PERIOD') throw new HttpsError('failed-precondition', `The commission summary is not available: ${overview.statusLabel}.`);
    csv = reviewerSummaryCsv(overview, at);
  } else if (kind === 'book') {
    const { settings, book } = (await buildView('book')) as { settings: ReturnType<typeof reviewerSettings>; book: ReturnType<typeof reviewerBook> };
    csv = reviewerBookCsv(book, settings.agencyName, at);
  } else if (kind === 'transactions') {
    const { settings, transactions } = (await buildView('transactions')) as { settings: ReturnType<typeof reviewerSettings>; transactions: ReturnType<typeof reviewerTransactions> };
    csv = reviewerTransactionsCsv(transactions, settings.agencyName, at);
  } else {
    const [settings, { statements }] = await Promise.all([settingsDoc(), buildView('statements') as Promise<{ statements: ReturnType<typeof reviewerStatements> }>]);
    csv = reviewerStatementsCsv(statements, settings.agencyName, at);
  }
  return deliver(caller, input.kind === 'statement' ? `statement ${input.statementId} export` : `${kind} export`, { downloadName: name, csv });
});

/**
 * The carrier's original statement file, byte for byte (PDF, or the workbook for spreadsheet statements).
 * Returned in the response — not as a link — after the same access checks as every reviewer request, for
 * listed statements only (discarded uploads excluded). The download name is neutral (carrier, month), never
 * the uploaded file name. Every access is audited.
 */
export const getReviewerStatementFile = onCall({ memory: '1GiB', timeoutSeconds: 120 }, async (req) => {
  const caller = await requireReviewer(req);
  const { statementId } = parse(reviewerFileInput, req.data);
  const st = await readOne('statements', statementId, STATEMENT_FIELDS);
  const [listed] = st ? reviewerStatements([st], await read('carriers', CARRIER_FIELDS)) : [];
  if (!st || !listed) throw new HttpsError('not-found', 'This statement is not available.');
  const access = originalFileAccess({ status: String(st.status ?? ''), originalPath: st.originalPath as string | null | undefined });
  if (!access.available) throw new HttpsError('not-found', access.reason);
  const file = getStorage().bucket().file(String(st.originalPath));
  const [exists] = await file.exists();
  if (!exists) throw new HttpsError('not-found', 'The original file is recorded for this statement but is missing from storage. Contact the agency.');
  const [meta] = await file.getMetadata();
  if (Number(meta.size ?? 0) > MAX_ORIGINAL_BYTES) throw new HttpsError('failed-precondition', 'This original file is too large to open here. Contact the agency for a copy.');
  const [bytes] = await file.download();
  const payload = {
    downloadName: reviewerOriginalName(listed),
    contentType: CONTENT_TYPE[listed.fileType ?? 'pdf'] ?? 'application/octet-stream',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    base64: bytes.toString('base64'),
  };
  return deliver(caller, `original statement ${statementId}`, payload);
});

// ---------------------------------------------------------------- owner provisioning

/** Invite (or re-activate) an external user. Owner only. Returns a one-time password-setup link for the owner to send. */
export const inviteExternalUser = onCall(async (req) => {
  const actor = requireRole(req, ['admin']);
  const input = parse(externalInviteInput, req.data);
  const t = today();
  const max = new Date(Date.now() + 366 * 86400_000).toISOString().slice(0, 10);
  if (input.expiresOn < t) throw new HttpsError('invalid-argument', 'The access end date is in the past.', { fieldErrors: { expiresOn: 'Choose today or a later date' } });
  if (input.expiresOn > max) throw new HttpsError('invalid-argument', 'Access can be granted for at most one year at a time.', { fieldErrors: { expiresOn: 'At most one year from today' } });
  const owners = OWNER_EMAILS.value().split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (owners.includes(input.email)) throw new HttpsError('failed-precondition', 'An owner account cannot be given external access.');

  let user = await auth.getUserByEmail(input.email).catch(() => null);
  if (user) {
    const current = user.customClaims?.role;
    if (current === 'admin' || current === 'staff') throw new HttpsError('failed-precondition', 'This email belongs to an internal account. Use a separate email for external access.');
    const existing = await db.collection('externalAccess').doc(user.uid).get();
    if (existing.exists && existing.get('status') === 'active' && existing.get('role') !== input.role) {
      throw new HttpsError('failed-precondition', `This account already has active access as ${EXTERNAL_ROLE_LABELS[existing.get('role') as ExternalRole]}. Revoke it first; one account belongs to one organization.`);
    }
  } else {
    user = await auth.createUser({ email: input.email, emailVerified: false, disabled: false });
  }
  await auth.setCustomUserClaims(user.uid, { role: input.role });
  if (user.disabled) await auth.updateUser(user.uid, { disabled: false });
  const organization = EXTERNAL_ROLE_LABELS[input.role];
  const b = db.batch();
  b.set(db.collection('externalAccess').doc(user.uid), {
    email: input.email, role: input.role, organization, status: 'active', expiresOn: input.expiresOn,
    invitedAt: FieldValue.serverTimestamp(), invitedAtIso: new Date().toISOString(), invitedBy: actor.uid,
    revokedAt: null, revokedAtIso: null, revokedBy: null, revokeReason: null,
  }, { merge: true });
  audit(b, actor, { action: 'external_invite', entityType: 'externalAccess', entityId: user.uid, summary: `Granted read-only due-diligence access (${organization}) to ${input.email} until ${input.expiresOn}` });
  await b.commit();
  const setupLink = await auth.generatePasswordResetLink(input.email);
  return { uid: user.uid, organization, expiresOn: input.expiresOn, setupLink };
});

/** Revoke an external user's access immediately. Owner only. */
export const revokeExternalUser = onCall(async (req) => {
  const actor = requireRole(req, ['admin']);
  const { uid, reason } = parse(externalRevokeInput, req.data);
  const ref = db.collection('externalAccess').doc(uid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No external access record for this account.');
  const user = await auth.getUser(uid).catch(() => null);
  if (user && (user.customClaims?.role === 'admin' || user.customClaims?.role === 'staff')) throw new HttpsError('failed-precondition', 'This is an internal account.');
  // Record first (takes effect at the next request), then remove the claim, disable sign-in and end sessions.
  const b = db.batch();
  b.update(ref, { status: 'revoked', revokedAt: FieldValue.serverTimestamp(), revokedAtIso: new Date().toISOString(), revokedBy: actor.uid, revokeReason: reason });
  audit(b, actor, { action: 'external_revoke', entityType: 'externalAccess', entityId: uid, summary: `Revoked due-diligence access (${String(snap.get('organization'))}) for ${String(snap.get('email'))}: ${reason}` });
  await b.commit();
  if (user) {
    await auth.setCustomUserClaims(uid, {});
    await auth.updateUser(uid, { disabled: true });
    await auth.revokeRefreshTokens(uid);
  }
  return { ok: true };
});
