import { totalInWindow } from '../aggregate.js';
import type { Cents } from '../money.js';
import { windowMonths, type Month } from '../period.js';
import {
  auditLedger, centsToDecimal, csvCell, groupPostings, inRange, ledgerTotals, windowRange, type ReportEntry,
} from './ledger.js';

/**
 * Due-diligence exports for a buyer (Pioneer Bank): a commission summary and a client/policy list.
 *
 * Source: posted ledger entries (the same entries and rules as the Dashboard and the Ledger report)
 * and the client, policy and carrier records. NO broker information of any kind is read into or
 * written by these exports: no broker names or IDs, shares, broker/agency splits, staff emails or notes.
 *
 * Completeness is computed, never assumed. The summary is stamped:
 *   CHECKS_FAILED — a reconciliation check failed: do not send
 *   INCOMPLETE    — some month of the period has no posted statement, or a statement for the period is
 *                   uploaded but not posted: the totals are NOT a complete history
 *   REVIEW        — every month has posted statements, but a carrier with active policies has months
 *                   with nothing posted: confirm those are genuinely zero
 *   READY         — every month and every statement-paying carrier with active policies has postings,
 *                   and every check passed (still "prepared from the posted ledger, subject to review")
 */

export type DiligenceCategory = 'commission' | 'unmatched' | 'adjustment' | 'retained' | 'manual';
export const DILIGENCE_CATEGORIES: DiligenceCategory[] = ['commission', 'unmatched', 'adjustment', 'retained', 'manual'];
export const DILIGENCE_CATEGORY_LABELS: Record<DiligenceCategory, string> = {
  commission: 'Commission (matched to policies)',
  unmatched: 'Commission not matched to a policy',
  adjustment: 'Statement adjustments (carrier-level)',
  retained: 'Retained commission (kept out of premium)',
  manual: 'Manual entries',
};

export function diligenceCategory(e: Pick<ReportEntry, 'sourceType' | 'level'>): DiligenceCategory {
  if (e.sourceType === 'retained') return 'retained';
  if (e.sourceType === 'manual') return 'manual';
  if (e.level === 'suspense') return 'unmatched';
  if (e.level === 'carrier') return 'adjustment';
  return 'commission';
}

export interface DiligenceCarrier { id: string; name: string; kind: 'carrier' | 'wholesaler'; commissionMethod?: 'statement' | 'retained'; status?: string }
export interface DiligencePolicy {
  id: string; clientId: string; carrierId: string; wholesalerId?: string | null; policyNumber: string; alternateNumbers?: string[];
  policyType?: string; line?: string; namedInsured?: string; effectiveDate?: string | null; expirationDate?: string | null;
  premiumCents?: number | null; commissionRateBps?: number | null; status?: string;
}
export interface DiligenceClient { id: string; name: string; externalId?: string; classification?: string; status?: string }
export interface DiligenceStatement { id: string; status: string; statementMonth?: string | null; payerId?: string | null }

export type CategoryTotals = Record<DiligenceCategory, Cents> & { total: Cents };
const zero = (): CategoryTotals => ({ commission: 0, unmatched: 0, adjustment: 0, retained: 0, manual: 0, total: 0 });
function addTo(t: CategoryTotals, e: ReportEntry) { t[diligenceCategory(e)] += e.amountCents; t.total += e.amountCents; }

export interface DiligenceCheck { name: string; pass: boolean; detail: string }
export type DiligenceStatus = 'CHECKS_FAILED' | 'INCOMPLETE' | 'REVIEW' | 'READY' | 'NO_PERIOD';

export interface DiligenceSummary {
  status: DiligenceStatus;
  statusLabel: string;
  statusText: string;
  notices: string[];
  from: Month; to: Month; months: Month[];
  total: CategoryTotals;
  byMonth: { month: Month; totals: CategoryTotals; statementPostings: number; retainedEntries: number; hasPostedStatement: boolean }[];
  byPayer: { id: string; name: string; kind: string; totals: CategoryTotals; monthsWithPostings: number; byMonth: Map<Month, Cents> }[];
  byCarrier: { id: string | null; name: string; total: Cents }[];
  missingMonths: Month[];
  unpostedStatements: { id: string; status: string; month: string }[];
  carrierGaps: { id: string; name: string; missingMonths: Month[] }[];
  checks: DiligenceCheck[];
  counts: { entries: number; postings: number; activePostings: number; reversedPostings: number };
  /** Window commission attributed to policies (ties to the client/policy export's t12 column). */
  policyAttributedCents: Cents;
}

