import type { DuplicateFinding } from './duplicates.js';
import type { BasisPoints, Cents } from '../money.js';
import type { LedgerClassification } from '../types.js';
import { UNASSIGNED_BROKER_ID } from '../schemas.js';
import type { StatementAdjustment, TransactionType } from './types.js';
import { brokerForPolicy, commissionSplit, type BrokerShareSource, type HistoricalAttribution, type LineMatch, type MatchBroker, type MatchPolicy } from './match.js';

/**
 * Stage 3C — statement approval and commission posting. Pure functions shared by the server, which
 * enforces them, and the browser, which previews them.
 *
 * Posting rules (fixed; documented in docs/STAGE-3C-POSTING.md):
 *  - Revenue = paid commission on each line + statement-level adjustments, in the statement's month
 *    (revenue basis: statement period). This equals the statement's month payable, which is why only
 *    reconciled statements can be posted.
 *  - Matched line → policy-level entry, split by the broker share captured in its match.
 *  - Line deliberately marked unmatched by a person → suspense entry (no policy, 100 % agency).
 *  - Statement adjustment → carrier-level entry (no policy, 100 % agency).
 *  - Lines without paid commission (payment-only) are not posted.
 *  - Every entry has a deterministic ID, so the same line can never be posted twice in one posting.
 *    Reversal creates an exact negative twin; the statement can then be corrected and posted again
 *    under the next posting number.
 */

export const POSTING_ENGINE_VERSION = 'posting-v1';
/** Upper bound on entries per statement (one atomic Firestore transaction). */
export const MAX_POSTING_ENTRIES = 1000;

export const TRANSACTION_CLASSIFICATION: Record<TransactionType, LedgerClassification> = {
  new_business: 'new_business',
  continuation: 'renewal',
  endorsement: 'endorsement',
  cancellation: 'cancellation',
  reinstatement: 'reinstatement',
  reversal: 'chargeback',
  installment_payment: 'other_adjustment',
  other: 'other_adjustment',
};

export interface PostingLine {
  id: string;
  lineNo: number;
  insuredName: string;
  policyNumberRaw: string;
  paidCommissionCents: Cents | null;
  transactionType: TransactionType;
  effectiveDate: string | null;
  match?: LineMatch | { status: 'not_started' } | null;
}

export interface PostingStatement {
  id: string;
  status: string;
  payerId: string | null;
  payerKind?: 'carrier' | 'wholesaler' | null;
  statementMonth: string | null;
  statementDate: string | null;
  adjustments: StatementAdjustment[];
  postedCents?: Cents;
  postingSeq?: number;
  possibleDuplicateOf?: string | null;
  matching?: { stale?: boolean; balanced?: boolean } | null;
}

export type ReadinessCode =
  | 'not_reconciled' | 'wrong_status' | 'no_payer' | 'no_month' | 'already_posted' | 'matching_not_run'
  | 'matching_stale' | 'matching_unbalanced' | 'lines_not_matched_yet' | 'lines_ambiguous'
  | 'lines_unmatched_unreviewed' | 'possible_duplicate' | 'duplicate_statement' | 'too_many_entries' | 'nothing_to_post';

export interface Readiness {
  ready: boolean;
  blockers: { code: ReadinessCode; message: string; lineNos?: number[] }[];
  warnings: { code: string; message: string; lineNos?: number[] }[];
}

const asMatch = (m: PostingLine['match']): LineMatch | null => (m && m.status !== 'not_started' ? (m as LineMatch) : null);
const hasCommission = (l: PostingLine) => typeof l.paidCommissionCents === 'number' && l.paidCommissionCents !== 0;

export interface DuplicateGateOpts {
  /** Same-payer, same-month findings from assessDuplicates (computed on the server for approval and posting). */
  duplicates?: DuplicateFinding[];
  /** An approval given before pairwise confirmation existed, with the old "not a duplicate" acknowledgement.
   *  Satisfies unconfirmed separate/overlapping findings only — never an identical / same-statement one. */
  legacyDuplicateAcknowledged?: boolean;
}

