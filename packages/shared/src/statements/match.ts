import type { BasisPoints, Cents } from '../money.js';
import { normalizePolicyNumber, nameVariants } from '../normalize.js';
import { brokerSplit } from '../aggregate.js';
import { UNASSIGNED_BROKER_ID } from '../schemas.js';
import type { ExtractedLine, StatementAdjustment } from './types.js';
import { personEvidence } from './personName.js';
import { resolveTerm, termEnd, type PolicyTerm, type TermResolution } from '../terms.js';

/**
 * Stage 3B — commission matching. Pure functions, shared by the server (which stores results)
 * and the browser (which previews a manual match), so both always compute the same answer.
 *
 * Rules:
 *  - The policy number decides; the insured name only supports or questions it.
 *  - A policy number matches only policies of the statement's payer (the carrier, or the
 *    wholesaler that paid). The same number at another carrier is never matched automatically.
 *  - Excel scientific notation is expanded only when every digit is present; otherwise the line
 *    is left for manual matching. Missing digits are never guessed.
 *  - Extracted line values are never changed. A match is stored beside them.
 *  - Nothing here creates, edits or deletes clients, policies or commissions.
 */

export const MATCH_ENGINE_VERSION = 'match-v1';

export type MatchStatus = 'matched' | 'ambiguous' | 'unmatched';
export type MatchMethod = 'auto' | 'manual';
/** How the policy number relates to a candidate policy. */
export type NumberEvidence = 'exact' | 'alternate' | 'leading_zeros' | 'none';
/** How the insured name on the line relates to the candidate's client / named insured. */
export type NameEvidence = 'strong' | 'partial' | 'none' | 'unknown';

export type MatchReason =
  | 'number_and_carrier'          // number matches a policy of the paying carrier/wholesaler
  | 'name_supports'               // name agrees
  | 'name_partial'                // name partly agrees
  | 'name_not_printed'            // no insured name on the line
  | 'name_conflicts'              // number + carrier match but the name does not
  | 'leading_zeros_only'          // matches only if leading zeros are ignored
  | 'multiple_policies'           // several policies of this payer share the number
  | 'number_at_other_carrier'     // the number exists only under other carriers
  | 'no_policy_found'
  | 'no_policy_number'
  | 'scientific_notation_truncated' // e.g. 6.17738E+08: digits are missing, never guessed
  | 'scientific_notation_expanded'  // e.g. 6.17738486E+08: all digits present, expanded exactly
  | 'payer_not_set'
  | 'policy_not_active'
  | 'manual'
  | 'manually_unmatched'
  | 'historical_policy'           // a person identified it as a past (cancelled/expired) policy not in the book
  | 'carrier_differs';            // manual match to a policy outside the statement's payer

export const MATCH_REASON_TEXT: Record<MatchReason, string> = {
  number_and_carrier: 'Policy number matches a policy of this carrier',
  name_supports: 'Insured name agrees',
  name_partial: 'Insured name partly agrees',
  name_not_printed: 'No insured name on the statement line',
  name_conflicts: 'Policy number and carrier match, but the insured name does not — confirm',
  leading_zeros_only: 'Matches only if leading zeros are ignored',
  multiple_policies: 'More than one policy of this carrier has this number',
  number_at_other_carrier: 'This number exists only under a different carrier',
  no_policy_found: 'No policy with this number',
  no_policy_number: 'No policy number on the line',
  scientific_notation_truncated: 'Policy number was shortened by Excel (scientific notation) — digits are missing; match manually',
  scientific_notation_expanded: 'Policy number was in Excel scientific notation; all digits were present',
  payer_not_set: 'Choose the statement’s carrier first',
  policy_not_active: 'The policy is not active',
  manual: 'Matched manually',
  manually_unmatched: 'Marked unmatched manually',
  historical_policy: 'Identified by a person as a past policy (cancelled or expired) that is not in the book',
  carrier_differs: 'Policy belongs to a different carrier than the statement',
};

export interface MatchCandidate {
  policyId: string;
  clientId: string;
  carrierId: string;
  numberEvidence: NumberEvidence;
  /** The policy belongs to the statement's payer (carrier or wholesaler). */
  samePayer: boolean;
  nameEvidence: NameEvidence;
}

