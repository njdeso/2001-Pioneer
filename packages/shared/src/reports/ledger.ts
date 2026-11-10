import { brokerSplit, isReportable } from '../aggregate.js';
import type { BasisPoints, Cents } from '../money.js';
import { addMonths, isMonth, type Month } from '../period.js';
import type { LedgerEntry } from '../types.js';

/**
 * Ledger reporting: the one place that turns posted ledger entries into totals, posting history,
 * filtered views, CSV exports and the balance audit.
 *
 * The Dashboard, the Ledger report and the development audit all call these functions with entries
 * read from the `ledger` collection, so their figures cannot drift apart:
 *   - an entry counts when postingStatus is 'posted' or 'reversed' (isReportable)
 *   - a reversal is its own entry with negated gross, broker and agency amounts, so a reversed
 *     posting nets to zero in every column
 *   - broker share is the allocation stored on each entry when it was posted; agency = gross − broker
 *   - revenue month = statementPeriod
 */

export type ReportEntry = Pick<LedgerEntry, 'id' | 'amountCents' | 'statementPeriod' | 'postingStatus'> &
  Partial<Omit<LedgerEntry, 'id' | 'amountCents' | 'statementPeriod' | 'postingStatus'>> & {
    /** ISO time the entry was written (posted or reversed), when the caller has it. */
    postedAtIso?: string | null;
  };

/** Broker and share for an entry that has no stored allocation (only possible for pre-Stage-3C entries). */
export type LegacyBrokerFn = (e: ReportEntry) => { brokerId: string; shareBps: BasisPoints } | null;

export interface LedgerTotals {
  entries: number;
  grossCents: Cents;
  brokerCents: Cents;
  agencyCents: Cents;
  /** Entries without a stored broker allocation (their share came from `legacyBroker`). */
  legacyEntries: number;
}

export interface MonthRange { from: Month; to: Month }

export function windowRange(start: Month, months = 12): MonthRange {
  return { from: start, to: addMonths(start, months - 1) };
}

export function inRange(e: Pick<ReportEntry, 'statementPeriod'>, range: Partial<MonthRange> | null | undefined): boolean {
  if (!range) return true;
  if (range.from && e.statementPeriod < range.from) return false;
  if (range.to && e.statementPeriod > range.to) return false;
  return true;
}

/**
 * Gross, broker and agency totals over the reportable entries given. This is THE calculation behind
 * the Dashboard's trailing-12-month commission, broker share and agency net, and the Ledger report.
 */
export function ledgerTotals(entries: Iterable<ReportEntry>, legacyBroker?: LegacyBrokerFn): LedgerTotals {
  let n = 0;
  let gross = 0;
  let stored = 0;
  let legacyEntries = 0;
  const legacyGross = new Map<string, { gross: Cents; shareBps: BasisPoints }>();
  for (const e of entries) {
    if (!isReportable(e)) continue;
    n++;
    gross += e.amountCents;
    if (typeof e.brokerCents === 'number') {
      stored += e.brokerCents;
      continue;
    }
    legacyEntries++;
    const b = legacyBroker?.(e);
    if (!b) continue; // no policy / no broker: all agency
    const cur = legacyGross.get(b.brokerId) ?? { gross: 0, shareBps: b.shareBps };
    cur.gross += e.amountCents;
    legacyGross.set(b.brokerId, cur);
  }
  let broker = stored;
  for (const { gross: g, shareBps } of legacyGross.values()) broker += brokerSplit(g, shareBps).broker;
  return { entries: n, grossCents: gross, brokerCents: broker, agencyCents: gross - broker, legacyEntries };
}

// ---------------------------------------------------------------- posting history

export type PostingState = 'active' | 'reversed' | 'partially_reversed';

