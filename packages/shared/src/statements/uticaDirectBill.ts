import type { Cents } from '../money.js';
import type { ExtractedLine, ExtractedStatement } from './types.js';
import { sectionKey } from './reconcile.js';

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
 *    commission check uses that total less the MVR/CLUE amount (likewise each printed premium total less
 *    the premium figure the moved row carried, e.g. its NET PREMIUMS amount), and "lines + adjustments =
 *    Amount Due Producer" still checks the printed amount exactly. Each adjustment records its page, row and the
 *    printed policy text for the audit trail. A positive (refund) EXP row is held for review, not moved.
 * 5. NET PREMIUM READ WITH THE WRONG SIGN. When the AI fills both premium fields, one is the row's GROSS and
 *    the other its NET, and the printed row satisfies Net = Gross + Commission(printed). A row whose net
 *    figure has the opposite sign of Gross + Commission (e.g. "136.00" read as -136.00 next to "34.00-") is a
 *    misread of that one figure: its sign evidence comes from the gross figure — and only when the printed
 *    rate confirms it (|Gross| x rate = |Commission|). The net figure is corrected to Gross + Commission only
 *    when, after the signs are verified, the corrected net column adds up EXACTLY to the printed net total;
 *    the line carries a note naming the figure read and the figure used. Otherwise the row is named in a
 *    blocking message and nothing is corrected. Commissions and gross premiums are never changed by this.
 *    Printed SECTION SUBTOTALS (e.g. "SUB TOTALS FOR SUBPRODUCERS 2576.26-") are in the same carrier view and
 *    are reversed with everything else; an MVR/CLUE row moved to the adjustments (rule 4) is taken out of its
 *    section's subtotal exactly as it is taken out of the Producers Total.
 * 6. GROSS AND COMMISSION READ WITH REVERSED SIGNS. A trailing minus can be copied onto the wrong column of a
 *    row: Feb 2026 line 22 prints "864.00-  129.60  734.40-" (a return-premium endorsement, commission charged
 *    back) and was read as gross 864.00, commission 129.60-. As read, the row looks like rule 5's case (its net
 *    disagrees with gross + commission). The two readings are told apart only by the carrier's printed
 *    totals: the row's gross and commission are corrected (signs reversed) only when the row's own arithmetic
 *    holds with them reversed (-gross + -commission as printed = net as read), the printed rate confirms the
 *    amounts, AND, with the correction, the gross column, the commission column and the net column each add
 *    up EXACTLY to Utica's printed totals (all three must be printed). Each corrected figure is kept in the
 *    audit log (value read, value used, reason, arithmetic). If any check fails, nothing is corrected and the
 *    row is named with both possible readings.
 * 3. ROWS OUTSIDE THE CARRIER'S TOTALS. If the lines exceed the printed commission total by exactly one
 *    row's commission (and, when printed, the gross premium total by exactly that row's premium), that row
 *    is named in a blocking message: it is printed but the carrier did not include it in what it paid.
 *    It is never removed automatically. This conclusion is NOT drawn when another row read with reversed
 *    signs (its gross and commission each counted twice over) explains exactly the same difference: then
 *    both rows are named, the reversed-sign reading is to be checked on the statement first, and nothing
 *    is changed. (Feb 2026: line 21, 1,728.00 / 259.20, and line 22, 864.00 / 129.60 read with reversed
 *    signs, both explain +259.20 and +1,728.00; the printed line 22 shows the reversed-sign reading was the
 *    real cause.)
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
/**
 * A row with NO gross premium: Utica's "commission chargebacks on unpaid direct bill premiums … and/or
 * MVR/CLUE expense" entries (entry codes COMM / EXP, GROSS PREMIUMS .00). Their NET PREMIUMS column equals
 * the commission, and the AI may copy that net figure into a premium field — which is not a gross premium
 * and says nothing about the sign convention. Recognised by the entry code, or by a premium equal to the
 * commission (impossible for a real policy row: that would be a 100 % commission rate).
 */
