import type { Cents } from '../money.js';
import type { IsoDate, Month } from '../period.js';
import { inRange, windowRange, type ReportEntry } from '../reports/ledger.js';
import {
  buildDiligenceSummary, diligenceCategory, DILIGENCE_CATEGORY_LABELS,
  type DiligenceCarrier, type DiligencePolicy, type DiligenceStatement, type DiligenceSummary,
} from '../reports/diligence.js';
import { csvCell, centsToDecimal } from '../reports/ledger.js';
import { displayName } from '../displayName.js';

/**
 * Allowlisted, read-only representations of the acquisition records for external reviewers (Pioneer Bank
 * and the independent due-diligence company).
 *
 * Every function below BUILDS a new object field by field from an explicit allowlist. Nothing is spread or
 * copied from a stored document, so a field added to a record later (or present on it today: broker IDs,
 * broker shares and amounts, notes, contact details, audit fields, file names) can never reach a reviewer
 * unless it is added here on purpose. Broker records, advances, buyout data, statement lines and their
 * matches, the audit log and original statement files are never read for reviewers at all.
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
}
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
        label: s(c.label),
        carrierPrintedCents: n(c.statedCents),
        extractedCents: n(c.extractedCents) ?? 0,
        differenceCents: n(c.differenceCents),
        ok: c.ok === true,
      })),
    });
  }
  return out.sort((a, b) => (b.statementMonth ?? '').localeCompare(a.statementMonth ?? '') || a.payer.localeCompare(b.payer));
}

// ---------------------------------------------------------------- active clients and policies
export interface ReviewerPolicy {
  id: string; clientId: string; client: string; policyNumber: string; alternateNumbers: string[];
  carrier: string; wholesaler: string; line: string; policyType: string; namedInsured: string;
  effectiveDate: IsoDate | null; expirationDate: IsoDate | null; status: string;
  annualPremiumCents: Cents | null; agencyCommissionRateBps: number | null;
  /** Posted commission on this policy in the reporting window (carrier-paid commission, all categories). */
  windowCommissionCents: Cents;
}
export interface ReviewerClient { id: string; name: string; externalId: string; classification: string; status: string; activePolicies: number }
export interface ReviewerBook { clients: ReviewerClient[]; policies: ReviewerPolicy[]; windowCommissionCents: Cents }

/** Active policies (status 'active') and the clients that hold them: the book being sold. */
export function reviewerBook(input: { clients: Doc[]; policies: Doc[]; carriers: Doc[]; entries: ReportEntry[]; start: Month | null; months: number }): ReviewerBook {
  const carrierName = new Map(input.carriers.map((c) => [c.id, s(c.name)]));
  const clientById = new Map(input.clients.map((c) => [c.id, c]));
  const range = input.start ? windowRange(input.start, input.months) : null;
  const perPolicy = new Map<string, Cents>();
  for (const e of input.entries) {
    if (!range || !e.policyId || !(e.postingStatus === 'posted' || e.postingStatus === 'reversed') || !inRange(e, range)) continue;
    perPolicy.set(e.policyId, (perPolicy.get(e.policyId) ?? 0) + e.amountCents);
  }
  const policies: ReviewerPolicy[] = input.policies
    .filter((p) => s(p.status) === 'active')
    .map((p) => ({
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
      status: 'active',
      annualPremiumCents: n(p.premiumCents),
      agencyCommissionRateBps: n(p.commissionRateBps),
      windowCommissionCents: perPolicy.get(p.id) ?? 0,
    }))
    .sort((a, b) => a.client.localeCompare(b.client) || a.policyNumber.localeCompare(b.policyNumber));
  const activeCount = new Map<string, number>();
  for (const p of policies) activeCount.set(p.clientId, (activeCount.get(p.clientId) ?? 0) + 1);
  const clients: ReviewerClient[] = [...activeCount.keys()]
    .map((id) => clientById.get(id))
    .filter((c): c is Doc => !!c)
    .map((c) => ({ id: c.id, name: displayName(s(c.name)), externalId: s(c.externalId), classification: s(c.classification), status: s(c.status) || 'active', activePolicies: activeCount.get(c.id) ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { clients, policies, windowCommissionCents: policies.reduce((t, p) => t + p.windowCommissionCents, 0) };
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
}
export function reviewerOverview(input: { settings: Record<string, unknown> | null | undefined; entries: ReportEntry[]; carriers: Doc[]; policies: Doc[]; statements: Doc[] }): ReviewerOverview {
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
    postedTotal: { ...summary.total },
    byMonth: summary.byMonth.map((m) => ({ month: m.month, totalCents: m.totals.total, hasPostedStatement: m.hasPostedStatement })),
    byPayer: summary.byPayer.map((p) => ({ name: p.name, kind: p.kind, totalCents: p.totals.total, monthsWithPostings: p.monthsWithPostings, byMonth: Object.fromEntries(p.byMonth) })),
    byCarrier: summary.byCarrier.map((c) => ({ name: c.name, totalCents: c.total })),
    missingMonths: [...summary.missingMonths],
    carrierGaps: summary.carrierGaps.map((g) => ({ name: g.name, missingMonths: [...g.missingMonths] })),
    checks: summary.checks.map((c) => ({ name: c.name, pass: c.pass, detail: c.detail })),
    notPosted,
  };
}

// ---------------------------------------------------------------- CSV exports (built from the allowlisted views only)
const row = (cells: (string | number | null)[]) => cells.map((c) => csvCell(c === null ? '' : c, typeof c === 'number' ? 'number' : 'text')).join(',');
const money = (c: Cents | null) => (c === null ? null : centsToDecimal(c));
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
  return out.join('\r\n') + '\r\n';
}
export function reviewerBookCsv(b: ReviewerBook, agency: string, preparedAtIso: string): string {
  const out = banner('Active clients and policies', agency, preparedAtIso);
  out.push(row(['Client', 'Client ID', 'Classification', 'Policy number', 'Alternate numbers', 'Carrier', 'Wholesaler', 'Line', 'Policy type', 'Named insured', 'Effective', 'Expiration', 'Status', 'Annual premium', 'Agency commission rate %', 'Posted commission in period']));
  const ext = new Map(b.clients.map((c) => [c.id, c]));
  for (const p of b.policies) out.push(row([p.client, ext.get(p.clientId)?.externalId ?? '', ext.get(p.clientId)?.classification ?? '', p.policyNumber, p.alternateNumbers.join('; '), p.carrier, p.wholesaler, p.line, p.policyType, p.namedInsured, p.effectiveDate, p.expirationDate, p.status, money(p.annualPremiumCents), p.agencyCommissionRateBps === null ? null : (p.agencyCommissionRateBps / 100).toFixed(2), money(p.windowCommissionCents)]));
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
