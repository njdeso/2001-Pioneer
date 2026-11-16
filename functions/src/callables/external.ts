import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import {
  EXTERNAL_ROLE_LABELS, externalAccessDecision, externalInviteInput, externalRevokeInput, guardReviewerPayload, isExternalRole,
  reviewerBook, reviewerBookCsv, reviewerCarriers, reviewerExportInput, reviewerOverview, reviewerStatements, reviewerStatementsCsv,
  reviewerSummaryCsv, reviewerTransactions, reviewerTransactionsCsv, reviewerViewInput, reviewerSettings,
  type ExternalAccessRecord, type ExternalRole, type ReportEntry,
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
 * Reviewer data (getReviewerData / getReviewerExport): external users have no Firestore or Storage access.
 * These callables read ONLY allowlisted fields (Firestore field selection, so broker IDs, shares and
 * amounts, notes, contact details and audit fields are never even loaded), build the views in
 * @asm/shared external/reviewerViews.ts, and pass every response through guardReviewerPayload (fail closed).
 * Broker records are read only as IDs and codes, for that guard. Nothing here writes business data.
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
const CLIENT_FIELDS = ['name', 'externalId', 'classification', 'status'];
const POLICY_FIELDS = ['clientId', 'carrierId', 'wholesalerId', 'policyNumber', 'alternateNumbers', 'line', 'policyType', 'namedInsured', 'effectiveDate', 'expirationDate', 'status', 'premiumCents', 'commissionRateBps'];
const LEDGER_FIELDS = ['amountCents', 'statementPeriod', 'postingStatus', 'payerId', 'carrierId', 'clientId', 'policyId', 'sourceType', 'level', 'classification', 'transactionDate', 'reversalOf', 'statementId', 'postingId'];
const STATEMENT_FIELDS = ['status', 'statementMonth', 'statementDate', 'payerId', 'statementTotalCents', 'postedCents', 'reconciliation.reconciled', 'reconciliation.checks', 'reconciliation.totals.commissionCents', 'reconciliation.totals.adjustmentsCents'];
const settingsDoc = async () => {
  const snap = await db.collection('settings').doc('app').get();
  return reviewerSettings(snap.exists ? snap.data() : null);
};
const ledger = async () => (await read('ledger', LEDGER_FIELDS)) as unknown as ReportEntry[];
const brokerIdentifiers = async () => (await db.collection('brokers').select('code').get()).docs.flatMap((d) => [d.id, String(d.get('code') ?? '')]);

async function buildView(view: string) {
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
  const { view } = parse(reviewerViewInput, req.data);
  const payload = { role: caller.role, organization: caller.role === 'admin' ? 'Owner preview' : EXTERNAL_ROLE_LABELS[caller.role], view, ...(await buildView(view)) };
  return deliver(caller, view, payload);
});

export const getReviewerExport = onCall({ memory: '512MiB', timeoutSeconds: 120 }, async (req) => {
  const caller = await requireReviewer(req);
  const { kind } = parse(reviewerExportInput, req.data);
  const at = new Date().toISOString();
  const date = at.slice(0, 10);
  let csv: string;
  if (kind === 'summary') {
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
  return deliver(caller, `${kind} export`, { downloadName: `Due-diligence-${kind}-${date}.csv`, csv });
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
