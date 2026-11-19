import { parseMoneyToCents, parsePercentToBps, type BasisPoints, type Cents } from '../money.js';
import { normalizePolicyNumber } from '../normalize.js';
import { isIsoDate, isMonth, type IsoDate, type Month } from '../period.js';
import { parseCsv } from '../csv.js';
import { TRANSACTION_TYPES, type ExtractedLine, type ExtractedStatement, type StatedTotals, type TransactionType } from './types.js';

/**
 * Manual reconciliation: a person keys (or corrects) a statement's lines and printed totals from the preserved
 * original, when automatic reading fails or reads it wrongly.
 *
 * The result is an ordinary ExtractedStatement, so EVERYTHING downstream is unchanged and shared with
 * AI-read statements:
 *   - exact-to-the-cent reconciliation (reconcileStatement)
 *   - duplicate detection, client/policy matching, approval, posting and the audit log
 * Nothing is balanced or invented: the printed totals are typed as printed, and the statement only reconciles
 * when the typed lines add up to them exactly.
 *
 * What a draft can hold is a closed list of fields (validateManualDraft rejects anything else). It has no
 * broker or split fields: broker shares come only from matching, exactly as for AI-read statements.
 */

export const MANUAL_METHOD = 'manual' as const;
export const MANUAL_MAX_LINES = 2000;
export const MANUAL_REASON_MIN = 5;

export interface ManualLine {
  insuredName: string;
  /** Exactly as printed. */
  policyNumberRaw: string;
  effectiveDate: IsoDate | null;
  transactionType: TransactionType;
  kind: 'commission' | 'payment_only';
  /** The commission actually paid on this line — the only revenue figure. Null on payment-only rows. */
  paidCommissionCents: Cents | null;
  premiumForCommissionCents: Cents | null;
  rateBps: BasisPoints | null;
  paymentReceivedCents: Cents | null;
  transactionPremiumCents: Cents | null;
  page: number | null;
  /** Free text kept with the line (e.g. "keyed from page 1, row 4"). */
  note: string;
}

export interface ManualAdjustment { label: string; amountCents: Cents }

export interface ManualStated {
  /** Sum of the paid-commission column as printed. */
  commissionPayableCents: Cents | null;
  /** Month total payable as printed (after adjustments). */
  monthCommissionPayableCents: Cents | null;
  /** Reference only. */
  ytdCommissionPayableCents: Cents | null;
}

export interface ManualDraft {
  /** An existing carrier / wholesaler. Manual reconciliation never creates one. */
  payerId: string;
  statementMonth: Month | null;
  statementDate: IsoDate | null;
  agencyCode: string;
  stated: ManualStated;
  adjustments: ManualAdjustment[];
  lines: ManualLine[];
  /** Why the statement is reconciled manually. Required to apply. */
  reason: string;
  /** Started from a blank sheet, or from the lines the reader extracted (correction). */
  basedOn: 'blank' | 'extracted';
}

export type ManualValidation = { ok: true; draft: ManualDraft } | { ok: false; errors: string[] };

const LINE_KEYS = ['insuredName', 'policyNumberRaw', 'effectiveDate', 'transactionType', 'kind', 'paidCommissionCents', 'premiumForCommissionCents', 'rateBps', 'paymentReceivedCents', 'transactionPremiumCents', 'page', 'note'] as const;
const DRAFT_KEYS = ['payerId', 'statementMonth', 'statementDate', 'agencyCode', 'stated', 'adjustments', 'lines', 'reason', 'basedOn'] as const;
const STATED_KEYS = ['commissionPayableCents', 'monthCommissionPayableCents', 'ytdCommissionPayableCents'] as const;
const MAX_CENTS = 100_000_000_00; // $100M: far above any real statement; stops typos like an extra 000000.

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const unknownKeys = (o: Record<string, unknown>, allowed: readonly string[]) => Object.keys(o).filter((k) => !allowed.includes(k));

export function emptyManualLine(): ManualLine {
  return { insuredName: '', policyNumberRaw: '', effectiveDate: null, transactionType: 'other', kind: 'commission', paidCommissionCents: null, premiumForCommissionCents: null, rateBps: null, paymentReceivedCents: null, transactionPremiumCents: null, page: null, note: '' };
}

export function emptyManualDraft(payerId = ''): ManualDraft {
  return { payerId, statementMonth: null, statementDate: null, agencyCode: '', stated: { commissionPayableCents: null, monthCommissionPayableCents: null, ytdCommissionPayableCents: null }, adjustments: [], lines: [], reason: '', basedOn: 'blank' };
}

