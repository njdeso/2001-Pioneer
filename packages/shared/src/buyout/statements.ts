import type { BasisPoints, Cents } from '../money.js';
import { ADVANCE_FLAG_TEXT } from './advances.js';
import { ENGINE_FLAG_TEXT, EXCLUSION_TEXT, type BuyoutAdjustment, type EngineFlag } from './engine.js';
import { SNAPSHOT_STATE_LABELS, type BuyoutSnapshot, type SnapshotPolicyRow, type SnapshotState } from './snapshot.js';

/**
 * Document models for broker settlement statements and the internal reconciliation report. Pure data —
 * the PDF / Excel writers (render.ts) only lay these out, so what each document may contain is decided
 * and tested here:
 *   - a broker statement contains ONLY that broker's own policy rows and adjustments, and no other
 *     broker's name, share, figures or the grand totals;
 *   - the reconciliation report is internal (owner only) and is never part of a Pioneer export.
 */

export const flagText = (f: string) => ENGINE_FLAG_TEXT[f as EngineFlag] ?? (ADVANCE_FLAG_TEXT as Record<string, string>)[f] ?? f;

export const METHODOLOGY = [
  'Eligible policies: broker-owned and in force on the closing date (the closing date is the first unearned day). Pending, cancelled, expired, agency-owned (Unassigned) and 0 % policies are excluded.',
  'Term commission: the verified full-term commission from the advance-payment records for the term in force at closing; where none exists, premium × commission rate is used and flagged.',
  'Annualized commission = term commission × 365 ÷ exact calendar days in the term. Annualized broker commission = annualized commission × broker share.',
  'Gross buyout = annualized broker commission × 1.5.',
  'Outstanding unearned advance = advance actually paid for the term × days remaining after closing ÷ days in the term. Net = gross buyout − outstanding unearned advance.',
  'Each figure is rounded once to the cent (round half to even) and each step uses the previous rounded figure.',
  'Policies cancelled after the buyout calculation are not clawed back.',
  'Payment schedule: 50 % at closing, 25 % on the first anniversary, 25 % on the second anniversary (a February 29 closing falls on February 28). Rounding differences are allocated to the closing payment.',
  'Bonuses, contingent commission and profit sharing are not included in this calculation.',
];

export const ACKNOWLEDGMENT = 'This statement shows the calculation of the broker buyout amount as of the closing date shown. It is provided for review and acknowledgment and is not itself a binding agreement; the terms of the buyout are governed by the written agreement between the parties.';

export interface StatementPolicyLine {
  clientName: string; carrierName: string; policyNumber: string; termEffectiveDate: string; termExpirationDate: string;
  termDays: number; remainingDays: number; basisCents: Cents; basisSource: string; brokerShareBps: BasisPoints;
  annualizedAgencyCents: Cents; annualizedBrokerCents: Cents; grossBuyoutCents: Cents;
  advancePaidCents: Cents; outstandingAdvanceCents: Cents; netContributionCents: Cents; notes: string;
}
export interface StatementExcludedLine { clientName: string; carrierName: string; policyNumber: string; reason: string }

