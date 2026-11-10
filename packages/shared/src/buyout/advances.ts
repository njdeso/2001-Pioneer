import { z } from 'zod';
import { applyBasisPoints, parseMoneyToCents, parsePercentToBps, type BasisPoints, type Cents } from '../money.js';
import { normalizePolicyNumber } from '../normalize.js';
import { parseFlexibleDate } from '../importMap.js';
import { bps, cents, isoDate, UNASSIGNED_BROKER_ID } from '../schemas.js';
import { resolveTerm, type PolicyTerm } from '../terms.js';

/**
 * Broker advance-payment records: commission ACTUALLY PAID to a broker upfront for a policy term.
 *
 * An advance is never assumed from the existence of a policy: a broker-owned policy with no advance
 * record for its current term is flagged "missing", never treated as paid. Records are append-only:
 * a correction voids the old record and creates a linked replacement, both with a mandatory note.
 *
 * Term identifier = the term's effective date (the same ID as policies/{id}/terms/{effectiveDate}).
 * Money is integer cents; expected advance = commission basis × broker share, half-even.
 */

export const ADVANCE_PAYMENT_TYPES = ['new_business', 'renewal'] as const;
export type AdvancePaymentType = (typeof ADVANCE_PAYMENT_TYPES)[number];

export const brokerAdvanceInput = z.object({
  policyId: z.string().min(1, 'Policy is required'),
  brokerId: z.string().min(1, 'Broker is required').refine((b) => b !== UNASSIGNED_BROKER_ID, 'Choose the broker who was paid'),
  termEffectiveDate: isoDate,
  termExpirationDate: isoDate,
  /** Full-term agency commission the advance was calculated on, when known. */
  commissionBasisCents: cents.nullable().default(null),
  brokerShareBps: bps.nullable().default(null),
  amountPaidCents: cents.refine((c) => c !== 0, 'Amount paid cannot be zero'),
  paymentDate: isoDate.nullable().default(null),
  paymentReference: z.string().trim().max(80).default(''),
  paymentType: z.enum(ADVANCE_PAYMENT_TYPES).nullable().default(null),
}).refine((a) => a.termExpirationDate > a.termEffectiveDate, { path: ['termExpirationDate'], message: 'Term expiration must be after the term effective date' });
export type BrokerAdvanceInput = z.infer<typeof brokerAdvanceInput>;

export interface BrokerAdvance extends BrokerAdvanceInput {
  id: string;
  clientId: string;
  termId: string;
  status: 'active' | 'voided';
  source: { kind: 'manual' | 'import'; importId?: string; fileName?: string; rowNo?: number };
  note: string;
  replacesId?: string | null;
  replacedById?: string | null;
  voidReason?: string | null;
}

export const advanceTermId = (a: Pick<BrokerAdvanceInput, 'termEffectiveDate'>) => a.termEffectiveDate;

// ---------------------------------------------------------------- review

export type AdvanceFlagCode =
  | 'no_current_term' | 'missing_advance' | 'broker_mismatch' | 'share_mismatch' | 'basis_missing' | 'basis_inconsistent'
  | 'amount_mismatch' | 'term_dates_mismatch' | 'advance_on_unassigned_policy' | 'share_missing'
  | 'rounding_difference' | 'multiple_advances' | 'negative_amount' | 'corrected';

export const ADVANCE_FLAG_TEXT: Record<AdvanceFlagCode, string> = {
  no_current_term: 'Current term not known (no term covering the date and no policy dates)',
  missing_advance: 'No advance payment recorded for the current term',
  broker_mismatch: 'An advance for this term was paid to a different broker than the policy’s broker',
  share_mismatch: 'Advance broker % differs from the policy’s applicable broker share',
  basis_missing: 'Advance has no full-term commission basis',
  basis_inconsistent: 'Advances for this term disagree on the commission basis',
  share_missing: 'Advance has no broker %',
  amount_mismatch: 'Amount paid differs from commission basis × broker share',
  term_dates_mismatch: 'Advance term dates differ from the policy’s term dates',
  advance_on_unassigned_policy: 'Advance recorded on a policy with no broker',
  rounding_difference: 'Amount paid differs from basis × share by one cent (rounding)',
  multiple_advances: 'Several advance records for this term (summed)',
  negative_amount: 'Includes a negative (correcting) payment',
  corrected: 'An earlier record for this term was voided and replaced',
};
/** Material flags block a final settlement until resolved. */
export const MATERIAL_ADVANCE_FLAGS: ReadonlySet<AdvanceFlagCode> = new Set<AdvanceFlagCode>([
  'no_current_term', 'missing_advance', 'broker_mismatch', 'share_mismatch', 'basis_missing', 'basis_inconsistent', 'share_missing',
  'amount_mismatch', 'term_dates_mismatch', 'advance_on_unassigned_policy',
]);

