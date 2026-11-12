import type { Cents } from '../money.js';
import type { ExtractedLine, ExtractedStatement } from './types.js';

/**
 * Utica National ("Utica Mutual Ins Co. - ERO") DIRECT BILL producer statements: carrier-specific reading
 * rules applied after the AI has copied the scanned statement exactly as printed. Other carriers are not
 * touched (isUticaDirectBill must match first).
 *
 * 1. SIGN CONVENTION. The COMMISSIONS column is printed from the carrier's account view: a commission owed
 *    to the producer is printed with a trailing minus ("429.75-"), a commission taken back (cancellation,
 *    chargeback, MVR/CLUE expense) is printed WITHOUT one ("130.40"); the "AMOUNT DUE PRODUCER" total is
 *    printed "2274.45-". Each row satisfies Gross + Commission(printed) = Net. The agency's commission is
 *    therefore the printed amount with its sign reversed — row by row, so genuine negatives stay negative.
 *    This is VERIFIED on every statement before anything is changed: every row with both a premium and a
 *    commission must show them with opposite printed signs (the convention), and the printed commission
 *    total must not contradict it. If any row disagrees, nothing is reversed and the statement is held
 *    for manual review with the rows named.
 * 2. GROUP-PRINTED ROWS. Utica prints the policyholder and policy number once; the policy's further rows
 *    leave both blank. Such a row takes the policy number and insured name of the row above on the same
 *    page (matching reads the line's policy number), and carries a note saying the number was not printed on
 *    that row and which line it came from. Rows with a printed policy number are never changed.
 * 4. MVR/CLUE EXPENSE (entry code EXP, policy "MVRCLU", no premium) is 100 % an agency expense (owner's
 *    rule, same as Progressive MVR charges): after the sign is verified each such row becomes ONE
 *    statement-level adjustment — carrier level, no policy, broker 0, never a policy commission line and
 *    never in broker commission or buyout figures. The printed Producers Total includes it, so the policy
 *    commission check uses that total less the MVR/CLUE amount, and "lines + adjustments = Amount Due
 *    Producer" still checks the printed amount exactly. Each adjustment records its page, row and the
 *    printed policy text for the audit trail. A positive (refund) EXP row is held for review, not moved.
 * 3. ROWS OUTSIDE THE CARRIER'S TOTALS. If the lines exceed the printed commission total by exactly one
 *    row's commission (and, when printed, the gross premium total by exactly that row's premium), that row
 *    is named in a blocking message: it is printed but the carrier did not include it in what it paid.
 *    It is never removed automatically.
 */

export const UTICA_DIRECT_BILL_RULES = 'utica-direct-bill-v1' as const;

export function isUticaDirectBill(s: Pick<ExtractedStatement, 'carrierName'>): boolean {
  return /\butica\b/i.test(s.carrierName ?? '');
}

const fmt = (c: Cents) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const neg = (c: Cents | null) => (c === null ? null : c === 0 ? 0 : -c);
/** The row's printed GROSS PREMIUMS amount. The AI may put it in either premium field (both mean the same
 *  column on this statement), so use whichever it filled. */
const premium = (l: Pick<ExtractedLine, 'transactionPremiumCents' | 'premiumForCommissionCents'>) => l.transactionPremiumCents ?? l.premiumForCommissionCents;
const sign = (c: Cents | null) => (c === null || c === 0 ? 0 : c > 0 ? 1 : -1);

export interface UticaReport {
  applied: boolean;
  /** Rows whose premium and commission confirm the printed sign convention. */
  evidenceRows: number;
  /** Rows that contradict it (blocks the reversal). */
  contradictingRows: number[];
  filledRows: number[];
  rowsOutsideTotals: number[];
  /** Original line numbers of MVR/CLUE expense rows moved to agency-only adjustments. */
  mvrClueRows: number[];
}

