import { parseMoneyToCents, type Cents } from '../money.js';
import { normalizePolicyNumber } from '../normalize.js';
import { isIsoDate, type IsoDate, type Month } from '../period.js';
import type { ExtractedLine, ExtractedStatement, LineIssue, StatementAdjustment, TransactionType } from './types.js';

/**
 * Deterministic parser for the Travelers "PERSONAL INSURANCE COMMISSION & ACCOUNTING
 * INFORMATION STATEMENT". The layout prints every column separated by "¡"; each data row is:
 *
 *   NAME ¡ POLICY ¡ PAYMENT RECEIVED ¡ PAID COMMISSION ¡ COMM RATE ¡ POLICY TERM COMMISSION ¡
 *   PREMIUM FOR COMMISSION ¡ POL-EFF-DT/TRANS-CODE ¡ PMT MTD ¡ POLHOLDERS SRVS FEE ¡ TRANSACTION PREMIUM
 *
 * Amounts use a trailing minus for negatives ("56.25-"). COMM RATE is basis points ("1200" = 12.00%).
 * POL-EFF-DT/TRANS-CODE is "MMDDYY-CODE" (e.g. "120325-CONT") or a code alone ("UNHON-CHECK").
 * Rows with a payment but no paid commission are installment payments (commission was paid on
 * the first installment — payment method "I").
 */

export const TRAVELERS_PL_PARSER = 'travelers-pl-v1' as const;
const SEP = '¡'; // ¡

const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

export function isTravelersPlStatement(pages: string[][]): boolean {
  const text = pages.flat().join('\n').replace(/[ \t]+/g, ' ');
  return /PERSONAL INSURANCE COMMISSION\s*&\s*ACCOUNTING INFORMATION STATEMENT\s*-\s*TRAVELERS/i.test(text)
    && text.includes(SEP)
    && /NAME OF INSURED/i.test(text);
}

function money(cell: string, issues: LineIssue[], label: string): Cents | null {
  const s = cell.trim();
  if (!s) return null;
  try {
    return parseMoneyToCents(s);
  } catch {
    issues.push({ level: 'error', code: 'bad_amount', text: `${label} "${s}" could not be read` });
    return null;
  }
}

function transactionType(code: string, hasPaid: boolean): TransactionType {
  const c = code.toUpperCase();
  if (!c) return hasPaid ? 'other' : 'installment_payment';
  if (c === 'CONT' || c === 'RENEW' || c === 'RNWL') return 'continuation';
  if (c === 'CHANGE' || c === 'CHG' || c === 'END') return 'endorsement';
  if (c.startsWith('CANC')) return 'cancellation';
  if (c.startsWith('REIN')) return 'reinstatement';
  if (c === 'NEW' || c === 'NB' || c === 'NEWBUS') return 'new_business';
  if (c.startsWith('UNHON') || c.includes('CHECK') || c.startsWith('REV')) return 'reversal';
  return 'other';
}

/** "120325-CONT" → { date: 2025-12-03, code: CONT }; "UNHON-CHECK" → { date: null, code: UNHON-CHECK } */
export function splitEffCode(cell: string): { date: IsoDate | null; code: string; bad: boolean } {
  const s = cell.trim().toUpperCase();
  if (!s) return { date: null, code: '', bad: false };
  const m = /^(\d{2})(\d{2})(\d{2})-(.+)$/.exec(s);
  if (!m) return { date: null, code: s, bad: false };
  const iso = `20${m[3]}-${m[1]}-${m[2]}`;
  return isIsoDate(iso) ? { date: iso, code: m[4].trim(), bad: false } : { date: null, code: m[4].trim(), bad: true };
}

const NEGATIVE_TYPES: TransactionType[] = ['cancellation', 'reversal'];

function findAmount(text: string, re: RegExp): Cents | null {
  const all = [...text.matchAll(re)];
  if (!all.length) return null;
  try { return parseMoneyToCents(all[all.length - 1][1]); } catch { return null; }
}

