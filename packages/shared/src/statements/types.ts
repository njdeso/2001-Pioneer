import type { BasisPoints, Cents } from '../money.js';
import type { IsoDate, Month } from '../period.js';

/**
 * Normalized result of reading one carrier commission statement, whatever the
 * method (deterministic parser, spreadsheet mapping, or Claude).
 *
 * Revenue is ONLY `paidCommissionCents`. Payment received, policy term commission
 * and premiums are kept for reference and reconciliation, never summed as revenue.
 */

export const TRANSACTION_TYPES = [
  'installment_payment', // payment-only row: premium payment received, no commission paid on it
  'new_business',
  'continuation', // renewal / continuation (Travelers "CONT")
  'endorsement', // policy change (Travelers "CHANGE"); may be positive or negative
  'cancellation',
  'reinstatement',
  'reversal', // e.g. dishonored payment (Travelers "UNHON-CHECK")
  'other',
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_TYPE_LABELS: Record<TransactionType, string> = {
  installment_payment: 'Installment payment',
  new_business: 'New business',
  continuation: 'Continuation / renewal',
  endorsement: 'Endorsement',
  cancellation: 'Cancellation',
  reinstatement: 'Reinstatement',
  reversal: 'Reversal',
  other: 'Other',
};

export interface LineIssue { level: 'error' | 'warning'; code: string; text: string }

export interface ExtractedLine {
  lineNo: number; // 1-based order within the statement
  page: number | null;
  insuredName: string;
  /** Exactly as printed. Never rewritten. */
  policyNumberRaw: string;
  /** For matching only (uppercase, letters and digits). */
  policyNumberNormalized: string;
  paymentReceivedCents: Cents | null;
  /** The commission actually paid on this line — the only revenue figure. */
  paidCommissionCents: Cents | null;
  rateBps: BasisPoints | null;
  /** Reference only: commission for the whole policy term. */
  termCommissionCents: Cents | null;
  premiumForCommissionCents: Cents | null;
  transactionPremiumCents: Cents | null;
  feeCents: Cents | null;
  effectiveDate: IsoDate | null;
  transactionCodeRaw: string;
  transactionType: TransactionType;
  paymentMethod: string;
  kind: 'commission' | 'payment_only';
  /** The row exactly as read from the document (audit trail). */
  rawText: string;
  issues: LineIssue[];
}

/** Totals printed by the carrier. `null` = not printed on this statement. */
export interface StatedTotals {
  commissionPayableCents: Cents | null; // sum of the paid-commission column
  monthCommissionPayableCents: Cents | null; // the "total month commission payable" (after adjustments)
  paymentReceivedCents: Cents | null;
  premiumForCommissionCents: Cents | null;
  transactionPremiumCents: Cents | null;
  feeCents: Cents | null;
  ytdCommissionPayableCents: Cents | null; // informational
}

export interface StatementAdjustment { label: string; amountCents: Cents }

export interface ExtractedStatement {
  carrierName: string;
  agencyCode: string | null;
  officeCode: string | null;
  statementMonth: Month | null;
  statementDate: IsoDate | null;
  title: string;
  pageCount: number | null;
  stated: StatedTotals;
  /** Carrier-level items between line totals and the month payable (fees, shared cost…). */
  adjustments: StatementAdjustment[];
  lines: ExtractedLine[];
  /** Problems with the statement as a whole (missing header, unreadable totals…). */
  issues: LineIssue[];
}

export type ExtractionMethod = 'travelers-pl-v1' | 'ai' | 'table-ai';

export interface ReconciliationCheck {
  key: 'commission' | 'monthPayable' | 'paymentReceived' | 'premiumForCommission' | 'transactionPremium' | 'fee';
  label: string;
  required: boolean;
  statedCents: Cents | null;
  extractedCents: Cents;
  differenceCents: Cents | null; // extracted − stated
  ok: boolean;
}

export interface ExtractedTotals {
  commissionCents: Cents;
  positiveCommissionCents: Cents;
  negativeCommissionCents: Cents;
  paymentReceivedCents: Cents;
  premiumForCommissionCents: Cents;
  transactionPremiumCents: Cents;
  feeCents: Cents;
  adjustmentsCents: Cents;
  lineCount: number;
  commissionLineCount: number;
  paymentOnlyLineCount: number;
  negativeLineCount: number;
}

export interface ReconciliationResult {
  /** True only when every required total matches to the cent and no line has an error. */
  reconciled: boolean;
  checks: ReconciliationCheck[];
  totals: ExtractedTotals;
  errorCount: number;
  warningCount: number;
  blockingReasons: string[];
}
