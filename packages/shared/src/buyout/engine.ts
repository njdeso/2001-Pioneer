import { applyBasisPoints, mulDivHalfEven, type BasisPoints, type Cents } from '../money.js';
import { UNASSIGNED_BROKER_ID } from '../schemas.js';
import { termEnd, type PolicyTerm } from '../terms.js';
import { MATERIAL_ADVANCE_FLAGS, reviewPolicyAdvances, type AdvanceFlagCode, type BrokerAdvance } from './advances.js';

/**
 * Broker buyout valuation (internal, owner only). Completely separate from the Pioneer agency
 * valuation: it never reads the ledger, so historical commission receipts can never create a buyout
 * entitlement, and nothing here appears in any due-diligence export.
 *
 * PER POLICY (eligible = broker-owned and in force at the closing date)
 *   term days            = scheduled expiration − effective date (exact calendar days; expiration exclusive)
 *   annualized agency    = term commission × 365 / term days                 (rounded half-even)
 *   annualized broker    = annualized agency × broker share                  (rounded half-even)
 *   gross buyout         = annualized broker × multiple (1.5×)               (rounded half-even)
 *   remaining days       = expiration − closing date, clamped to [0, term days] (closing date = first unearned day)
 *   outstanding advance  = advance actually paid × remaining days / term days (rounded half-even)
 *   net contribution     = gross buyout − outstanding advance                (exact)
 * Every printed figure is rounded once, half-even, and each step uses the previous printed figure, so
 * anyone can recompute the statement from the numbers on it.
 *
 * PER BROKER: net = Σ policy contributions (negatives offset positives) + adjustments; a negative
 * broker total is flagged for manual resolution (never a broker debt). Installments: 25 % and 25 %
 * (half-even), the closing payment takes the rest, so the three always equal the net exactly.
 *
 * Commission basis: the verified full-term commission on the advance records for the closing term;
 * otherwise premium × commission rate as a FLAGGED fallback.
 * Cancelled/expired policies are excluded (no clawback); their advances are never deducted elsewhere.
 */

export const BUYOUT_ENGINE_VERSION = 'buyout-1.0';

export interface BuyoutRules {
  multipleBps: BasisPoints;               // 15000 = 1.5×
  installmentsBps: [BasisPoints, BasisPoints, BasisPoints]; // closing, 1st anniversary, 2nd anniversary
  daysPerYear: 365;
}
export const DEFAULT_BUYOUT_RULES: BuyoutRules = { multipleBps: 15000, installmentsBps: [5000, 2500, 2500], daysPerYear: 365 };

// ---------------------------------------------------------------- dates (exact calendar days, UTC)

const dayNumber = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000;
export const daysBetween = (from: string, to: string) => dayNumber(to) - dayNumber(from);