export interface BrokerStatementModel {
  kind: 'broker_statement';
  agencyName: string; brokerId: string; brokerName: string; closingDate: string; generatedAt: string;
  snapshotId: string; version: number; state: SnapshotState; stateLabel: string; final: boolean; watermark: string | null;
  methodology: string[]; policies: StatementPolicyLine[]; excluded: StatementExcludedLine[];
  summary: { policies: number; grossBuyoutCents: Cents; outstandingAdvanceCents: Cents; netBeforeAdjustmentsCents: Cents; adjustments: { amountCents: Cents; reason: string }[]; adjustmentsCents: Cents; finalNetCents: Cents; negative: boolean };
  schedule: { label: string; dueDate: string; percent: string; amountCents: Cents }[];
  acknowledgment: string;
}

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 2 : 0)} %`;
const watermarkFor = (s: SnapshotState) => (s === 'finalized' ? null : s === 'superseded' ? 'SUPERSEDED — NOT CURRENT' : s === 'discarded' ? 'DISCARDED — NOT VALID' : 'DRAFT — NOT FINAL');

function line(r: SnapshotPolicyRow): StatementPolicyLine {
  return {
    clientName: r.clientName, carrierName: r.carrierName, policyNumber: r.policyNumber,
    termEffectiveDate: r.term?.effectiveDate ?? '', termExpirationDate: r.term?.expirationDate ?? '',
    termDays: r.termDays, remainingDays: r.remainingDays, basisCents: r.basis?.cents ?? 0,
    basisSource: r.basis?.source === 'advance' ? 'Advance record' : r.basis?.source === 'premium_x_rate' ? 'Premium × rate' : 'None',
    brokerShareBps: r.brokerShareBps, annualizedAgencyCents: r.annualizedAgencyCents, annualizedBrokerCents: r.annualizedBrokerCents,
    grossBuyoutCents: r.grossBuyoutCents, advancePaidCents: r.advancePaidCents, outstandingAdvanceCents: r.outstandingAdvanceCents,
    netContributionCents: r.netContributionCents,
    notes: r.flags.filter((f) => f !== 'multiple_advances' && f !== 'rounding_difference').map(flagText).join('; '),
  };
}

/** The statement for one broker: that broker's records only. */
export function brokerStatementModel(snap: BuyoutSnapshot, rows: SnapshotPolicyRow[], brokerId: string, generatedAt: string): BrokerStatementModel {
  const b = snap.brokers.find((x) => x.brokerId === brokerId);
  if (!b) throw new Error('This broker has no settlement in this snapshot.');
  const mine = rows.filter((r) => r.brokerId === brokerId);
  const included = mine.filter((r) => r.included).sort((a, c) => a.clientName.localeCompare(c.clientName) || a.policyNumber.localeCompare(c.policyNumber));
  const excluded = mine.filter((r) => !r.included && r.exclusion).sort((a, c) => a.clientName.localeCompare(c.clientName));
  return {
    kind: 'broker_statement',
    agencyName: snap.agencyName, brokerId, brokerName: b.brokerName, closingDate: snap.closingDate, generatedAt,
    snapshotId: snap.id, version: snap.version, state: snap.state, stateLabel: SNAPSHOT_STATE_LABELS[snap.state], final: snap.state === 'finalized', watermark: watermarkFor(snap.state),
    methodology: METHODOLOGY, policies: included.map(line),
    excluded: excluded.map((r) => ({ clientName: r.clientName, carrierName: r.carrierName, policyNumber: r.policyNumber, reason: EXCLUSION_TEXT[r.exclusion!] })),
    summary: {
      policies: b.policies, grossBuyoutCents: b.grossBuyoutCents, outstandingAdvanceCents: b.outstandingAdvanceCents, netBeforeAdjustmentsCents: b.netBeforeAdjustmentsCents,
      adjustments: b.adjustments.map((a: BuyoutAdjustment) => ({ amountCents: a.amountCents, reason: a.reason })), adjustmentsCents: b.adjustmentsCents,
      finalNetCents: b.finalNetCents, negative: b.finalNetCents < 0,
    },
    schedule: b.installments.map((i) => ({ label: i.label, dueDate: i.dueDate, percent: pct(i.bps), amountCents: i.amountCents })),
    acknowledgment: ACKNOWLEDGMENT,
  };
}

export interface ReconciliationModel {
  kind: 'reconciliation'; internal: true;
  agencyName: string; closingDate: string; generatedAt: string; snapshotId: string; version: number; state: SnapshotState; stateLabel: string; watermark: string | null;
  engineVersion: string; inputFingerprint: string; finalizable: boolean; blockers: string[];
  totals: BuyoutSnapshot['totals']; checks: BuyoutSnapshot['checks'];
  brokers: { brokerName: string; policies: number; annualizedBrokerCents: Cents; grossBuyoutCents: Cents; outstandingAdvanceCents: Cents; netBeforeAdjustmentsCents: Cents; adjustmentsCents: Cents; finalNetCents: Cents; installments: Cents[]; flags: string }[];
  policies: (StatementPolicyLine & { brokerName: string })[];
  excluded: (StatementExcludedLine & { brokerName: string; material: boolean })[];
  exceptions: { brokerName: string; clientName: string; policyNumber: string; flags: string; material: boolean }[];
  adjustments: { brokerName: string; amountCents: Cents; reason: string }[];
  history: { at: string; by: string; from: string; to: string; note: string }[];
}

export function reconciliationModel(snap: BuyoutSnapshot, rows: SnapshotPolicyRow[], generatedAt: string): ReconciliationModel {
  const nameOf = new Map(snap.brokerDirectory.map((b) => [b.id, b.name]));
  const bn = (id: string) => nameOf.get(id) ?? id;
  return {
    kind: 'reconciliation', internal: true,
    agencyName: snap.agencyName, closingDate: snap.closingDate, generatedAt, snapshotId: snap.id, version: snap.version, state: snap.state, stateLabel: SNAPSHOT_STATE_LABELS[snap.state], watermark: watermarkFor(snap.state),
    engineVersion: snap.engineVersion, inputFingerprint: snap.inputFingerprint, finalizable: snap.finalizable, blockers: snap.blockers,
    totals: snap.totals, checks: snap.checks,
    brokers: snap.brokers.map((b) => ({ brokerName: b.brokerName, policies: b.policies, annualizedBrokerCents: b.annualizedBrokerCents, grossBuyoutCents: b.grossBuyoutCents, outstandingAdvanceCents: b.outstandingAdvanceCents, netBeforeAdjustmentsCents: b.netBeforeAdjustmentsCents, adjustmentsCents: b.adjustmentsCents, finalNetCents: b.finalNetCents, installments: b.installments.map((i) => i.amountCents), flags: b.flags.join(', ') })),
    policies: rows.filter((r) => r.included).map((r) => ({ ...line(r), brokerName: bn(r.brokerId) })),
    excluded: rows.filter((r) => !r.included).map((r) => ({ clientName: r.clientName, carrierName: r.carrierName, policyNumber: r.policyNumber, reason: r.exclusion ? EXCLUSION_TEXT[r.exclusion] : '', brokerName: bn(r.brokerId), material: r.material })),
    exceptions: rows.filter((r) => r.flags.length).map((r) => ({ brokerName: bn(r.brokerId), clientName: r.clientName, policyNumber: r.policyNumber, flags: r.flags.map(flagText).join('; '), material: r.material })),
    adjustments: snap.adjustments.map((a) => ({ brokerName: bn(a.brokerId), amountCents: a.amountCents, reason: a.reason })),
    history: (snap.history ?? []).map((h) => ({ at: h.at, by: h.by, from: h.from ?? '', to: h.to, note: h.note })),
  };
}

/** File-name-safe stem, e.g. "Broker-Fifty-buyout-2027-01-15-v3-DRAFT". */
export function statementFileStem(m: { closingDate: string; version: number; final: boolean } & ({ brokerName: string } | { kind: 'reconciliation' })): string {
  const who = 'brokerName' in m ? m.brokerName.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') : 'INTERNAL-reconciliation';
  return `${who}-buyout-${m.closingDate}-v${m.version}${m.final ? '' : '-DRAFT'}`;
}