/**
 * Can this statement be approved and posted? Same-month statements from the payer are judged by
 * statements/duplicates.ts: identical / same-statement content always blocks; anything else needs an
 * owner's recorded "separate statement" confirmation.
 */
export function postingReadiness(stmt: PostingStatement, lines: PostingLine[], opts: DuplicateGateOpts = {}): Readiness {
  const blockers: Readiness['blockers'] = [];
  const warnings: Readiness['warnings'] = [];
  const nos = (pred: (l: PostingLine) => boolean) => lines.filter(pred).map((l) => l.lineNo);

  if ((stmt.postedCents ?? 0) !== 0 || stmt.status === 'posted') blockers.push({ code: 'already_posted', message: 'This statement is already posted. Reverse it first to post it again.' });
  else if (stmt.status === 'discrepancy') blockers.push({ code: 'not_reconciled', message: 'The statement does not reconcile to its printed totals. Only reconciled statements can be posted.' });
  else if (!['needs_review', 'approved'].includes(stmt.status)) blockers.push({ code: 'wrong_status', message: `A statement that is "${stmt.status}" cannot be posted.` });
  if (!stmt.payerId) blockers.push({ code: 'no_payer', message: 'Choose the statement’s carrier.' });
  if (!stmt.statementMonth || !/^\d{4}-(0[1-9]|1[0-2])$/.test(stmt.statementMonth)) blockers.push({ code: 'no_month', message: 'The statement month is missing.' });

  const commissionLines = lines.filter(hasCommission);
  if (!stmt.matching) blockers.push({ code: 'matching_not_run', message: 'Run commission matching first.' });
  else {
    if (stmt.matching.stale) blockers.push({ code: 'matching_stale', message: 'The carrier changed after matching. Re-run matching.' });
    if (stmt.matching.balanced === false) blockers.push({ code: 'matching_unbalanced', message: 'Matching totals do not balance.' });
  }
  const notRun = nos((l) => hasCommission(l) && !asMatch(l.match));
  const ambiguous = nos((l) => hasCommission(l) && asMatch(l.match)?.status === 'ambiguous');
  const unreviewed = nos((l) => hasCommission(l) && asMatch(l.match)?.status === 'unmatched' && asMatch(l.match)?.method !== 'manual');
  if (notRun.length) blockers.push({ code: 'lines_not_matched_yet', message: `${notRun.length} commission line(s) have not been matched.`, lineNos: notRun });
  if (ambiguous.length) blockers.push({ code: 'lines_ambiguous', message: `${ambiguous.length} ambiguous line(s): match each one or mark it unmatched.`, lineNos: ambiguous });
  if (unreviewed.length) blockers.push({ code: 'lines_unmatched_unreviewed', message: `${unreviewed.length} unmatched line(s) not yet reviewed: match each one, or mark it unmatched to post it to suspense.`, lineNos: unreviewed });

  const dups = opts.duplicates ?? [];
  for (const d of dups.filter((x) => x.hard)) {
    blockers.push({ code: 'duplicate_statement', message: `Same statement as "${d.other.fileName || d.otherId}" (${d.other.status}): ${d.sharedLines} of ${d.thisLines} lines are identical. It cannot be posted twice — discard one of them.` });
  }
  const unconfirmed = dups.filter((x) => !x.hard && !x.confirmed);
  if (unconfirmed.length && !opts.legacyDuplicateAcknowledged) {
    blockers.push({ code: 'possible_duplicate', message: `${unconfirmed.length === 1 ? 'Another statement' : `${unconfirmed.length} other statements`} from this carrier for ${stmt.statementMonth ?? 'this month'} ${unconfirmed.length === 1 ? 'is' : 'are'} loaded (${unconfirmed.map((u) => `"${u.other.fileName || u.otherId}"`).join(', ')}). An owner must confirm ${unconfirmed.length === 1 ? 'it is a separate statement' : 'each is a separate statement'} ("Confirm separate statement" in the duplicate check above).` });
  }
  const entryCount = commissionLines.length + (stmt.adjustments ?? []).filter((a) => a.amountCents !== 0).length;
  if (entryCount === 0) blockers.push({ code: 'nothing_to_post', message: 'There is no commission to post on this statement.' });
  if (entryCount > MAX_POSTING_ENTRIES) blockers.push({ code: 'too_many_entries', message: `This statement has ${entryCount} entries; the limit for one posting is ${MAX_POSTING_ENTRIES}.` });

  const suspense = nos((l) => hasCommission(l) && asMatch(l.match)?.status === 'unmatched' && asMatch(l.match)?.method === 'manual');
  if (suspense.length) warnings.push({ code: 'suspense', message: `${suspense.length} line(s) will be posted to suspense (no policy, 100 % agency).`, lineNos: suspense });
  const historical = nos((l) => hasCommission(l) && !!asMatch(l.match)?.historical);
  if (historical.length) warnings.push({ code: 'historical', message: `${historical.length} of those are identified as past policies not in the book (attribution recorded; no buyout eligibility).`, lineNos: historical });
  const inactive = nos((l) => !!asMatch(l.match)?.reasons.includes('policy_not_active'));
  if (inactive.length) warnings.push({ code: 'policy_not_active', message: `${inactive.length} line(s) are matched to a policy that is not active.`, lineNos: inactive });
  const otherCarrier = nos((l) => !!asMatch(l.match)?.reasons.includes('carrier_differs'));
  if (otherCarrier.length) warnings.push({ code: 'carrier_differs', message: `${otherCarrier.length} line(s) are matched to a policy of another carrier.`, lineNos: otherCarrier });

  return { ready: blockers.length === 0, blockers, warnings };
}