export interface LineMatch {
  status: MatchStatus;
  method: MatchMethod;
  confidence: 'high' | 'medium' | null;
  policyId: string | null;
  clientId: string | null;
  carrierId: string | null;
  brokerId: string | null;
  /** Broker share used for this line, captured at match time. */
  brokerShareBps: BasisPoints | null;
  /** Where the share came from: the policy's own share, the broker's standard share, or none (Unassigned). */
  brokerShareSource: BrokerShareSource | null;
  /** Paid commission on the line (copied for convenience; the line's own value is authoritative). */
  commissionCents: Cents;
  brokerCents: Cents;
  agencyCents: Cents;
  reasons: MatchReason[];
  /** Up to 5 suggestions for review (never applied automatically when ambiguous). */
  candidates: MatchCandidate[];
  /** Policy number as used for matching, or null when it could not be read safely. */
  policyNumberKey: string | null;
  nameEvidence: NameEvidence;
  engineVersion: string;
  /** Set when a person identified the line as commission on a past policy that is not in the book. */
  historical?: HistoricalAttribution | null;
  /** Matched lines: the coverage term of the policy the line belongs to, when the dates decide it. */
  term?: MatchedTerm | null;
  termResolution?: TermResolution;
}

export interface MatchedTerm { termId: string; effectiveDate: string; endDate: string; status: string }

/**
 * Add the coverage term to a MATCHED line (never changes the policy, amounts or status of the match).
 * Terms come from policies/{policyId}/terms. Lines without a match keep no term.
 */
export function withTerm<M extends LineMatch>(m: M, lineEffectiveDate: string | null | undefined, terms: PolicyTerm[] | undefined): M {
  // Firestore rejects undefined values: an unmatched line has no termResolution field at all.
  if (m.status !== 'matched' || !m.policyId) { const { termResolution: _r, ...rest } = m; return { ...rest, term: null } as M; }
  const { term, resolution } = resolveTerm(lineEffectiveDate, terms ?? []);
  return { ...m, term: term ? { termId: term.id, effectiveDate: term.effectiveDate, endDate: termEnd(term), status: term.status } : null, termResolution: resolution };
}

export const HISTORICAL_POLICY_STATUSES = ['cancelled', 'expired', 'unknown'] as const;
export type HistoricalPolicyStatus = (typeof HISTORICAL_POLICY_STATUSES)[number];

/**
 * A person's record of the original policy behind a historical commission line (a cancelled or expired
 * policy that was never imported into the active book). It is information only:
 *   - the line still posts to suspense (no policy, 100 % agency): no total, split or export changes;
 *   - clientId links it to an EXISTING customer (e.g. one with other active policies) without adding
 *     the policy to the book;
 *   - attributedBrokerId is internal reporting attribution only. It never creates broker-buyout
 *     eligibility (buyoutEligible is always false) and is never set automatically.
 */
export interface HistoricalAttribution {
  clientId: string | null;
  insuredName: string;
  policyNumber: string;
  carrierId: string | null;
  policyStatus: HistoricalPolicyStatus;
  attributedBrokerId: string | null;
  buyoutEligible: false;
  note: string;
}

// ---------------------------------------------------------------------------- inputs

export interface MatchPolicy {
  id: string;
  clientId: string;
  carrierId: string;
  wholesalerId: string | null;
  policyNumber: string;
  normalizedPolicyNumber?: string;
  alternateNumbers?: string[];
  alternateNumbersNormalized?: string[];
  namedInsured?: string;
  brokerId?: string;
  /** Per-policy broker share; null/absent = the broker's standard share. */
  brokerShareBps?: number | null;
  status?: string;
}
export interface MatchClient { id: string; name: string; brokerId?: string }
export interface MatchBroker { id: string; name?: string; shareBps: BasisPoints }

export interface MatchContext {
  /** The carrier or wholesaler that issued/paid the statement. */
  payerId: string | null;
  policies: MatchPolicy[];
  clients: MatchClient[];
  brokers: MatchBroker[];
}

// ---------------------------------------------------------------------------- policy numbers

/**
 * The key used to match a printed policy number, or null if it cannot be read safely.
 *  - Spaces, dashes, slashes and case are ignored ("AB-123 456" → "AB123456").
 *  - Excel float artefacts "617738486.0" → "617738486".
 *  - Excel scientific notation is expanded only when every digit is present and Excel's
 *    15-digit precision was not exceeded: "6.17738486E+08" → "617738486".
 *    "6.17738E+08" has lost three digits → null (problem 'scientific_notation_truncated').
 */