/** Same calendar day N years later; a Feb 29 date falls on Feb 28 in a non-leap year. */
export function addYearsCalendar(iso: string, years: number): string {
  const y = +iso.slice(0, 4) + years, m = +iso.slice(5, 7), d = +iso.slice(8, 10);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const day = m === 2 && d === 29 && !leap ? 28 : d;
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- inputs

export interface BuyoutPolicy {
  id: string; clientId: string; carrierId: string; policyNumber: string; brokerId: string; brokerShareBps?: number | null;
  status: string; effectiveDate?: string | null; expirationDate?: string | null; premiumCents?: number | null; commissionRateBps?: number | null;
}
export interface BuyoutBroker { id: string; name: string; shareBps: BasisPoints; status?: string }
export interface BuyoutAdjustment { id: string; brokerId: string; amountCents: Cents; reason: string }

export type ExclusionReason =
  | 'agency_owned' | 'zero_share' | 'pending' | 'cancelled' | 'expired' | 'not_in_force_at_closing' | 'no_term_dates' | 'renewal_not_recorded' | 'cancellation_date_unknown';
export const EXCLUSION_TEXT: Record<ExclusionReason, string> = {
  agency_owned: 'Agency-owned (Unassigned): no broker buyout',
  zero_share: 'Broker share is 0 %: agency-owned',
  pending: 'Pending at closing',
  cancelled: 'Cancelled before the closing date (no clawback; advances not deducted elsewhere)',
  expired: 'Expired before the closing date',
  not_in_force_at_closing: 'No coverage term in force on the closing date',
  no_term_dates: 'No effective/expiration dates to establish the term in force at closing',
  renewal_not_recorded: 'Policy dates end before closing but the policy is active: record the renewal term',
  cancellation_date_unknown: 'Policy is cancelled/expired but its dates cover the closing date: record the cancellation as a term',
};

export type EngineFlag = AdvanceFlagCode | 'basis_fallback' | 'no_commission_basis' | 'negative_policy_contribution' | 'cancelled_after_closing' | 'renewal_not_recorded' | 'cancellation_date_unknown';
export const ENGINE_FLAG_TEXT: Partial<Record<EngineFlag, string>> = {
  basis_fallback: 'Commission basis from premium × commission rate (no verified full-term commission on the advance records)',
  no_commission_basis: 'No commission basis: neither a verified full-term commission nor premium × rate',
  negative_policy_contribution: 'Negative contribution (outstanding advance exceeds gross buyout); offset within the broker',
  cancelled_after_closing: 'Cancelled after the closing date: included as in force at closing',
  renewal_not_recorded: EXCLUSION_TEXT.renewal_not_recorded,
  cancellation_date_unknown: EXCLUSION_TEXT.cancellation_date_unknown,
};
export const MATERIAL_ENGINE_FLAGS: ReadonlySet<EngineFlag> = new Set<EngineFlag>([...MATERIAL_ADVANCE_FLAGS, 'no_commission_basis', 'renewal_not_recorded', 'cancellation_date_unknown']);

export interface PolicyValuation {
  policyId: string; clientId: string; carrierId: string; policyNumber: string; brokerId: string;
  included: boolean; exclusion: ExclusionReason | null; explanation: string;
  term: { effectiveDate: string; expirationDate: string; source: 'terms' | 'policy'; termStatus: string | null } | null;
  basis: { cents: Cents; source: 'advance' | 'premium_x_rate' } | null;
  termDays: number; remainingDays: number;
  annualizedAgencyCents: Cents; brokerShareBps: BasisPoints; annualizedBrokerCents: Cents; grossBuyoutCents: Cents;
  advancePaidCents: Cents; earnedAdvanceCents: Cents; outstandingAdvanceCents: Cents; netContributionCents: Cents;
  advanceIds: string[]; flags: EngineFlag[]; material: boolean;
}

export interface BrokerSettlement {
  brokerId: string; brokerName: string; policies: number;
  annualizedAgencyCents: Cents; annualizedBrokerCents: Cents; grossBuyoutCents: Cents; outstandingAdvanceCents: Cents;
  netBeforeAdjustmentsCents: Cents; adjustments: BuyoutAdjustment[]; adjustmentsCents: Cents; finalNetCents: Cents;
  installments: { label: string; dueDate: string; bps: BasisPoints; amountCents: Cents }[];
  flags: ('negative_broker_settlement' | 'policies_need_review')[]; materialPolicies: number;
}

export interface BuyoutCheck { name: string; pass: boolean; detail: string }

export interface BuyoutValuation {
  engineVersion: string; closingDate: string; rules: BuyoutRules;
  policies: PolicyValuation[]; brokers: BrokerSettlement[];
  totals: {
    eligiblePolicies: number; excludedPolicies: number; annualizedAgencyCents: Cents; annualizedBrokerCents: Cents; grossBuyoutCents: Cents;
    outstandingAdvanceCents: Cents; netBeforeAdjustmentsCents: Cents; adjustmentsCents: Cents; finalNetCents: Cents;
    installmentsCents: [Cents, Cents, Cents]; policiesRequiringReview: number; missingAdvances: number;
  };
  checks: BuyoutCheck[];
  /** True when nothing blocks finalization: every check passes and no material exception remains. */
  finalizable: boolean;
  blockers: string[];
}

// ---------------------------------------------------------------- engine

/** Which term was in force on the closing date, and whether the policy is eligible. */
function closingTerm(p: BuyoutPolicy, terms: PolicyTerm[], closing: string): { term: PolicyValuation['term']; exclusion: ExclusionReason | null; flags: EngineFlag[] } {
  const flags: EngineFlag[] = [];
  if (terms.length) {
    // In force on the closing date: effective ≤ closing < coverage end.
    const t = terms.find((x) => x.effectiveDate <= closing && closing < termEnd(x));
    if (!t) {
      const ended = terms.filter((x) => termEnd(x) <= closing).sort((a, b) => termEnd(b).localeCompare(termEnd(a)))[0];
      return { term: null, exclusion: ended ? (ended.status === 'cancelled' ? 'cancelled' : 'expired') : 'not_in_force_at_closing', flags };
    }
    const term = { effectiveDate: t.effectiveDate, expirationDate: t.scheduledExpirationDate, source: 'terms' as const, termStatus: t.status };
    if (t.status === 'pending') return { term, exclusion: 'pending', flags };
    if (t.status === 'cancelled') flags.push('cancelled_after_closing'); // cancellation date is after closing
    return { term, exclusion: null, flags };
  }
  if (!p.effectiveDate || !p.expirationDate) return { term: null, exclusion: 'no_term_dates', flags };
  const term = { effectiveDate: p.effectiveDate, expirationDate: p.expirationDate, source: 'policy' as const, termStatus: null };
  const covers = p.effectiveDate <= closing && closing < p.expirationDate;
  if (p.status === 'pending') return { term, exclusion: 'pending', flags };
  if (p.status === 'cancelled' || p.status === 'expired') {
    if (covers) return { term, exclusion: 'cancellation_date_unknown', flags: ['cancellation_date_unknown'] };
    return { term, exclusion: p.status === 'cancelled' ? 'cancelled' : 'expired', flags };
  }
  if (!covers) {
    if (p.expirationDate <= closing) return { term, exclusion: 'renewal_not_recorded', flags: ['renewal_not_recorded'] };
    return { term, exclusion: 'not_in_force_at_closing', flags };
  }
  return { term, exclusion: null, flags };
}

export function valueBuyout(input: {
  closingDate: string; rules?: BuyoutRules; policies: BuyoutPolicy[]; termsByPolicy: Map<string, PolicyTerm[]>;
  brokers: BuyoutBroker[]; advances: BrokerAdvance[]; adjustments?: BuyoutAdjustment[];
  carrierRateBps?: (carrierId: string) => number | null;
}): BuyoutValuation {
  const rules = input.rules ?? DEFAULT_BUYOUT_RULES;
  const closing = input.closingDate;
  const brokerById = new Map(input.brokers.map((b) => [b.id, b]));
  const out: PolicyValuation[] = [];

  for (const p of [...input.policies].sort((a, b) => a.brokerId.localeCompare(b.brokerId) || a.policyNumber.localeCompare(b.policyNumber))) {
    const brokerId = p.brokerId || UNASSIGNED_BROKER_ID;
    const share = brokerId === UNASSIGNED_BROKER_ID ? 0 : typeof p.brokerShareBps === 'number' ? p.brokerShareBps : brokerById.get(brokerId)?.shareBps ?? 0;
    const base = { policyId: p.id, clientId: p.clientId, carrierId: p.carrierId, policyNumber: p.policyNumber, brokerId };
    const empty = { basis: null, termDays: 0, remainingDays: 0, annualizedAgencyCents: 0, brokerShareBps: share, annualizedBrokerCents: 0, grossBuyoutCents: 0, advancePaidCents: 0, earnedAdvanceCents: 0, outstandingAdvanceCents: 0, netContributionCents: 0, advanceIds: [] as string[] };
    const terms = input.termsByPolicy.get(p.id) ?? [];
    const exclude = (reason: ExclusionReason, term: PolicyValuation['term'], flags: EngineFlag[] = []) =>
      out.push({ ...base, ...empty, included: false, exclusion: reason, explanation: `Excluded: ${EXCLUSION_TEXT[reason]}.`, term, flags, material: flags.some((f) => MATERIAL_ENGINE_FLAGS.has(f)) });

    if (brokerId === UNASSIGNED_BROKER_ID) { exclude('agency_owned', null); continue; }
    const ct = closingTerm(p, terms, closing);
    if (ct.exclusion) { exclude(ct.exclusion, ct.term, ct.flags); continue; }
    if (share === 0) { exclude('zero_share', ct.term); continue; }
    const term = ct.term!;

    // Advances for the closing term, reviewed as of the closing date.
    const review = reviewPolicyAdvances({
      policy: { id: p.id, clientId: p.clientId, brokerId, brokerShareBps: p.brokerShareBps ?? null, status: 'active', effectiveDate: term.effectiveDate, expirationDate: term.expirationDate },
      terms, advances: input.advances, brokerShareBps: (id) => brokerById.get(id)?.shareBps ?? 0, asOf: closing,
    });
    const flags = new Set<EngineFlag>([...ct.flags, ...review.flags]);
    // Only advances paid to the broker who owns the policy at closing are deducted (others are flagged).
    const own = review.advances.filter((a) => a.brokerId === brokerId);
    const paid = own.reduce((s, a) => s + a.amountPaidCents, 0);

    let basis: PolicyValuation['basis'] = null;
    if (review.basisCents !== null) basis = { cents: review.basisCents, source: 'advance' };
    else {
      const rate = typeof p.commissionRateBps === 'number' ? p.commissionRateBps : input.carrierRateBps?.(p.carrierId) ?? null;
      if (typeof p.premiumCents === 'number' && rate !== null) { basis = { cents: applyBasisPoints(p.premiumCents, rate), source: 'premium_x_rate' }; flags.add('basis_fallback'); }
      else flags.add('no_commission_basis');
    }

    const termDays = daysBetween(term.effectiveDate, term.expirationDate);
    const remainingDays = Math.min(Math.max(daysBetween(closing, term.expirationDate), 0), termDays);
    const annualizedAgency = basis && termDays > 0 ? mulDivHalfEven(basis.cents, rules.daysPerYear, termDays) : 0;
    const annualizedBroker = applyBasisPoints(annualizedAgency, share);
    const gross = applyBasisPoints(annualizedBroker, rules.multipleBps);
    const outstanding = termDays > 0 ? mulDivHalfEven(paid, remainingDays, termDays) : 0;
    const net = gross - outstanding;
    if (net < 0) flags.add('negative_policy_contribution');
    const list = [...flags];
    out.push({
      ...base, included: true, exclusion: null, term, basis, termDays, remainingDays,
      explanation: `Included: broker-owned and in force on ${closing} (term ${term.effectiveDate} → ${term.expirationDate}${term.source === 'terms' ? ', from term history' : ', from policy dates'}).`,
      annualizedAgencyCents: annualizedAgency, brokerShareBps: share, annualizedBrokerCents: annualizedBroker, grossBuyoutCents: gross,
      advancePaidCents: paid, earnedAdvanceCents: paid - outstanding, outstandingAdvanceCents: outstanding, netContributionCents: net,
      advanceIds: own.map((a) => a.id), flags: list, material: list.some((f) => MATERIAL_ENGINE_FLAGS.has(f)),
    });
  }

  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const included = out.filter((v) => v.included);
  const adjustments = input.adjustments ?? [];
  const brokerIds = [...new Set([...included.map((v) => v.brokerId), ...adjustments.map((a) => a.brokerId)])].sort((a, b) => (brokerById.get(a)?.name ?? a).localeCompare(brokerById.get(b)?.name ?? b));
  const brokers: BrokerSettlement[] = brokerIds.map((id) => {
    const mine = included.filter((v) => v.brokerId === id);
    const adj = adjustments.filter((a) => a.brokerId === id);
    const netBefore = sum(mine.map((v) => v.netContributionCents));
    const adjCents = sum(adj.map((a) => a.amountCents));
    const final = netBefore + adjCents;
    const flags: BrokerSettlement['flags'] = [];
    if (final < 0) flags.push('negative_broker_settlement');
    const materialPolicies = mine.filter((v) => v.material).length;
    if (materialPolicies) flags.push('policies_need_review');
    const [b0, b1, b2] = rules.installmentsBps;
    const second = final > 0 ? applyBasisPoints(final, b1) : 0;
    const third = final > 0 ? applyBasisPoints(final, b2) : 0;
    const first = final > 0 ? final - second - third : 0; // rounding differences go to the closing payment
    return {
      brokerId: id, brokerName: brokerById.get(id)?.name ?? id, policies: mine.length,
      annualizedAgencyCents: sum(mine.map((v) => v.annualizedAgencyCents)), annualizedBrokerCents: sum(mine.map((v) => v.annualizedBrokerCents)),
      grossBuyoutCents: sum(mine.map((v) => v.grossBuyoutCents)), outstandingAdvanceCents: sum(mine.map((v) => v.outstandingAdvanceCents)),
      netBeforeAdjustmentsCents: netBefore, adjustments: adj, adjustmentsCents: adjCents, finalNetCents: final,
      installments: [
        { label: 'At closing', dueDate: closing, bps: b0, amountCents: first },
        { label: 'First anniversary', dueDate: addYearsCalendar(closing, 1), bps: b1, amountCents: second },
        { label: 'Second anniversary', dueDate: addYearsCalendar(closing, 2), bps: b2, amountCents: third },
      ],
      flags, materialPolicies,
    };
  });

  const totals = {
    eligiblePolicies: included.length, excludedPolicies: out.length - included.length,
    annualizedAgencyCents: sum(included.map((v) => v.annualizedAgencyCents)), annualizedBrokerCents: sum(included.map((v) => v.annualizedBrokerCents)),
    grossBuyoutCents: sum(included.map((v) => v.grossBuyoutCents)), outstandingAdvanceCents: sum(included.map((v) => v.outstandingAdvanceCents)),
    netBeforeAdjustmentsCents: sum(included.map((v) => v.netContributionCents)), adjustmentsCents: sum(adjustments.map((a) => a.amountCents)),
    finalNetCents: sum(brokers.map((b) => b.finalNetCents)),
    installmentsCents: [0, 1, 2].map((i) => sum(brokers.map((b) => b.installments[i].amountCents))) as [Cents, Cents, Cents],
    policiesRequiringReview: out.filter((v) => v.material).length,
    missingAdvances: included.filter((v) => v.flags.includes('missing_advance')).length,
  };

  const checks: BuyoutCheck[] = [
    { name: 'Policy net = gross buyout − outstanding advance, for every policy', pass: included.every((v) => v.netContributionCents === v.grossBuyoutCents - v.outstandingAdvanceCents), detail: `${included.length} eligible policies` },
    { name: 'Earned + outstanding advance = advance paid, for every policy', pass: included.every((v) => v.earnedAdvanceCents + v.outstandingAdvanceCents === v.advancePaidCents), detail: '' },
    { name: 'Remaining days within [0, term days]', pass: included.every((v) => v.remainingDays >= 0 && v.remainingDays <= v.termDays && v.termDays > 0), detail: '' },
    { name: 'Broker totals add up to the grand totals', pass: sum(brokers.map((b) => b.grossBuyoutCents)) === totals.grossBuyoutCents && sum(brokers.map((b) => b.outstandingAdvanceCents)) === totals.outstandingAdvanceCents && sum(brokers.map((b) => b.netBeforeAdjustmentsCents)) === totals.netBeforeAdjustmentsCents, detail: `${brokers.length} brokers` },
    { name: 'Each broker settlement = Σ policy contributions + adjustments', pass: brokers.every((b) => b.finalNetCents === b.netBeforeAdjustmentsCents + b.adjustmentsCents), detail: '' },
    { name: 'Each broker’s three installments equal its net settlement exactly', pass: brokers.every((b) => b.finalNetCents <= 0 || sum(b.installments.map((x) => x.amountCents)) === b.finalNetCents), detail: '' },
    { name: 'Every policy is either included or excluded with a reason', pass: out.every((v) => v.included !== !!v.exclusion) && out.length === input.policies.length, detail: `${out.length} considered: ${included.length} included, ${out.length - included.length} excluded` },
    { name: 'Every policy belongs to exactly one broker', pass: new Set(out.map((v) => v.policyId)).size === out.length, detail: '' },
    { name: 'Adjustments belong to a broker with a reason', pass: adjustments.every((a) => !!a.brokerId && a.reason.trim().length >= 3 && Number.isSafeInteger(a.amountCents)), detail: `${adjustments.length} adjustment(s)` },
  ];
  const blockers: string[] = [];
  if (checks.some((c) => !c.pass)) blockers.push('A reconciliation check failed.');
  const materialCount = out.filter((v) => v.material).length;
  if (materialCount) blockers.push(`${materialCount} polic${materialCount === 1 ? 'y requires' : 'ies require'} review (unresolved advance or eligibility discrepancies).`);
  const negative = brokers.filter((b) => b.flags.includes('negative_broker_settlement'));
  if (negative.length) blockers.push(`${negative.length} broker settlement(s) are negative: resolve manually (no broker debt is created).`);
  return { engineVersion: BUYOUT_ENGINE_VERSION, closingDate: closing, rules, policies: out, brokers, totals, checks, finalizable: blockers.length === 0, blockers };
}
