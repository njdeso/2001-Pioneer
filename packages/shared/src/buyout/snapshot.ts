import { z } from 'zod';
import { UNASSIGNED_BROKER_ID } from '../schemas.js';
import type { PolicyTerm } from '../terms.js';
import type { BrokerAdvance } from './advances.js';
import type { BrokerSettlement, BuyoutAdjustment, BuyoutBroker, BuyoutCheck, BuyoutPolicy, BuyoutRules, BuyoutValuation, PolicyValuation } from './engine.js';

/**
 * Broker buyout settlement snapshots (owner only). Stored at buyoutSettlements/{id}, with the per-policy
 * valuations in buyoutSettlements/{id}/policyRows/{policyId}. Nothing here is read by any Pioneer export.
 *
 * A snapshot freezes the calculation for one closing date. Versions count up per closing date.
 *   draft      → adjustments may be added or removed (each re-settles the brokers from the stored policy rows)
 *   reviewed   → locked; may be reopened to draft, or finalized
 *   finalized  → immutable. Finalizing requires every check to pass, no policy needing review, no negative
 *                broker settlement, and the live data unchanged since the snapshot (input fingerprint).
 *                The previously finalized version for the same closing date becomes superseded.
 *   superseded → immutable, kept for history
 *   discarded  → a draft or reviewed snapshot set aside; kept for history
 * A revision is always a new version; finalized numbers are never edited.
 */

export const SNAPSHOT_STATES = ['draft', 'reviewed', 'finalized', 'superseded', 'discarded'] as const;
export type SnapshotState = (typeof SNAPSHOT_STATES)[number];
export const SNAPSHOT_STATE_LABELS: Record<SnapshotState, string> = {
  draft: 'Draft', reviewed: 'Reviewed', finalized: 'Finalized', superseded: 'Superseded', discarded: 'Discarded',
};

/** Transitions an owner may request (superseded is only ever set by finalizing a newer version). */
const ALLOWED: Record<SnapshotState, SnapshotState[]> = {
  draft: ['reviewed', 'discarded'],
  reviewed: ['draft', 'finalized', 'discarded'],
  finalized: [],
  superseded: [],
  discarded: [],
};
export function canTransition(from: SnapshotState, to: SnapshotState): boolean { return ALLOWED[from].includes(to); }
export const isEditable = (s: SnapshotState) => s === 'draft';
export const isImmutable = (s: SnapshotState) => s === 'finalized' || s === 'superseded' || s === 'discarded';

export interface SnapshotPolicyRow extends PolicyValuation { clientName: string; carrierName: string; brokerName: string }

export interface BuyoutSnapshot {
  id: string; closingDate: string; version: number; state: SnapshotState;
  engineVersion: string; rules: BuyoutRules; inputFingerprint: string;
  brokers: BrokerSettlement[]; totals: BuyoutValuation['totals']; checks: BuyoutCheck[]; finalizable: boolean; blockers: string[];
  adjustments: BuyoutAdjustment[]; brokerDirectory: BuyoutBroker[]; policyCount: number;
  note: string; agencyName: string;
  createdAt?: unknown; createdBy?: string; reviewedBy?: string | null; finalizedBy?: string | null; finalizedAt?: unknown;
  supersededById?: string | null; history?: { at: string; by: string; from: SnapshotState | null; to: SnapshotState; note: string }[];
}

// ---------------------------------------------------------------- input fingerprint

const sortBy = <T>(xs: T[], k: (x: T) => string) => [...xs].sort((a, b) => k(a).localeCompare(k(b)));

/**
 * Canonical text of every input the calculation reads. Hash it (SHA-256) to detect any change to the
 * book, terms, advances or broker shares between taking a snapshot and finalizing it.
 */
