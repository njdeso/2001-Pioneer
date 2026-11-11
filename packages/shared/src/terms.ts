import { z } from 'zod';
import { isoDate } from './schemas.js';

/**
 * Policy-term history. One policy record per carrier + policy number (the existing uniqueness rule is
 * unchanged); each record can hold several consecutive coverage terms in policies/{id}/terms/{termId}:
 *
 *   Karen-style example:  2025-07-02 → 2026-07-03  renewed (or expired)
 *                         2026-07-03 → 2027-07-03  cancelled 2026-08-13
 *
 * Dates are calendar dates (YYYY-MM-DD). A term covers [effectiveDate, end) where end is the actual
 * cancellation date when cancelled, otherwise the scheduled expiration date (exclusive, the usual
 * insurance convention: a 7/2–7/3 term ends as the renewal term starts on 7/3).
 *
 * "Renewed" is a TERM status (the term ran to its scheduled expiration and the next term followed).
 * The policy's own status stays active / cancelled / expired / pending, so every existing filter,
 * export and eligibility rule keeps working.
 *
 * Term ID = the term's effective date, so a policy cannot have two terms starting the same day.
 */

export const TERM_STATUSES = ['active', 'renewed', 'expired', 'cancelled', 'pending'] as const;
export type TermStatus = (typeof TERM_STATUSES)[number];
export const TERM_STATUS_LABELS: Record<TermStatus, string> = {
  active: 'Active', renewed: 'Renewed (ran to expiration; next term followed)', expired: 'Expired (not renewed)', cancelled: 'Cancelled', pending: 'Pending',
};

export const policyTermInput = z.object({
  effectiveDate: isoDate,
  scheduledExpirationDate: isoDate,
  cancellationDate: isoDate.nullable().default(null),
  status: z.enum(TERM_STATUSES),
  note: z.string().trim().max(500).default(''),
}).superRefine((t, ctx) => {
  if (t.scheduledExpirationDate <= t.effectiveDate) ctx.addIssue({ code: 'custom', path: ['scheduledExpirationDate'], message: 'Scheduled expiration must be after the effective date' });
  if (t.status === 'cancelled' && !t.cancellationDate) ctx.addIssue({ code: 'custom', path: ['cancellationDate'], message: 'A cancelled term needs its cancellation date' });
  if (t.status !== 'cancelled' && t.cancellationDate) ctx.addIssue({ code: 'custom', path: ['cancellationDate'], message: 'Only a cancelled term has a cancellation date' });
  if (t.cancellationDate && (t.cancellationDate < t.effectiveDate || t.cancellationDate > t.scheduledExpirationDate)) {
    ctx.addIssue({ code: 'custom', path: ['cancellationDate'], message: 'Cancellation must be between the effective date and the scheduled expiration' });
  }
});
export type PolicyTermInput = z.infer<typeof policyTermInput>;

export interface PolicyTerm extends PolicyTermInput { id: string; policyId: string }

export const termIdFor = (effectiveDate: string) => effectiveDate;
/** Exclusive end of coverage: the cancellation date, else the scheduled expiration. */
export const termEnd = (t: Pick<PolicyTerm, 'scheduledExpirationDate' | 'cancellationDate'>) => t.cancellationDate ?? t.scheduledExpirationDate;

export interface TermProblem { code: 'overlap' | 'multiple_active' | 'active_not_latest' | 'renewed_without_next' | 'gap'; severity: 'error' | 'warning'; message: string; termIds: string[] }

/**
 * Check a policy's terms as a whole: terms may not overlap; at most one term is active and it must be
 * the latest; a "renewed" term should be followed by a term starting on its scheduled expiration.
 * Gaps (a lapse between terms) are allowed but reported.
 */
export function checkTerms(terms: Pick<PolicyTerm, 'id' | 'effectiveDate' | 'scheduledExpirationDate' | 'cancellationDate' | 'status'>[]): TermProblem[] {
  const t = [...terms].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  const out: TermProblem[] = [];
  for (let i = 1; i < t.length; i++) {
    const prev = t[i - 1], cur = t[i];
    if (cur.effectiveDate < termEnd(prev)) out.push({ code: 'overlap', severity: 'error', message: `Term ${cur.effectiveDate} starts before the term ${prev.effectiveDate} ends (${termEnd(prev)}).`, termIds: [prev.id, cur.id] });
    else if (cur.effectiveDate > termEnd(prev)) out.push({ code: 'gap', severity: 'warning', message: `No coverage between ${termEnd(prev)} and ${cur.effectiveDate}.`, termIds: [prev.id, cur.id] });
  }
  const active = t.filter((x) => x.status === 'active');
  if (active.length > 1) out.push({ code: 'multiple_active', severity: 'error', message: 'Only one term can be active.', termIds: active.map((x) => x.id) });
  if (active.length === 1 && active[0] !== t[t.length - 1]) out.push({ code: 'active_not_latest', severity: 'error', message: 'The active term must be the latest term.', termIds: [active[0].id] });
  t.forEach((x, i) => {
    if (x.status !== 'renewed') return;
    const next = t[i + 1];
    if (!next || next.effectiveDate !== x.scheduledExpirationDate) out.push({ code: 'renewed_without_next', severity: 'warning', message: `Term ${x.effectiveDate} is marked renewed, but no term starts on ${x.scheduledExpirationDate}.`, termIds: [x.id] });
  });
  return out;
}

export type TermResolution = 'exact' | 'within' | 'not_determined' | 'no_terms' | 'no_date';

/**
 * Which term a statement line belongs to, from the line's effective date (policy or transaction
 * effective date printed on the statement):
 *   exact          — a term starts on that date (new business / renewal lines)
 *   within         — the date falls inside exactly one term's coverage (endorsements, cancellations)
 *   not_determined — no term covers it (e.g. after the cancellation date) or it is ambiguous
 * The match to the POLICY is never affected; this only adds the term when the dates support it.
 */
export function resolveTerm<T extends Pick<PolicyTerm, 'id' | 'effectiveDate' | 'scheduledExpirationDate' | 'cancellationDate'>>(lineDate: string | null | undefined, terms: T[]): { term: T | null; resolution: TermResolution } {
  if (!terms.length) return { term: null, resolution: 'no_terms' };
  if (!lineDate || !/^\d{4}-\d{2}-\d{2}$/.test(lineDate)) return { term: null, resolution: 'no_date' };
  const exact = terms.filter((t) => t.effectiveDate === lineDate);
  if (exact.length === 1) return { term: exact[0], resolution: 'exact' };
  // A cancellation line is often dated the cancellation day itself, which is the term's exclusive end.
  const within = terms.filter((t) => t.effectiveDate <= lineDate && (lineDate < termEnd(t) || lineDate === t.cancellationDate));
  if (within.length === 1) return { term: within[0], resolution: 'within' };
  return { term: null, resolution: 'not_determined' };
}

export const TERM_RESOLUTION_TEXT: Record<TermResolution, string> = {
  exact: 'Term starts on the line’s effective date',
  within: 'Line’s date falls within this term',
  not_determined: 'No single term covers the line’s date — term not determined',
  no_terms: 'No term history recorded for this policy',
  no_date: 'No effective date on the line — term not determined',
};