const noGrossPremium = (l: ExtractedLine) => {
  const p = premium(l);
  return !p || /^(COMM|EXP)$/i.test(l.transactionCodeRaw.trim()) || Math.abs(p) === Math.abs(l.paidCommissionCents ?? 0);
};
type PremField = 'transactionPremiumCents' | 'premiumForCommissionCents';
const OTHER: Record<PremField, PremField> = { transactionPremiumCents: 'premiumForCommissionCents', premiumForCommissionCents: 'transactionPremiumCents' };
/**
 * A row whose two premium fields are its GROSS and NET with the net read with the wrong sign
 * (-net = gross + commission as printed), the gross confirmed by the printed rate. Returns the field
 * holding the misread net, or null. Commission is the PRINTED (carrier-view) figure.
 */
function misreadNetField(l: ExtractedLine): PremField | null {
  const c = l.paidCommissionCents;
  if (!c) return null;
  for (const net of ['transactionPremiumCents', 'premiumForCommissionCents'] as const) {
    const n = l[net], g = l[OTHER[net]];
    if (n === null || g === null || !n || !g || n === g) continue;
    if (g + c !== -n || sign(n) === sign(g)) continue;
    if (!l.rateBps || Math.round((Math.abs(g) * l.rateBps) / 10000) !== Math.abs(c)) continue; // the printed rate must confirm the gross
    return net;
  }
  return null;
}
const sign = (c: Cents | null) => (c === null || c === 0 ? 0 : c > 0 ? 1 : -1);

/** One AI-extracted figure corrected by a carrier reading rule: kept permanently in the audit log. */
export interface AiValueCorrection {
  lineNo: number;
  policyNumber: string;
  field: 'transactionPremiumCents' | 'premiumForCommissionCents' | 'paidCommissionCents';
  fieldLabel: string;
  originalCents: Cents;
  correctedCents: Cents;
  rule: string;
  reason: string;
  arithmetic: string;
}

export interface UticaReport {
  applied: boolean;
  /** Rows whose premium and commission confirm the printed sign convention. */
  evidenceRows: number;
  /** Rows that contradict it (blocks the reversal). */
  contradictingRows: number[];
  filledRows: number[];
  /** Rows whose net premium was read with the wrong sign and corrected from the printed row arithmetic. */
  netSignCorrectedRows: number[];
  /** The same corrections with the value read, the value used, reason and arithmetic (for the audit log). */
  corrections: AiValueCorrection[];
  rowsOutsideTotals: number[];
  /** Rows whose gross premium and commission were read with reversed signs and corrected (rule 6). */
  reversedSignCorrectedRows: number[];
  /** Rows that may have been read with reversed signs; not corrected (named in a blocking message). */
  reversedSignSuspectRows: number[];
  /** Original line numbers of MVR/CLUE expense rows moved to agency-only adjustments. */
  mvrClueRows: number[];
}

/**
 * Rule 6: rows whose gross premium and commission were both read with reversed signs (net field `f` read
 * correctly). Corrects only when every printed column total confirms it; returns false (nothing changed)
 * otherwise. Commissions are already in the agency's sign when this runs.
 */