export interface ReviewPolicy {
  id: string; clientId: string; brokerId: string; brokerShareBps?: number | null; status: string;
  effectiveDate?: string | null; expirationDate?: string | null;
}

export interface AdvanceReview {
  policyId: string;
  term: { termId: string; effectiveDate: string; expirationDate: string; source: 'terms' | 'policy' } | null;
  applicableShareBps: BasisPoints;
  advances: BrokerAdvance[];
  paidCents: Cents;
  basisCents: Cents | null;
  expectedCents: Cents | null;
  flags: AdvanceFlagCode[];
  material: boolean;
}

/**
 * Review the advance records for a policy's current term as of a date (e.g. today, or the closing
 * date): which term applies, what was actually paid, and every inconsistency. Never infers a payment.
 */
export function reviewPolicyAdvances(input: {
  policy: ReviewPolicy; terms: PolicyTerm[]; advances: BrokerAdvance[]; brokerShareBps: (brokerId: string) => BasisPoints; asOf: string;
}): AdvanceReview {
  const { policy, asOf } = input;
  const flags = new Set<AdvanceFlagCode>();
  const share = policy.brokerId === UNASSIGNED_BROKER_ID ? 0 : typeof policy.brokerShareBps === 'number' ? policy.brokerShareBps : input.brokerShareBps(policy.brokerId);

  let term: AdvanceReview['term'] = null;
  const fromTerms = resolveTerm(asOf, input.terms).term;
  if (fromTerms) term = { termId: fromTerms.id, effectiveDate: fromTerms.effectiveDate, expirationDate: fromTerms.scheduledExpirationDate, source: 'terms' };
  else if (policy.effectiveDate && policy.expirationDate && policy.effectiveDate <= asOf && asOf < policy.expirationDate) {
    term = { termId: policy.effectiveDate, effectiveDate: policy.effectiveDate, expirationDate: policy.expirationDate, source: 'policy' };
  }

  const all = input.advances.filter((a) => a.policyId === policy.id);
  const active = all.filter((a) => a.status === 'active');
  if (policy.brokerId === UNASSIGNED_BROKER_ID) {
    if (active.length) flags.add('advance_on_unassigned_policy');
    return { policyId: policy.id, term, applicableShareBps: 0, advances: active, paidCents: active.reduce((s, a) => s + a.amountPaidCents, 0), basisCents: null, expectedCents: null, flags: [...flags], material: [...flags].some((f) => MATERIAL_ADVANCE_FLAGS.has(f)) };
  }
  if (!term) flags.add('no_current_term');

  const forTerm = term ? active.filter((a) => a.termEffectiveDate === term!.effectiveDate) : [];
  if (term && !forTerm.length) flags.add('missing_advance');
  if (forTerm.length > 1) flags.add('multiple_advances');
  if (term && all.some((a) => a.status === 'voided' && a.termEffectiveDate === term!.effectiveDate)) flags.add('corrected');
  for (const a of forTerm) {
    if (a.brokerId !== policy.brokerId) flags.add('broker_mismatch');
    if (a.amountPaidCents < 0) flags.add('negative_amount');
    if (a.termExpirationDate !== term!.expirationDate) flags.add('term_dates_mismatch');
    if (a.commissionBasisCents === null) flags.add('basis_missing');
    if (a.brokerShareBps === null) flags.add('share_missing');
    else if (a.brokerShareBps !== share) flags.add('share_mismatch');
  }
  const bases = [...new Set(forTerm.map((a) => a.commissionBasisCents).filter((b): b is number => b !== null))];
  if (bases.length > 1) flags.add('basis_inconsistent');
  const paid = forTerm.reduce((s, a) => s + a.amountPaidCents, 0);
  const basis = bases.length === 1 ? bases[0] : null;
  const expected = basis !== null ? applyBasisPoints(basis, share) : null;
  if (expected !== null && forTerm.length) {
    const d = Math.abs(paid - expected);
    if (d === 1) flags.add('rounding_difference');
    else if (d > 1) flags.add('amount_mismatch');
  }
  const list = [...flags];
  return { policyId: policy.id, term, applicableShareBps: share, advances: forTerm, paidCents: paid, basisCents: basis, expectedCents: expected, flags: list, material: list.some((f) => MATERIAL_ADVANCE_FLAGS.has(f)) };
}

// ---------------------------------------------------------------- import

export const MAX_ADVANCE_IMPORT_ROWS = 2000;