/**
 * Strict check of a manual draft, the same in the browser and on the server.
 *  - 'draft': saving unfinished work — shapes and limits only; blanks allowed.
 *  - 'apply': everything needed to build the statement (carrier, month, a printed total, complete lines, reason).
 * Unknown fields are refused anywhere in the draft, so nothing outside the closed list (e.g. broker data) can be stored.
 */
export function validateManualDraft(input: unknown, mode: 'draft' | 'apply'): ManualValidation {
  const errors: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ['The manual statement is missing.'] };
  const extra = unknownKeys(input, DRAFT_KEYS);
  if (extra.length) errors.push(`Unknown field(s): ${extra.join(', ')}`);

  const str = (v: unknown, label: string, max: number): string => {
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string') { errors.push(`${label} must be text.`); return ''; }
    if (v.length > max) errors.push(`${label} is too long (max ${max} characters).`);
    return v.trim();
  };
  const cents = (v: unknown, label: string): Cents | null => {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) { errors.push(`${label} must be a whole number of cents.`); return null; }
    if (Math.abs(v) > MAX_CENTS) errors.push(`${label} is implausibly large.`);
    return v;
  };

  const payerId = str(input.payerId, 'Carrier', 128);
  if (payerId && !/^[A-Za-z0-9_-]{1,128}$/.test(payerId)) errors.push('Carrier is not valid.');
  const statementMonth = input.statementMonth == null || input.statementMonth === '' ? null : String(input.statementMonth);
  if (statementMonth !== null && !isMonth(statementMonth)) errors.push('Statement month must be YYYY-MM.');
  const statementDate = input.statementDate == null || input.statementDate === '' ? null : String(input.statementDate);
  if (statementDate !== null && !isIsoDate(statementDate)) errors.push('Statement date must be YYYY-MM-DD.');
  const agencyCode = str(input.agencyCode, 'Agency code', 40);
  const reason = str(input.reason, 'Reason', 1000);
  const basedOn = input.basedOn === 'extracted' ? 'extracted' : 'blank';
  if (input.basedOn !== undefined && input.basedOn !== 'blank' && input.basedOn !== 'extracted') errors.push('basedOn must be blank or extracted.');

  const statedIn = input.stated === undefined ? {} : input.stated;
  const stated: ManualStated = { commissionPayableCents: null, monthCommissionPayableCents: null, ytdCommissionPayableCents: null };
  if (!isObj(statedIn)) errors.push('Printed totals are not valid.');
  else {
    const x = unknownKeys(statedIn, STATED_KEYS);
    if (x.length) errors.push(`Unknown field(s) in printed totals: ${x.join(', ')}`);
    stated.commissionPayableCents = cents(statedIn.commissionPayableCents, 'Printed commission total');
    stated.monthCommissionPayableCents = cents(statedIn.monthCommissionPayableCents, 'Printed month payable');
    stated.ytdCommissionPayableCents = cents(statedIn.ytdCommissionPayableCents, 'Printed year-to-date');
  }

  const adjustments: ManualAdjustment[] = [];
  const adjIn = input.adjustments ?? [];
  if (!Array.isArray(adjIn) || adjIn.length > 50) errors.push('Adjustments must be a list of at most 50.');
  else adjIn.forEach((a, i) => {
    if (!isObj(a)) { errors.push(`Adjustment ${i + 1} is not valid.`); return; }
    const x = unknownKeys(a, ['label', 'amountCents']);
    if (x.length) errors.push(`Adjustment ${i + 1}: unknown field(s) ${x.join(', ')}`);
    const label = str(a.label, `Adjustment ${i + 1} label`, 200);
    const amountCents = cents(a.amountCents, `Adjustment ${i + 1} amount`);
    if (mode === 'apply' && (!label || amountCents === null)) errors.push(`Adjustment ${i + 1} needs a label and an amount.`);
    adjustments.push({ label, amountCents: amountCents ?? 0 });
  });

  const lines: ManualLine[] = [];
  const linesIn = input.lines ?? [];
  if (!Array.isArray(linesIn)) errors.push('Lines must be a list.');
  else if (linesIn.length > MANUAL_MAX_LINES) errors.push(`At most ${MANUAL_MAX_LINES} lines.`);
  else linesIn.forEach((l, i) => {
    const n = `Line ${i + 1}`;
    if (!isObj(l)) { errors.push(`${n} is not valid.`); return; }
    const x = unknownKeys(l, LINE_KEYS);
    if (x.length) errors.push(`${n}: unknown field(s) ${x.join(', ')}`);
    const transactionType = (TRANSACTION_TYPES as readonly string[]).includes(String(l.transactionType)) ? l.transactionType as TransactionType : null;
    if (!transactionType) errors.push(`${n}: transaction type is not valid.`);
    const kind = l.kind === 'payment_only' ? 'payment_only' : l.kind === 'commission' ? 'commission' : null;
    if (!kind) errors.push(`${n}: kind must be commission or payment_only.`);
    const effectiveDate = l.effectiveDate == null || l.effectiveDate === '' ? null : String(l.effectiveDate);
    if (effectiveDate !== null && !isIsoDate(effectiveDate)) errors.push(`${n}: effective date must be YYYY-MM-DD.`);
    let rateBps: BasisPoints | null = null;
    if (l.rateBps != null) {
      if (typeof l.rateBps !== 'number' || !Number.isSafeInteger(l.rateBps) || Math.abs(l.rateBps) > 10000) errors.push(`${n}: rate must be between -100% and 100%.`);
      else rateBps = l.rateBps;
    }
    let page: number | null = null;
    if (l.page != null) {
      if (typeof l.page !== 'number' || !Number.isSafeInteger(l.page) || l.page < 1 || l.page > 10000) errors.push(`${n}: page must be a positive whole number.`);
      else page = l.page;
    }
    const line: ManualLine = {
      insuredName: str(l.insuredName, `${n} insured`, 200),
      policyNumberRaw: str(l.policyNumberRaw, `${n} policy number`, 80),
      effectiveDate,
      transactionType: transactionType ?? 'other',
      kind: kind ?? 'commission',
      paidCommissionCents: cents(l.paidCommissionCents, `${n} commission`),
      premiumForCommissionCents: cents(l.premiumForCommissionCents, `${n} premium`),
      rateBps,
      paymentReceivedCents: cents(l.paymentReceivedCents, `${n} payment received`),
      transactionPremiumCents: cents(l.transactionPremiumCents, `${n} transaction premium`),
      page,
      note: str(l.note, `${n} note`, 300),
    };
    if (mode === 'apply') {
      if (!normalizePolicyNumber(line.policyNumberRaw)) errors.push(`${n}: policy number is required.`);
      if (line.kind === 'commission' && line.paidCommissionCents === null) errors.push(`${n}: commission amount is required (enter 0.00 if the statement prints zero).`);
      if (line.kind === 'payment_only' && line.paidCommissionCents !== null) errors.push(`${n}: a payment-only line cannot carry a commission.`);
    }
    lines.push(line);
  });

  if (mode === 'apply') {
    if (!payerId) errors.push('Choose the carrier or wholesaler.');
    if (!statementMonth) errors.push('Enter the statement month.');
    if (stated.commissionPayableCents === null && stated.monthCommissionPayableCents === null) errors.push('Enter at least one total exactly as printed on the statement (commission total or month payable).');
    if (!lines.length) errors.push('Enter at least one line.');
    if (reason.length < MANUAL_REASON_MIN) errors.push('Give a short reason for reconciling this statement manually.');
  }

  return errors.length ? { ok: false, errors } : { ok: true, draft: { payerId, statementMonth, statementDate, agencyCode, stated, adjustments, lines, reason, basedOn } };
}