const STATUS_LABEL: Record<DiligenceStatus, string> = {
  CHECKS_FAILED: 'NOT FOR DISTRIBUTION — reconciliation checks failed',
  INCOMPLETE: 'PRELIMINARY — INCOMPLETE',
  REVIEW: 'PRELIMINARY — REVIEW CARRIER GAPS',
  READY: 'Prepared from the posted ledger — subject to review',
  NO_PERIOD: 'NOT FOR DISTRIBUTION — no reporting period set',
};

/** Defensive string for records that may lack a field (older or hand-edited documents). */
const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

const fmtMonth = (m: Month) => {
  const [y, mm] = m.split('-').map(Number);
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][mm - 1]} ${y}`;
};

export function buildDiligenceSummary(input: {
  entries: ReportEntry[];
  start: Month | null | undefined;
  months?: number;
  carriers: DiligenceCarrier[];
  policies: DiligencePolicy[];
  statements?: DiligenceStatement[] | null;
}): DiligenceSummary {
  const monthsCount = input.months ?? 12;
  if (!input.start) {
    const empty = zero();
    return {
      status: 'NO_PERIOD', statusLabel: STATUS_LABEL.NO_PERIOD, statusText: 'Set the snapshot window in Settings first.', notices: [],
      from: '', to: '', months: [], total: empty, byMonth: [], byPayer: [], byCarrier: [], missingMonths: [], unpostedStatements: [], carrierGaps: [],
      checks: [], counts: { entries: 0, postings: 0, activePostings: 0, reversedPostings: 0 }, policyAttributedCents: 0,
    };
  }
  const range = windowRange(input.start, monthsCount);
  const months = windowMonths(input.start, monthsCount);
  const entries = input.entries.filter((e) => (e.postingStatus === 'posted' || e.postingStatus === 'reversed') && inRange(e, range));
  const carrierById = new Map(input.carriers.map((c) => [c.id, c]));
  const policyById = new Map(input.policies.map((p) => [p.id, p]));
  const postings = groupPostings(entries);

  const total = zero();
  const monthTotals = new Map(months.map((m) => [m, zero()]));
  const payerTotals = new Map<string, { totals: CategoryTotals; byMonth: Map<Month, Cents> }>();
  const carrierTotals = new Map<string | null, Cents>();
  let policyAttributedCents = 0;
  for (const e of entries) {
    addTo(total, e);
    addTo(monthTotals.get(e.statementPeriod)!, e);
    const p = payerTotals.get(e.payerId ?? '') ?? { totals: zero(), byMonth: new Map() };
    addTo(p.totals, e);
    p.byMonth.set(e.statementPeriod, (p.byMonth.get(e.statementPeriod) ?? 0) + e.amountCents);
    payerTotals.set(e.payerId ?? '', p);
    const cid = e.carrierId ?? (e.policyId ? policyById.get(e.policyId)?.carrierId ?? null : null);
    carrierTotals.set(cid, (carrierTotals.get(cid) ?? 0) + e.amountCents);
    if (e.policyId) policyAttributedCents += e.amountCents;
  }

  // Coverage: a month counts only if a statement posting for it is still active (not reversed).
  const activeStatementPostings = postings.filter((g) => g.state === 'active' && g.sourceType === 'statement');
  const byMonth = months.map((m) => {
    const sp = activeStatementPostings.filter((g) => g.periods.includes(m)).length;
    const rt = entries.filter((e) => e.statementPeriod === m && e.sourceType === 'retained' && !e.reversalOf && e.postingStatus === 'posted').length;
    return { month: m, totals: monthTotals.get(m)!, statementPostings: sp, retainedEntries: rt, hasPostedStatement: sp > 0 };
  });
  const missingMonths = byMonth.filter((m) => !m.hasPostedStatement).map((m) => m.month);
  const unpostedStatements = (input.statements ?? [])
    .filter((s) => s.statementMonth && s.statementMonth >= range.from && s.statementMonth <= range.to && !['posted', 'discarded'].includes(s.status))
    .map((s) => ({ id: s.id, status: s.status, month: s.statementMonth! }));

  // Carrier gaps: statement-paying payers that have active policies (directly or as wholesaler), by month without an active posting.
  const activePolicyPayers = new Set<string>();
  for (const p of input.policies) if ((p.status ?? 'active') === 'active') activePolicyPayers.add(p.wholesalerId || p.carrierId);
  const carrierGaps = [...activePolicyPayers]
    .map((id) => carrierById.get(id))
    .filter((c): c is DiligenceCarrier => !!c && (c.commissionMethod ?? 'statement') === 'statement' && (c.status ?? 'active') === 'active')
    .map((c) => ({ id: c.id, name: c.name, missingMonths: months.filter((m) => !activeStatementPostings.some((g) => g.payerIds.includes(c.id) && g.periods.includes(m))) }))
    .filter((g) => g.missingMonths.length > 0)
    .sort((a, b) => str(a.name).localeCompare(str(b.name)));

  const byPayer = [...payerTotals].map(([id, v]) => {
    const c = carrierById.get(id);
    return { id, name: str(c?.name) || id || 'Unknown payer', kind: c?.kind ?? 'unknown', totals: v.totals, monthsWithPostings: months.filter((m) => activeStatementPostings.some((g) => g.payerIds.includes(id) && g.periods.includes(m))).length, byMonth: v.byMonth };
  }).sort((a, b) => b.totals.total - a.totals.total || str(a.name).localeCompare(str(b.name)));
  const byCarrier = [...carrierTotals].map(([id, cents]) => ({ id, name: id ? str(carrierById.get(id)?.name) || id : 'Not attributed to a carrier (adjustments, unmatched)', total: cents }))
    .sort((a, b) => b.total - a.total || str(a.name).localeCompare(str(b.name)));

  // Reconciliation checks (every one must pass before the summary may be distributed).
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const audit = auditLedger({ entries, window: range });
  const orphanPolicyEntries = entries.filter((e) => e.policyId && !policyById.has(e.policyId));
  const checks: DiligenceCheck[] = [
    { name: 'All amounts are whole cents', pass: entries.every((e) => Number.isSafeInteger(e.amountCents)), detail: `${entries.length} ledger entries in the period` },
    { name: 'Monthly totals add up to the period total', pass: sum(byMonth.map((m) => m.totals.total)) === total.total, detail: `${centsToDecimal(sum(byMonth.map((m) => m.totals.total)))} vs ${centsToDecimal(total.total)}` },
    { name: 'Carrier totals add up to the period total', pass: sum(byPayer.map((p) => p.totals.total)) === total.total, detail: `${byPayer.length} paying carriers / wholesalers` },
    { name: 'Carrier × month grid adds up to the period total', pass: sum(byPayer.flatMap((p) => [...p.byMonth.values()])) === total.total, detail: `${byPayer.length} × ${months.length}` },
    { name: 'Categories add up to the period total', pass: sum(DILIGENCE_CATEGORIES.map((c) => total[c])) === total.total, detail: DILIGENCE_CATEGORIES.map((c) => `${c} ${centsToDecimal(total[c])}`).join('; ') },
    { name: 'Period total equals the Dashboard trailing-12-month commission', pass: totalInWindow(entries, input.start, monthsCount) === total.total && ledgerTotals(entries).grossCents === total.total, detail: `Dashboard calculation ${centsToDecimal(totalInWindow(entries, input.start, monthsCount))}` },
    { name: 'Ledger balanced: every reversal exactly offsets its original; no partial reversals', pass: audit.errors === 0, detail: audit.errors === 0 ? `${audit.counts.reversedPostings} reversed postings net to $0.00` : audit.findings.filter((f) => f.severity === 'error').slice(0, 3).map((f) => f.message).join(' ') },
    { name: 'Every policy-level commission belongs to a policy in the client/policy export', pass: orphanPolicyEntries.length === 0, detail: orphanPolicyEntries.length ? `${orphanPolicyEntries.length} entries refer to missing policies` : `${centsToDecimal(policyAttributedCents)} attributed to policies` },
  ];

  const notices: string[] = [];
  if (missingMonths.length) notices.push(`No posted commission statements for ${missingMonths.length} of ${months.length} months: ${missingMonths.map(fmtMonth).join(', ')}.`);
  if (unpostedStatements.length) notices.push(`${unpostedStatements.length} statement(s) for this period are uploaded but not posted, so their commission is not included.`);
  if (carrierGaps.length) notices.push(`${carrierGaps.length} statement-paying carrier(s) with active policies have months with nothing posted: ${carrierGaps.slice(0, 8).map((g) => `${g.name} (${g.missingMonths.length})`).join(', ')}${carrierGaps.length > 8 ? ', …' : ''}.`);
  const retainedCarriers = input.carriers.filter((c) => c.commissionMethod === 'retained' && (c.status ?? 'active') === 'active');
  if (retainedCarriers.length && total.retained === 0) notices.push(`No retained commission is recorded for retained-commission carriers (${retainedCarriers.map((c) => c.name).join(', ')}).`);

  const status: DiligenceStatus = checks.some((c) => !c.pass) ? 'CHECKS_FAILED'
    : missingMonths.length || unpostedStatements.length ? 'INCOMPLETE'
      : carrierGaps.length ? 'REVIEW' : 'READY';
  const statusText = {
    CHECKS_FAILED: 'A reconciliation check failed. Do not send this summary; review the checks below.',
    INCOMPLETE: `These totals are NOT a complete ${months.length}-month commission history. ${notices.slice(0, 2).join(' ')}`,
    REVIEW: 'Every month has posted statements, but some carriers with active policies have months with nothing posted. Confirm those are genuinely zero before presenting the totals as complete.',
    READY: 'Every month and every statement-paying carrier with active policies has posted statements, and every reconciliation check passed.',
    NO_PERIOD: '',
  }[status];

  return {
    status, statusLabel: STATUS_LABEL[status], statusText, notices, from: range.from, to: range.to, months, total, byMonth, byPayer, byCarrier,
    missingMonths, unpostedStatements, carrierGaps, checks,
    counts: { entries: entries.length, postings: postings.length, activePostings: postings.filter((g) => g.state === 'active').length, reversedPostings: postings.filter((g) => g.state === 'reversed').length },
    policyAttributedCents,
  };
}

// ---------------------------------------------------------------- CSV

const row = (cells: (string | number | null | undefined)[], kinds: ('text' | 'number')[] = []) => cells.map((c, i) => csvCell(c, kinds[i] ?? (typeof c === 'number' ? 'number' : 'text'))).join(',');
const money = (c: Cents) => centsToDecimal(c);

/** The commission summary as one Excel-ready CSV with labelled sections. Contains no broker information. */
export function diligenceSummaryCsv(s: DiligenceSummary, meta: { agencyName: string; preparedAtIso: string }): string {
  const L: string[] = [];
  const cats = DILIGENCE_CATEGORIES;
  const catHead = cats.map((c) => DILIGENCE_CATEGORY_LABELS[c]);
  const catVals = (t: CategoryTotals) => [...cats.map((c) => money(t[c])), money(t.total)];
  const N = (n: number) => Array(n).fill('number') as ('number')[];

  L.push(row([`${meta.agencyName} — Commission summary for due diligence`]));
  L.push(row(['Status', s.statusLabel]));
  L.push(row(['Status detail', s.statusText]));
  for (const n of s.notices) L.push(row(['Notice', n]));
  L.push(row(['Period (statement months)', `${s.from} to ${s.to}`]));
  L.push(row(['Prepared', meta.preparedAtIso]));
  L.push(row(['Basis', 'Posted ledger entries. Revenue month = statement period. Amounts are commission received by the agency, net of chargebacks and reversals.']));
  L.push(row(['Excluded', 'Internal compensation and allocation information is not included.']));
  L.push('');
  L.push(row(['Reconciliation checks']));
  L.push(row(['Check', 'Result', 'Detail']));
  for (const c of s.checks) L.push(row([c.name, c.pass ? 'PASS' : 'FAIL', c.detail]));
  L.push('');
  L.push(row(['Commission by category, period total']));
  L.push(row(['Category', 'Amount']));
  for (const c of cats) L.push(row([DILIGENCE_CATEGORY_LABELS[c], money(s.total[c])], ['text', 'number']));
  L.push(row(['Total', money(s.total.total)], ['text', 'number']));
  L.push('');
  L.push(row(['Monthly commission']));
  L.push(row(['Statement month', ...catHead, 'Total', 'Statement postings', 'Posted statements for month']));
  for (const m of s.byMonth) L.push(row([m.month, ...catVals(m.totals), m.statementPostings, m.hasPostedStatement ? 'Yes' : 'NO — missing'], ['text', ...N(cats.length + 2), 'text']));
  L.push(row(['Total', ...catVals(s.total), '', ''], ['text', ...N(cats.length + 1), 'text', 'text']));
  L.push('');
  L.push(row(['Commission by paying carrier or wholesaler']));
  L.push(row(['Paid by', 'Type', ...catHead, 'Total', `Months with posted statements (of ${s.months.length})`]));
  for (const p of s.byPayer) L.push(row([p.name, p.kind, ...catVals(p.totals), p.monthsWithPostings], ['text', 'text', ...N(cats.length + 2)]));
  L.push(row(['Total', '', ...catVals(s.total), ''], ['text', 'text', ...N(cats.length + 1), 'text']));
  L.push('');
  L.push(row(['Carrier by month (total commission; blank = nothing posted)']));
  L.push(row(['Paid by', ...s.months, 'Total']));
  for (const p of s.byPayer) L.push(row([p.name, ...s.months.map((m) => (p.byMonth.has(m) ? money(p.byMonth.get(m)!) : '')), money(p.totals.total)], ['text', ...N(s.months.length + 1)]));
  L.push(row(['Total', ...s.byMonth.map((m) => money(m.totals.total)), money(s.total.total)], ['text', ...N(s.months.length + 1)]));
  L.push('');
  L.push(row(['Commission by insurance carrier (underlying company, where known)']));
  L.push(row(['Insurance carrier', 'Total']));
  for (const c of s.byCarrier) L.push(row([c.name, money(c.total)], ['text', 'number']));
  L.push(row(['Total', money(s.total.total)], ['text', 'number']));
  if (s.carrierGaps.length) {
    L.push('');
    L.push(row(['Carriers with active policies and months with nothing posted']));
    L.push(row(['Carrier', 'Months with nothing posted']));
    for (const g of s.carrierGaps) L.push(row([g.name, g.missingMonths.join(' ')]));
  }
  return `﻿${L.join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------- client / policy export

export const CLIENT_POLICY_HEADERS = [
  'client_id', 'client_external_id', 'insured', 'client_type', 'client_status',
  'policy_id', 'named_insured', 'carrier', 'wholesaler', 'line', 'policy_type', 'policy_number', 'alternate_policy_numbers',
  'effective_date', 'expiration_date', 'policy_status', 'annual_premium', 'agency_commission_rate_pct',
  't12_commission', 't12_commission_entries',
] as const;

export interface ClientPolicyExport {
  csv: string;
  rows: number;
  policyRows: number;
  clientsWithoutPolicies: number;
  orphanPolicies: number;
  t12PolicyCents: Cents;
  checks: DiligenceCheck[];
}

/**
 * One row per policy (with its client), plus one row per client without policies. No broker fields,
 * no contact details (phone, email, street address), no notes, no staff or audit fields.
 * t12_commission = this policy's posted commission in the period (ties to the summary).
 */
export function clientPolicyExport(input: {
  clients: DiligenceClient[]; policies: DiligencePolicy[]; carriers: DiligenceCarrier[];
  entries: ReportEntry[]; start: Month | null | undefined; months?: number; policyAttributedCents?: Cents;
}): ClientPolicyExport {
  const carrierName = new Map(input.carriers.map((c) => [c.id, str(c.name) || c.id]));
  const clientById = new Map(input.clients.map((c) => [c.id, c]));
  const range = input.start ? windowRange(input.start, input.months ?? 12) : null;
  const t12 = new Map<string, { cents: Cents; n: number }>();
  if (range) {
    for (const e of input.entries) {
      if (!e.policyId || !(e.postingStatus === 'posted' || e.postingStatus === 'reversed') || !inRange(e, range)) continue;
      const cur = t12.get(e.policyId) ?? { cents: 0, n: 0 };
      cur.cents += e.amountCents; cur.n += 1;
      t12.set(e.policyId, cur);
    }
  }
  const pct = (bps: number | null | undefined) => (typeof bps === 'number' ? (bps / 100).toFixed(2) : '');
  const lines = [row([...CLIENT_POLICY_HEADERS])];
  const policies = [...input.policies].sort((a, b) =>
    str(clientById.get(a.clientId)?.name).localeCompare(str(clientById.get(b.clientId)?.name)) || str(a.policyNumber).localeCompare(str(b.policyNumber)));
  let orphan = 0;
  let t12PolicyCents = 0;
  const withPolicy = new Set<string>();
  for (const p of policies) {
    const c = clientById.get(p.clientId);
    if (!c) orphan++;
    withPolicy.add(p.clientId);
    const t = t12.get(p.id);
    t12PolicyCents += t?.cents ?? 0;
    lines.push(row([
      p.clientId, c?.externalId ?? '', c ? str(c.name) : '(client record missing)', c?.classification ?? '', c?.status ?? '',
      p.id, p.namedInsured ?? '', carrierName.get(p.carrierId) ?? p.carrierId, p.wholesalerId ? carrierName.get(p.wholesalerId) ?? p.wholesalerId : '',
      p.line ?? '', p.policyType ?? '', str(p.policyNumber), (Array.isArray(p.alternateNumbers) ? p.alternateNumbers : []).join('; '),
      p.effectiveDate ?? '', p.expirationDate ?? '', p.status ?? '',
      typeof p.premiumCents === 'number' ? centsToDecimal(p.premiumCents) : '', pct(p.commissionRateBps),
      range ? centsToDecimal(t?.cents ?? 0) : '', t?.n ?? 0,
    ], [...Array(16).fill('text'), 'number', 'number', 'number', 'number'] as ('text' | 'number')[]));
  }
  const noPolicy = [...input.clients].filter((c) => !withPolicy.has(c.id)).sort((a, b) => str(a.name).localeCompare(str(b.name)));
  for (const c of noPolicy) {
    lines.push(row([c.id, c.externalId ?? '', str(c.name), c.classification ?? '', c.status ?? '', ...Array(15).fill('')]));
  }
  const unexportedT12 = [...t12.keys()].filter((id) => !input.policies.some((p) => p.id === id));
  const checks: DiligenceCheck[] = [
    { name: 'Every policy record is exported', pass: policies.length === input.policies.length, detail: `${policies.length} policies` },
    { name: 'Every client record is exported', pass: [...withPolicy].filter((id) => clientById.has(id)).length + noPolicy.length === input.clients.length, detail: `${input.clients.length} clients (${noPolicy.length} without policies)` },
    { name: 'Every policy belongs to an existing client', pass: orphan === 0, detail: orphan ? `${orphan} policies without a client record` : 'yes' },
    { name: 'Policy t12_commission column ties to the summary', pass: unexportedT12.length === 0 && (input.policyAttributedCents === undefined || input.policyAttributedCents === t12PolicyCents), detail: `${centsToDecimal(t12PolicyCents)}${input.policyAttributedCents === undefined ? '' : ` vs summary ${centsToDecimal(input.policyAttributedCents)}`}` },
  ];
  return { csv: `﻿${lines.join('\r\n')}\r\n`, rows: lines.length - 1, policyRows: policies.length, clientsWithoutPolicies: noPolicy.length, orphanPolicies: orphan, t12PolicyCents, checks };
}