export interface PlannedEntry {
  id: string;
  /** Suspense entries only: a person's record of the past policy behind the line (information only). */
  historical?: HistoricalAttribution;
  /** Policy-level entries: the coverage term (policies/{policyId}/terms/{termId}) when it was determined. */
  termId?: string;
  level: 'policy' | 'carrier' | 'suspense';
  payerId: string;
  carrierId: string | null;
  clientId: string | null;
  policyId: string | null;
  classification: LedgerClassification;
  amountCents: Cents;
  statementPeriod: string;
  transactionDate: string | null;
  paymentDate: string | null;
  sourceType: 'statement' | 'retained' | 'manual';
  statementId: string | null;
  lineId: string | null;
  lineNo: number | null;
  note: string;
  postingStatus: 'posted';
  reversalOf: null;
  postingId: string;
  brokerId: string;
  brokerShareBps: BasisPoints;
  brokerShareSource: BrokerShareSource | 'none';
  brokerCents: Cents;
  agencyCents: Cents;
  matchMethod: 'auto' | 'manual' | null;
  insuredName: string;
  policyNumberRaw: string;
  engineVersion: string;
}

export interface PostingPlan {
  postingId: string;
  seq: number;
  entries: PlannedEntry[];
  totals: {
    entries: number;
    amountCents: Cents;
    commissionCents: Cents;
    adjustmentsCents: Cents;
    policyCents: Cents;
    suspenseCents: Cents;
    brokerCents: Cents;
    agencyCents: Cents;
  };
  /** Every entry's broker + agency = amount, and the plan total = commission + adjustments. */
  balanced: boolean;
}

/** Ledger document ID for a posted line (deterministic; one ID per statement, posting and line). */
export const ledgerEntryId = (statementId: string, seq: number, part: string) => `${statementId}__p${seq}__${part}`;