export function applyUticaDirectBillRules(input: ExtractedStatement): { statement: ExtractedStatement; report: UticaReport } {
  const s: ExtractedStatement = { ...input, issues: [...input.issues], lines: input.lines.map((l) => ({ ...l, issues: [...l.issues] })), adjustments: input.adjustments.map((a) => ({ ...a })), stated: { ...input.stated } };
  const report: UticaReport = { applied: false, evidenceRows: 0, contradictingRows: [], filledRows: [], rowsOutsideTotals: [], mvrClueRows: [] };

  // ---- 2. group-printed rows: policy number and insured from the row above (same page) ----
  let prev: ExtractedLine | null = null;
  for (const l of s.lines) {
    const blankPolicy = !l.policyNumberRaw.trim() && !l.policyNumberNormalized;
    if (blankPolicy && !l.insuredName.trim() && prev && prev.page === l.page && prev.policyNumberNormalized) {
      l.policyNumberRaw = prev.policyNumberRaw;
      l.policyNumberNormalized = prev.policyNumberNormalized;
      l.insuredName = prev.insuredName;
      l.issues.push({ level: 'warning', code: 'utica_group_row', text: `Policy number and insured not printed on this row (Utica prints them once per policy): taken from line ${prev.lineNo} above, policy ${prev.policyNumberRaw}` });
      report.filledRows.push(l.lineNo);
      continue;
    }
    if (l.policyNumberNormalized) prev = l; // the row that PRINTS the number (a filled row never becomes a source)
  }

  // ---- 1. verify the printed sign convention, then reverse every commission figure ----
  for (const l of s.lines) {
    const c = sign(l.paidCommissionCents), p = sign(premium(l));
    if (c === 0 || p === 0) continue;
    if (c !== p) report.evidenceRows++;
    else report.contradictingRows.push(l.lineNo);
  }
  const statedTotal = s.stated.commissionPayableCents;
  const linesTotal = s.lines.reduce((t, l) => t + (l.paidCommissionCents ?? 0), 0);
  const totalContradicts = statedTotal !== null && linesTotal !== 0 && sign(statedTotal) !== 0 && sign(statedTotal) !== sign(linesTotal);
  // With no row showing both a premium and a commission, the rows must at least add up exactly to the
  // printed commission total (same convention, read faithfully) before anything is reversed.
  const noEvidenceButTotalsAgree = report.evidenceRows === 0 && statedTotal !== null && statedTotal === linesTotal && linesTotal !== 0;
  if (report.contradictingRows.length || (report.evidenceRows === 0 && !noEvidenceButTotalsAgree) || totalContradicts) {
    const why = report.contradictingRows.length
      ? `line(s) ${report.contradictingRows.join(', ')} print the commission with the same sign as the premium`
      : report.evidenceRows === 0 ? 'no row has both a premium and a commission to confirm it, and the rows do not add up to the printed commission total'
        : 'the printed commission total and the rows disagree in sign';
    s.issues.push({ level: 'error', code: 'utica_sign_unverified', text: `Utica direct-bill statement: commission signs were NOT reversed because ${why}. The commissions are shown as printed; check the statement manually.` });
    return { statement: s, report };
  }
  for (const l of s.lines) l.paidCommissionCents = neg(l.paidCommissionCents);
  s.stated.commissionPayableCents = neg(s.stated.commissionPayableCents);
  s.stated.monthCommissionPayableCents = neg(s.stated.monthCommissionPayableCents);
  s.stated.ytdCommissionPayableCents = neg(s.stated.ytdCommissionPayableCents);
  for (const a of s.adjustments) a.amountCents = neg(a.amountCents) ?? 0;
  s.issues.push({ level: 'warning', code: 'utica_sign_convention', text: `Utica direct-bill statement: the COMMISSIONS column prints commission owed to the agency with a trailing minus. Signs were reversed for the agency's view after ${report.evidenceRows ? `${report.evidenceRows} row(s) confirmed it (premium and commission printed with opposite signs)` : 'the rows added up exactly to the printed commission total'}. Cancellations, chargebacks and MVR/CLUE expenses stay negative.` });
  report.applied = true;

  // ---- 3. a printed row the carrier left out of its totals ----
  const total = s.stated.commissionPayableCents;
  if (total !== null) {
    const diff = s.lines.reduce((t, l) => t + (l.paidCommissionCents ?? 0), 0) - total;
    if (diff !== 0) {
      const statedPremium = s.stated.transactionPremiumCents ?? s.stated.premiumForCommissionCents;
      const premDiff = statedPremium !== null ? s.lines.reduce((t, l) => t + (premium(l) ?? 0), 0) - statedPremium : null;
      const candidates = s.lines.filter((l) => l.paidCommissionCents === diff && (premDiff === null || premium(l) === premDiff));
      if (candidates.length === 1) {
        const l = candidates[0];
        report.rowsOutsideTotals.push(l.lineNo);
        const text = `Line ${l.lineNo} (policy ${l.policyNumberRaw || l.policyNumberNormalized}, commission ${fmt(diff)}) is printed on the statement but is not included in Utica's totals: the commission total${premDiff !== null ? ' and the gross premium total both' : ''} leave out exactly this row. Confirm with Utica whether this commission was paid before approving.`;
        l.issues.push({ level: 'error', code: 'utica_row_outside_totals', text });
        s.issues.push({ level: 'error', code: 'utica_row_outside_totals', text });
      }
    }
  }
  // ---- 4. MVR/CLUE expense rows → agency-only statement adjustments ----
  const isMvrClue = (l: ExtractedLine) => /^EXP$/i.test(l.transactionCodeRaw.trim()) && /^MVR\s*CLU/i.test(l.policyNumberRaw.trim()) && !premium(l);
  const mvr = s.lines.filter(isMvrClue);
  const refunds = mvr.filter((l) => (l.paidCommissionCents ?? 0) > 0);
  if (refunds.length) {
    for (const l of refunds) l.issues.push({ level: 'error', code: 'utica_mvr_positive', text: `Line ${l.lineNo}: an MVR/CLUE entry that pays the agency (${fmt(l.paidCommissionCents!)}) is not handled automatically; confirm how it should be recorded.` });
  } else if (mvr.length) {
    const mvrTotal = mvr.reduce((t, l) => t + (l.paidCommissionCents ?? 0), 0);
    for (const l of mvr) {
      if (l.paidCommissionCents) {
        s.adjustments.push({
          label: `MVR/CLUE expense (statement page ${l.page ?? '?'}, line ${l.lineNo}${l.effectiveDate ? `, ${l.effectiveDate}` : ''})`,
          amountCents: l.paidCommissionCents,
          source: { sheet: `page ${l.page ?? '?'}`, sheetRow: l.lineNo, kind: 'mvr', policyNumberRaw: l.policyNumberRaw, lineNo: null },
        });
      }
      report.mvrClueRows.push(l.lineNo);
    }
    s.lines = s.lines.filter((l) => !isMvrClue(l)); // line numbers keep the printed order (audit trail)
    if (s.stated.commissionPayableCents !== null) s.stated.commissionPayableCents -= mvrTotal;
    s.checkLabels = {
      commission: 'Policy commissions = Producers Total less MVR/CLUE expenses',
      monthPayable: 'Policy commissions + MVR/CLUE expenses (agency only) = Amount Due Producer',
    };
    s.issues.push({ level: 'warning', code: 'utica_mvr_clue', text: `${mvr.length} MVR/CLUE expense row(s) (line ${report.mvrClueRows.join(', ')}, total ${fmt(mvrTotal)}) recorded as agency-only adjustments: no policy, never split with a broker.` });
  }
  return { statement: s, report };
}