const HEADER_ALIASES: Record<string, string[]> = {
  broker: ['broker', 'broker code', 'broker name', 'producer', 'producer code'],
  policyNumber: ['policy number', 'policy #', 'policy no', 'policy', 'policy num'],
  carrier: ['carrier', 'company', 'insurance company', 'carrier code'],
  termEffectiveDate: ['term effective', 'effective date', 'effective', 'eff date', 'term start'],
  termExpirationDate: ['term expiration', 'expiration date', 'expiration', 'exp date', 'term end'],
  commissionBasis: ['commission basis', 'full term commission', 'term commission', 'agency commission', 'commission'],
  brokerShare: ['broker %', 'broker percent', 'broker percentage', 'broker share', 'split %', 'split'],
  amountPaid: ['amount paid', 'paid', 'advance', 'advance amount', 'amount', 'paid to broker'],
  paymentDate: ['payment date', 'paid date', 'date paid', 'check date'],
  paymentReference: ['payment reference', 'reference', 'check number', 'check #', 'check no', 'ref'],
  paymentType: ['payment type', 'type', 'business type', 'new/renewal'],
  note: ['note', 'notes', 'memo', 'comment'],
};
export const ADVANCE_TEMPLATE_HEADERS = ['Broker code', 'Policy number', 'Carrier', 'Term effective', 'Term expiration', 'Commission basis', 'Broker %', 'Amount paid', 'Payment date', 'Payment reference', 'Payment type', 'Notes'];

const canon = (h: string) => h.trim().toLowerCase().replace(/[_\s]+/g, ' ').replace(/\s*#\s*/, ' #').trim();
export function mapAdvanceHeaders(headers: string[]): { map: Partial<Record<keyof typeof HEADER_ALIASES, number>>; missing: string[] } {
  const map: Partial<Record<string, number>> = {};
  headers.forEach((h, i) => {
    const c = canon(h);
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) if (map[field] === undefined && aliases.includes(c)) { map[field] = i; break; }
  });
  const missing = ['broker', 'policyNumber', 'termEffectiveDate', 'termExpirationDate', 'amountPaid'].filter((f) => map[f] === undefined);
  return { map, missing };
}

export interface ImportLookups {
  brokers: { id: string; name: string; code?: string }[];
  carriers: { id: string; name: string; code?: string }[];
  policies: { id: string; clientId: string; carrierId: string; wholesalerId?: string | null; policyNumber: string; alternateNumbers?: string[] }[];
  existing: Pick<BrokerAdvance, 'policyId' | 'termEffectiveDate' | 'amountPaidCents' | 'paymentDate' | 'paymentReference' | 'status'>[];
}
export interface ParsedAdvanceRow {
  rowNo: number;
  ok: boolean;
  errors: string[];
  warnings: string[];
  advance: (BrokerAdvanceInput & { clientId: string; note: string }) | null;
}

function paymentTypeOf(v: string): AdvancePaymentType | null | 'invalid' {
  const s = v.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  if (!s) return null;
  if (['new', 'new business', 'nb', 'new bus'].includes(s)) return 'new_business';
  if (['renewal', 'renew', 'ren', 'rn', 'rnwl'].includes(s)) return 'renewal';
  return 'invalid';
}

