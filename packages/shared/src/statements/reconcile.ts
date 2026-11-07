import { applyBasisPoints, sumCents, type Cents } from '../money.js';
import type { ExtractedStatement, ReconciliationCheck, ReconciliationResult } from './types.js';
import { NEGATIVE_TYPES } from './travelers.js';

/**
 * Validate extracted lines and reconcile them to the carrier's printed totals.
 * Exact to the cent: there is no tolerance on totals. A statement can only move toward
 * posting (Stage 3C) when `reconciled` is true.
 *
 * Revenue = paid commission only. Payment received and premiums are reconciled as
 * completeness checks, never counted as commission.
 */

export interface ReconcileOptions {
  /** Allowed difference between rate × premium and the printed paid commission, per line. */
  rateToleranceCents?: number;
}

export function reconcileStatement(s: ExtractedStatement, opts: ReconcileOptions = {}): ReconciliationResult {
  const tol = opts.rateToleranceCents ?? 1;

  // Per-line validation (adds issues to the lines in place, idempotently)
  for (const l of s.lines) {
    l.issues = l.issues.filter((i) => !i.code.startsWith('chk_'));
    if (!l.policyNumberNormalized) l.issues.push({ level: 'error', code: 'chk_no_policy', text: 'Policy number is missing' });
    if (!l.insuredName.trim()) l.issues.push({ level: 'warning', code: 'chk_no_insured', text: 'Insured name is missing' });
    if (l.kind === 'commission' && l.paidCommissionCents !== null) {
      if (l.rateBps !== null && l.premiumForCommissionCents !== null) {
        const expected = applyBasisPoints(l.premiumForCommissionCents, l.rateBps);
        if (Math.abs(expected - l.paidCommissionCents) > tol) {
          l.issues.push({
            level: 'warning', code: 'chk_rate',
            text: `Rate × premium = ${(expected / 100).toFixed(2)} but paid commission is ${(l.paidCommissionCents / 100).toFixed(2)}`,
          });
        }
      }
      if (NEGATIVE_TYPES.includes(l.transactionType) && l.paidCommissionCents > 0) {
        l.issues.push({ level: 'warning', code: 'chk_sign', text: `${l.transactionType} with a positive commission` });
      }
      if (l.premiumForCommissionCents !== null && l.premiumForCommissionCents !== 0
        && Math.sign(l.premiumForCommissionCents) !== Math.sign(l.paidCommissionCents) && l.paidCommissionCents !== 0) {
        l.issues.push({ level: 'warning', code: 'chk_sign_premium', text: 'Commission and premium have opposite signs' });
      }
    }
    if (l.kind === 'payment_only' && l.paidCommissionCents !== null) {
      l.issues.push({ level: 'error', code: 'chk_kind', text: 'Payment-only row carries a commission' });
    }
  }

  const v = (xs: (Cents | null)[]) => sumCents(xs.map((x) => x ?? 0));
  const paid = s.lines.map((l) => l.paidCommissionCents);
  const totals = {
    commissionCents: v(paid),
    positiveCommissionCents: v(paid.filter((x) => (x ?? 0) > 0)),
    negativeCommissionCents: v(paid.filter((x) => (x ?? 0) < 0)),
    paymentReceivedCents: v(s.lines.map((l) => l.paymentReceivedCents)),
    premiumForCommissionCents: v(s.lines.map((l) => l.premiumForCommissionCents)),
    transactionPremiumCents: v(s.lines.map((l) => l.transactionPremiumCents)),
    feeCents: v(s.lines.map((l) => l.feeCents)),
    adjustmentsCents: v(s.adjustments.map((a) => a.amountCents)),
    lineCount: s.lines.length,
    commissionLineCount: s.lines.filter((l) => l.kind === 'commission').length,
    paymentOnlyLineCount: s.lines.filter((l) => l.kind === 'payment_only').length,
    negativeLineCount: s.lines.filter((l) => (l.paidCommissionCents ?? 0) < 0).length,
  };

  const check = (key: ReconciliationCheck['key'], label: string, stated: Cents | null, extracted: Cents, required: boolean): ReconciliationCheck => ({
    key, label, required, statedCents: stated, extractedCents: extracted,
    differenceCents: stated === null ? null : extracted - stated,
    ok: stated === null ? !required : extracted === stated,
  });
  const st = s.stated;
  const checks: ReconciliationCheck[] = [
    check('commission', 'Paid commission (sum of lines)', st.commissionPayableCents, totals.commissionCents, true),
    check('monthPayable', 'Total month commission payable', st.monthCommissionPayableCents ?? st.commissionPayableCents,
      totals.commissionCents + totals.adjustmentsCents, true),
  ];
  if (st.paymentReceivedCents !== null) checks.push(check('paymentReceived', 'Payment received (not revenue)', st.paymentReceivedCents, totals.paymentReceivedCents, true));
  if (st.premiumForCommissionCents !== null) checks.push(check('premiumForCommission', 'Premium for commission', st.premiumForCommissionCents, totals.premiumForCommissionCents, true));
  if (st.transactionPremiumCents !== null) checks.push(check('transactionPremium', 'Transaction premium', st.transactionPremiumCents, totals.transactionPremiumCents, true));
  if (st.feeCents !== null) checks.push(check('fee', 'Policyholder services fee', st.feeCents, totals.feeCents, true));

  const lineErrors = s.lines.reduce((n, l) => n + l.issues.filter((i) => i.level === 'error').length, 0);
  const lineWarnings = s.lines.reduce((n, l) => n + l.issues.filter((i) => i.level === 'warning').length, 0);
  const stmtErrors = s.issues.filter((i) => i.level === 'error').length;
  const stmtWarnings = s.issues.filter((i) => i.level === 'warning').length;

  const blockingReasons: string[] = [];
  for (const c of checks) {
    if (c.ok) continue;
    blockingReasons.push(c.statedCents === null
      ? `${c.label}: the carrier total was not found`
      : `${c.label}: extracted ${(c.extractedCents / 100).toFixed(2)} vs carrier ${(c.statedCents / 100).toFixed(2)}`);
  }
  if (lineErrors) blockingReasons.push(`${lineErrors} line error${lineErrors === 1 ? '' : 's'}`);
  if (stmtErrors) blockingReasons.push(...s.issues.filter((i) => i.level === 'error').map((i) => i.text));

  return {
    reconciled: blockingReasons.length === 0,
    checks,
    totals,
    errorCount: lineErrors + stmtErrors,
    warningCount: lineWarnings + stmtWarnings,
    blockingReasons,
  };
}
