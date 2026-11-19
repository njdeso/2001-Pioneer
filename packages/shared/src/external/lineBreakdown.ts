import type { Cents } from '../money.js';
import { windowMonths, type Month } from '../period.js';
import { inRange, windowRange, type ReportEntry } from '../reports/ledger.js';

/**
 * Personal Lines vs Commercial Lines breakdown for external reviewers (Pioneer Bank, due-diligence company).
 *
 * Built only from allowlisted fields: policy line/status/client/carrier, statement classification (the
 * owner's Personal Lines / Commercial Lines marking), carrier names and posted ledger amounts. No broker data.
 *
 * Commission uses exactly the entries and rules of the commission summary (posted and reversed entries in the
 * snapshot window, so reversals net out), so every total here ties to the summary's posted total.
 * Nothing is estimated or allocated: commission is assigned to a line only through the policy it was
 * posted to. Carrier-level amounts (bonuses, profit sharing, adjustments, unmatched lines) are shown as
 * "not attributable to a line"; policies without a valid Personal/Commercial value are "unclassified".
 *
 * Always PRELIMINARY until the classification correction is reconciled (the owner sets nothing here: the
 * flag is fixed on, and the notice says so).
 */
export type LineBucket = 'personal' | 'commercial' | 'unclassified' | 'notAttributable';
export type LineCents = Record<LineBucket, Cents> & { total: Cents };
const zero = (): LineCents => ({ personal: 0, commercial: 0, unclassified: 0, notAttributable: 0, total: 0 });

export interface ReviewerLineBreakdown {
  preliminary: true;
  notice: string;
  from: Month; to: Month;
  /** Each client counted once, from its ACTIVE policies' lines (no double counting of mixed clients). */
  clients: { total: number; personal: number; commercial: number; mixed: number; unclassified: number; noActivePolicies: number };
  /** Active policies by line, and all policies (every status) by line. */
  activePolicies: { total: number; personal: number; commercial: number; unclassified: number };
  allPolicies: { total: number; personal: number; commercial: number; unclassified: number };
  /** Posted commission in the snapshot window, by the line of the policy it was posted to. */
  commission: LineCents;
  byMonth: { month: Month; cents: LineCents }[];
  byCarrier: { name: string; cents: LineCents }[];
  /** Carrier bonuses and profit sharing (carrier-level; part of notAttributable). */
  bonusProfitSharing: { bonusCents: Cents; profitSharingCents: Cents; byCarrier: { name: string; bonusCents: Cents; profitSharingCents: Cents }[] };
  /**
   * Independent view: posted statement commission by how the STATEMENT is marked (Personal Lines / Commercial
   * Lines statements from the carrier, as marked by the agency). Unmarked statements and non-statement
   * entries are shown as such. Not affected by policy classification.
   */
  byStatementMarking: { personal: Cents; commercial: Cents; other: Cents; unmarked: Cents; notFromStatement: Cents; total: Cents };
  /** Must equal the commission summary's posted total; checked in tests and shown to reviewers. */
  tiesToSummaryTotal: boolean;
}

type Doc = Record<string, unknown> & { id: string };
const s = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const lineOf = (v: unknown): 'personal' | 'commercial' | 'unclassified' => (v === 'personal' || v === 'commercial' ? v : 'unclassified');

export const LINE_BREAKDOWN_NOTICE =
  'PRELIMINARY — subject to classification reconciliation. The agency is reviewing and correcting Personal/Commercial ' +
  'classifications; some records may still be misclassified or awaiting manual review. These figures come directly from the ' +
  'records as they stand at the time shown and are not final. Commission is assigned to a line only through the policy it was ' +
  'posted to; nothing is estimated.';