/** Build the ordinary statement the rest of the system uses. Call only with a draft validated in 'apply' mode. */
export function manualDraftToStatement(d: ManualDraft, carrierName: string): ExtractedStatement {
  const stated: StatedTotals = {
    commissionPayableCents: d.stated.commissionPayableCents,
    monthCommissionPayableCents: d.stated.monthCommissionPayableCents,
    paymentReceivedCents: null, premiumForCommissionCents: null, transactionPremiumCents: null, feeCents: null,
    ytdCommissionPayableCents: d.stated.ytdCommissionPayableCents,
  };
  const lines: ExtractedLine[] = d.lines.map((l, i) => ({
    lineNo: i + 1,
    page: l.page,
    insuredName: l.insuredName,
    policyNumberRaw: l.policyNumberRaw,
    policyNumberNormalized: normalizePolicyNumber(l.policyNumberRaw),
    paymentReceivedCents: l.paymentReceivedCents,
    paidCommissionCents: l.kind === 'payment_only' ? null : l.paidCommissionCents,
    rateBps: l.rateBps,
    termCommissionCents: null,
    premiumForCommissionCents: l.premiumForCommissionCents,
    transactionPremiumCents: l.transactionPremiumCents,
    feeCents: null,
    effectiveDate: l.effectiveDate,
    transactionCodeRaw: '',
    transactionType: l.transactionType,
    paymentMethod: '',
    kind: l.kind,
    rawText: `Manual entry${l.note ? `: ${l.note}` : ''}`,
    issues: [],
  }));
  return {
    carrierName,
    agencyCode: d.agencyCode || null,
    officeCode: null,
    statementMonth: d.statementMonth,
    statementDate: d.statementDate,
    title: 'Manual reconciliation',
    pageCount: null,
    stated,
    adjustments: d.adjustments.map((a) => ({ label: a.label, amountCents: a.amountCents })),
    lines,
    issues: [{ level: 'warning', code: 'manual_entry', text: 'Lines and printed totals were entered manually from the original statement. Check them against the original before approving.' }],
  };
}