export function buyoutInputsCanonical(i: { closingDate: string; rules: BuyoutRules; policies: BuyoutPolicy[]; termsByPolicy: Map<string, PolicyTerm[]>; brokers: BuyoutBroker[]; advances: BrokerAdvance[]; carrierRates: Record<string, number | null> }): string {
  const lines: string[] = [`C|${i.closingDate}`, `R|${i.rules.multipleBps}|${i.rules.installmentsBps.join(',')}|${i.rules.daysPerYear}`];
  for (const b of sortBy(i.brokers, (b) => b.id)) lines.push(`B|${b.id}|${b.shareBps}`);
  for (const p of sortBy(i.policies, (p) => p.id)) {
    lines.push(`P|${p.id}|${p.clientId}|${p.carrierId}|${p.policyNumber}|${p.brokerId}|${p.brokerShareBps ?? ''}|${p.status}|${p.effectiveDate ?? ''}|${p.expirationDate ?? ''}|${p.premiumCents ?? ''}|${p.commissionRateBps ?? ''}`);
    for (const t of sortBy(i.termsByPolicy.get(p.id) ?? [], (t) => t.effectiveDate)) lines.push(`T|${p.id}|${t.effectiveDate}|${t.scheduledExpirationDate}|${t.cancellationDate ?? ''}|${t.status}`);
  }
  for (const a of sortBy(i.advances, (a) => a.id)) lines.push(`A|${a.id}|${a.status}|${a.policyId}|${a.brokerId}|${a.termEffectiveDate}|${a.termExpirationDate}|${a.commissionBasisCents ?? ''}|${a.brokerShareBps ?? ''}|${a.amountPaidCents}|${a.paymentDate}`);
  for (const k of Object.keys(i.carrierRates).sort()) lines.push(`K|${k}|${i.carrierRates[k] ?? ''}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- callable inputs

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'Not a real date');
const reason = z.string().trim().min(3, 'A reason is required').max(500);

export const buyoutConfigInput = z.object({
  plannedClosingDate: isoDate.nullable(),
  closingDateConfirmed: z.boolean(),
  note: reason,
});
export type BuyoutConfig = z.infer<typeof buyoutConfigInput>;

export const createSnapshotInput = z.object({ closingDate: isoDate, note: reason });
export const adjustmentInput = z.object({
  snapshotId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  brokerId: z.string().min(1).max(128),
  amountCents: z.number().int().refine((n) => n !== 0, 'Amount cannot be zero').refine((n) => Math.abs(n) <= 100_000_000_00, 'Amount is too large'),
  reason,
});
export const removeAdjustmentInput = z.object({ snapshotId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), adjustmentId: z.string().min(1).max(128), reason });
export const setSnapshotStateInput = z.object({ snapshotId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), to: z.enum(['draft', 'reviewed', 'finalized', 'discarded']), note: reason });

// ---------------------------------------------------------------- record → engine input (shared by the preview and the server)

interface RawPolicy { id: string; clientId?: unknown; carrierId?: unknown; policyNumber?: unknown; brokerId?: unknown; brokerShareBps?: unknown; status?: unknown; effectiveDate?: unknown; expirationDate?: unknown; premiumCents?: unknown; commissionRateBps?: unknown }
interface RawBroker { id: string; name?: unknown; shareBps?: unknown; status?: unknown }
interface RawCarrier { id: string; defaultRateBps?: unknown }
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const date = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

export function toBuyoutInputs(raw: { policies: RawPolicy[]; brokers: RawBroker[]; carriers: RawCarrier[] }) {
  const policies: BuyoutPolicy[] = raw.policies.map((p) => ({
    id: p.id, clientId: str(p.clientId), carrierId: str(p.carrierId), policyNumber: str(p.policyNumber),
    brokerId: str(p.brokerId) || UNASSIGNED_BROKER_ID, brokerShareBps: num(p.brokerShareBps), status: str(p.status) || 'active',
    effectiveDate: date(p.effectiveDate), expirationDate: date(p.expirationDate), premiumCents: num(p.premiumCents), commissionRateBps: num(p.commissionRateBps),
  }));
  const brokers: BuyoutBroker[] = raw.brokers.map((b) => ({ id: b.id, name: str(b.name) || b.id, shareBps: num(b.shareBps) ?? 0 }));
  const carrierRates: Record<string, number | null> = Object.fromEntries(raw.carriers.map((c) => [c.id, num(c.defaultRateBps)]));
  return { policies, brokers, carrierRates, carrierRateBps: (id: string) => carrierRates[id] ?? null };
}
