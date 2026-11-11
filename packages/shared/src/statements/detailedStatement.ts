import { parseMoneyToCents, type Cents } from '../money.js';
import { normalizePolicyNumber } from '../normalize.js';
import { parseFlexibleDate } from '../importMap.js';
import type { IsoDate, Month } from '../period.js';
import type { ExtractedLine, ExtractedStatement, LineIssue, SourceAccounting, StatementAdjustment, TransactionType } from './types.js';

/**
 * Deterministic reader for the carrier "DetailedStatement" Excel export: a "Detailed" sheet of
 * transaction rows and a "Summary" sheet of totals. Recognized by its sheets and column headers (never
 * the file name). No AI is involved for this layout.
 *
 * ACCOUNTING (business rule "Option B — agency absorbs MVR charges", confirmed by the owner):
 *   - each transaction row becomes one statement line whose paid commission is GROSS COMM; broker
 *     splits are computed from it, exactly as for any other statement line;
 *   - where NET DUE AGENT differs from Gross Comm on a row, the difference must be an MVR charge
 *     (identified by an MVR column or "MVR" on the row). It becomes ONE statement-level adjustment:
 *     carrier level, 100 % agency, never split with a broker and never a policy commission;
 *   - a row that is only an MVR charge (no Gross Comm) becomes only that adjustment, no line;
 *   - the plain "Comm" column is ignored (its meaning is not defined by the carrier).
 * Reconciliation (exact to the cent, enforced by reconcileStatement and the checks below):
 *   Σ Gross Comm                    = Summary "Commissions - Current"
 *   Σ Gross Comm + Σ MVR adjustments = Summary "Net Amount Due Agent"
 *   Σ Net Due Agent (every row)     = Summary "Net Amount Due Agent"   (catches a double-counted charge)
 *   every data row is a line, an adjustment-only row or a verified total row — nothing is dropped.
 * Anything else that does not add up — an unexplained Net/Gross difference, a positive MVR amount, an
 * MVR row whose charge sits inside Gross Comm, mixed Month End values, a missing or repeated Summary
 * total, an unreadable amount — is an ERROR: the statement is stored as a discrepancy and cannot be
 * approved or posted. Nothing is guessed.
 */

export const DETAILED_STATEMENT_READER = 'detailed-statement-v1' as const;

export interface Sheet { name: string; rows: string[][] }

