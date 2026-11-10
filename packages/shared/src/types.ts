import type { Cents, BasisPoints } from './money.js';
import type { IsoDate, Month } from './period.js';
import type { BrokerInput, CarrierInput, ClientInput, PolicyInput, SettingsInput } from './schemas.js';

/** Firestore timestamps are kept opaque in shared code. */
export type Stamp = unknown;

interface Meta {
  id: string;
  createdAt?: Stamp;
  createdBy?: string;
  updatedAt?: Stamp;
  updatedBy?: string;
}

export type Carrier = CarrierInput & Meta;
export type Broker = BrokerInput & Meta;
export type Client = ClientInput & Meta & { normalizedName: string; searchTokens: string[] };
export type Policy = PolicyInput &
  Meta & { normalizedPolicyNumber: string; searchTokens: string[] };
export type Settings = SettingsInput;

export type Role = 'admin' | 'staff';

export const LEDGER_CLASSIFICATIONS = [
  'new_business',
  'renewal',
  'endorsement',
  'cancellation',
  'chargeback',
  'return_commission',
  'reinstatement',
  'bonus',
  'profit_sharing',
  'other_adjustment',
] as const;
export type LedgerClassification = (typeof LEDGER_CLASSIFICATIONS)[number];

export const CLASSIFICATION_LABELS: Record<LedgerClassification, string> = {
  new_business: 'New business',
  renewal: 'Renewal',
  endorsement: 'Endorsement',
  cancellation: 'Cancellation',
  chargeback: 'Chargeback',
  return_commission: 'Return commission',
  reinstatement: 'Reinstatement',
  bonus: 'Bonus',
  profit_sharing: 'Profit sharing',
  other_adjustment: 'Other adjustment',
};

/** One posted commission entry. Written only by the server (Phase 4). */
export interface LedgerEntry {
  id: string;
  level: 'policy' | 'carrier' | 'suspense';
  /** Who paid: a carrier or a wholesaler. */
  payerId: string;
  /** Underlying insurance carrier, when known. */
  carrierId: string | null;
  clientId: string | null;
  policyId: string | null;
  classification: LedgerClassification;
  amountCents: Cents;
  statementPeriod: Month;
  transactionDate: IsoDate | null;
  paymentDate: IsoDate | null;
  sourceType: 'statement' | 'retained' | 'manual';
  statementId: string | null;
  lineId: string | null;
  note: string;
  postingStatus: 'posted' | 'reversed';
  reversalOf: string | null;
  createdAt?: Stamp;
  approvedAt?: Stamp;
  approvedBy?: string;
  // Stage 3C allocation and lineage (present on every entry posted by Stage 3C or later)
  postingId?: string;
  lineNo?: number | null;
  brokerId?: string;
  brokerShareBps?: number;
  brokerShareSource?: 'policy' | 'broker' | 'unassigned' | 'none';
  brokerCents?: Cents;
  agencyCents?: Cents;
  insuredName?: string;
  policyNumberRaw?: string;
  postedBy?: string;
  postedByEmail?: string;
  reversalId?: string;
  reversalReason?: string;
}

export interface AuditEvent {
  id: string;
  at: Stamp;
  actor: string;
  actorEmail: string;
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  changes: Record<string, { before: unknown; after: unknown }>;
}

export type { BasisPoints };