function correctReversedSigns(s: ExtractedStatement, rows: ExtractedLine[], f: PremField, report: UticaReport): boolean {
  const gf = OTHER[f];
  const printedGross = s.stated[gf], printedNet = s.stated[f], printedComm = s.stated.commissionPayableCents;
  if (printedGross === null || printedNet === null || printedComm === null) return false; // all three totals must confirm
  // Row arithmetic with gross and printed commission reversed: -gross + -(printed commission) = net as read.
  // The printed commission is -(agency commission), so reversed it is the agency commission itself.
  if (!rows.every((l) => -(l[gf] ?? 0) + (l.paidCommissionCents ?? 0) === l[f])) return false;
  const total = (field: PremField | 'paidCommissionCents', flip: boolean) => s.lines.reduce((t, l) => t + (flip && rows.includes(l) ? -(l[field] ?? 0) : (l[field] ?? 0)), 0);
  const asRead = { gross: total(gf, false), comm: total('paidCommissionCents', false) };
  if (total(gf, true) !== printedGross || total('paidCommissionCents', true) !== printedComm || total(f, false) !== printedNet) return false;
  for (const l of rows) {
    const g = l[gf]!, a = l.paidCommissionCents!, n = l[f]!;
    const rate = (l.rateBps! / 100).toFixed(2);
    const reason = 'a trailing minus was copied onto the wrong column of this row: with the gross premium and commission reversed, the row and all three of Utica\'s printed column totals agree';
    const arithmetic = `printed row: gross ${fmt(-g)} + commission charged ${fmt(a)} = net ${fmt(n)} (net read correctly); ${fmt(Math.abs(g))} x ${rate}% = ${fmt(Math.abs(a))}; `
      + `with the correction the gross column adds up to the printed ${fmt(printedGross)} (as read ${fmt(asRead.gross)}), the commission column to the printed ${fmt(printedComm)} (as read ${fmt(asRead.comm)}), and the net column as read equals the printed ${fmt(printedNet)}`;
    const policy = l.policyNumberRaw || l.policyNumberNormalized;
    report.corrections.push(
      { lineNo: l.lineNo, policyNumber: policy, field: gf, fieldLabel: 'gross premium', originalCents: g, correctedCents: -g, rule: `${UTICA_DIRECT_BILL_RULES}/reversed-sign`, reason, arithmetic },
      { lineNo: l.lineNo, policyNumber: policy, field: 'paidCommissionCents', fieldLabel: 'commission (agency view)', originalCents: a, correctedCents: -a, rule: `${UTICA_DIRECT_BILL_RULES}/reversed-sign`, reason, arithmetic },
    );
    l[gf] = -g;
    l.paidCommissionCents = -a;
    const text = `Line ${l.lineNo}: AI read the gross premium as ${fmt(g)} and the commission as ${fmt(a)} (agency view); corrected to ${fmt(-g)} and ${fmt(-a)}. Reason: ${reason}. Arithmetic: ${arithmetic}. Net premium unchanged.`;
    l.issues.push({ level: 'warning', code: 'utica_reversed_sign_read', text });
    s.issues.push({ level: 'warning', code: 'utica_reversed_sign_read', text });
    report.reversedSignCorrectedRows.push(l.lineNo);
  }
  return true;
}