/** Start a correction from what the reader extracted (statement fields + its current lines). */
export function draftFromExtracted(
  stmt: { payerId?: string | null; statementMonth?: string | null; statementDate?: string | null; agencyCode?: string | null; stated?: Partial<StatedTotals> | null; adjustments?: { label: string; amountCents: number }[] | null },
  lines: Pick<ExtractedLine, 'lineNo' | 'insuredName' | 'policyNumberRaw' | 'effectiveDate' | 'transactionType' | 'kind' | 'paidCommissionCents' | 'premiumForCommissionCents' | 'rateBps' | 'paymentReceivedCents' | 'transactionPremiumCents' | 'page'>[],
): ManualDraft {
  return {
    payerId: stmt.payerId ?? '',
    statementMonth: stmt.statementMonth ?? null,
    statementDate: stmt.statementDate ?? null,
    agencyCode: stmt.agencyCode ?? '',
    stated: {
      commissionPayableCents: stmt.stated?.commissionPayableCents ?? null,
      monthCommissionPayableCents: stmt.stated?.monthCommissionPayableCents ?? null,
      ytdCommissionPayableCents: stmt.stated?.ytdCommissionPayableCents ?? null,
    },
    adjustments: (stmt.adjustments ?? []).map((a) => ({ label: a.label, amountCents: a.amountCents })),
    lines: [...lines].sort((a, b) => a.lineNo - b.lineNo).map((l) => ({
      insuredName: l.insuredName ?? '', policyNumberRaw: l.policyNumberRaw ?? '', effectiveDate: l.effectiveDate ?? null,
      transactionType: l.transactionType, kind: l.kind, paidCommissionCents: l.paidCommissionCents ?? null,
      premiumForCommissionCents: l.premiumForCommissionCents ?? null, rateBps: l.rateBps ?? null,
      paymentReceivedCents: l.paymentReceivedCents ?? null, transactionPremiumCents: l.transactionPremiumCents ?? null,
      page: l.page ?? null, note: '',
    })),
    reason: '',
    basedOn: 'extracted',
  };
}

const CMP_FIELDS = ['insuredName', 'policyNumberRaw', 'effectiveDate', 'transactionType', 'kind', 'paidCommissionCents', 'premiumForCommissionCents', 'rateBps', 'paymentReceivedCents', 'transactionPremiumCents'] as const;
type CmpLine = Partial<Record<(typeof CMP_FIELDS)[number], unknown>> & { lineNo: number };

/** Line-by-line differences between the lines replaced and the manual lines, for the audit log (capped). */
export function manualLineChanges(before: CmpLine[], after: CmpLine[], cap = 200): {
  before: number; after: number; changedLines: number;
  changes: { lineNo: number; field: string; before: unknown; after: unknown }[]; truncated: boolean;
} {
  const byNo = new Map(before.map((l) => [l.lineNo, l]));
  const changes: { lineNo: number; field: string; before: unknown; after: unknown }[] = [];
  const changed = new Set<number>();
  for (const a of after) {
    const b = byNo.get(a.lineNo);
    for (const f of CMP_FIELDS) {
      const bv = b ? b[f] ?? null : null;
      const av = a[f] ?? null;
      if (JSON.stringify(bv) !== JSON.stringify(av)) { changed.add(a.lineNo); changes.push({ lineNo: a.lineNo, field: f, before: b ? bv : '(new line)', after: av }); }
    }
  }
  const afterNos = new Set(after.map((l) => l.lineNo));
  for (const b of before) {
    if (!afterNos.has(b.lineNo)) { changed.add(b.lineNo); changes.push({ lineNo: b.lineNo, field: '(line)', before: `${String(b.policyNumberRaw ?? '')} ${String(b.paidCommissionCents ?? '')}`.trim(), after: '(removed)' }); }
  }
  return { before: before.length, after: after.length, changedLines: changed.size, changes: changes.slice(0, cap), truncated: changes.length > cap };
}

