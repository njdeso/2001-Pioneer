import { normalizeName, normalizePolicyNumber } from '../normalize.js';

/**
 * Duplicate statement detection.
 *
 * A carrier can send more than one statement for the same month — typically one for Personal Lines and one
 * for Commercial Lines — so "same carrier and month" is NOT a duplicate by itself. Each statement is
 * compared with every other live statement from the same payer and month, by CONTENT:
 *
 *   identical       every extracted line is the same (policy, insured, amounts, transaction, effective date):
 *                   the same statement uploaded again (another file name, a re-saved copy, a different
 *                   format). Can never be confirmed separate; only one of them may be posted.
 *   same_statement  ≥ 80 % of the smaller statement's lines are also on the other one (a re-issued or
 *                   partly re-extracted copy). Treated like identical.
 *   overlapping     some lines in common: may be separate, but an owner must confirm it, with a reason.
 *   separate        no lines in common (e.g. Personal vs Commercial Lines): an owner confirms once.
 *
 * The classification (Personal / Commercial / Other) is recorded and shown, but it never decides the
 * outcome: two files classified differently with identical lines are still the same statement.
 *
 * A confirmation is stored on BOTH statements with a digest of each one's content at the time; if either
 * statement's lines change (re-extraction), the confirmation no longer applies and must be given again.
 * Approval and posting re-run this check on the server every time.
 */

export const STATEMENT_CLASSIFICATIONS = ['personal', 'commercial', 'other'] as const;
export type StatementClassification = (typeof STATEMENT_CLASSIFICATIONS)[number];
export const STATEMENT_CLASSIFICATION_LABELS: Record<StatementClassification, string> = { personal: 'Personal Lines', commercial: 'Commercial Lines', other: 'Other' };
export const SAME_STATEMENT_OVERLAP = 0.8;

/** Statuses whose lines can still be (or have been) posted. Discarded and failed statements never post. */
export const LIVE_STATUSES = ['needs_review', 'discrepancy', 'approved', 'posted'] as const;

export interface DupLine {
  policyNumberRaw?: string; policyNumberNormalized?: string; insuredName?: string;
  paidCommissionCents?: number | null; paymentReceivedCents?: number | null;
  transactionType?: string; effectiveDate?: string | null; kind?: string;
}
export interface DupStatement {
  id: string; status: string; fileName?: string; payerId: string | null; statementMonth: string | null;
  classification?: StatementClassification | null;
  agencyCode?: string | null; officeCode?: string | null; statementDate?: string | null; title?: string;
  statedTotalCents?: number | null; postedCents?: number;
  /** SHA-256 of contentCanonical(lines), computed by the server. */
  digest: string;
  lines: DupLine[];
}
export interface SeparateConfirmation { by: string; email: string; at: string; reason: string; digest: string; otherDigest: string }

/** One line's identity: everything that makes it the same carrier entry, nothing that extraction can vary. */
export function lineKey(l: DupLine): string {
  const pol = l.policyNumberNormalized || normalizePolicyNumber(l.policyNumberRaw ?? '');
  return [pol, normalizeName(l.insuredName ?? ''), l.paidCommissionCents ?? '', l.paymentReceivedCents ?? '', l.transactionType ?? '', l.effectiveDate ?? '', l.kind ?? ''].join('|');
}

/** Canonical text of a statement's lines (order-independent). The server hashes it into `digest`. */
export function contentCanonical(lines: DupLine[]): string {
  return lines.map(lineKey).sort().join('\n');
}

function sharedCount(a: string[], b: string[]): number {
  const counts = new Map<string, number>();
  for (const k of a) counts.set(k, (counts.get(k) ?? 0) + 1);
  let n = 0;
  for (const k of b) { const c = counts.get(k) ?? 0; if (c > 0) { n++; counts.set(k, c - 1); } }
  return n;
}

export type DuplicateRelation = 'identical' | 'same_statement' | 'overlapping' | 'separate';

export interface DuplicateFinding {
  otherId: string;
  other: { fileName: string; status: string; classification: StatementClassification | null; agencyCode: string | null; officeCode: string | null; statementDate: string | null; title: string; statedTotalCents: number | null; postedCents: number; lineCount: number };
  relation: DuplicateRelation;
  /** identical / same_statement: may never be confirmed separate or posted alongside. */
  hard: boolean;
  sharedLines: number; thisLines: number; otherLines: number;
  evidence: string[];
  confirmation: SeparateConfirmation | null;
  /** A confirmation exists AND still matches both statements' current content. */
  confirmed: boolean;
}