export function policyNumberKey(raw: string | null | undefined): { key: string | null; problem: 'missing' | 'scientific_notation_truncated' | null; expanded: boolean } {
  const t = String(raw ?? '').trim();
  if (!t) return { key: null, problem: 'missing', expanded: false };
  // Excel's display form only: one digit, optional fraction, "E+" exponent ("6.17738486E+08", "6E+08").
  // Genuine alphanumeric numbers such as "12E3" or "AB1E+5" are not treated as notation.
  const sci = /^(\d)(?:\.(\d+))?[eE]\+(\d{1,3})$/.exec(t);
  if (sci) {
    const frac = sci[2] ?? '';
    const exp = Number(sci[3]);
    const digits = sci[1] + frac;
    // Exact only if the shown fraction fills the exponent exactly (nothing to pad, no decimals left)
    // and Excel's 15 significant digits were not exceeded. Otherwise digits are missing.
    if (frac.length === exp && digits.length <= 15) return { key: digits, problem: null, expanded: true };
    return { key: null, problem: 'scientific_notation_truncated', expanded: false };
  }
  const floatArtefact = /^(\d+)\.0+$/.exec(t);
  const key = normalizePolicyNumber(floatArtefact ? floatArtefact[1] : t);
  return key ? { key, problem: null, expanded: false } : { key: null, problem: 'missing', expanded: false };
}

const stripZeros = (k: string) => k.replace(/^0+/, '');
const zeroKeyEligible = (k: string) => /^\d+$/.test(k) && stripZeros(k).length >= 5;

// ---------------------------------------------------------------------------- names

function tokens(n: string): Set<string> { return new Set(n.split(' ').filter((w) => w.length > 0)); }

/**
 * Compare a printed insured name with a client name and/or named insured. Order-insensitive.
 *
 * Word overlap first ("SMITH JOHN" = "John Smith"). Then person-name rules (personName.ts) for people
 * printed as "LAST,F", "LAST FIRST M" or joint insureds: the same surname with compatible given names
 * ("BIONDI,D" ~ "Dana Biondi", "AUGUSTINE WILLIAM A" ~ "William & Joelle Augustine") is PARTIAL support
 * — never strong, so it can only confirm a policy already found by number and carrier, never pick
 * between several. The same surname with conflicting given names ("SMITH JOHN A" vs "Mary A Smith") is
 * no support, even when the words overlap.
 */
export function nameEvidence(printed: string, ...targets: (string | undefined | null)[]): NameEvidence {
  const lineVariants = nameVariants(printed);
  if (!lineVariants.length) return 'unknown';
  const targetVariants = targets.flatMap((t) => (t ? nameVariants(t) : []));
  if (!targetVariants.length) return 'unknown';
  let best = 0;
  for (const a of lineVariants) {
    const ta = tokens(a);
    for (const b of targetVariants) {
      if (a === b) return 'strong';
      const tb = tokens(b);
      const inter = [...ta].filter((w) => tb.has(w)).length;
      const union = new Set([...ta, ...tb]).size;
      if (inter === ta.size && inter === tb.size) return 'strong'; // same words, any order ("SMITH JOHN" / "John Smith")
      best = Math.max(best, union ? inter / union : 0);
    }
  }
  const people = targets.filter((t): t is string => !!t).map((t) => personEvidence(printed, t));
  if (people.includes('compatible')) return 'partial';
  if (people.includes('conflict')) return 'none';
  return best >= 0.5 ? 'partial' : 'none';
}

// ---------------------------------------------------------------------------- split

/** Broker and agency commission for a matched line, in integer cents (half-even; parts sum exactly). */
export function commissionSplit(commissionCents: Cents, brokerShareBps: BasisPoints): { brokerCents: Cents; agencyCents: Cents } {
  const { broker, agency } = brokerSplit(commissionCents, brokerShareBps);
  return { brokerCents: broker, agencyCents: agency };
}

export type BrokerShareSource = 'policy' | 'broker' | 'unassigned';

/**
 * The broker that earns on a policy (the policy's broker, as everywhere else in the app) and the
 * applicable share: the policy's own broker share if set, otherwise the broker's standard share.
 * The Unassigned broker always earns 0 %: the agency keeps the commission.
 */
export function brokerForPolicy(policy: MatchPolicy, brokers: Map<string, MatchBroker>): { brokerId: string; shareBps: BasisPoints; source: BrokerShareSource } {
  const brokerId = policy.brokerId || UNASSIGNED_BROKER_ID;
  if (brokerId === UNASSIGNED_BROKER_ID) return { brokerId, shareBps: 0, source: 'unassigned' };
  if (typeof policy.brokerShareBps === 'number') return { brokerId, shareBps: policy.brokerShareBps, source: 'policy' };
  const b = brokers.get(brokerId);
  return { brokerId, shareBps: b ? b.shareBps : 0, source: 'broker' };
}