export function reviewerLineBreakdown(input: {
  entries: ReportEntry[]; policies: Doc[]; clients: Doc[]; carriers: Doc[]; statements: Doc[];
  start: Month | null; months: number; summaryTotalCents: Cents | null;
}): ReviewerLineBreakdown | null {
  if (!input.start) return null;
  const months = windowMonths(input.start, input.months || 12);
  const range = windowRange(input.start, input.months || 12);
  const carrierName = new Map(input.carriers.map((c) => [c.id, s(c.name) || c.id]));
  const policyById = new Map(input.policies.map((p) => [p.id, p]));
  const stmtMark = new Map(input.statements.map((x) => [x.id, s(x.classification)]));

  // ---- clients and policies (counts only; no names)
  const activeLinesByClient = new Map<string, Set<string>>();
  const allPolicies = { total: 0, personal: 0, commercial: 0, unclassified: 0 };
  const activePolicies = { total: 0, personal: 0, commercial: 0, unclassified: 0 };
  for (const p of input.policies) {
    const line = lineOf(p.line);
    allPolicies.total++; allPolicies[line]++;
    if (s(p.status) === 'active') {
      activePolicies.total++; activePolicies[line]++;
      const set = activeLinesByClient.get(s(p.clientId)) ?? new Set<string>();
      set.add(line); activeLinesByClient.set(s(p.clientId), set);
    }
  }
  const clients = { total: input.clients.length, personal: 0, commercial: 0, mixed: 0, unclassified: 0, noActivePolicies: 0 };
  for (const c of input.clients) {
    const set = activeLinesByClient.get(c.id);
    if (!set || set.size === 0) clients.noActivePolicies++;
    else if (set.has('unclassified')) clients.unclassified++;
    else if (set.has('personal') && set.has('commercial')) clients.mixed++;
    else if (set.has('personal')) clients.personal++;
    else clients.commercial++;
  }

  // ---- commission (same entry filter as the commission summary)
  const entries = input.entries.filter((e) => (e.postingStatus === 'posted' || e.postingStatus === 'reversed') && inRange(e, range));
  const commission = zero();
  const byMonth = new Map(months.map((m) => [m, zero()]));
  const byCarrier = new Map<string, LineCents>();
  const bonus = new Map<string, { bonusCents: Cents; profitSharingCents: Cents }>();
  const marking = { personal: 0, commercial: 0, other: 0, unmarked: 0, notFromStatement: 0, total: 0 };
  for (const e of entries) {
    const pol = e.policyId ? policyById.get(e.policyId) : undefined;
    const bucket: LineBucket = !e.policyId ? 'notAttributable' : lineOf(pol?.line);
    const add = (t: LineCents) => { t[bucket] += e.amountCents; t.total += e.amountCents; };
    add(commission);
    const m = byMonth.get(e.statementPeriod);
    if (m) add(m);
    const cid = e.carrierId ?? (pol ? s(pol.carrierId) || null : null);
    const cname = cid ? carrierName.get(cid) ?? cid : 'Not attributed to a carrier (adjustments, unmatched)';
    const ct = byCarrier.get(cname) ?? zero(); add(ct); byCarrier.set(cname, ct);
    if (e.classification === 'bonus' || e.classification === 'profit_sharing') {
      const b = bonus.get(cname) ?? { bonusCents: 0, profitSharingCents: 0 };
      if (e.classification === 'bonus') b.bonusCents += e.amountCents; else b.profitSharingCents += e.amountCents;
      bonus.set(cname, b);
    }
    const mk = e.statementId ? stmtMark.get(e.statementId) ?? '' : null;
    const key = mk === null ? 'notFromStatement' : mk === 'personal' || mk === 'commercial' || mk === 'other' ? mk : 'unmarked';
    marking[key] += e.amountCents; marking.total += e.amountCents;
  }
  const bonusRows = [...bonus].map(([name, v]) => ({ name, ...v })).sort((a, b) => a.name.localeCompare(b.name));
  return {
    preliminary: true,
    notice: LINE_BREAKDOWN_NOTICE,
    from: months[0], to: months[months.length - 1],
    clients, activePolicies, allPolicies, commission,
    byMonth: months.map((month) => ({ month, cents: byMonth.get(month)! })),
    byCarrier: [...byCarrier].map(([name, cents]) => ({ name, cents })).sort((a, b) => b.cents.total - a.cents.total || a.name.localeCompare(b.name)),
    bonusProfitSharing: {
      bonusCents: bonusRows.reduce((t, r) => t + r.bonusCents, 0),
      profitSharingCents: bonusRows.reduce((t, r) => t + r.profitSharingCents, 0),
      byCarrier: bonusRows,
    },
    byStatementMarking: marking,
    tiesToSummaryTotal: input.summaryTotalCents === null ? false : commission.total === input.summaryTotalCents && marking.total === input.summaryTotalCents,
  };
}

/** Share of a total as a percentage string with one decimal ("—" when the total is zero). */
export function pct(part: number, total: number): string {
  return total ? `${((part / total) * 100).toFixed(1)}%` : '—';
}