/** Build the exact ledger entries a statement would post. Throws if the statement is not ready. */
export function buildPostingPlan(stmt: PostingStatement, lines: PostingLine[], opts: DuplicateGateOpts & { note?: string } = {}): PostingPlan {
  const r = postingReadiness(stmt, lines, opts);
  if (!r.ready) throw new Error(`Not ready to post: ${r.blockers.map((b) => b.message).join(' ')}`);
  const seq = (stmt.postingSeq ?? 0) + 1;
  const postingId = `${stmt.id}__p${seq}`;
  const period = stmt.statementMonth!;
  const payerId = stmt.payerId!;
  const entries: PlannedEntry[] = [];
  const common = { payerId, statementPeriod: period, paymentDate: null, sourceType: 'statement' as const, statementId: stmt.id, postingStatus: 'posted' as const, reversalOf: null, postingId, engineVersion: POSTING_ENGINE_VERSION };

  for (const l of [...lines].sort((a, b) => a.lineNo - b.lineNo)) {
    if (!hasCommission(l)) continue;
    const m = asMatch(l.match)!;
    const amount = l.paidCommissionCents!;
    const base = {
      ...common, id: ledgerEntryId(stmt.id, seq, l.id), classification: TRANSACTION_CLASSIFICATION[l.transactionType] ?? 'other_adjustment',
      amountCents: amount, transactionDate: l.effectiveDate, lineId: l.id, lineNo: l.lineNo, insuredName: l.insuredName, policyNumberRaw: l.policyNumberRaw,
      matchMethod: m.method, note: opts.note ?? '',
    };
    if (m.status === 'matched' && m.policyId) {
      // The split reviewed during matching, recomputed from its captured share so it always matches the amount.
      const { brokerCents, agencyCents } = commissionSplit(amount, m.brokerShareBps ?? 0);
      entries.push({ ...base, level: 'policy', carrierId: m.carrierId, clientId: m.clientId, policyId: m.policyId, brokerId: m.brokerId ?? UNASSIGNED_BROKER_ID, brokerShareBps: m.brokerShareBps ?? 0, brokerShareSource: m.brokerShareSource ?? 'broker', brokerCents, agencyCents, ...(m.term ? { termId: m.term.termId } : {}) });
    } else {
      // Historical lines keep the person's attribution on the entry for reference only; amounts, level,
      // carrier, client and broker allocation are exactly those of any other suspense entry.
      entries.push({ ...base, level: 'suspense', carrierId: null, clientId: null, policyId: null, brokerId: UNASSIGNED_BROKER_ID, brokerShareBps: 0, brokerShareSource: 'none', brokerCents: 0, agencyCents: amount, ...(m.historical ? { historical: { ...m.historical, buyoutEligible: false as const } } : {}) });
    }
  }
  (stmt.adjustments ?? []).forEach((a, i) => {
    if (a.amountCents === 0) return;
    entries.push({
      ...common, id: ledgerEntryId(stmt.id, seq, `adj${i + 1}`), level: 'carrier', carrierId: stmt.payerKind === 'carrier' ? payerId : null, clientId: null, policyId: null,
      classification: a.amountCents > 0 ? 'bonus' : 'other_adjustment', amountCents: a.amountCents, transactionDate: stmt.statementDate, lineId: null, lineNo: null,
      note: a.label, brokerId: UNASSIGNED_BROKER_ID, brokerShareBps: 0, brokerShareSource: 'none', brokerCents: 0, agencyCents: a.amountCents, matchMethod: null,
      insuredName: '', policyNumberRaw: '',
    });
  });

  const sum = (f: (e: PlannedEntry) => number) => entries.reduce((s, e) => s + f(e), 0);
  const commissionCents = lines.filter(hasCommission).reduce((s, l) => s + l.paidCommissionCents!, 0);
  const adjustmentsCents = (stmt.adjustments ?? []).reduce((s, a) => s + a.amountCents, 0);
  const totals = {
    entries: entries.length,
    amountCents: sum((e) => e.amountCents),
    commissionCents,
    adjustmentsCents,
    policyCents: sum((e) => (e.level === 'policy' ? e.amountCents : 0)),
    suspenseCents: sum((e) => (e.level === 'suspense' ? e.amountCents : 0)),
    brokerCents: sum((e) => e.brokerCents),
    agencyCents: sum((e) => e.agencyCents),
  };
  const balanced = entries.every((e) => e.brokerCents + e.agencyCents === e.amountCents && Number.isInteger(e.amountCents))
    && totals.amountCents === commissionCents + adjustmentsCents
    && totals.brokerCents + totals.agencyCents === totals.amountCents
    && new Set(entries.map((e) => e.id)).size === entries.length;
  return { postingId, seq, entries, totals, balanced };
}