export interface PostingGroup {
  /** postingId, or `entry:<id>` for an entry posted without one. */
  key: string;
  postingId: string | null;
  statementId: string | null;
  sourceType: string;
  periods: Month[];
  payerIds: string[];
  state: PostingState;
  originals: ReportEntry[];
  reversals: ReportEntry[];
  original: LedgerTotals;
  reversal: LedgerTotals;
  net: LedgerTotals;
  postedAtIso: string | null;
  postedByEmail: string | null;
  reversedAtIso: string | null;
  reversedByEmail: string | null;
  reversalReason: string | null;
}

export function postingKey(e: Pick<ReportEntry, 'id' | 'postingId' | 'reversalOf'>): string {
  return e.postingId ?? `entry:${e.reversalOf ?? e.id}`;
}

const minIso = (xs: (string | null | undefined)[]) => xs.filter((x): x is string => !!x).sort()[0] ?? null;

/** Group entries into postings (one per approval-and-post, or per retained / manual entry) with their reversals. */
export function groupPostings(entries: Iterable<ReportEntry>, legacyBroker?: LegacyBrokerFn): PostingGroup[] {
  const groups = new Map<string, ReportEntry[]>();
  for (const e of entries) {
    if (!isReportable(e)) continue;
    const k = postingKey(e);
    const list = groups.get(k);
    if (list) list.push(e);
    else groups.set(k, [e]);
  }
  const out: PostingGroup[] = [];
  for (const [key, list] of groups) {
    const originals = list.filter((e) => !e.reversalOf).sort(byLine);
    const reversals = list.filter((e) => !!e.reversalOf).sort(byLine);
    const twinOf = new Set(reversals.map((r) => r.reversalOf!));
    const reversedOriginals = originals.filter((o) => o.postingStatus === 'reversed' && twinOf.has(o.id)).length;
    const state: PostingState =
      reversedOriginals === 0 && reversals.length === 0 ? 'active'
        : reversedOriginals === originals.length && reversals.length === originals.length && originals.length > 0 ? 'reversed'
          : 'partially_reversed';
    const first = originals[0] ?? reversals[0];
    out.push({
      key,
      postingId: first.postingId ?? null,
      statementId: first.statementId ?? null,
      sourceType: first.sourceType ?? 'statement',
      periods: [...new Set(list.map((e) => e.statementPeriod))].sort(),
      payerIds: [...new Set(list.map((e) => e.payerId).filter((x): x is string => !!x))].sort(),
      state,
      originals,
      reversals,
      original: ledgerTotals(originals, legacyBroker),
      reversal: ledgerTotals(reversals, legacyBroker),
      net: ledgerTotals(list, legacyBroker),
      postedAtIso: minIso(originals.map((e) => e.postedAtIso)),
      postedByEmail: originals.find((e) => e.postedByEmail)?.postedByEmail ?? null,
      reversedAtIso: minIso(reversals.map((e) => e.postedAtIso)),
      reversedByEmail: reversals.find((e) => e.postedByEmail)?.postedByEmail ?? null,
      reversalReason: reversals.find((e) => e.reversalReason)?.reversalReason ?? null,
    });
  }
  return out.sort((a, b) => (a.periods[0] ?? '').localeCompare(b.periods[0] ?? '') || (a.postedAtIso ?? '').localeCompare(b.postedAtIso ?? '') || a.key.localeCompare(b.key));
}

function byLine(a: ReportEntry, b: ReportEntry): number {
  return (a.lineNo ?? 0) - (b.lineNo ?? 0) || a.id.localeCompare(b.id);
}

// ---------------------------------------------------------------- filters

export interface LedgerFilter {
  from?: Month | null;
  to?: Month | null;
  /** Carrier or wholesaler: matches the payer or the underlying carrier. */
  companyId?: string | null;
  brokerId?: string | null;
  statementId?: string | null;
  postingState?: 'all' | 'active' | 'reversed';
  sourceType?: 'all' | 'statement' | 'retained' | 'manual';
  search?: string | null;
}