// ---------------------------------------------------------------------------- matching

export interface PreparedContext {
  payerId: string | null;
  byKey: Map<string, { policy: MatchPolicy; evidence: 'exact' | 'alternate' }[]>;
  byZeroKey: Map<string, MatchPolicy[]>;
  policyById: Map<string, MatchPolicy>;
  clientById: Map<string, MatchClient>;
  brokerById: Map<string, MatchBroker>;
  policies: MatchPolicy[];
}

export function prepareMatchContext(ctx: MatchContext): PreparedContext {
  const byKey = new Map<string, { policy: MatchPolicy; evidence: 'exact' | 'alternate' }[]>();
  const byZeroKey = new Map<string, MatchPolicy[]>();
  const add = (k: string, policy: MatchPolicy, evidence: 'exact' | 'alternate') => {
    if (!k) return;
    const list = byKey.get(k) ?? [];
    if (!list.some((e) => e.policy.id === policy.id)) list.push({ policy, evidence });
    byKey.set(k, list);
    if (zeroKeyEligible(k)) {
      const z = stripZeros(k);
      const zl = byZeroKey.get(z) ?? [];
      if (!zl.some((p) => p.id === policy.id)) zl.push(policy);
      byZeroKey.set(z, zl);
    }
  };
  for (const p of ctx.policies) {
    add(p.normalizedPolicyNumber || normalizePolicyNumber(p.policyNumber), p, 'exact');
    const alts = p.alternateNumbersNormalized?.length ? p.alternateNumbersNormalized : (p.alternateNumbers ?? []).map(normalizePolicyNumber);
    for (const a of alts) add(a, p, 'alternate');
  }
  return {
    payerId: ctx.payerId,
    byKey,
    byZeroKey,
    policyById: new Map(ctx.policies.map((p) => [p.id, p])),
    clientById: new Map(ctx.clients.map((c) => [c.id, c])),
    brokerById: new Map(ctx.brokers.map((b) => [b.id, b])),
    policies: ctx.policies,
  };
}

const samePayer = (p: MatchPolicy, payerId: string | null) => !!payerId && (p.carrierId === payerId || p.wholesalerId === payerId);

function candidateFor(line: Pick<ExtractedLine, 'insuredName'>, p: MatchPolicy, numberEvidence: NumberEvidence, c: PreparedContext): MatchCandidate {
  return {
    policyId: p.id,
    clientId: p.clientId,
    carrierId: p.carrierId,
    numberEvidence,
    samePayer: samePayer(p, c.payerId),
    nameEvidence: nameEvidence(line.insuredName, c.clientById.get(p.clientId)?.name, p.namedInsured),
  };
}

function sortCandidates(list: MatchCandidate[]): MatchCandidate[] {
  const rankN: Record<NumberEvidence, number> = { exact: 0, alternate: 1, leading_zeros: 2, none: 3 };
  const rankName: Record<NameEvidence, number> = { strong: 0, partial: 1, unknown: 2, none: 3 };
  return [...list].sort((a, b) => Number(b.samePayer) - Number(a.samePayer) || rankN[a.numberEvidence] - rankN[b.numberEvidence] || rankName[a.nameEvidence] - rankName[b.nameEvidence] || a.policyId.localeCompare(b.policyId));
}

type LineIn = Pick<ExtractedLine, 'policyNumberRaw' | 'insuredName' | 'paidCommissionCents'>;

/** Build a match for a chosen policy (used for automatic matches and manual assignments). */
export function matchToPolicy(line: LineIn, policy: MatchPolicy, c: PreparedContext, method: MatchMethod, base: Partial<LineMatch> = {}): LineMatch {
  const { brokerId, shareBps, source } = brokerForPolicy(policy, c.brokerById);
  const commissionCents = line.paidCommissionCents ?? 0;
  const { brokerCents, agencyCents } = commissionSplit(commissionCents, shareBps);
  const ne = nameEvidence(line.insuredName, c.clientById.get(policy.clientId)?.name, policy.namedInsured);
  const reasons = [...(base.reasons ?? [])];
  if (method === 'manual') {
    reasons.unshift('manual');
    if (c.payerId && !samePayer(policy, c.payerId)) reasons.push('carrier_differs');
  }
  if (policy.status && policy.status !== 'active') reasons.push('policy_not_active');
  return {
    status: 'matched',
    method,
    confidence: method === 'manual' ? 'high' : base.confidence ?? 'medium',
    policyId: policy.id,
    clientId: policy.clientId,
    carrierId: policy.carrierId,
    brokerId,
    brokerShareBps: shareBps,
    brokerShareSource: source,
    commissionCents,
    brokerCents,
    agencyCents,
    reasons: [...new Set(reasons)],
    candidates: base.candidates ?? [],
    policyNumberKey: base.policyNumberKey ?? policyNumberKey(line.policyNumberRaw).key,
    nameEvidence: ne,
    engineVersion: MATCH_ENGINE_VERSION,
  };
}