export function applyUticaDirectBillRules(input: ExtractedStatement): { statement: ExtractedStatement; report: UticaReport } {
  const s: ExtractedStatement = { ...input, issues: [...input.issues], lines: input.lines.map((l) => ({ ...l, issues: [...l.issues] })), adjustments: input.adjustments.map((a) => ({ ...a })), stated: { ...input.stated },
    ...(input.sections ? { sections: input.sections.map((x) => ({ ...x })) } : {}) };
  const report: UticaReport = { applied: false, evidenceRows: 0, contradictingRows: [], filledRows: [], netSignCorrectedRows: [], corrections: [], rowsOutsideTotals: [], reversedSignCorrectedRows: [], reversedSignSuspectRows: [], mvrClueRows: [] };

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
    if (noGrossPremium(l)) continue; // chargeback / expense rows carry no gross premium to compare with
    const misread = misreadNetField(l);
    const c = sign(l.paidCommissionCents), p = sign(misread ? l[OTHER[misread]] : premium(l)); // a misread net says nothing; use the gross
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
  for (const x of s.sections ?? []) x.commissionCents = neg(x.commissionCents);
  s.issues.push({ level: 'warning', code: 'utica_sign_convention', text: `Utica direct-bill statement: the COMMISSIONS column prints commission owed to the agency with a trailing minus. Signs were reversed for the agency's view after ${report.evidenceRows ? `${report.evidenceRows} row(s) confirmed it (premium and commission printed with opposite signs)` : 'the rows added up exactly to the printed commission total'}. Cancellations, chargebacks and MVR/CLUE expenses stay negative.` });
  report.applied = true;

  // ---- 5. a net premium read with the wrong sign: correct only if the printed net total confirms it ----
  for (const f of ['transactionPremiumCents', 'premiumForCommissionCents'] as const) {
    const rows = s.lines.filter((l) => misreadNetField({ ...l, paidCommissionCents: neg(l.paidCommissionCents) }) === f); // commissions already reversed
    if (!rows.length) continue;
    const printed = s.stated[f];
    const corrected = s.lines.reduce((t, l) => t + (rows.includes(l) ? -(l[f] ?? 0) : (l[f] ?? 0)), 0);
    if (printed !== null && corrected === printed) {
      const asRead = s.lines.reduce((t, l) => t + (l[f] ?? 0), 0);
      for (const l of rows) {
        const read = l[f]!, gross = l[OTHER[f]]!, printedComm = neg(l.paidCommissionCents)!;
        l[f] = -read;
        const rate = (l.rateBps! / 100).toFixed(2);
        const reason = 'the net premium is the only figure on the row that does not agree with the others';
        const arithmetic = `gross ${fmt(gross)} x ${rate}% = commission ${fmt(Math.abs(printedComm))} (printed ${(Math.abs(printedComm) / 100).toFixed(2)}${printedComm < 0 ? '-' : ''}); gross ${fmt(gross)} + commission as printed ${fmt(printedComm)} = net ${fmt(-read)}; with ${fmt(-read)} the net premium column adds up exactly to the printed total ${fmt(printed)} (as read it added up to ${fmt(asRead)})`;
        const text = `Line ${l.lineNo}: AI read the net premium as ${fmt(read)}; corrected to ${fmt(-read)}. Reason: ${reason}. Arithmetic: ${arithmetic}. Commission and gross premium unchanged.`;
        report.corrections.push({ lineNo: l.lineNo, policyNumber: l.policyNumberRaw || l.policyNumberNormalized, field: f, fieldLabel: 'net premium', originalCents: read, correctedCents: -read, rule: `${UTICA_DIRECT_BILL_RULES}/net-sign`, reason, arithmetic });
        l.issues.push({ level: 'warning', code: 'utica_net_sign_read', text });
        s.issues.push({ level: 'warning', code: 'utica_net_sign_read', text });
        report.netSignCorrectedRows.push(l.lineNo);
      }
    } else if (!correctReversedSigns(s, rows, f, report)) {
      for (const l of rows) {
        const g = l[OTHER[f]]!, a = l.paidCommissionCents ?? 0;
        const text = `Line ${l.lineNo}: net premium read as ${fmt(l[f]!)}, but the printed row gives ${fmt(-(l[f]!))} (gross + commission as printed)${printed === null ? '' : ' and correcting it does not make the printed net premium total add up'}. `
          + `Alternatively the gross premium (${fmt(g)}) and commission (${fmt(a)}) may have been read with reversed signs, but Utica's printed totals do not confirm that either. Not corrected; check this row's signs on the statement.`;
        l.issues.push({ level: 'error', code: 'utica_row_premium_inconsistent', text });
        s.issues.push({ level: 'error', code: 'utica_row_premium_inconsistent', text });
      }
    }
  }

  // ---- 3. a printed row the carrier left out of its totals ----
  const total = s.stated.commissionPayableCents;
  if (total !== null) {
    const diff = s.lines.reduce((t, l) => t + (l.paidCommissionCents ?? 0), 0) - total;
    if (diff !== 0) {
      const statedPremium = s.stated.transactionPremiumCents ?? s.stated.premiumForCommissionCents;
      const premDiff = statedPremium !== null ? s.lines.reduce((t, l) => t + (premium(l) ?? 0), 0) - statedPremium : null;
      const candidates = s.lines.filter((l) => l.paidCommissionCents === diff && (premDiff === null || premium(l) === premDiff));
      // The same difference explained by a row read with reversed signs: its commission (and gross) counted
      // with the wrong sign moves the column total by twice its amount. Rate-confirmed rows only.
      const reversed = s.lines.filter((l) => {
        const c = l.paidCommissionCents ?? 0, p = premium(l);
        if (!c || 2 * c !== diff || !p || !l.rateBps || noGrossPremium(l)) return false;
        if (premDiff !== null && 2 * p !== premDiff) return false;
        return Math.round((Math.abs(p) * l.rateBps) / 10000) === Math.abs(c);
      });
      if (reversed.length) {
        report.reversedSignSuspectRows.push(...reversed.map((l) => l.lineNo));
        const alt = reversed.map((l) => `line ${l.lineNo} (policy ${l.policyNumberRaw || l.policyNumberNormalized}, gross ${fmt(premium(l)!)}, commission ${fmt(l.paidCommissionCents!)})`).join(' or ');
        const outside = candidates.map((l) => `line ${l.lineNo} (policy ${l.policyNumberRaw || l.policyNumberNormalized}, commission ${fmt(diff)}) being left out of Utica's totals`).join(' or ');
        const text = `The lines exceed Utica's printed commission total by ${fmt(diff)}${premDiff !== null ? ` and the gross premium total by ${fmt(premDiff)}` : ''}. `
          + `This is exactly what ${alt} read with the opposite signs would cause (a trailing minus copied onto the wrong column)${outside ? `; it would also match ${outside}` : ''}. `
          + `Check the printed signs of ${reversed.map((l) => `line ${l.lineNo}`).join(' and ')} on the statement and re-read before contacting Utica. Nothing has been changed or removed.`;
        for (const l of reversed) l.issues.push({ level: 'error', code: 'utica_reversed_sign_suspect', text });
        s.issues.push({ level: 'error', code: 'utica_reversed_sign_suspect', text });
      } else if (candidates.length === 1) {
        const l = candidates[0];
        report.rowsOutsideTotals.push(l.lineNo);
        const text = `Line ${l.lineNo} (policy ${l.policyNumberRaw || l.policyNumberNormalized}, commission ${fmt(diff)}) is printed on the statement but is not included in Utica's totals: the commission total${premDiff !== null ? ' and the gross premium total both' : ''} leave out exactly this row. Confirm with Utica whether this commission was paid before approving.`;
        l.issues.push({ level: 'error', code: 'utica_row_outside_totals', text });
        s.issues.push({ level: 'error', code: 'utica_row_outside_totals', text });
      }
    }
  }
  // ---- 4. MVR/CLUE expense rows → agency-only statement adjustments ----
  const isMvrClue = (l: ExtractedLine) => /^EXP$/i.test(l.transactionCodeRaw.trim()) && /^MVR\s*CLU/i.test(l.policyNumberRaw.trim()) && noGrossPremium(l);
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
    for (const x of s.sections ?? []) {
      const moved = mvr.filter((l) => l.section && sectionKey(l.section) === sectionKey(x.label)).reduce((t, l) => t + (l.paidCommissionCents ?? 0), 0);
      if (moved && x.commissionCents !== null) x.commissionCents -= moved;
    }
    // The printed premium totals include the MVR/CLUE rows too (GROSS .00, NET = the expense): the
    // NET PREMIUMS total is Σ(Gross + Commission) over EVERY printed row. Compare the policy lines with the
    // printed totals less exactly what the moved rows carried in that field. Line premiums are unchanged.
    const moved = (f: 'transactionPremiumCents' | 'premiumForCommissionCents') => mvr.reduce((t, l) => t + (l[f] ?? 0), 0);
    if (s.stated.transactionPremiumCents !== null) s.stated.transactionPremiumCents -= moved('transactionPremiumCents');
    if (s.stated.premiumForCommissionCents !== null) s.stated.premiumForCommissionCents -= moved('premiumForCommissionCents');
    s.checkLabels = {
      commission: 'Policy commissions = Producers Total less MVR/CLUE expenses',
      monthPayable: 'Policy commissions + MVR/CLUE expenses (agency only) = Amount Due Producer',
    };
    s.issues.push({ level: 'warning', code: 'utica_mvr_clue', text: `${mvr.length} MVR/CLUE expense row(s) (line ${report.mvrClueRows.join(', ')}, total ${fmt(mvrTotal)}) recorded as agency-only adjustments: no policy, never split with a broker.` });
  }
  return { statement: s, report };
}


/**
 * Audit-log entries for AI-extracted figures corrected by a reading rule. Written by processStatement in
 * the same batch as the extraction run, with a new auto-generated audit id each time: a later re-read
 * replaces the statement's lines but never these entries (the audit log is append-only and admin-read).
 */
export function aiCorrectionAuditEntries(statementId: string, runId: string, corrections: readonly AiValueCorrection[]) {
  return corrections.map((c) => ({
    action: 'ai_value_corrected',
    entityType: 'statement',
    entityId: statementId,
    summary: `Line ${c.lineNo} (policy ${c.policyNumber}): AI read the ${c.fieldLabel} as ${fmt(c.originalCents)}; corrected to ${fmt(c.correctedCents)}. Reason: ${c.reason}. Arithmetic: ${c.arithmetic}. Run ${runId}.`,
    changes: { [`line ${c.lineNo} ${c.fieldLabel}`]: { before: c.originalCents, after: c.correctedCents } },
    detail: { statementId, runId, lineNo: c.lineNo, policyNumber: c.policyNumber, field: c.field, originalCents: c.originalCents, correctedCents: c.correctedCents, rule: c.rule, reason: c.reason, arithmetic: c.arithmetic },
  }));
}
