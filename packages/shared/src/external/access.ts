import { z } from 'zod';
import { isIsoDate, type IsoDate } from '../period.js';

/**
 * External due-diligence access (read-only).
 *
 * Two organizations, each with its own accounts and designation:
 *   buyer      Pioneer Bank — Buyer
 *   diligence  Independent Due Diligence Company — Reviewer
 *
 * An external user is authorized only when ALL of these hold, checked on the server on every request:
 *   - the Firebase ID token carries custom claim role = 'buyer' | 'diligence' (set only by the owner's
 *     inviteExternalUser callable through the Admin SDK; users cannot set their own claims);
 *   - an owner-managed access record externalAccess/{uid} exists with the SAME role, status 'active',
 *     and an expiry date that has not passed.
 * Revoking flips the record to 'revoked' (and clears the claim, disables the account and revokes refresh
 * tokens), so access ends at the next request even while an old ID token is still unexpired.
 *
 * External users have NO Firestore or Storage access (security rules deny every role but admin/staff);
 * they receive only allowlisted representations from the reviewer callables (see reviewerViews.ts).
 */

export const EXTERNAL_ROLES = ['buyer', 'diligence'] as const;
export type ExternalRole = (typeof EXTERNAL_ROLES)[number];

export const EXTERNAL_ROLE_LABELS: Record<ExternalRole, string> = {
  buyer: 'Pioneer Bank — Buyer',
  diligence: 'Independent Due Diligence Company — Reviewer',
};

export function isExternalRole(r: unknown): r is ExternalRole {
  return typeof r === 'string' && (EXTERNAL_ROLES as readonly string[]).includes(r);
}

/** Owner input: invite (or re-activate) an external user. */
export const externalInviteInput = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address').max(200),
  role: z.enum(EXTERNAL_ROLES),
  /** Last day of access (inclusive), YYYY-MM-DD. Required: access is never open-ended. */
  expiresOn: z.string().refine(isIsoDate, 'Use a valid date (YYYY-MM-DD)'),
}).strict();
export type ExternalInviteInput = z.infer<typeof externalInviteInput>;

export const externalRevokeInput = z.object({
  uid: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  reason: z.string().trim().min(3, 'Give a short reason').max(300),
}).strict();

/** The owner-managed access record, externalAccess/{uid}. */
export interface ExternalAccessRecord {
  email: string;
  role: ExternalRole;
  organization: string;
  status: 'active' | 'revoked';
  expiresOn: IsoDate;
  invitedAtIso?: string;
  revokedAtIso?: string | null;
}

export type AccessDecision = { ok: true } | { ok: false; reason: 'no_record' | 'revoked' | 'role_mismatch' | 'expired' | 'not_external' };

/**
 * Pure authorization decision for an external caller. `today` is the server's date (YYYY-MM-DD, UTC);
 * access is valid through the end of expiresOn.
 */
export function externalAccessDecision(claimRole: unknown, record: Partial<ExternalAccessRecord> | null | undefined, today: IsoDate): AccessDecision {
  if (!isExternalRole(claimRole)) return { ok: false, reason: 'not_external' };
  if (!record) return { ok: false, reason: 'no_record' };
  if (record.status !== 'active') return { ok: false, reason: 'revoked' };
  if (record.role !== claimRole) return { ok: false, reason: 'role_mismatch' };
  if (!record.expiresOn || !isIsoDate(record.expiresOn) || record.expiresOn < today) return { ok: false, reason: 'expired' };
  return { ok: true };
}

/** Reviewer views and exports (input of the reviewer callables). Anything else is rejected. */
export const REVIEWER_VIEWS = ['overview', 'statements', 'book', 'carriers', 'transactions'] as const;
export type ReviewerView = (typeof REVIEWER_VIEWS)[number];
export const reviewerViewInput = z.object({ view: z.enum(REVIEWER_VIEWS) }).strict();
export const REVIEWER_EXPORTS = ['summary', 'book', 'transactions', 'statements'] as const;
export type ReviewerExport = (typeof REVIEWER_EXPORTS)[number];
export const reviewerExportInput = z.object({ kind: z.enum(REVIEWER_EXPORTS) }).strict();