/** A line that is not (or no longer) matched to a policy. */
export function noMatch(line: LineIn, status: 'ambiguous' | 'unmatched', method: MatchMethod, reasons: MatchReason[], candidates: MatchCandidate[], key: string | null): LineMatch {
  return {
    status, method, confidence: null,
    policyId: null, clientId: null, carrierId: null, brokerId: null, brokerShareBps: null, brokerShareSource: null,
    commissionCents: line.paidCommissionCents ?? 0, brokerCents: 0, agencyCents: 0,
    reasons: [...new Set(reasons)], candidates: sortCandidates(candidates).slice(0, 5),
    policyNumberKey: key, nameEvidence: 'unknown', engineVersion: MATCH_ENGINE_VERSION,
  };
}

/** Automatic match for one extracted line. */
export function autoMatchLine(line: LineIn, c: PreparedContext): LineMatch {
  const pk = policyNumberKey(line.policyNumberRaw);
  const info: MatchReason[] = pk.expanded ? ['scientific_notation_expanded'] : [];

  // Name-only suggestions for manual review (never applied automatically).
  const nameSuggestions = (): MatchCandidate[] => {
    if (!line.insuredName?.trim()) return [];
    const pool = c.payerId ? c.policies.filter((p) => samePayer(p, c.payerId)) : c.policies;
    return pool.map((p) => candidateFor(line, p, 'none', c)).filter((x) => x.nameEvidence === 'strong').slice(0, 5);
  };

  if (!pk.key) {
    const reason: MatchReason = pk.problem === 'scientific_notation_truncated' ? 'scientific_notation_truncated' : 'no_policy_number';
    return noMatch(line, 'unmatched', 'auto', [reason], nameSuggestions(), null);
  }

  const direct = (c.byKey.get(pk.key) ?? []).map((e) => candidateFor(line, e.policy, e.evidence, c));
  const zeros = zeroKeyEligible(pk.key)
    ? (c.byZeroKey.get(stripZeros(pk.key)) ?? []).filter((p) => !direct.some((d) => d.policyId === p.id)).map((p) => candidateFor(line, p, 'leading_zeros', c))
    : [];

  if (!c.payerId) {
    const all = [...direct, ...zeros];
    return all.length
      ? noMatch(line, 'ambiguous', 'auto', [...info, 'payer_not_set'], all, pk.key)
      : noMatch(line, 'unmatched', 'auto', [...info, 'payer_not_set', 'no_policy_found'], nameSuggestions(), pk.key);
  }

  const inScope = direct.filter((d) => d.samePayer);
  const nameReason = (e: NameEvidence): MatchReason[] => (e === 'strong' ? ['name_supports'] : e === 'partial' ? ['name_partial'] : e === 'unknown' ? ['name_not_printed'] : []);

  if (inScope.length === 1) {
    const cand = inScope[0];
    const policy = c.policyById.get(cand.policyId)!;
    if (cand.nameEvidence === 'none') {
      return noMatch(line, 'ambiguous', 'auto', [...info, 'number_and_carrier', 'name_conflicts'], [...direct, ...zeros], pk.key);
    }
    return matchToPolicy(line, policy, c, 'auto', {
      confidence: cand.nameEvidence === 'strong' ? 'high' : 'medium',
      reasons: [...info, 'number_and_carrier', ...nameReason(cand.nameEvidence)],
      candidates: [],
      policyNumberKey: pk.key,
    });
  }
  if (inScope.length > 1) {
    const strong = inScope.filter((d) => d.nameEvidence === 'strong');
    if (strong.length === 1) {
      return matchToPolicy(line, c.policyById.get(strong[0].policyId)!, c, 'auto', {
        confidence: 'medium', reasons: [...info, 'number_and_carrier', 'multiple_policies', 'name_supports'],
        candidates: sortCandidates(inScope).slice(0, 5), policyNumberKey: pk.key,
      });
    }
    return noMatch(line, 'ambiguous', 'auto', [...info, 'multiple_policies'], inScope, pk.key);
  }
  if (direct.length) return noMatch(line, 'ambiguous', 'auto', [...info, 'number_at_other_carrier'], [...direct, ...zeros], pk.key);

  const zerosInScope = zeros.filter((z) => z.samePayer);
  if (zerosInScope.length === 1 && zerosInScope[0].nameEvidence === 'strong') {
    return matchToPolicy(line, c.policyById.get(zerosInScope[0].policyId)!, c, 'auto', {
      confidence: 'medium', reasons: [...info, 'leading_zeros_only', 'name_supports'], candidates: [], policyNumberKey: pk.key,
    });
  }
  if (zerosInScope.length) return noMatch(line, 'ambiguous', 'auto', [...info, 'leading_zeros_only'], zeros, pk.key);
  if (zeros.length) return noMatch(line, 'ambiguous', 'auto', [...info, 'leading_zeros_only', 'number_at_other_carrier'], zeros, pk.key);
  return noMatch(line, 'unmatched', 'auto', [...info, 'no_policy_found'], nameSuggestions(), pk.key);
}

