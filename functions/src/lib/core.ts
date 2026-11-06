import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue, type Transaction, type DocumentReference } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { fieldErrors, type Role } from '@asm/shared';

if (!getApps().length) initializeApp();

export const db = getFirestore();
export const auth = getAuth();
export { FieldValue };

export interface Actor {
  uid: string;
  email: string;
  role: Role;
}

/** Server-side authorization. Every privileged callable starts here. */
export function requireRole(req: CallableRequest<unknown>, allowed: Role[] = ['admin']): Actor {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const role = req.auth.token.role as Role | undefined;
  if (!role || !allowed.includes(role)) {
    throw new HttpsError('permission-denied', 'You do not have permission for this action.');
  }
  return { uid: req.auth.uid, email: String(req.auth.token.email ?? ''), role };
}

/** Validate callable input; return structured field errors the form can show. */
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  try {
    return schema.parse(data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'Please correct the highlighted fields.', {
        fieldErrors: fieldErrors(err),
      });
    }
    throw err;
  }
}

const META_KEYS = new Set(['createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'searchTokens']);

/** Field-level before/after for the audit trail (stored in Firestore, never in application logs). */
export function diff(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown>,
): Record<string, { before: unknown; after: unknown }> {
  const out: Record<string, { before: unknown; after: unknown }> = {};
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after)]);
  for (const k of keys) {
    if (META_KEYS.has(k)) continue;
    const b = before?.[k] ?? null;
    const a = after[k] ?? null;
    if (JSON.stringify(b) !== JSON.stringify(a)) out[k] = { before: b, after: a };
  }
  return out;
}

export interface AuditInput {
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  changes?: Record<string, { before: unknown; after: unknown }>;
}

/** Anything that can stage a document write: a Transaction or a WriteBatch. */
export interface Writer {
  set(ref: DocumentReference, data: Record<string, unknown>): unknown;
}

/** Append an audit event inside the caller's transaction/batch so the change and its record commit together. */
export function audit(tx: Writer, actor: Actor, a: AuditInput): void {
  tx.set(db.collection('auditLog').doc(), {
    at: FieldValue.serverTimestamp(),
    actor: actor.uid,
    actorEmail: actor.email,
    action: a.action,
    entityType: a.entityType,
    entityId: a.entityId,
    summary: a.summary,
    changes: a.changes ?? {},
  });
  // Application log carries ids only — no names, numbers or amounts.
  logger.info('audit', { action: a.action, entityType: a.entityType, entityId: a.entityId });
}

export function meta(actor: Actor, isNew: boolean): Record<string, unknown> {
  return isNew
    ? {
        createdAt: FieldValue.serverTimestamp(),
        createdBy: actor.uid,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: actor.uid,
      }
    : { updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid };
}

export async function mustExist(
  tx: Transaction,
  ref: DocumentReference,
  label: string,
): Promise<Record<string, unknown>> {
  const snap = await tx.get(ref);
  if (!snap.exists) throw new HttpsError('failed-precondition', `${label} not found.`);
  return snap.data() as Record<string, unknown>;
}

export function idParam(v: unknown, label = 'id'): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(v)) {
    throw new HttpsError('invalid-argument', `Invalid ${label}.`);
  }
  return v;
}