// ---------------------------------------------------------------- CSV transaction import

/** Header row of the CSV template (any order; extra columns are refused so nothing is silently dropped). */
export const MANUAL_CSV_TEMPLATE = 'Insured,Policy number,Effective date,Transaction type,Premium,Rate,Commission,Payment received,Page,Note';

const CSV_COLUMNS: Record<string, keyof ManualLine> = {
  insured: 'insuredName', 'insured name': 'insuredName', name: 'insuredName',
  policy: 'policyNumberRaw', 'policy number': 'policyNumberRaw', 'policy #': 'policyNumberRaw', 'policy no': 'policyNumberRaw',
  'effective date': 'effectiveDate', effective: 'effectiveDate', 'eff date': 'effectiveDate',
  'transaction type': 'transactionType', type: 'transactionType', transaction: 'transactionType',
  premium: 'premiumForCommissionCents', 'premium for commission': 'premiumForCommissionCents',
  rate: 'rateBps', 'commission rate': 'rateBps', 'rate %': 'rateBps',
  commission: 'paidCommissionCents', 'paid commission': 'paidCommissionCents', 'commission paid': 'paidCommissionCents',
  'payment received': 'paymentReceivedCents', payment: 'paymentReceivedCents',
  'transaction premium': 'transactionPremiumCents',
  page: 'page',
  note: 'note', notes: 'note',
};

const TYPE_WORDS: Record<string, TransactionType> = {
  '': 'other', other: 'other',
  new: 'new_business', nb: 'new_business', 'new business': 'new_business',
  renewal: 'continuation', ren: 'continuation', rwl: 'continuation', cont: 'continuation', continuation: 'continuation',
  endorsement: 'endorsement', end: 'endorsement', endt: 'endorsement', change: 'endorsement', chg: 'endorsement',
  cancellation: 'cancellation', cancel: 'cancellation', can: 'cancellation', canc: 'cancellation', cxl: 'cancellation',
  reinstatement: 'reinstatement', rei: 'reinstatement', rein: 'reinstatement',
  reversal: 'reversal', rev: 'reversal',
  installment: 'installment_payment', 'installment payment': 'installment_payment', payment: 'installment_payment', pay: 'installment_payment',
};