/** The broker an entry is allocated to: the stored allocation, else the legacy lookup. */
export function entryBrokerId(e: ReportEntry, legacyBroker?: LegacyBrokerFn): string | null {
  return e.brokerId ?? legacyBroker?.(e)?.brokerId ?? null;
}

/**
 * Filter reportable entries. The posting-state filter works on whole postings (an original and its
 * reversal stay together), so the net of any filtered view is still exact.
 */
export function filterLedger(entries: ReportEntry[], f: LedgerFilter, legacyBroker?: LegacyBrokerFn): ReportEntry[] {
  const reportable = entries.filter(isReportable);
  const state = new Map<string, PostingState>();
  if (f.postingState && f.postingState !== 'all') for (const g of groupPostings(reportable)) state.set(g.key, g.state);
  const q = f.search?.trim().toLowerCase() ?? '';
  return reportable.filter((e) => {
    if (!inRange(e, { from: f.from ?? undefined, to: f.to ?? undefined })) return false;
    if (f.companyId && e.payerId !== f.companyId && e.carrierId !== f.companyId) return false;
    if (f.brokerId && entryBrokerId(e, legacyBroker) !== f.brokerId) return false;
    if (f.statementId && e.statementId !== f.statementId) return false;
    if (f.sourceType && f.sourceType !== 'all' && (e.sourceType ?? 'statement') !== f.sourceType) return false;
    if (f.postingState && f.postingState !== 'all') {
      const s = state.get(postingKey(e));
      if (f.postingState === 'active' ? s !== 'active' : s === 'active') return false;
    }
    if (q) {
      const hay = [e.id, e.postingId, e.statementId, e.policyNumberRaw, e.insuredName, e.note, e.reversalReason].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------- CSV export

/** Cents as a plain decimal string for spreadsheets: -4500 → "-45.00". */
export function centsToDecimal(cents: Cents): string {
  if (!Number.isSafeInteger(cents)) return '';
  const neg = cents < 0;
  const abs = Math.abs(cents);
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * One CSV cell. Text cells that a spreadsheet would read as a formula (=, +, -, @, tab, CR) get a
 * leading apostrophe; numeric cells (amounts) are written as-is. Cells with a comma, quote or line
 * break are quoted.
 */
export function csvCell(value: string | number | null | undefined, kind: 'text' | 'number' = 'text'): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (kind === 'text' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

type Col<T> = { header: string; kind?: 'text' | 'number'; value: (row: T) => string | number | null | undefined; internal?: boolean };

function toCsv<T>(rows: T[], cols: Col<T>[], variant: CsvVariant): string {
  const used = cols.filter((c) => variant === 'accounting' || !c.internal);
  const lines = [used.map((c) => csvCell(c.header)).join(',')];
  for (const r of rows) lines.push(used.map((c) => csvCell(c.value(r), c.kind ?? 'text')).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/**
 * accounting:    everything, including broker allocation and who posted (internal use only)
 * due_diligence: transactions without broker names, broker/agency split, staff emails or notes
 *                (broker information is never shared with the buyer)
 */
export type CsvVariant = 'accounting' | 'due_diligence';

export interface CsvLookups {
  companyName?: (id: string | null | undefined) => string;
  brokerName?: (id: string | null | undefined) => string;
  policyNumber?: (id: string | null | undefined) => string;
}

export const LEDGER_CSV_ACCOUNTING_HEADERS = [
  'entry_id', 'posting_id', 'statement_id', 'line_no', 'entry_type', 'reversal_of', 'posting_state', 'statement_period', 'transaction_date',
  'payer', 'carrier', 'level', 'classification', 'source_type', 'policy_number', 'insured', 'broker', 'broker_share_pct', 'broker_share_source',
  'amount', 'broker_amount', 'agency_amount', 'posted_at', 'posted_by', 'reversal_reason', 'note',
] as const;

/** Transaction-level ledger export, in statement-month and posting order (each original, then its reversal). */
export function ledgerCsv(entries: ReportEntry[], variant: CsvVariant, lookups: CsvLookups = {}, legacyBroker?: LegacyBrokerFn): string {
  const reportable = entries.filter(isReportable);
  const state = new Map(groupPostings(reportable, legacyBroker).map((g) => [g.key, g.state]));
  const company = lookups.companyName ?? ((id) => id ?? '');
  const broker = lookups.brokerName ?? ((id) => id ?? '');
  const rows = [...reportable].sort((a, b) =>
    a.statementPeriod.localeCompare(b.statementPeriod) || postingKey(a).localeCompare(postingKey(b))
    || (a.lineNo ?? 0) - (b.lineNo ?? 0) || (a.reversalOf ?? a.id).localeCompare(b.reversalOf ?? b.id) || (a.reversalOf ? 1 : 0) - (b.reversalOf ? 1 : 0));
  const cols: Col<ReportEntry>[] = [
    { header: 'entry_id', value: (e) => e.id },
    { header: 'posting_id', value: (e) => e.postingId ?? '' },
    { header: 'statement_id', value: (e) => e.statementId ?? '' },
    { header: 'line_no', kind: 'number', value: (e) => e.lineNo ?? '' },
    { header: 'entry_type', value: (e) => (e.reversalOf ? 'reversal' : 'original') },
    { header: 'reversal_of', value: (e) => e.reversalOf ?? '' },
    { header: 'posting_state', value: (e) => state.get(postingKey(e)) ?? '' },
    { header: 'statement_period', value: (e) => e.statementPeriod },
    { header: 'transaction_date', value: (e) => e.transactionDate ?? '' },
    { header: 'payer', value: (e) => company(e.payerId) },
    { header: 'carrier', value: (e) => (e.carrierId ? company(e.carrierId) : '') },
    { header: 'level', value: (e) => e.level ?? '' },
    { header: 'classification', value: (e) => e.classification ?? '' },
    { header: 'source_type', value: (e) => e.sourceType ?? '' },
    { header: 'policy_number', value: (e) => e.policyNumberRaw || lookups.policyNumber?.(e.policyId) || '' },
    { header: 'insured', value: (e) => e.insuredName ?? '' },
    { header: 'broker', internal: true, value: (e) => { const id = entryBrokerId(e, legacyBroker); return id ? broker(id) : ''; } },
    { header: 'broker_share_pct', internal: true, kind: 'number', value: (e) => (typeof e.brokerShareBps === 'number' ? (e.brokerShareBps / 100).toFixed(2) : '') },
    { header: 'broker_share_source', internal: true, value: (e) => e.brokerShareSource ?? (typeof e.brokerCents === 'number' ? '' : 'legacy') },
    { header: 'amount', kind: 'number', value: (e) => centsToDecimal(e.amountCents) },
    { header: 'broker_amount', internal: true, kind: 'number', value: (e) => (typeof e.brokerCents === 'number' ? centsToDecimal(e.brokerCents) : '') },
    { header: 'agency_amount', internal: true, kind: 'number', value: (e) => (typeof e.agencyCents === 'number' ? centsToDecimal(e.agencyCents) : '') },
    { header: 'posted_at', value: (e) => e.postedAtIso ?? '' },
    { header: 'posted_by', internal: true, value: (e) => e.postedByEmail ?? '' },
    { header: 'reversal_reason', internal: true, value: (e) => e.reversalReason ?? '' },
    { header: 'note', internal: true, value: (e) => e.note ?? '' },
  ];
  return toCsv(rows, cols, variant);
}

/** Posting-level export: one row per posting with original, reversal and net amounts. */
export function postingsCsv(groups: PostingGroup[], variant: CsvVariant, lookups: CsvLookups = {}): string {
  const company = lookups.companyName ?? ((id) => id ?? '');
  const cols: Col<PostingGroup>[] = [
    { header: 'posting_id', value: (g) => g.postingId ?? g.key },
    { header: 'statement_id', value: (g) => g.statementId ?? '' },
    { header: 'source_type', value: (g) => g.sourceType },
    { header: 'statement_period', value: (g) => g.periods.join(' ') },
    { header: 'payer', value: (g) => g.payerIds.map((id) => company(id)).join('; ') },
    { header: 'state', value: (g) => g.state },
    { header: 'original_entries', kind: 'number', value: (g) => g.original.entries },
    { header: 'reversal_entries', kind: 'number', value: (g) => g.reversal.entries },
    { header: 'original_amount', kind: 'number', value: (g) => centsToDecimal(g.original.grossCents) },
    { header: 'reversal_amount', kind: 'number', value: (g) => centsToDecimal(g.reversal.grossCents) },
    { header: 'net_amount', kind: 'number', value: (g) => centsToDecimal(g.net.grossCents) },
    { header: 'original_broker', internal: true, kind: 'number', value: (g) => centsToDecimal(g.original.brokerCents) },
    { header: 'original_agency', internal: true, kind: 'number', value: (g) => centsToDecimal(g.original.agencyCents) },
    { header: 'net_broker', internal: true, kind: 'number', value: (g) => centsToDecimal(g.net.brokerCents) },
    { header: 'net_agency', internal: true, kind: 'number', value: (g) => centsToDecimal(g.net.agencyCents) },
    { header: 'posted_at', value: (g) => g.postedAtIso ?? '' },
    { header: 'posted_by', internal: true, value: (g) => g.postedByEmail ?? '' },
    { header: 'reversed_at', value: (g) => g.reversedAtIso ?? '' },
    { header: 'reversed_by', internal: true, value: (g) => g.reversedByEmail ?? '' },
    { header: 'reversal_reason', internal: true, value: (g) => g.reversalReason ?? '' },
  ];
  return toCsv(groups, cols, variant);
}

// ---------------------------------------------------------------- audit

export interface AuditStatement {
  id: string;
  status: string;
  postedCents?: number | null;
  posting?: { postingId?: string } | null;
  reversals?: { postingId: string; amountCents: number; entries?: number }[] | null;
}

export interface AuditFinding {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  ids: string[];
}

export interface LedgerAuditResult {
  ok: boolean;
  errors: number;
  warnings: number;
  findings: AuditFinding[];
  totals: LedgerTotals;
  window: (MonthRange & { totals: LedgerTotals }) | null;
  postings: PostingGroup[];
  counts: { entries: number; originals: number; reversals: number; postings: number; activePostings: number; reversedPostings: number; statements: number };
}

/**
 * Read-only balance audit of ledger entries (and, when given, the statements that posted them).
 * Every reversal must be an exact negative twin of its original (gross, broker and agency), every
 * reversed posting must net to zero in all three, allocations must add up, and statement posting
 * status must agree with the ledger.
 */
export function auditLedger(input: { entries: ReportEntry[]; statements?: AuditStatement[]; window?: MonthRange | null; legacyBroker?: LegacyBrokerFn }): LedgerAuditResult {
  const findings: AuditFinding[] = [];
  const add = (severity: AuditFinding['severity'], code: string, message: string, ids: string[]) => findings.push({ severity, code, message, ids });
  const entries = input.entries;
  const byId = new Map(entries.map((e) => [e.id, e]));
  const twins = new Map<string, ReportEntry[]>();
  for (const e of entries) if (e.reversalOf) twins.set(e.reversalOf, [...(twins.get(e.reversalOf) ?? []), e]);

  let legacy = 0;
  for (const e of entries) {
    if (!Number.isSafeInteger(e.amountCents)) add('error', 'amount_not_integer_cents', `Entry ${e.id} amount is not whole cents (${String(e.amountCents)}).`, [e.id]);
    if (e.postingStatus !== 'posted' && e.postingStatus !== 'reversed') add('error', 'unknown_posting_status', `Entry ${e.id} has posting status "${String(e.postingStatus)}".`, [e.id]);
    if (!isMonth(e.statementPeriod)) add('error', 'bad_statement_period', `Entry ${e.id} has statement period "${String(e.statementPeriod)}".`, [e.id]);
    if (typeof e.brokerCents === 'number' || typeof e.agencyCents === 'number') {
      if (!Number.isSafeInteger(e.brokerCents) || !Number.isSafeInteger(e.agencyCents) || e.brokerCents! + e.agencyCents! !== e.amountCents) {
        add('error', 'split_mismatch', `Entry ${e.id}: broker ${String(e.brokerCents)} + agency ${String(e.agencyCents)} ≠ gross ${String(e.amountCents)}.`, [e.id]);
      }
    } else legacy++;

    if (e.reversalOf) {
      const o = byId.get(e.reversalOf);
      if (!o) { add('error', 'reversal_without_original', `Reversal ${e.id} points to ${e.reversalOf}, which is not in the ledger.`, [e.id]); continue; }
      if (o.reversalOf) add('error', 'reversal_of_reversal', `Reversal ${e.id} reverses another reversal (${o.id}).`, [e.id, o.id]);
      if (e.postingStatus !== 'posted') add('error', 'reversal_marked_reversed', `Reversal ${e.id} is itself marked reversed.`, [e.id]);
      if (o.postingStatus !== 'reversed') add('error', 'original_not_marked_reversed', `Original ${o.id} has a reversal (${e.id}) but is still marked posted.`, [o.id, e.id]);
      if (o.reversalId !== e.id) add('error', 'reversal_link_mismatch', `Original ${o.id} names reversal ${String(o.reversalId)}, not ${e.id}.`, [o.id, e.id]);
      const neg = (a: number | undefined, b: number | undefined) => (a === undefined && b === undefined) || (typeof a === 'number' && typeof b === 'number' && a === -b);
      if (!neg(e.amountCents, o.amountCents) || !neg(e.brokerCents, o.brokerCents) || !neg(e.agencyCents, o.agencyCents)) {
        add('error', 'reversal_amount_mismatch', `Reversal ${e.id} is not the exact negative of ${o.id} (gross ${e.amountCents}/${o.amountCents}, broker ${String(e.brokerCents)}/${String(o.brokerCents)}, agency ${String(e.agencyCents)}/${String(o.agencyCents)}).`, [e.id, o.id]);
      }
      if (e.statementPeriod !== o.statementPeriod) add('error', 'reversal_period_mismatch', `Reversal ${e.id} is in ${e.statementPeriod}; original ${o.id} is in ${o.statementPeriod}.`, [e.id, o.id]);
      if ((e.postingId ?? null) !== (o.postingId ?? null)) add('error', 'reversal_posting_mismatch', `Reversal ${e.id} belongs to posting ${String(e.postingId)}; original to ${String(o.postingId)}.`, [e.id, o.id]);
    } else {
      const t = twins.get(e.id) ?? [];
      if (t.length > 1) add('error', 'multiple_reversals', `Entry ${e.id} has ${t.length} reversal entries.`, [e.id, ...t.map((x) => x.id)]);
      if (e.postingStatus === 'reversed' && t.length === 0) add('error', 'reversed_without_reversal_entry', `Entry ${e.id} is marked reversed but no reversal entry exists.`, [e.id]);
    }
  }
  if (legacy) add('warning', 'no_stored_allocation', `${legacy} entr${legacy === 1 ? 'y has' : 'ies have'} no stored broker/agency allocation (pre-Stage-3C); broker share uses the current broker's standard share.`, []);

  const postings = groupPostings(entries, input.legacyBroker);
  for (const g of postings) {
    if (g.state === 'partially_reversed') add('error', 'partial_reversal', `Posting ${g.key}: ${g.reversals.length} reversal(s) for ${g.originals.length} original(s); a posting is reversed whole.`, [g.key]);
    if (g.state === 'reversed' && (g.net.grossCents !== 0 || g.net.brokerCents !== 0 || g.net.agencyCents !== 0)) {
      add('error', 'reversed_posting_not_zero', `Reversed posting ${g.key} nets to gross ${g.net.grossCents}, broker ${g.net.brokerCents}, agency ${g.net.agencyCents} (cents), not zero.`, [g.key]);
    }
  }

  if (input.statements) {
    const stmtIds = new Set(input.statements.map((s) => s.id));
    for (const g of postings) if (g.statementId && !stmtIds.has(g.statementId)) add('error', 'unknown_statement', `Posting ${g.key} refers to statement ${g.statementId}, which does not exist.`, [g.key]);
    for (const s of input.statements) {
      const mine = postings.filter((g) => g.statementId === s.id);
      const active = mine.filter((g) => g.state === 'active');
      if (s.status === 'posted') {
        if (active.length !== 1) add('error', 'posted_statement_posting_count', `Statement ${s.id} is posted but has ${active.length} active postings in the ledger.`, [s.id]);
        else {
          if (s.posting?.postingId && s.posting.postingId !== active[0].postingId) add('error', 'posted_statement_posting_id', `Statement ${s.id} names posting ${s.posting.postingId}; the ledger's active posting is ${String(active[0].postingId)}.`, [s.id]);
          if ((s.postedCents ?? 0) !== active[0].original.grossCents) add('error', 'posted_amount_mismatch', `Statement ${s.id} posted ${String(s.postedCents)} cents; its ledger entries total ${active[0].original.grossCents}.`, [s.id]);
        }
      } else {
        if (active.length) add('error', 'unposted_statement_has_active_entries', `Statement ${s.id} is "${s.status}" but posting ${active.map((g) => g.key).join(', ')} is still active in the ledger.`, [s.id]);
        if ((s.postedCents ?? 0) !== 0) add('error', 'unposted_statement_posted_cents', `Statement ${s.id} is "${s.status}" with postedCents ${String(s.postedCents)}.`, [s.id]);
      }
      const recorded = new Map((s.reversals ?? []).map((r) => [r.postingId, r]));
      for (const r of s.reversals ?? []) {
        const g = mine.find((x) => x.postingId === r.postingId);
        if (!g || g.state !== 'reversed' || g.reversal.grossCents !== r.amountCents) {
          add('error', 'reversal_record_mismatch', `Statement ${s.id} records reversal of ${r.postingId} (${r.amountCents} cents), but the ledger shows ${g ? `${g.state}, reversal ${g.reversal.grossCents}` : 'no such posting'}.`, [s.id, r.postingId]);
        }
      }
      for (const g of mine) if (g.state === 'reversed' && g.postingId && !recorded.has(g.postingId)) add('error', 'reversal_not_recorded_on_statement', `Posting ${g.postingId} is reversed in the ledger but not recorded on statement ${s.id}.`, [s.id, g.postingId]);
    }
  }

  const reportable = entries.filter(isReportable);
  const errors = findings.filter((f) => f.severity === 'error').length;
  return {
    ok: errors === 0,
    errors,
    warnings: findings.length - errors,
    findings,
    totals: ledgerTotals(reportable, input.legacyBroker),
    window: input.window ? { ...input.window, totals: ledgerTotals(reportable.filter((e) => inRange(e, input.window)), input.legacyBroker) } : null,
    postings,
    counts: {
      entries: entries.length,
      originals: entries.filter((e) => !e.reversalOf).length,
      reversals: entries.filter((e) => !!e.reversalOf).length,
      postings: postings.length,
      activePostings: postings.filter((g) => g.state === 'active').length,
      reversedPostings: postings.filter((g) => g.state === 'reversed').length,
      statements: input.statements?.length ?? 0,
    },
  };
}
