import type { Cents } from '../money.js';
import type { IsoDate, Month } from '../period.js';
import { inRange, windowRange, type ReportEntry } from '../reports/ledger.js';
import {
  buildDiligenceSummary, diligenceCategory, DILIGENCE_CATEGORY_LABELS,
  type DiligenceCarrier, type DiligencePolicy, type DiligenceStatement, type DiligenceSummary,
} from '../reports/diligence.js';
import { csvCell, centsToDecimal } from '../reports/ledger.js';
import { displayName } from '../displayName.js';
import { reviewerLineBreakdown, pct, type ReviewerLineBreakdown } from './lineBreakdown.js';

/**
 * Allowlisted, read-only representations of the acquisition records for external reviewers (Pioneer Bank
 * and the independent due-diligence company).
 *
 * Every function below BUILDS a new object field by field from an explicit allowlist. Nothing is spread or
 * copied from a stored document, so a field added to a record later (or present on it today: broker IDs,
 * broker shares and amounts, notes, contact details, audit fields, file names) can never reach a reviewer
 * unless it is added here on purpose. Broker records, advances, buyout data, line matches (beyond the matched
 * policy number and client), internal notes and the audit log are never read for reviewers. Statement lines
 * are read field by field (reviewerStatementDetail); original statement files are served unchanged by the
 * reviewer file callable.
 *
 * guardReviewerPayload() is a second, independent check run on every response before it leaves the server.
 */

type Doc = Record<string, unknown> & { id: string };
const s = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export interface ReviewerSettings { agencyName: string; snapshotStartMonth: Month | null; snapshotMonths: number }
export function reviewerSettings(settings: Record<string, unknown> | null | undefined): ReviewerSettings {
  return {
    agencyName: s(settings?.agencyName) || 'Agency',
    snapshotStartMonth: strOrNull(settings?.snapshotStartMonth),
    snapshotMonths: n(settings?.snapshotMonths) ?? 12,
  };
}