/** Stable fingerprint of a plan, stored at approval. Posting refuses if anything changed since. */
export function planFingerprint(plan: PostingPlan): string {
  // Historical attribution is appended only when present, so fingerprints of other plans are unchanged.
  const parts = plan.entries.map((e) => [e.id, e.level, e.policyId ?? '', e.amountCents, e.brokerId, e.brokerShareBps, e.brokerCents, e.agencyCents, e.classification, e.statementPeriod].join('|')
    + (e.termId ? `|T:${e.termId}` : '')
    + (e.historical ? `|H:${e.historical.clientId ?? ''}:${e.historical.attributedBrokerId ?? ''}:${e.historical.policyNumber}:${e.historical.policyStatus}` : ''));
  let h = 0x811c9dc5; // FNV-1a 32-bit over the canonical text (integrity check, not security)
  const text = `${plan.postingId}#${parts.join('\n')}`;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${plan.entries.length}-${plan.totals.amountCents}-${plan.totals.brokerCents}-${h.toString(16).padStart(8, '0')}`;
}

export interface ReversalEntry extends Omit<PlannedEntry, 'reversalOf' | 'postingStatus'> { reversalOf: string; postingStatus: 'posted' }

/** Exact negative twin of a posted entry. Deterministic ID, so an entry can be reversed only once. */
export function reversalOf(e: Pick<PlannedEntry, 'id' | 'amountCents' | 'brokerCents' | 'agencyCents'> & Record<string, unknown>, reason: string): ReversalEntry {
  return {
    ...(e as unknown as PlannedEntry),
    id: `${e.id}__rev`,
    amountCents: -e.amountCents,
    brokerCents: -e.brokerCents,
    agencyCents: -e.agencyCents,
    reversalOf: e.id,
    postingStatus: 'posted',
    note: `Reversal: ${reason}`,
  };
}

/** A retained commission (commission the agency kept out of premium, e.g. per a bind document). */
export function retainedEntry(input: {
  requestId: string; policy: MatchPolicy; payerId: string; brokers: Map<string, MatchBroker>;
  amountCents: Cents; statementPeriod: string; transactionDate: string | null; classification: LedgerClassification; note: string;
}): PlannedEntry {
  const { brokerId, shareBps, source } = brokerForPolicy(input.policy, input.brokers);
  const { brokerCents, agencyCents } = commissionSplit(input.amountCents, shareBps);
  return {
    id: `retained__${input.requestId}`, level: 'policy', payerId: input.payerId, carrierId: input.policy.carrierId, clientId: input.policy.clientId, policyId: input.policy.id,
    classification: input.classification, amountCents: input.amountCents, statementPeriod: input.statementPeriod, transactionDate: input.transactionDate, paymentDate: null,
    sourceType: 'retained', statementId: null, lineId: null, lineNo: null, note: input.note, postingStatus: 'posted', reversalOf: null,
    postingId: `retained__${input.requestId}`, brokerId, brokerShareBps: shareBps, brokerShareSource: source, brokerCents, agencyCents, matchMethod: null,
    insuredName: '', policyNumberRaw: input.policy.policyNumber, engineVersion: POSTING_ENGINE_VERSION,
  };
}

/**
 * Broker share across posted ledger entries, from each entry's stored allocation. Entries without a
 * stored allocation (none exist before Stage 3C) fall back to `fallback(entry)`.
 */
export function storedBrokerShare(entries: Iterable<{ amountCents: Cents; brokerCents?: Cents | null }>, fallback: (e: { amountCents: Cents }) => Cents = () => 0): Cents {
  let total = 0;
  for (const e of entries) total += typeof e.brokerCents === 'number' ? e.brokerCents : fallback(e);
  return total;
}