/** Validate and resolve each row of an advance-payment file. Nothing is created here. */
export function parseAdvanceRows(headers: string[], rows: string[][], lk: ImportLookups): { rows: ParsedAdvanceRow[]; missingColumns: string[] } {
  const { map, missing } = mapAdvanceHeaders(headers);
  if (missing.length) return { rows: [], missingColumns: missing };
  const cell = (r: string[], f: keyof typeof HEADER_ALIASES) => (map[f] === undefined ? '' : String(r[map[f]!] ?? '').trim());
  const byKey = new Map<string, ImportLookups['policies']>();
  for (const p of lk.policies) for (const n of [p.policyNumber, ...(p.alternateNumbers ?? [])]) {
    const k = normalizePolicyNumber(n); if (!k) continue;
    byKey.set(k, [...(byKey.get(k) ?? []), p]);
  }
  const findBy = <T extends { id: string; name: string; code?: string }>(v: string, list: T[]) => {
    const s = v.trim().toLowerCase();
    return list.filter((x) => (x.code ?? '').toLowerCase() === s || x.name.trim().toLowerCase() === s || x.id.toLowerCase() === s);
  };
  const seen = new Set<string>();
  const out: ParsedAdvanceRow[] = [];
  rows.slice(0, MAX_ADVANCE_IMPORT_ROWS).forEach((r, i) => {
    const rowNo = i + 2; // header is row 1
    if (r.every((c) => !String(c ?? '').trim())) return;
    const errors: string[] = [], warnings: string[] = [];
    const brokers = findBy(cell(r, 'broker'), lk.brokers.filter((b) => b.id !== UNASSIGNED_BROKER_ID));
    if (brokers.length !== 1) errors.push(brokers.length ? `Broker "${cell(r, 'broker')}" matches several brokers.` : `Broker "${cell(r, 'broker')}" not found.`);
    let candidates = byKey.get(normalizePolicyNumber(cell(r, 'policyNumber'))) ?? [];
    const carrierText = cell(r, 'carrier');
    if (carrierText) {
      const cs = findBy(carrierText, lk.carriers).map((c) => c.id);
      if (!cs.length) errors.push(`Carrier "${carrierText}" not found.`);
      candidates = candidates.filter((p) => cs.includes(p.carrierId) || (p.wholesalerId && cs.includes(p.wholesalerId)));
    }
    if (!candidates.length) errors.push(`Policy "${cell(r, 'policyNumber')}" not found${carrierText ? ` at ${carrierText}` : ''}.`);
    else if (candidates.length > 1) errors.push(`Policy number "${cell(r, 'policyNumber')}" exists at several carriers; add the carrier.`);
    const date = (f: keyof typeof HEADER_ALIASES, label: string, required: boolean) => {
      const v = parseFlexibleDate(cell(r, f));
      if (v === null) { if (required) errors.push(`${label} is required.`); return null; }
      if (typeof v === 'object') { errors.push(`${label}: ${v.error}.`); return null; }
      return v;
    };
    const eff = date('termEffectiveDate', 'Term effective date', true);
    const exp = date('termExpirationDate', 'Term expiration date', true);
    const paidOn = date('paymentDate', 'Payment date', false);
    if (!paidOn && !errors.some((e) => e.startsWith('Payment date'))) warnings.push('No payment date.');
    const money = (f: keyof typeof HEADER_ALIASES, label: string, required: boolean): Cents | null => {
      const v = cell(r, f);
      if (!v) { if (required) errors.push(`${label} is required.`); return null; }
      try { return parseMoneyToCents(v); } catch { errors.push(`${label}: "${v}" is not an amount.`); return null; }
    };
    const paid = money('amountPaid', 'Amount paid', true);
    if (paid === 0) errors.push('Amount paid cannot be zero.');
    const basis = money('commissionBasis', 'Commission basis', false);
    if (basis === null) warnings.push('No commission basis: the advance will be flagged for review.');
    let share: BasisPoints | null = null;
    if (cell(r, 'brokerShare')) {
      try {
        const raw = cell(r, 'brokerShare');
        // "0.5" with no % sign is read as a fraction (50 %); "50" or "50%" as a percentage.
        share = /^0?\.\d+$/.test(raw) ? Math.round(Number(raw) * 10000) : parsePercentToBps(raw);
        if (share < 0 || share > 10000) { errors.push(`Broker % "${raw}" is out of range.`); share = null; }
      } catch { errors.push(`Broker % "${cell(r, 'brokerShare')}" is not a percentage.`); }
    } else warnings.push('No broker %: the advance will be flagged for review.');
    const type = paymentTypeOf(cell(r, 'paymentType'));
    if (type === 'invalid') errors.push(`Payment type "${cell(r, 'paymentType')}" must be new business or renewal.`);
    else if (type === null) warnings.push('No payment type.');
    if (eff && exp && exp <= eff) errors.push('Term expiration must be after the term effective date.');

    const policy = candidates.length === 1 ? candidates[0] : null;
    const reference = cell(r, 'paymentReference').slice(0, 80);
    if (policy && eff && paid !== null) {
      const key = [policy.id, eff, paid, paidOn ?? '', reference].join('|');
      if (seen.has(key)) errors.push('Duplicate of an earlier row in this file.');
      seen.add(key);
      if (lk.existing.some((x) => x.status === 'active' && x.policyId === policy.id && x.termEffectiveDate === eff && x.amountPaidCents === paid && (x.paymentDate ?? '') === (paidOn ?? '') && x.paymentReference === reference)) {
        errors.push('Already recorded (same policy, term, amount, date and reference).');
      }
    }
    const ok = errors.length === 0;
    out.push({
      rowNo, ok, errors, warnings,
      advance: ok ? {
        policyId: policy!.id, clientId: policy!.clientId, brokerId: brokers[0].id, termEffectiveDate: eff!, termExpirationDate: exp!,
        commissionBasisCents: basis, brokerShareBps: share, amountPaidCents: paid!, paymentDate: paidOn, paymentReference: reference,
        paymentType: type === 'invalid' ? null : type, note: cell(r, 'note').slice(0, 500),
      } : null,
    });
  });
  return { rows: out, missingColumns: [] };
}