function csvDate(v: string): IsoDate | null | undefined {
  const s = v.trim();
  if (!s) return null;
  if (isIsoDate(s)) return s;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (!m) return undefined;
  const y = m[3].length === 2 ? `20${m[3]}` : m[3];
  const d = `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return isIsoDate(d) ? d : undefined;
}

/**
 * Read transaction lines from a CSV (the template above, or any file with those column names).
 * All or nothing: if any row has an error, no lines are returned, so a partly-read file is never imported.
 * The lines only fill the manual editor; they are validated again and reconciled when the statement is applied.
 */
export function parseManualCsv(text: string): { lines: ManualLine[]; errors: string[] } {
  let rows: string[][];
  try { rows = parseCsv(text).filter((r) => r.some((c) => c.trim())); } catch (e) { return { lines: [], errors: [`The CSV could not be read: ${(e as Error).message}`] }; }
  if (rows.length < 2) return { lines: [], errors: ['The CSV needs a header row and at least one transaction.'] };
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, ' '));
  const map: (keyof ManualLine)[] = [];
  const errors: string[] = [];
  header.forEach((h, i) => {
    const f = CSV_COLUMNS[h];
    if (!f) errors.push(`Column ${i + 1} "${rows[0][i]}" is not recognized. Use: ${MANUAL_CSV_TEMPLATE}`);
    else if (map.includes(f)) errors.push(`Column "${rows[0][i]}" appears twice.`);
    map.push(f);
  });
  if (!map.includes('policyNumberRaw')) errors.push('A "Policy number" column is required.');
  if (!map.includes('paidCommissionCents')) errors.push('A "Commission" column is required.');
  if (errors.length) return { lines: [], errors };
  if (rows.length - 1 > MANUAL_MAX_LINES) return { lines: [], errors: [`At most ${MANUAL_MAX_LINES} lines.`] };

  const lines: ManualLine[] = [];
  rows.slice(1).forEach((r, ri) => {
    const rowNo = ri + 2;
    if (r.length > header.length && r.slice(header.length).some((c) => c.trim())) { errors.push(`Row ${rowNo}: more values than columns.`); return; }
    const l = emptyManualLine();
    let typeGiven = false;
    map.forEach((f, ci) => {
      const v = (r[ci] ?? '').trim();
      const money = (): Cents | null => { if (!v) return null; try { return parseMoneyToCents(v); } catch { errors.push(`Row ${rowNo}: "${v}" is not an amount.`); return null; } };
      switch (f) {
        case 'insuredName': l.insuredName = v; break;
        case 'policyNumberRaw': l.policyNumberRaw = v; break;
        case 'note': l.note = v.slice(0, 300); break;
        case 'effectiveDate': { const d = csvDate(v); if (d === undefined) errors.push(`Row ${rowNo}: "${v}" is not a date (use YYYY-MM-DD or M/D/YYYY).`); else l.effectiveDate = d; break; }
        case 'transactionType': {
          const key = v.toLowerCase().replace(/[_-]+/g, ' ').trim();
          const t = TYPE_WORDS[key] ?? (TRANSACTION_TYPES as readonly string[]).find((x) => x.replace(/_/g, ' ') === key) as TransactionType | undefined;
          if (!t) errors.push(`Row ${rowNo}: transaction type "${v}" is not recognized.`); else { l.transactionType = t; typeGiven = v !== ''; }
          break;
        }
        case 'rateBps': if (v) { try { l.rateBps = parsePercentToBps(v); } catch { errors.push(`Row ${rowNo}: "${v}" is not a rate.`); } } break;
        case 'page': if (v) { const p = Number(v); if (!Number.isSafeInteger(p) || p < 1) errors.push(`Row ${rowNo}: page "${v}" is not valid.`); else l.page = p; } break;
        case 'paidCommissionCents': l.paidCommissionCents = money(); break;
        case 'premiumForCommissionCents': l.premiumForCommissionCents = money(); break;
        case 'paymentReceivedCents': l.paymentReceivedCents = money(); break;
        case 'transactionPremiumCents': l.transactionPremiumCents = money(); break;
        default: break;
      }
    });
    // A payment row with no commission is a payment-only line; everything else is a commission line.
    if (typeGiven && l.transactionType === 'installment_payment' && l.paidCommissionCents === null) l.kind = 'payment_only';
    if (!l.policyNumberRaw) errors.push(`Row ${rowNo}: policy number is missing.`);
    if (l.kind === 'commission' && l.paidCommissionCents === null) errors.push(`Row ${rowNo}: commission is missing (enter 0.00 if the statement prints zero).`);
    lines.push(l);
  });
  return errors.length ? { lines: [], errors } : { lines, errors: [] };
}

/**
 * Whether a statement can be reconciled manually, and why not. Same rules as a re-read: never once anything
 * from it was approved or posted (posted financial records are never changed by this feature), and only when
 * the original file is preserved, so every keyed figure can be checked against it.
 */
export function manualEditBlocker(s: { status?: unknown; postedCents?: unknown; postingSeq?: unknown; reversals?: unknown; originalPath?: unknown }): string | null {
  if (!['extraction_failed', 'needs_review', 'discrepancy'].includes(String(s.status))) {
    return s.status === 'approved' || s.status === 'posted'
      ? 'An approved or posted statement cannot be changed. Return it to review (or reverse its posting) first.'
      : `This statement is ${String(s.status)}.`;
  }
  if (Number(s.postedCents ?? 0) !== 0) return 'Lines from this statement have been posted.';
  if (Number(s.postingSeq ?? 0) > 0 || (Array.isArray(s.reversals) && s.reversals.length > 0)) {
    return 'This statement has posting history, so its lines are kept as the source of those ledger entries. Discard it and upload the file as a new statement instead.';
  }
  if (typeof s.originalPath !== 'string' || !s.originalPath.trim()) return 'The original file was never stored for this statement, so it cannot be reconciled manually against it. Upload the statement again.';
  return null;
}