// ---------------------------------------------------------------- carriers and wholesalers
export interface ReviewerCarrier { id: string; name: string; kind: 'carrier' | 'wholesaler'; commissionMethod: 'statement' | 'retained'; status: string }
export function reviewerCarriers(carriers: Doc[]): ReviewerCarrier[] {
  return carriers
    .map((c) => ({
      id: c.id,
      name: s(c.name),
      kind: c.kind === 'wholesaler' ? 'wholesaler' as const : 'carrier' as const,
      commissionMethod: c.commissionMethod === 'retained' ? 'retained' as const : 'statement' as const,
      status: s(c.status) || 'active',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- statements and reconciliation status
/**
 * Reviewer status of a statement. Posted figures are the only ones in the commission totals; every other
 * status is shown separately and never added to them.
 */
export type ReviewerStatementStatus = 'posted' | 'approved_not_posted' | 'reconciled_not_posted' | 'disputed' | 'not_yet_read';
export const REVIEWER_STATEMENT_STATUS_LABELS: Record<ReviewerStatementStatus, string> = {
  posted: 'Posted — included in commission totals',
  approved_not_posted: 'Approved, not yet posted — not included',
  reconciled_not_posted: 'Reconciled, not yet posted — not included',
  disputed: 'Disputed — does not reconcile to the carrier total; not included',
  not_yet_read: 'Uploaded, not yet read — not included',
};
function reviewerStatus(status: string, postedCents: number): ReviewerStatementStatus | null {
  if (status === 'discarded') return null; // withdrawn uploads are not part of the record
  if (status === 'posted' || postedCents !== 0) return 'posted';
  if (status === 'approved') return 'approved_not_posted';
  if (status === 'needs_review') return 'reconciled_not_posted';
  if (status === 'discrepancy') return 'disputed';
  return 'not_yet_read';
}
/**
 * Fixed reviewer labels by check type. Stored labels are NOT passed through: they are free text and can carry
 * printed statement wording (e.g. a section subtotal named after a sub-producer).
 */
const CHECK_LABELS: Record<string, string> = {
  commission: 'Commission total (carrier printed vs extracted)',
  monthPayable: 'Statement total (carrier printed vs extracted)',
  section: 'Section subtotal (carrier printed vs extracted)',
  paymentReceived: 'Payments received (carrier printed vs extracted)',
  premiumForCommission: 'Premium for commission (carrier printed vs extracted)',
  transactionPremium: 'Transaction premium (carrier printed vs extracted)',
  fee: 'Fees (carrier printed vs extracted)',
};
export interface ReviewerCheck { label: string; carrierPrintedCents: Cents | null; extractedCents: Cents; differenceCents: Cents | null; ok: boolean }
export interface ReviewerStatement {
  id: string;
  payer: string;
  statementMonth: Month | null;
  statementDate: IsoDate | null;
  status: ReviewerStatementStatus;
  statusLabel: string;
  /** Total printed by the carrier (as read). */
  carrierTotalCents: Cents | null;
  /** Sum of the statement's lines and adjustments as extracted. */
  extractedCents: Cents | null;
  /** Amount in the posted ledger from this statement (0 unless posted). */
  postedCents: Cents;
  reconciled: boolean;
  checks: ReviewerCheck[];
  /** The carrier's original document is stored and can be opened (never the stored path or file name). */
  hasOriginal: boolean;
  fileType: 'pdf' | 'xlsx' | 'csv' | null;
}
const fileTypeOf = (v: unknown): 'pdf' | 'xlsx' | 'csv' | null => (v === 'pdf' || v === 'xlsx' || v === 'csv' ? v : null);
export function reviewerStatements(statements: Doc[], carriers: Doc[]): ReviewerStatement[] {
  const payerName = new Map(carriers.map((c) => [c.id, s(c.name)]));
  const out: ReviewerStatement[] = [];
  for (const st of statements) {
    const posted = n(st.postedCents) ?? 0;
    const status = reviewerStatus(s(st.status), posted);
    if (!status) continue;
    const rec = (st.reconciliation ?? null) as { reconciled?: unknown; checks?: unknown; totals?: { commissionCents?: unknown; adjustmentsCents?: unknown } } | null;
    const checks = Array.isArray(rec?.checks) ? (rec!.checks as Record<string, unknown>[]) : [];
    const ext = rec?.totals ? (n(rec.totals.commissionCents) ?? 0) + (n(rec.totals.adjustmentsCents) ?? 0) : null;
    out.push({
      id: st.id,
      payer: payerName.get(s(st.payerId)) ?? 'Carrier not yet assigned',
      statementMonth: strOrNull(st.statementMonth),
      statementDate: strOrNull(st.statementDate),
      status,
      statusLabel: REVIEWER_STATEMENT_STATUS_LABELS[status],
      carrierTotalCents: n(st.statementTotalCents),
      extractedCents: ext,
      postedCents: posted,
      reconciled: rec?.reconciled === true,
      checks: checks.map((c) => ({
        label: CHECK_LABELS[s(c.key)] ?? 'Other check (carrier printed vs extracted)',
        carrierPrintedCents: n(c.statedCents),
        extractedCents: n(c.extractedCents) ?? 0,
        differenceCents: n(c.differenceCents),
        ok: c.ok === true,
      })),
      hasOriginal: typeof st.originalPath === 'string' && st.originalPath.trim() !== '',
      fileType: fileTypeOf(st.fileType),
    });
  }
  return out.sort((a, b) => (b.statementMonth ?? '').localeCompare(a.statementMonth ?? '') || a.payer.localeCompare(b.payer));
}

// ---------------------------------------------------------------- clients and policies (every status)
export const REVIEWER_POLICY_STATUS_LABELS: Record<string, string> = { active: 'Active', pending: 'Pending', cancelled: 'Cancelled', expired: 'Expired' };
const policyStatusLabel = (v: string) => REVIEWER_POLICY_STATUS_LABELS[v] ?? (v ? v[0].toUpperCase() + v.slice(1) : 'Unknown');
const POLICY_STATUS_ORDER = ['active', 'pending', 'cancelled', 'expired'];
export interface ReviewerPolicy {
  id: string; clientId: string; client: string; policyNumber: string; alternateNumbers: string[];
  carrier: string; wholesaler: string; line: string; policyType: string; namedInsured: string;
  effectiveDate: IsoDate | null; expirationDate: IsoDate | null;
  /** Policy status as recorded (active, pending, cancelled, expired) and its label. */
  status: string; statusLabel: string;
  annualPremiumCents: Cents | null; agencyCommissionRateBps: number | null;
  /** Posted commission on this policy in the reporting window (full carrier-paid commission, all categories). */
  windowCommissionCents: Cents;
}
export interface ReviewerClient { id: string; name: string; classification: string; status: string; activePolicies: number; policyCount: number }
export interface ReviewerBook {
  clients: ReviewerClient[]; policies: ReviewerPolicy[];
  /** Policy count by status, e.g. { active: 120, cancelled: 14 }. */
  policiesByStatus: Record<string, number>;
  /** Posted commission in the window on all listed policies (every status). */
  windowCommissionCents: Cents;
  /** Posted commission in the window on active policies only. */
  activeWindowCommissionCents: Cents;
}

/** Every policy, each labelled with its status (active first), and the clients that hold them. */
export function reviewerBook(input: { clients: Doc[]; policies: Doc[]; carriers: Doc[]; entries: ReportEntry[]; start: Month | null; months: number }): ReviewerBook {
  const carrierName = new Map(input.carriers.map((c) => [c.id, s(c.name)]));
  const clientById = new Map(input.clients.map((c) => [c.id, c]));
  const range = input.start ? windowRange(input.start, input.months) : null;
  const perPolicy = new Map<string, Cents>();
  for (const e of input.entries) {
    if (!range || !e.policyId || !(e.postingStatus === 'posted' || e.postingStatus === 'reversed') || !inRange(e, range)) continue;
    perPolicy.set(e.policyId, (perPolicy.get(e.policyId) ?? 0) + e.amountCents);
  }
  const rank = (st: string) => { const i = POLICY_STATUS_ORDER.indexOf(st); return i < 0 ? POLICY_STATUS_ORDER.length : i; };
  const policies: ReviewerPolicy[] = input.policies
    .map((p) => {
      const status = s(p.status) || 'unknown';
      return {
        id: p.id,
        clientId: s(p.clientId),
        client: displayName(s(clientById.get(s(p.clientId))?.name)),
        policyNumber: s(p.policyNumber),
        alternateNumbers: Array.isArray(p.alternateNumbers) ? (p.alternateNumbers as unknown[]).map(s).filter(Boolean) : [],
        carrier: carrierName.get(s(p.carrierId)) ?? '',
        wholesaler: p.wholesalerId ? carrierName.get(s(p.wholesalerId)) ?? '' : '',
        line: s(p.line),
        policyType: s(p.policyType),
        namedInsured: displayName(s(p.namedInsured)),
        effectiveDate: strOrNull(p.effectiveDate),
        expirationDate: strOrNull(p.expirationDate),
        status,
        statusLabel: policyStatusLabel(status),
        annualPremiumCents: n(p.premiumCents),
        agencyCommissionRateBps: n(p.commissionRateBps),
        windowCommissionCents: perPolicy.get(p.id) ?? 0,
      };
    })
    .sort((a, b) => rank(a.status) - rank(b.status) || a.client.localeCompare(b.client) || a.policyNumber.localeCompare(b.policyNumber));
  const count = new Map<string, { active: number; all: number }>();
  const byStatus: Record<string, number> = {};
  for (const p of policies) {
    const c = count.get(p.clientId) ?? { active: 0, all: 0 };
    c.all += 1; if (p.status === 'active') c.active += 1;
    count.set(p.clientId, c);
    byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
  }
  const clients: ReviewerClient[] = [...count.keys()]
    .map((id) => clientById.get(id))
    .filter((c): c is Doc => !!c)
    .map((c) => ({ id: c.id, name: displayName(s(c.name)), classification: s(c.classification), status: s(c.status) || 'active', activePolicies: count.get(c.id)?.active ?? 0, policyCount: count.get(c.id)?.all ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    clients, policies, policiesByStatus: byStatus,
    windowCommissionCents: policies.reduce((t, p) => t + p.windowCommissionCents, 0),
    activeWindowCommissionCents: policies.filter((p) => p.status === 'active').reduce((t, p) => t + p.windowCommissionCents, 0),
  };
}

// ---------------------------------------------------------------- posted transactions (reporting window)
export interface ReviewerTransaction {
  id: string; statementPeriod: Month; transactionDate: IsoDate | null; payer: string; carrier: string;
  client: string; policyNumber: string; category: string; classification: string;
  amountCents: Cents; postingStatus: 'posted' | 'reversed'; isReversal: boolean; statementId: string | null;
}
export function reviewerTransactions(input: { entries: ReportEntry[]; carriers: Doc[]; clients: Doc[]; policies: Doc[]; start: Month | null; months: number }): ReviewerTransaction[] {
  if (!input.start) return [];
  const range = windowRange(input.start, input.months);
  const carrierName = new Map(input.carriers.map((c) => [c.id, s(c.name)]));
  const clientName = new Map(input.clients.map((c) => [c.id, displayName(s(c.name))]));
  const policyNumber = new Map(input.policies.map((p) => [p.id, s(p.policyNumber)]));
  return input.entries
    .filter((e) => (e.postingStatus === 'posted' || e.postingStatus === 'reversed') && inRange(e, range))
    .map((e) => ({
      id: e.id,
      statementPeriod: e.statementPeriod,
      transactionDate: strOrNull(e.transactionDate),
      payer: carrierName.get(s(e.payerId)) ?? '',
      carrier: e.carrierId ? carrierName.get(s(e.carrierId)) ?? '' : '',
      client: e.clientId ? clientName.get(s(e.clientId)) ?? '' : '',
      policyNumber: e.policyId ? policyNumber.get(s(e.policyId)) ?? '' : '',
      category: DILIGENCE_CATEGORY_LABELS[diligenceCategory(e)],
      classification: s(e.classification),
      amountCents: e.amountCents,
      postingStatus: e.postingStatus,
      isReversal: !!e.reversalOf,
      statementId: strOrNull(e.statementId),
    }))
    .sort((a, b) => a.statementPeriod.localeCompare(b.statementPeriod) || a.payer.localeCompare(b.payer) || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------- one statement in detail
export interface ReviewerStatementLine {
  lineNo: number;
  page: number | null;
  /** As printed by the carrier (as read). */
  insured: string;
  policyNumber: string;
  transactionCode: string;
  transactionType: string;
  effectiveDate: IsoDate | null;
  premiumForCommissionCents: Cents | null;
  transactionPremiumCents: Cents | null;
  rateBps: number | null;
  /** Commission paid by the carrier on this line — the full amount, whoever services the policy. */
  commissionCents: Cents | null;
  termCommissionCents: Cents | null;
  feeCents: Cents | null;
  paymentReceivedCents: Cents | null;
  /** The agency policy the line was matched to (number and client only), if any. */
  matchedPolicyNumber: string | null;
  matchedClient: string | null;
  matched: boolean;
}
export interface ReviewerAdjustment { label: string; kind: string; amountCents: Cents }
export interface ReviewerStatementDetail {
  statement: ReviewerStatement;
  /** Totals printed by the carrier (as read), where the statement prints them. */
  carrierPrinted: { commissionCents: Cents | null; statementTotalCents: Cents | null; premiumForCommissionCents: Cents | null; transactionPremiumCents: Cents | null; feeCents: Cents | null; paymentReceivedCents: Cents | null };
  lines: ReviewerStatementLine[];
  adjustments: ReviewerAdjustment[];
  totals: { lines: number; commissionCents: Cents; adjustmentsCents: Cents; premiumForCommissionCents: Cents; transactionPremiumCents: Cents; feeCents: Cents };
}
const ADJUSTMENT_KIND: Record<string, string> = { mvr: 'MVR / CLUE charge' };
export function reviewerStatementDetail(input: { statement: Doc; lines: Doc[]; carriers: Doc[]; policies: Doc[]; clients: Doc[] }): ReviewerStatementDetail | null {
  const [statement] = reviewerStatements([input.statement], input.carriers);
  if (!statement) return null; // discarded uploads are not part of the record
  const policyById = new Map(input.policies.map((p) => [p.id, p]));
  const clientName = new Map(input.clients.map((c) => [c.id, displayName(s(c.name))]));
  const stated = (input.statement.stated ?? {}) as Record<string, unknown>;
  const lines: ReviewerStatementLine[] = input.lines.map((l) => {
    const m = (l.match ?? {}) as Record<string, unknown>;
    const pol = m.policyId ? policyById.get(s(m.policyId)) : undefined;
    const matched = !!pol;
    return {
      lineNo: n(l.lineNo) ?? 0,
      page: n(l.page),
      insured: s(l.insuredName),
      policyNumber: s(l.policyNumberRaw),
      transactionCode: s(l.transactionCodeRaw),
      transactionType: s(l.transactionType),
      effectiveDate: strOrNull(l.effectiveDate),
      premiumForCommissionCents: n(l.premiumForCommissionCents),
      transactionPremiumCents: n(l.transactionPremiumCents),
      rateBps: n(l.rateBps),
      commissionCents: n(l.paidCommissionCents),
      termCommissionCents: n(l.termCommissionCents),
      feeCents: n(l.feeCents),
      paymentReceivedCents: n(l.paymentReceivedCents),
      matchedPolicyNumber: matched ? s(pol!.policyNumber) || null : null,
      matchedClient: matched ? clientName.get(s(pol!.clientId)) ?? null : null,
      matched,
    };
  }).sort((a, b) => a.lineNo - b.lineNo);
  const adjustments: ReviewerAdjustment[] = (Array.isArray(input.statement.adjustments) ? (input.statement.adjustments as Record<string, unknown>[]) : [])
    .map((a) => {
      const kind = s((a.source as Record<string, unknown> | undefined)?.kind);
      return { label: s(a.label) || 'Statement adjustment', kind: ADJUSTMENT_KIND[kind] ?? 'Carrier adjustment', amountCents: n(a.amountCents) ?? 0 };
    });
  const sum = (f: (l: ReviewerStatementLine) => Cents | null) => lines.reduce((t, l) => t + (f(l) ?? 0), 0);
  return {
    statement,
    carrierPrinted: {
      commissionCents: n(stated.commissionPayableCents),
      statementTotalCents: n(stated.monthCommissionPayableCents) ?? statement.carrierTotalCents,
      premiumForCommissionCents: n(stated.premiumForCommissionCents),
      transactionPremiumCents: n(stated.transactionPremiumCents),
      feeCents: n(stated.feeCents),
      paymentReceivedCents: n(stated.paymentReceivedCents),
    },
    lines,
    adjustments,
    totals: {
      lines: lines.length,
      commissionCents: sum((l) => l.commissionCents),
      adjustmentsCents: adjustments.reduce((t, a) => t + a.amountCents, 0),
      premiumForCommissionCents: sum((l) => l.premiumForCommissionCents),
      transactionPremiumCents: sum((l) => l.transactionPremiumCents),
      feeCents: sum((l) => l.feeCents),
    },
  };
}

/** Neutral download name for a carrier's original document: carrier, month, type (never the uploaded file name). */
export function reviewerOriginalName(statement: Pick<ReviewerStatement, 'payer' | 'statementMonth' | 'id' | 'fileType'>): string {
  const base = `${statement.payer} ${statement.statementMonth ?? 'undated'} commission statement`.replace(/[^A-Za-z0-9 .&()-]+/g, ' ').replace(/\s+/g, ' ').trim() || `Commission statement ${statement.id}`;
  return `${base}.${statement.fileType ?? 'pdf'}`;
}

// ---------------------------------------------------------------- overview (monthly, rolling 12, carrier level)
export interface ReviewerOverview {
  settings: ReviewerSettings;
  status: string; statusLabel: string; statusText: string; notices: string[];
  from: Month; to: Month;
  /** Posted ledger only. */
  postedTotal: Record<string, Cents>;
  byMonth: { month: Month; totalCents: Cents; hasPostedStatement: boolean }[];
  byPayer: { name: string; kind: string; totalCents: Cents; monthsWithPostings: number; byMonth: Record<Month, Cents> }[];
  byCarrier: { name: string; totalCents: Cents }[];
  missingMonths: Month[];
  carrierGaps: { name: string; missingMonths: Month[] }[];
  checks: { name: string; pass: boolean; detail: string }[];
  /** Statements NOT in the posted totals, by reviewer status, with the carrier-printed and extracted amounts. */
  notPosted: { status: ReviewerStatementStatus; label: string; count: number; carrierTotalCents: Cents; extractedCents: Cents }[];
  /** Personal Lines vs Commercial Lines (always marked PRELIMINARY). null when there is no snapshot window or no client list was given. */
  lines: ReviewerLineBreakdown | null;
}
export function reviewerOverview(input: { settings: Record<string, unknown> | null | undefined; entries: ReportEntry[]; carriers: Doc[]; policies: Doc[]; statements: Doc[]; clients?: Doc[] }): ReviewerOverview {
  const settings = reviewerSettings(input.settings);
  const summary: DiligenceSummary = buildDiligenceSummary({
    entries: input.entries, start: settings.snapshotStartMonth, months: settings.snapshotMonths,
    carriers: input.carriers.map((c) => ({ id: c.id, name: s(c.name), kind: c.kind === 'wholesaler' ? 'wholesaler' : 'carrier', commissionMethod: c.commissionMethod === 'retained' ? 'retained' : 'statement', status: s(c.status) || 'active' })) as DiligenceCarrier[],
    policies: input.policies.map((p) => ({ id: p.id, clientId: s(p.clientId), carrierId: s(p.carrierId), wholesalerId: strOrNull(p.wholesalerId), policyNumber: s(p.policyNumber), status: s(p.status) })) as DiligencePolicy[],
    statements: input.statements.map((x) => ({ id: x.id, status: s(x.status), statementMonth: strOrNull(x.statementMonth), payerId: strOrNull(x.payerId) })) as DiligenceStatement[],
  });
  const statements = reviewerStatements(input.statements, input.carriers);
  const notPosted = (['approved_not_posted', 'reconciled_not_posted', 'disputed', 'not_yet_read'] as const).map((status) => {
    const xs = statements.filter((x) => x.status === status);
    return { status, label: REVIEWER_STATEMENT_STATUS_LABELS[status], count: xs.length, carrierTotalCents: xs.reduce((t, x) => t + (x.carrierTotalCents ?? 0), 0), extractedCents: xs.reduce((t, x) => t + (x.extractedCents ?? 0), 0) };
  });
  return {
    settings,
    status: summary.status, statusLabel: summary.statusLabel, statusText: summary.statusText, notices: [...summary.notices],
    from: summary.from, to: summary.to,
    postedTotal: { commission: summary.total.commission, unmatched: summary.total.unmatched, adjustment: summary.total.adjustment, retained: summary.total.retained, manual: summary.total.manual, total: summary.total.total },
    byMonth: summary.byMonth.map((m) => ({ month: m.month, totalCents: m.totals.total, hasPostedStatement: m.hasPostedStatement })),
    byPayer: summary.byPayer.map((p) => ({ name: p.name, kind: p.kind, totalCents: p.totals.total, monthsWithPostings: p.monthsWithPostings, byMonth: Object.fromEntries(p.byMonth) })),
    byCarrier: summary.byCarrier.map((c) => ({ name: c.name, totalCents: c.total })),
    missingMonths: [...summary.missingMonths],
    carrierGaps: summary.carrierGaps.map((g) => ({ name: g.name, missingMonths: [...g.missingMonths] })),
    // A failed check's detail can quote ledger-audit wording (broker/agency columns); reviewers get a generic detail.
    checks: summary.checks.map((c) => ({ name: c.name, pass: c.pass, detail: !c.pass || /broker|agency|split|share/i.test(c.detail) ? 'This check did not pass. Details are available from the agency.' : c.detail })),
    notPosted,
    lines: input.clients
      ? reviewerLineBreakdown({ entries: input.entries, policies: input.policies, clients: input.clients, carriers: input.carriers, statements: input.statements, start: settings.snapshotStartMonth, months: settings.snapshotMonths, summaryTotalCents: summary.status === 'NO_PERIOD' ? null : summary.total.total })
      : null,
  };
}

// ---------------------------------------------------------------- CSV exports (built from the allowlisted views only)
/** A formatted amount: written as a number (no formula-guard apostrophe, so -19.14 stays -19.14). */
type Amount = { amount: string };
type Cell = string | number | null | Amount;
const isAmount = (c: Cell): c is Amount => typeof c === 'object' && c !== null;
const row = (cells: Cell[]) => cells.map((c) => (isAmount(c) ? csvCell(c.amount, 'number') : csvCell(c === null ? '' : c, typeof c === 'number' ? 'number' : 'text'))).join(',');
const money = (c: Cents | null): Amount | null => (c === null ? null : { amount: centsToDecimal(c) });
const banner = (title: string, agency: string, preparedAtIso: string, extra: string[] = []) =>
  [row([title]), row([`Agency: ${agency}`]), row([`Prepared: ${preparedAtIso}`]), ...extra.map((x) => row([x])), row(['Read-only due-diligence extract. Contains no broker information. Confidential — use only under the applicable confidentiality agreement.']), ''];

export function reviewerSummaryCsv(o: ReviewerOverview, preparedAtIso: string): string {
  const out = banner('Commission summary (posted ledger)', o.settings.agencyName, preparedAtIso, [`Status: ${o.statusLabel}`, `Period: ${o.from} to ${o.to}`, ...o.notices]);
  out.push(row(['Category', 'Posted commission']));
  for (const [k, v] of Object.entries(o.postedTotal)) out.push(row([k === 'total' ? 'TOTAL' : DILIGENCE_CATEGORY_LABELS[k as keyof typeof DILIGENCE_CATEGORY_LABELS] ?? k, money(v)]));
  out.push('', row(['Month', 'Posted commission', 'Has posted statement']));
  for (const m of o.byMonth) out.push(row([m.month, money(m.totalCents), m.hasPostedStatement ? 'yes' : 'no']));
  out.push('', row(['Paying carrier / wholesaler', 'Kind', 'Posted commission', 'Months with postings']));
  for (const p of o.byPayer) out.push(row([p.name, p.kind, money(p.totalCents), p.monthsWithPostings]));
  out.push('', row(['Underlying carrier', 'Posted commission']));
  for (const c of o.byCarrier) out.push(row([c.name, money(c.totalCents)]));
  out.push('', row(['Statements NOT included in the totals', 'Count', 'Carrier printed total', 'Extracted']));
  for (const x of o.notPosted) out.push(row([x.label, x.count, money(x.carrierTotalCents), money(x.extractedCents)]));
  out.push('', row(['Check', 'Result', 'Detail']));
  for (const c of o.checks) out.push(row([c.name, c.pass ? 'PASS' : 'FAIL', c.detail]));
  const L = o.lines;
  if (L) {
    const lc = L.commission;
    out.push('', row(['PERSONAL LINES vs COMMERCIAL LINES — ' + L.notice]));
    out.push(row(['Clients (each counted once, by active policies)', 'Count', '% of clients']));
    for (const [label, n] of [['Personal Lines', L.clients.personal], ['Commercial Lines', L.clients.commercial], ['Mixed (both)', L.clients.mixed], ['Unclassified policy', L.clients.unclassified], ['No active policies', L.clients.noActivePolicies], ['TOTAL', L.clients.total]] as const) {
      out.push(row([label, n, pct(n, L.clients.total)]));
    }
    out.push('', row(['Active policies', 'Count', '% of active policies']));
    for (const [label, n] of [['Personal Lines', L.activePolicies.personal], ['Commercial Lines', L.activePolicies.commercial], ['Unclassified', L.activePolicies.unclassified], ['TOTAL', L.activePolicies.total]] as const) {
      out.push(row([label, n, pct(n, L.activePolicies.total)]));
    }
    out.push('', row([`Posted commission ${L.from} to ${L.to}`, 'Amount', '% of total']));
    for (const [label, c] of [['Personal Lines', lc.personal], ['Commercial Lines', lc.commercial], ['Policy unclassified', lc.unclassified], ['Not attributable to a line (carrier-level)', lc.notAttributable], ['TOTAL', lc.total]] as const) {
      out.push(row([label, money(c), pct(c, lc.total)]));
    }
    out.push('', row(['Month', 'Personal Lines', 'Commercial Lines', 'Unclassified', 'Not attributable', 'Total']));
    for (const m of L.byMonth) out.push(row([m.month, money(m.cents.personal), money(m.cents.commercial), money(m.cents.unclassified), money(m.cents.notAttributable), money(m.cents.total)]));
    out.push('', row(['Carrier', 'Personal Lines', 'Commercial Lines', 'Unclassified', 'Not attributable', 'Total']));
    for (const c of L.byCarrier) out.push(row([c.name, money(c.cents.personal), money(c.cents.commercial), money(c.cents.unclassified), money(c.cents.notAttributable), money(c.cents.total)]));
    out.push('', row(['Carrier bonuses and profit sharing (carrier-level)', 'Bonus', 'Profit sharing']));
    for (const b of L.bonusProfitSharing.byCarrier) out.push(row([b.name, money(b.bonusCents), money(b.profitSharingCents)]));
    out.push(row(['TOTAL', money(L.bonusProfitSharing.bonusCents), money(L.bonusProfitSharing.profitSharingCents)]));
    const sm = L.byStatementMarking;
    out.push('', row(['Posted commission by statement marking (independent of policy classification)', 'Amount']));
    for (const [label, c] of [['Personal Lines statements', sm.personal], ['Commercial Lines statements', sm.commercial], ['Other statements', sm.other], ['Statements not marked', sm.unmarked], ['Not from a statement (retained, manual)', sm.notFromStatement], ['TOTAL', sm.total]] as const) {
      out.push(row([label, money(c)]));
    }
    out.push(row([L.tiesToSummaryTotal ? 'Ties to the posted commission total: yes' : 'Ties to the posted commission total: NO — do not rely on this breakdown']));
  }
  return out.join('\r\n') + '\r\n';
}
export function reviewerBookCsv(b: ReviewerBook, agency: string, preparedAtIso: string): string {
  const counts = Object.entries(b.policiesByStatus).map(([k, v]) => `${policyStatusLabel(k)} ${v}`).join(', ');
  const out = banner('Clients and policies (every status)', agency, preparedAtIso, [`Policies by status: ${counts || 'none'}`]);
  out.push(row(['Client', 'Classification', 'Policy number', 'Alternate numbers', 'Carrier', 'Wholesaler', 'Line', 'Policy type', 'Named insured', 'Effective', 'Expiration', 'Status', 'Annual premium', 'Agency commission rate %', 'Posted commission in period']));
  const ext = new Map(b.clients.map((c) => [c.id, c]));
  for (const p of b.policies) out.push(row([p.client, ext.get(p.clientId)?.classification ?? '', p.policyNumber, p.alternateNumbers.join('; '), p.carrier, p.wholesaler, p.line, p.policyType, p.namedInsured, p.effectiveDate, p.expirationDate, p.statusLabel, money(p.annualPremiumCents), p.agencyCommissionRateBps === null ? null : (p.agencyCommissionRateBps / 100).toFixed(2), money(p.windowCommissionCents)]));
  return out.join('\r\n') + '\r\n';
}
export function reviewerTransactionsCsv(t: ReviewerTransaction[], agency: string, preparedAtIso: string): string {
  const out = banner('Posted commission transactions (reporting period)', agency, preparedAtIso);
  out.push(row(['Statement period', 'Transaction date', 'Paying carrier / wholesaler', 'Underlying carrier', 'Client', 'Policy number', 'Category', 'Classification', 'Amount', 'Posting status', 'Reversal']));
  for (const x of t) out.push(row([x.statementPeriod, x.transactionDate, x.payer, x.carrier, x.client, x.policyNumber, x.category, x.classification, money(x.amountCents), x.postingStatus, x.isReversal ? 'yes' : 'no']));
  return out.join('\r\n') + '\r\n';
}
export function reviewerStatementsCsv(st: ReviewerStatement[], agency: string, preparedAtIso: string): string {
  const out = banner('Commission statements and reconciliation status', agency, preparedAtIso, ['Only statements with status "Posted" are included in the commission totals.']);
  out.push(row(['Statement month', 'Paying carrier / wholesaler', 'Status', 'Carrier printed total', 'Extracted', 'Posted', 'Reconciles to carrier total']));
  for (const x of st) out.push(row([x.statementMonth, x.payer, x.statusLabel, money(x.carrierTotalCents), money(x.extractedCents), money(x.postedCents), x.reconciled ? 'yes' : 'no']));
  return out.join('\r\n') + '\r\n';
}

const LINE_HEAD = ['Line', 'Page', 'Insured (as printed)', 'Policy number (as printed)', 'Transaction code', 'Transaction type', 'Effective', 'Premium for commission', 'Transaction premium', 'Rate %', 'Commission', 'Term commission', 'Fee', 'Payment received', 'Matched agency policy', 'Matched client'];
const lineCells = (l: ReviewerStatementLine): Cell[] => [l.lineNo, l.page, l.insured, l.policyNumber, l.transactionCode, l.transactionType, l.effectiveDate, money(l.premiumForCommissionCents), money(l.transactionPremiumCents), l.rateBps === null ? null : (l.rateBps / 100).toFixed(2), money(l.commissionCents), money(l.termCommissionCents), money(l.feeCents), money(l.paymentReceivedCents), l.matchedPolicyNumber, l.matchedClient];

/** One statement: carrier-printed totals, every commission line, adjustments and totals. */
export function reviewerStatementDetailCsv(d: ReviewerStatementDetail, agency: string, preparedAtIso: string): string {
  const st = d.statement;
  const out = banner(`Commission statement detail — ${st.payer} ${st.statementMonth ?? ''}`.trim(), agency, preparedAtIso, [`Status: ${st.statusLabel}`, 'Commission amounts are the full amounts paid by the carrier.']);
  out.push(row(['Carrier printed totals', 'Amount']));
  const cp = d.carrierPrinted;
  for (const [label, v] of [['Commission', cp.commissionCents], ['Statement total', cp.statementTotalCents], ['Premium for commission', cp.premiumForCommissionCents], ['Transaction premium', cp.transactionPremiumCents], ['Fees', cp.feeCents], ['Payments received', cp.paymentReceivedCents]] as const) if (v !== null) out.push(row([label, money(v)]));
  out.push('', row(LINE_HEAD));
  for (const l of d.lines) out.push(row(lineCells(l)));
  out.push('', row(['Adjustment', 'Kind', 'Amount']));
  for (const a of d.adjustments) out.push(row([a.label, a.kind, money(a.amountCents)]));
  out.push('', row(['Totals (as extracted)', 'Amount']));
  out.push(row(['Lines', d.totals.lines]), row(['Commission on lines', money(d.totals.commissionCents)]), row(['Adjustments', money(d.totals.adjustmentsCents)]), row(['Commission plus adjustments', money(d.totals.commissionCents + d.totals.adjustmentsCents)]), row(['Premium for commission', money(d.totals.premiumForCommissionCents)]), row(['Transaction premium', money(d.totals.transactionPremiumCents)]), row(['Fees', money(d.totals.feeCents)]));
  return out.join('\r\n') + '\r\n';
}

/** Every statement's commission lines and adjustments in one file (one row each, statement columns first). */
export function reviewerStatementLinesCsv(details: ReviewerStatementDetail[], agency: string, preparedAtIso: string): string {
  const out = banner('Commission statement lines (all statements)', agency, preparedAtIso, ['Only statements with status "Posted" are included in the commission totals. Commission amounts are the full amounts paid by the carrier.']);
  out.push(row(['Statement month', 'Paying carrier / wholesaler', 'Statement status', 'Row type', ...LINE_HEAD, 'Adjustment description', 'Adjustment kind', 'Adjustment amount']));
  for (const d of details) {
    const st: Cell[] = [d.statement.statementMonth, d.statement.payer, d.statement.statusLabel];
    for (const l of d.lines) out.push(row([...st, 'Commission line', ...lineCells(l), null, null, null]));
    for (const a of d.adjustments) out.push(row([...st, 'Adjustment', ...Array(LINE_HEAD.length).fill(null), a.label, a.kind, money(a.amountCents)]));
  }
  return out.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- independent response guard
/** Keys that must never appear anywhere in a reviewer response (case-insensitive substring match). */
export const FORBIDDEN_REVIEWER_KEY = /broker|share|split|advance|buyout|settlement|unearned|note|email|phone|address|contact|createdby|updatedby|approvedby|actor|audit|filename|path|raw|agencycents/i;

/**
 * Throws if `payload` contains a forbidden key anywhere, or any string equal to a broker document ID or
 * broker code. Run on every reviewer response before it is returned (fail closed).
 */
export function guardReviewerPayload(payload: unknown, brokerIdentifiers: Iterable<string>): void {
  const ids = new Set([...brokerIdentifiers].filter((x) => x && x.length >= 2).map((x) => x.toUpperCase()));
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (FORBIDDEN_REVIEWER_KEY.test(k)) throw new Error(`reviewer payload guard: forbidden field at ${path}.${k}`);
        walk(x, `${path}.${k}`);
      }
      return;
    }
    if (typeof v === 'string' && ids.has(v.trim().toUpperCase())) throw new Error(`reviewer payload guard: broker identifier at ${path}`);
  };
  walk(payload, '$');
}