// ---------------------------------------------------------------------------- summary

export interface MatchSummary {
  engineVersion: string;
  lineCount: number;
  commissionLineCount: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
  manual: number;
  /** Commission lines only (lines with a paid commission). */
  matchedCommissionLines: number;
  commissionCents: Cents;
  matchedCommissionCents: Cents;
  ambiguousCommissionCents: Cents;
  unmatchedCommissionCents: Cents;
  brokerCents: Cents;
  agencyCents: Cents;
  /** Statement-level adjustments (fees, bonuses): agency-only, not split with brokers. */
  adjustmentsCents: Cents;
  byBroker: { brokerId: string; commissionCents: Cents; brokerCents: Cents; agencyCents: Cents; lines: number }[];
  /** commission = matched + ambiguous + unmatched, and broker + agency = matched, both to the cent. */
  balanced: boolean;
}

export function summarizeMatches(lines: { paidCommissionCents: Cents | null; match?: LineMatch | null }[], adjustments: StatementAdjustment[] = []): MatchSummary {
  let matched = 0, ambiguous = 0, unmatched = 0, manual = 0, commissionLineCount = 0, matchedCommissionLines = 0;
  let commission = 0, mC = 0, aC = 0, uC = 0, broker = 0, agency = 0;
  const byBroker = new Map<string, { commissionCents: number; brokerCents: number; agencyCents: number; lines: number }>();
  for (const l of lines) {
    const paid = l.paidCommissionCents ?? 0;
    const hasCommission = l.paidCommissionCents !== null && l.paidCommissionCents !== undefined;
    if (hasCommission) commissionLineCount++;
    commission += paid;
    const m = l.match;
    if (m?.method === 'manual') manual++;
    if (m?.status === 'matched') {
      matched++; mC += paid;
      if (hasCommission) matchedCommissionLines++;
      broker += m.brokerCents; agency += m.agencyCents;
      const k = m.brokerId ?? UNASSIGNED_BROKER_ID;
      const b = byBroker.get(k) ?? { commissionCents: 0, brokerCents: 0, agencyCents: 0, lines: 0 };
      b.commissionCents += paid; b.brokerCents += m.brokerCents; b.agencyCents += m.agencyCents; b.lines++;
      byBroker.set(k, b);
    } else if (m?.status === 'ambiguous') { ambiguous++; aC += paid; } else { unmatched++; uC += paid; }
  }
  const adjustmentsCents = adjustments.reduce((s, a) => s + a.amountCents, 0);
  return {
    engineVersion: MATCH_ENGINE_VERSION,
    lineCount: lines.length,
    commissionLineCount,
    matched, ambiguous, unmatched, manual, matchedCommissionLines,
    commissionCents: commission,
    matchedCommissionCents: mC,
    ambiguousCommissionCents: aC,
    unmatchedCommissionCents: uC,
    brokerCents: broker,
    agencyCents: agency,
    adjustmentsCents,
    byBroker: [...byBroker].map(([brokerId, v]) => ({ brokerId, ...v })).sort((a, b) => b.commissionCents - a.commissionCents),
    balanced: mC + aC + uC === commission && broker + agency === mC,
  };
}