export function parseTravelersPl(rawPages: string[][]): ExtractedStatement {
  // Text extraction may split words with extra spaces; collapse them before matching.
  const pages = rawPages.map((p) => p.map((l) => l.replace(/[ \t]+/g, ' ')));
  const issues: LineIssue[] = [];
  const lines: ExtractedLine[] = [];
  const text = pages.map((p) => p.join('\n')).join('\n');

  // ---- Header ----
  const monthMatch = /\b(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s+(\d{4})\s+OFF:\s*(\d+)/i.exec(text);
  let statementMonth: Month | null = null;
  let officeCode: string | null = null;
  if (monthMatch) {
    statementMonth = `${monthMatch[2]}-${String(MONTHS.indexOf(monthMatch[1].toUpperCase()) + 1).padStart(2, '0')}`;
    officeCode = monthMatch[3];
  } else {
    issues.push({ level: 'error', code: 'no_month', text: 'Statement month not found in the header' });
  }
  const agency = /AGENT CODE:\s*([A-Z0-9]+)/i.exec(text);
  if (!agency) issues.push({ level: 'error', code: 'no_agency', text: 'Agent code not found in the header' });
  const dates = [...text.matchAll(/\b(\d{2})\/(\d{2})\/(\d{2})\s*$/gm)];
  let statementDate: IsoDate | null = null;
  if (dates.length) {
    const d = dates[dates.length - 1];
    const iso = `20${d[3]}-${d[1]}-${d[2]}`;
    statementDate = isIsoDate(iso) ? iso : null;
  }

  // ---- Rows ----
  type TotalsRow = { payment: Cents | null; paid: Cents | null; prem: Cents | null; fee: Cents | null; txn: Cents | null };
  const found: { pl: TotalsRow | null } = { pl: null };
  pages.forEach((pageLines, pageIdx) => {
    pageLines.forEach((raw, rowIdx) => {
      if (!raw.includes(SEP)) return;
      const cells = raw.split(SEP).map((c) => c.trim());
      const first = cells[0] ?? '';

      if (/^TOTAL COMMISSION PAYABLE/i.test(first)) {
        const t: LineIssue[] = [];
        found.pl = {
          payment: money(cells[1] ?? '', t, 'Total payment received'),
          paid: money(cells[2] ?? '', t, 'Total paid commission'),
          prem: money(cells[5] ?? '', t, 'Total premium for commission'),
          fee: money(cells[8] ?? '', t, 'Total policyholder fee'),
          txn: money(cells[9] ?? '', t, 'Total transaction premium'),
        };
        issues.push(...t);
        return;
      }
      // Data rows: name, then a policy number made of digits/letters and spaces.
      if (cells.length < 10 || !first || /NAME OF INSURED|AGENT:/i.test(first)) return;
      const policy = (cells[1] ?? '').replace(/\s+/g, ' ').trim();
      if (!/^[A-Z0-9][A-Z0-9 -]{4,}$/i.test(policy) || !/\d/.test(policy)) return;

      const li: LineIssue[] = [];
      const payment = money(cells[2] ?? '', li, 'Payment received');
      const paid = money(cells[3] ?? '', li, 'Paid commission');
      const rateCell = (cells[4] ?? '').trim();
      let rateBps: number | null = null;
      if (rateCell) {
        if (/^\d{1,5}$/.test(rateCell) && Number(rateCell) <= 10000) rateBps = Number(rateCell);
        else li.push({ level: 'error', code: 'bad_rate', text: `Commission rate "${rateCell}" could not be read` });
      }
      const term = money(cells[5] ?? '', li, 'Policy term commission');
      const prem = money(cells[6] ?? '', li, 'Premium for commission');
      const eff = splitEffCode(cells[7] ?? '');
      if (eff.bad) li.push({ level: 'warning', code: 'bad_date', text: `Effective date in "${cells[7]}" is not a valid date` });
      const fee = money(cells[9] ?? '', li, 'Policyholder fee');
      const txn = money(cells[10] ?? '', li, 'Transaction premium');
      const hasPaid = paid !== null;
      const type = transactionType(eff.code, hasPaid);
      if (!hasPaid && payment === null) li.push({ level: 'warning', code: 'empty_row', text: 'Row has neither a payment nor a commission' });

      lines.push({
        lineNo: lines.length + 1,
        page: pageIdx + 1,
        insuredName: first.replace(/\s+/g, ' '),
        policyNumberRaw: policy,
        policyNumberNormalized: normalizePolicyNumber(policy),
        paymentReceivedCents: payment,
        paidCommissionCents: paid,
        rateBps,
        termCommissionCents: term,
        premiumForCommissionCents: prem,
        transactionPremiumCents: txn,
        feeCents: fee,
        effectiveDate: eff.date,
        transactionCodeRaw: (cells[7] ?? '').trim(),
        transactionType: type,
        paymentMethod: (cells[8] ?? '').trim(),
        kind: hasPaid ? 'commission' : 'payment_only',
        rawText: rawPages[pageIdx]?.[rowIdx] ?? raw,
        issues: li,
      });
    });
  });

  // ---- Summary block (no ¡ separators) ----
  const amt = String.raw`\$?\s*([\d,]*\.\d{2}-?)`;
  const plBusinessOnly = findAmount(text, new RegExp(String.raw`TOTAL COMMISSION PAYABLE\s*-\s*PL BUSINESS ONLY\s+` + amt, 'gi'));
  const monthPayable = findAmount(text, new RegExp(String.raw`TOTAL MONTH COMMISSION PAYABLE\s+` + amt, 'gi'));
  const ytd = findAmount(text, new RegExp(String.raw`TOTAL YEAR TO DATE COMMISSION PAYABLE\s+` + amt, 'gi'));
  const adjustments: StatementAdjustment[] = [];
  for (const [label, re] of [
    ['Policyholders services fee', String.raw`POLICYHOLDERS SERVICES FEE\s+`],
    ['Report shared cost', String.raw`REPORT SHARED COST\s+`],
    ['RSA new business commission adjustment', String.raw`RSA NEW BUSINESS COMMISSION ADJUSTMENT\s+`],
  ] as const) {
    const v = findAmount(text, new RegExp(re + amt, 'gi'));
    if (v !== null) adjustments.push({ label, amountCents: v });
  }

  const pl = found.pl;
  if (!pl) issues.push({ level: 'error', code: 'no_total_row', text: 'The "TOTAL COMMISSION PAYABLE" totals row was not found' });
  if (monthPayable === null) issues.push({ level: 'error', code: 'no_month_payable', text: '"TOTAL MONTH COMMISSION PAYABLE" was not found' });
  if (pl?.paid !== null && pl?.paid !== undefined && plBusinessOnly !== null && pl.paid !== plBusinessOnly) {
    issues.push({ level: 'error', code: 'carrier_totals_disagree', text: 'The carrier\'s own PL totals disagree with each other' });
  }
  if (!lines.length) issues.push({ level: 'error', code: 'no_lines', text: 'No transaction rows were found' });

  return {
    carrierName: 'Travelers',
    agencyCode: agency ? agency[1].toUpperCase() : null,
    officeCode,
    statementMonth,
    statementDate,
    title: 'Personal Insurance Commission & Accounting Information Statement',
    pageCount: pages.length,
    stated: {
      commissionPayableCents: pl?.paid ?? plBusinessOnly,
      monthCommissionPayableCents: monthPayable,
      paymentReceivedCents: pl?.payment ?? null,
      premiumForCommissionCents: pl?.prem ?? null,
      transactionPremiumCents: pl?.txn ?? null,
      feeCents: pl?.fee ?? null,
      ytdCommissionPayableCents: ytd,
    },
    adjustments,
    lines,
    issues,
  };
}

export { NEGATIVE_TYPES };