type Role = 'gross' | 'net' | 'comm' | 'monthEnd' | 'policy' | 'insured' | 'transType' | 'effDate' | 'premium' | 'company' | 'agency' | 'mvr';

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9#%]+/g, ' ').trim();
/** Header patterns, matched against the normalized header text (whole text). */
const ROLE_PATTERNS: Record<Role, RegExp> = {
  gross: /^gross comm(ission)?s?( amount| amt)?$/,
  net: /^net (amount )?due (to )?agent$/,
  comm: /^comm(ission)?s?$/,
  monthEnd: /^month end(ing)?( date)?$/,
  policy: /^pol(icy)?( (number|num|no|nbr))?( #)?$|^pol(icy)? ?#$/,
  insured: /^(named )?insured( name)?$|^(customer|client)( name)?$|^name$/,
  transType: /^trans(action)? ?(type|code|desc|description)?$|^(type|activity)$/,
  effDate: /^(pol(icy)? )?eff(ective)?( date| dt)?$/,
  premium: /^(written |trans(action)? )?prem(ium)?( amount| amt)?$/,
  company: /^(company|carrier|insurer|writing (company|co))( name)?$/,
  agency: /^(agency|agent|producer)( (code|number|no|#))?$/,
  mvr: /(^| )mvrs?( |$)/,
};
const REQUIRED: Role[] = ['gross', 'net', 'monthEnd', 'policy'];
const ROLE_LABEL: Record<Role, string> = {
  gross: 'Gross Comm', net: 'Net Due Agent', comm: 'Comm', monthEnd: 'Month End', policy: 'Policy number', insured: 'Insured',
  transType: 'Transaction type', effDate: 'Effective date', premium: 'Premium', company: 'Company', agency: 'Agency code', mvr: 'MVR',
};

export interface DetailedColumns { [role: string]: { index: number; header: string } }

export interface DetailedReport {
  sheet: string;
  summarySheet: string;
  headerRow: number; // 1-based among the sheet's non-blank rows
  columns: DetailedColumns;
  ignoredCommTotalCents: Cents | null;
  grossTotalCents: Cents;
  netColumnTotalCents: Cents;
  mvr: { count: number; totalCents: Cents; identifiedBy: string[] };
  summary: { commissionsCurrentCents: Cents | null; netAmountDueAgentCents: Cents | null; mvrCents: Cents | null; labels: { label: string; cents: Cents }[] };
  monthEndValues: string[];
  /** Independent checks of the reader (the two Summary checks are also run by reconcileStatement). */
  checks: { key: string; label: string; ok: boolean; expectedCents?: Cents | null; actualCents?: Cents | null; detail?: string }[];
}

export type DetailedReadResult =
  | { kind: 'not_this_layout' }
  | { kind: 'incomplete'; code: string; message: string; detail: string }
  | { kind: 'statement'; statement: ExtractedStatement; report: DetailedReport };

function findRoles(header: string[]): { cols: DetailedColumns; ambiguous: string[] } {
  const cols: DetailedColumns = {};
  const ambiguous: string[] = [];
  for (const role of Object.keys(ROLE_PATTERNS) as Role[]) {
    const hits = header.map((h, i) => ({ h, i })).filter(({ h }) => ROLE_PATTERNS[role].test(norm(h)));
    // A "Gross Comm" header must not also be counted as the MVR column, etc.
    const own = role === 'mvr' ? hits.filter(({ i }) => !Object.values(cols).some((c) => c.index === i)) : hits;
    if (own.length === 1) cols[role] = { index: own[0].i, header: own[0].h };
    else if (own.length > 1) ambiguous.push(`${ROLE_LABEL[role]}: ${own.map((x) => `"${x.h}"`).join(', ')}`);
  }
  return { cols, ambiguous };
}

/** Does this sheet look like the Detailed sheet (a Gross Comm or Net Due Agent header)? */
function headerIndex(rows: string[][]): number {
  // Either commission header marks the layout; a missing partner column is then reported, never guessed.
  return rows.findIndex((r) => r.filter((c) => c.trim() !== '').length >= 3 && r.some((c) => ROLE_PATTERNS.gross.test(norm(c)) || ROLE_PATTERNS.net.test(norm(c))));
}

function money(cell: string | undefined): { cents: Cents | null; bad: boolean } {
  const s = (cell ?? '').trim();
  if (!s) return { cents: null, bad: false };
  try { return { cents: parseMoneyToCents(s), bad: false }; } catch { return { cents: null, bad: true }; }
}

const fmt = (c: Cents) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function transactionType(raw: string): TransactionType {
  const c = raw.trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (!c) return 'other';
  if (/^(NB|NEW|NEWBUS|NEWBUSINESS)$/.test(c)) return 'new_business';
  if (/^(RN|RNW|RNWL|REN|RENEW|RENEWAL|CONT|CONTINUATION)$/.test(c)) return 'continuation';
  if (/^(EN|END|ENDT|ENDORSE|ENDORSEMENT|CHG|CHANGE|PC|POLICYCHANGE)$/.test(c)) return 'endorsement';
  if (/^(CN|CX|CAN|CANC|CANCEL|CANCELLATION|XLN|FLAT|FLATCANCEL)/.test(c)) return 'cancellation';
  if (/^(RI|REI|REIN|REINST|REINSTATE|REINSTATEMENT)$/.test(c)) return 'reinstatement';
  if (/^(REV|REVERSAL|NSF|UNHON)/.test(c)) return 'reversal';
  return 'other';
}

/** Summary "label → amount" pairs: label then value on one row, or a label row above a value row. */
export function summaryPairs(rows: string[][]): { label: string; cents: Cents }[] {
  const out: { label: string; cents: Cents }[] = [];
  const isLabel = (c: string) => /[A-Za-z]/.test(c) && money(c).cents === null;
  rows.forEach((r, i) => {
    for (let j = 0; j < r.length; j++) {
      if (!isLabel(r[j] ?? '')) continue;
      for (let k = j + 1; k < r.length; k++) {
        const c = money(r[k]).cents;
        if (c !== null) { out.push({ label: r[j].trim(), cents: c }); break; }
        if (isLabel(r[k] ?? '')) break;
      }
    }
    const next = rows[i + 1];
    if (next && r.every((c) => c === '' || isLabel(c)) && next.some((c) => money(c).cents !== null)) {
      r.forEach((lab, j) => { const c = money(next[j]).cents; if (lab && c !== null && !out.some((p) => p.label === lab.trim() && p.cents === c)) out.push({ label: lab.trim(), cents: c }); });
    }
  });
  return out;
}

const SUMMARY_COMMISSIONS = /^commissions? (current|this (month|period))$/;
const SUMMARY_NET = /^net (amount )?due (to )?agent( current)?$/;
const SUMMARY_MVR = /(^| )mvrs?( |$)/;

/** One Summary total by label; null if absent; an error if printed more than once with different amounts. */
function summaryTotal(pairs: { label: string; cents: Cents }[], re: RegExp): { cents: Cents | null; error: string | null } {
  const hits = pairs.filter((p) => re.test(norm(p.label)));
  const values = [...new Set(hits.map((h) => h.cents))];
  if (!hits.length) return { cents: null, error: null };
  if (values.length > 1) return { cents: null, error: `"${hits[0].label}" is printed with different amounts (${values.map(fmt).join(', ')})` };
  return { cents: values[0], error: null };
}

/**
 * Read a DetailedStatement workbook. `not_this_layout` → use the other readers (AI). `incomplete` → it IS
 * this layout but a required column or sheet is missing: refuse the file (never hand it to the AI).
 */
export function readDetailedStatement(sheets: Sheet[]): DetailedReadResult {
  const detailed = sheets.find((s) => /^detail/i.test(s.name.trim()) && headerIndex(s.rows) >= 0)
    ?? sheets.find((s) => headerIndex(s.rows) >= 0 && sheets.some((o) => o !== s && /^summar/i.test(o.name.trim())));
  if (!detailed) return { kind: 'not_this_layout' };
  const summary = sheets.find((s) => /^summar/i.test(s.name.trim()));
  if (!summary) {
    return { kind: 'incomplete', code: 'detailed_no_summary', message: 'This looks like a carrier DetailedStatement (Gross Comm and Net Due Agent columns), but its Summary sheet is missing, so the totals cannot be verified.', detail: `sheets: ${sheets.map((s) => s.name).join(', ')}` };
  }

  const hi = headerIndex(detailed.rows);
  const header = detailed.rows[hi];
  const { cols, ambiguous } = findRoles(header);
  const missing = REQUIRED.filter((r) => !cols[r]);
  if (missing.length || ambiguous.length) {
    return {
      kind: 'incomplete', code: 'detailed_columns',
      message: `This looks like a carrier DetailedStatement, but ${missing.length ? `required column(s) are missing: ${missing.map((r) => ROLE_LABEL[r]).join(', ')}` : ''}${missing.length && ambiguous.length ? '; and ' : ''}${ambiguous.length ? `more than one column could be: ${ambiguous.join('; ')}` : ''}. It was not read.`,
      detail: `headers: ${header.map((h, i) => `${i + 1}. ${h}`).join(' | ')}`,
    };
  }
  const col = (r: Role) => cols[r]?.index ?? -1;
  const cell = (row: string[], r: Role) => (col(r) >= 0 ? (row[col(r)] ?? '').trim() : '');

  const issues: LineIssue[] = [];
  const lines: ExtractedLine[] = [];
  const adjustments: StatementAdjustment[] = [];
  const data = detailed.rows.slice(hi + 1);
  const firstDataRow = hi + 2; // 1-based position among the sheet's non-blank rows
  const rowsWithErrors: number[] = [];
  let totalRows = 0, adjustmentOnlyRows = 0, gross = 0, netCol = 0, commTotal = 0, commOk = true, mvrTotal = 0, mvrCount = 0;
  const identifiedBy = new Set<string>();
  const monthEnds = new Map<string, number>();
  const companies = new Set<string>();
  const agencies = new Set<string>();
  const runningGross: number[] = []; const runningNet: number[] = [];
  const textCols = header.map((_, j) => j).filter((j) => ![col('insured'), col('policy'), col('gross'), col('net'), col('comm'), col('premium')].includes(j));
  const rawOf = (row: string[]) => header.map((h, j) => `${h}=${row[j] ?? ''}`).join(' | ');

  data.forEach((row, k) => {
    const sheetRow = firstDataRow + k;
    const rowIssues: LineIssue[] = [];
    const g = money(row[col('gross')]);
    const n = money(row[col('net')]);
    const c = cols.comm ? money(row[col('comm')]) : { cents: 0, bad: false };
    if (c.bad) commOk = false; else commTotal += c.cents ?? 0;
    if (g.bad) rowIssues.push({ level: 'error', code: 'bad_amount', text: `Row ${sheetRow}: Gross Comm "${row[col('gross')]}" could not be read` });
    if (n.bad) rowIssues.push({ level: 'error', code: 'bad_amount', text: `Row ${sheetRow}: Net Due Agent "${row[col('net')]}" could not be read` });
    const grossC = g.cents ?? 0;
    const netC = n.cents ?? 0;
    const policy = cell(row, 'policy');

    // Carrier total / subtotal row: no policy, labelled "total"; verified against the rows above, not counted.
    if (!policy && row.some((v, j) => j !== col('gross') && j !== col('net') && /^(grand |sub ?)?totals?:?$/i.test(v.trim()))) {
      totalRows++;
      const sg = runningGross.reduce((a, b) => a + b, 0), sn = runningNet.reduce((a, b) => a + b, 0);
      if ((g.cents !== null && g.cents !== sg) || (n.cents !== null && n.cents !== sn)) {
        issues.push({ level: 'error', code: 'total_row_mismatch', text: `Row ${sheetRow} is a total row (Gross Comm ${fmt(grossC)}, Net Due Agent ${fmt(netC)}) but the rows above add up to ${fmt(sg)} / ${fmt(sn)}` });
        rowsWithErrors.push(sheetRow);
      }
      runningGross.length = 0; runningNet.length = 0; // a subtotal closes its group
      return;
    }

    gross += grossC; netCol += netC; runningGross.push(grossC); runningNet.push(netC);
    const me = cell(row, 'monthEnd'); monthEnds.set(me, (monthEnds.get(me) ?? 0) + 1);
    if (cell(row, 'company')) companies.add(cell(row, 'company'));
    if (cell(row, 'agency')) agencies.add(cell(row, 'agency'));

    // Is the Net − Gross difference on this row an MVR charge?
    const diff = netC - grossC;
    const mvrCell = cols.mvr ? money(row[col('mvr')]) : { cents: null, bad: false };
    const byColumn = mvrCell.cents !== null && mvrCell.cents !== 0;
    const byText = textCols.some((j) => j !== col('mvr') && /\bm\.?v\.?r\.?s?\b|motor vehicle (record|report)/i.test(row[j] ?? ''));
    const isMvr = byColumn || byText;
    let mvrCents: Cents | null = null;

    if (mvrCell.bad) rowIssues.push({ level: 'error', code: 'bad_amount', text: `Row ${sheetRow}: MVR amount "${row[col('mvr')]}" could not be read` });
    if (diff !== 0) {
      if (!isMvr) {
        rowIssues.push({ level: 'error', code: 'net_differs', text: `Row ${sheetRow}: Net Due Agent is ${fmt(netC)} but Gross Comm is ${fmt(grossC)} (difference ${fmt(diff)}), and nothing on the row identifies the difference as an MVR charge. Only MVR charges are handled; confirm what this deduction is.` });
      } else if (diff > 0) {
        rowIssues.push({ level: 'error', code: 'mvr_positive', text: `Row ${sheetRow}: the MVR difference increases the payment (${fmt(diff)}). An MVR refund or reversal is not handled automatically; confirm how it should be recorded.` });
      } else if (byColumn && Math.abs(mvrCell.cents!) !== Math.abs(diff)) {
        rowIssues.push({ level: 'error', code: 'mvr_column_mismatch', text: `Row ${sheetRow}: the MVR column shows ${fmt(mvrCell.cents!)} but Net Due Agent − Gross Comm is ${fmt(diff)}` });
      } else {
        mvrCents = diff;
        if (byColumn) identifiedBy.add(`"${cols.mvr!.header}" column`);
        if (byText) identifiedBy.add('"MVR" text on the row');
      }
    } else if (byColumn) {
      rowIssues.push({ level: 'error', code: 'mvr_column_mismatch', text: `Row ${sheetRow}: the MVR column shows ${fmt(mvrCell.cents!)} but Net Due Agent equals Gross Comm (${fmt(grossC)}), so the charge is not deducted on this row` });
    } else if (isMvr && grossC !== 0) {
      // "MVR" on a row whose Net equals Gross: the charge would sit inside Gross Comm and be split with a broker.
      rowIssues.push({ level: 'error', code: 'mvr_in_gross', text: `Row ${sheetRow}: the row refers to an MVR charge but Net Due Agent equals Gross Comm (${fmt(grossC)}), so the charge cannot be separated from the policy commission. Confirm how this row should be recorded.` });
    }

    const effRaw = cell(row, 'effDate');
    const eff = effRaw ? parseFlexibleDate(effRaw) : null;
    if (eff && typeof eff === 'object') rowIssues.push({ level: 'warning', code: 'bad_date', text: `Effective date "${effRaw}" is not a valid date` });
    const effectiveDate: IsoDate | null = typeof eff === 'string' ? eff : null;

    // A zero-dollar MVR row (no commission, no charge) is recorded as a zero adjustment: kept, never posted.
    if (isMvr && !byColumn && diff === 0 && grossC === 0 && !g.bad && !n.bad) mvrCents = 0;
    const mvrOnly = mvrCents !== null && grossC === 0 && !g.bad;
    if (mvrOnly) {
      // The row is only an MVR charge: one agency-only adjustment, no policy commission line.
      adjustmentOnlyRows++;
      adjustments.push({ label: `MVR chargeback (Detailed row ${sheetRow}${policy ? `, policy ${policy}` : ''})`, amountCents: mvrCents!, source: { sheet: detailed.name, sheetRow, kind: 'mvr', policyNumberRaw: policy, lineNo: null } });
      if (rowIssues.some((i) => i.level === 'error')) { issues.push(...rowIssues.filter((i) => i.level === 'error')); rowsWithErrors.push(sheetRow); }
      return;
    }

    const lineNo = lines.length + 1;
    const transRaw = cell(row, 'transType');
    const prem = cols.premium ? money(row[col('premium')]) : { cents: null, bad: false };
    if (prem.bad) rowIssues.push({ level: 'warning', code: 'bad_premium', text: `Premium "${row[col('premium')]}" could not be read (reference only)` });
    lines.push({
      lineNo, page: null,
      insuredName: cell(row, 'insured'),
      policyNumberRaw: policy, // text exactly as in the workbook (leading zeros kept)
      policyNumberNormalized: normalizePolicyNumber(policy),
      paymentReceivedCents: null,
      paidCommissionCents: g.bad ? null : grossC, // GROSS commission: brokers are paid on gross
      rateBps: null, termCommissionCents: null, premiumForCommissionCents: null,
      transactionPremiumCents: prem.cents, feeCents: null,
      effectiveDate, transactionCodeRaw: transRaw, transactionType: transactionType(transRaw),
      paymentMethod: '', kind: 'commission',
      rawText: rawOf(row),
      issues: rowIssues,
    });
    if (mvrCents !== null) {
      adjustments.push({ label: `MVR chargeback (Detailed row ${sheetRow}${policy ? `, policy ${policy}` : ''})`, amountCents: mvrCents, source: { sheet: detailed.name, sheetRow, kind: 'mvr', policyNumberRaw: policy, lineNo } });
    }
    if (rowIssues.some((i) => i.level === 'error') || !policy) rowsWithErrors.push(sheetRow);
  });
  for (const a of adjustments) { mvrTotal += a.amountCents; mvrCount++; }

  // ---- Month End: one YYYYMM value for every row ----
  const meValues = [...monthEnds.keys()];
  let statementMonth: Month | null = null;
  const only = meValues.length === 1 ? meValues[0] : null;
  const m = only ? /^(\d{4})(\d{2})(?:\.0+)?$/.exec(only) : null;
  if (m && +m[2] >= 1 && +m[2] <= 12) statementMonth = `${m[1]}-${m[2]}`;
  else issues.push({ level: 'error', code: 'month_end', text: meValues.length > 1 ? `Rows have different Month End values (${meValues.map((v) => v || '(blank)').join(', ')}); one statement must cover one month` : `Month End "${only ?? ''}" is not a YYYYMM month` });

  // ---- Summary totals ----
  const pairs = summaryPairs(summary.rows);
  const sc = summaryTotal(pairs, SUMMARY_COMMISSIONS);
  const sn = summaryTotal(pairs, SUMMARY_NET);
  const sm = summaryTotal(pairs, SUMMARY_MVR);
  for (const [t, name] of [[sc, 'Commissions - Current'], [sn, 'Net Amount Due Agent']] as const) {
    if (t.error) issues.push({ level: 'error', code: 'summary_ambiguous', text: `Summary: ${t.error}` });
    else if (t.cents === null) issues.push({ level: 'error', code: 'summary_missing', text: `Summary sheet: "${name}" total not found` });
  }
  if (sm.error) issues.push({ level: 'error', code: 'summary_ambiguous', text: `Summary: ${sm.error}` });

  // ---- Independent checks (reconcileStatement repeats the two Summary checks on the stored lines) ----
  const lineTotal = lines.reduce((s, l) => s + (l.paidCommissionCents ?? 0), 0);
  const checks: DetailedReport['checks'] = [
    { key: 'gross_vs_summary', label: 'Σ Gross Comm = Summary "Commissions - Current"', ok: sc.cents !== null && gross === sc.cents && lineTotal === gross, expectedCents: sc.cents, actualCents: gross },
    { key: 'net_vs_summary', label: 'Σ Gross Comm + MVR adjustments = Summary "Net Amount Due Agent"', ok: sn.cents !== null && lineTotal + mvrTotal === sn.cents, expectedCents: sn.cents, actualCents: lineTotal + mvrTotal },
    { key: 'net_column', label: 'Σ Net Due Agent column = Summary "Net Amount Due Agent" (no charge counted twice)', ok: sn.cents !== null && netCol === sn.cents, expectedCents: sn.cents, actualCents: netCol },
    { key: 'row_identity', label: 'Every row: Gross Comm + its MVR adjustment = its Net Due Agent', ok: lineTotal + mvrTotal === netCol && gross === lineTotal, expectedCents: netCol, actualCents: lineTotal + mvrTotal },
    { key: 'accounted', label: 'Every data row is a line, an MVR-only adjustment or a verified total row', ok: lines.length + adjustmentOnlyRows + totalRows === data.length, detail: `${data.length} rows = ${lines.length} lines + ${adjustmentOnlyRows} MVR-only + ${totalRows} total` },
    { key: 'adjustment_once', label: 'Each MVR charge recorded exactly once', ok: new Set(adjustments.map((a) => a.source!.sheetRow)).size === adjustments.length },
  ];
  if (sm.cents !== null) checks.push({ key: 'mvr_vs_summary', label: 'MVR adjustments = Summary MVR total', ok: Math.abs(sm.cents) === Math.abs(mvrTotal), expectedCents: -Math.abs(sm.cents), actualCents: mvrTotal });
  for (const ch of checks) {
    if (ch.ok) continue;
    // Missing Summary totals are already reported above; do not repeat them.
    if ((ch.key === 'gross_vs_summary' && sc.cents === null) || ((ch.key === 'net_vs_summary' || ch.key === 'net_column') && sn.cents === null)) continue;
    issues.push({ level: 'error', code: `chk_${ch.key}`, text: `${ch.label}: ${ch.detail ?? `expected ${fmt(ch.expectedCents ?? 0)}, found ${fmt(ch.actualCents ?? 0)}`}` });
  }

  // ---- Identical rows: all kept (legitimate repeats exist); flagged for review ----
  const seen = new Map<string, number[]>();
  data.forEach((row, k) => { const key = row.join('\u0001'); seen.set(key, [...(seen.get(key) ?? []), firstDataRow + k]); });
  const identicalRowGroups = [...seen.values()].filter((g2) => g2.length > 1);
  if (identicalRowGroups.length) issues.push({ level: 'warning', code: 'identical_rows', text: `Identical rows (all kept; confirm they are separate transactions): ${identicalRowGroups.map((g2) => `rows ${g2.join(' & ')}`).join('; ')}` });
  if (!lines.length && !adjustments.length) issues.push({ level: 'error', code: 'no_lines', text: 'No transaction rows were found' });

  const sourceAccounting: SourceAccounting = { sheet: detailed.name, rows: data.length, lineRows: lines.length, adjustmentOnlyRows, totalRows, rowsWithErrors: [...new Set(rowsWithErrors)].sort((a, b) => a - b), identicalRowGroups };
  const statement: ExtractedStatement = {
    carrierName: companies.size === 1 ? [...companies][0] : '',
    agencyCode: agencies.size === 1 ? [...agencies][0] : null,
    officeCode: null,
    statementMonth,
    statementDate: null,
    title: 'Detailed Statement',
    pageCount: null,
    stated: {
      commissionPayableCents: sc.cents, // gross policy commission
      monthCommissionPayableCents: sn.cents, // net amount paid to the agency
      paymentReceivedCents: null, premiumForCommissionCents: null, transactionPremiumCents: null, feeCents: null, ytdCommissionPayableCents: null,
    },
    adjustments,
    lines,
    issues,
    sourceAccounting,
    checkLabels: { commission: 'Gross policy commission (Σ Gross Comm) = Summary "Commissions - Current"', monthPayable: 'Net agency payment (gross + agency-only MVR adjustments) = Summary "Net Amount Due Agent"' },
  };
  return {
    kind: 'statement', statement,
    report: {
      sheet: detailed.name, summarySheet: summary.name, headerRow: hi + 1, columns: cols,
      ignoredCommTotalCents: cols.comm && commOk ? commTotal : null,
      grossTotalCents: gross, netColumnTotalCents: netCol,
      mvr: { count: mvrCount, totalCents: mvrTotal, identifiedBy: [...identifiedBy] },
      summary: { commissionsCurrentCents: sc.cents, netAmountDueAgentCents: sn.cents, mvrCents: sm.cents, labels: pairs },
      monthEndValues: meValues, checks,
    },
  };
}