export function compareStatements(a: DupStatement, b: DupStatement): Pick<DuplicateFinding, 'relation' | 'hard' | 'sharedLines' | 'thisLines' | 'otherLines' | 'evidence'> {
  const ka = a.lines.map(lineKey), kb = b.lines.map(lineKey);
  const shared = sharedCount(ka, kb);
  const smaller = Math.min(ka.length, kb.length);
  const identical = ka.length > 0 && ka.length === kb.length && shared === ka.length;
  const relation: DuplicateRelation = identical ? 'identical' : smaller > 0 && shared / smaller >= SAME_STATEMENT_OVERLAP ? 'same_statement' : shared > 0 ? 'overlapping' : 'separate';
  const evidence: string[] = [];
  evidence.push(`${shared} of ${ka.length} line(s) on this statement also appear on the other (${kb.length} lines).`);
  const sameHeader = !!a.statementDate && a.statementDate === b.statementDate && (a.agencyCode ?? null) === (b.agencyCode ?? null) && (a.officeCode ?? null) === (b.officeCode ?? null);
  if (sameHeader) evidence.push('Same agency code, office code and statement date.');
  if (a.statedTotalCents != null && a.statedTotalCents === b.statedTotalCents) evidence.push('Same printed commission total.');
  else if (a.statedTotalCents != null && b.statedTotalCents != null) evidence.push('Different printed commission totals.');
  if (a.title && b.title && a.title !== b.title) evidence.push(`Different statement titles ("${a.title}" / "${b.title}").`);
  if (a.classification && b.classification && a.classification !== b.classification) evidence.push('Classified differently — this alone does not prove they are separate statements.');
  if ((b.postedCents ?? 0) !== 0 || b.status === 'posted') evidence.push('The other statement is already posted to the ledger.');
  return { relation, hard: relation === 'identical' || relation === 'same_statement', sharedLines: shared, thisLines: ka.length, otherLines: kb.length, evidence };
}

/** Findings for `current` against every other live statement of the same payer and month. */
export function assessDuplicates(current: DupStatement, others: DupStatement[], confirmations: Record<string, SeparateConfirmation> = {}): DuplicateFinding[] {
  if (!current.payerId || !current.statementMonth) return [];
  return others
    .filter((o) => o.id !== current.id && o.payerId === current.payerId && o.statementMonth === current.statementMonth && (LIVE_STATUSES as readonly string[]).includes(o.status))
    .map((o) => {
      const c = compareStatements(current, o);
      const conf = confirmations[o.id] ?? null;
      const confirmed = !c.hard && !!conf && conf.digest === current.digest && conf.otherDigest === o.digest;
      return {
        otherId: o.id,
        other: { fileName: o.fileName ?? '', status: o.status, classification: o.classification ?? null, agencyCode: o.agencyCode ?? null, officeCode: o.officeCode ?? null, statementDate: o.statementDate ?? null, title: o.title ?? '', statedTotalCents: o.statedTotalCents ?? null, postedCents: o.postedCents ?? 0, lineCount: o.lines.length },
        ...c, confirmation: conf, confirmed,
      };
    })
    .sort((x, y) => Number(y.hard) - Number(x.hard) || y.sharedLines - x.sharedLines || x.otherId.localeCompare(y.otherId));
}

export const RELATION_TEXT: Record<DuplicateRelation, string> = {
  identical: 'Identical content — this is the same statement uploaded again.',
  same_statement: 'Almost all lines are the same — treated as the same statement.',
  overlapping: 'Some lines appear on both statements — confirm they are separate before posting.',
  separate: 'No lines in common (e.g. Personal vs Commercial Lines) — confirm they are separate before posting.',
};

/** Why a confirmation request is refused (null = may be confirmed). */
export function confirmationRefusal(f: DuplicateFinding | undefined, reason: string, thisClassification: StatementClassification | null | undefined): string | null {
  if (!f) return 'That statement is not a same-month statement from this carrier, or it has been discarded.';
  if (f.hard) return `${RELATION_TEXT[f.relation]} It cannot be confirmed as separate; discard one of the two.`;
  if (!thisClassification) return 'Classify this statement (Personal Lines, Commercial Lines or Other) first.';
  if (!f.other.classification) return 'Classify the other statement first.';
  if (reason.trim().length < 10) return 'Give a reason of at least 10 characters (e.g. "Commercial Lines statement for the same month").';
  return null;
}
