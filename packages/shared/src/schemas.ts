import { z } from 'zod';
import { isIsoDate, isMonth } from './period.js';

/** Input schemas, validated in the browser for UX and again on the server for safety. */

const trimmed = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => trimmed(max).optional().default('');

export const isoDate = z.string().refine(isIsoDate, 'Use a valid date (YYYY-MM-DD)');
export const month = z.string().refine(isMonth, 'Use a valid month (YYYY-MM)');
export const cents = z.number().int('Amount must be whole cents').refine(Number.isSafeInteger, 'Amount out of range');
export const bps = z.number().int().min(0).max(10000);

export const contactSchema = z
  .object({
    name: optionalText(120),
    phone: optionalText(40),
    email: z.union([z.literal(''), z.string().trim().email('Invalid email').max(200)]).optional().default(''),
    address: optionalText(300),
    notes: optionalText(2000),
  })
  // zod 4: prefault parses the fallback, so inner defaults ('' for each field) apply.
  .prefault({});

export const statusSchema = z.enum(['active', 'inactive']);

/** A carrier is either an insurance company or a wholesaler/MGA that pays commission on others' paper. */
export const carrierInput = z.object({
  name: trimmed(120).min(1, 'Name is required'),
  code: trimmed(30)
    .min(1, 'Code is required')
    .regex(/^[A-Za-z0-9_-]+$/, 'Letters, digits, - and _ only')
    .transform((s) => s.toUpperCase()),
  kind: z.enum(['carrier', 'wholesaler']),
  /** statement = commission paid by statement; retained = commission kept out of premium (e.g. Lancer). */
  commissionMethod: z.enum(['statement', 'retained']).default('statement'),
  defaultRateBps: bps.nullable().default(null),
  contact: contactSchema,
  aliases: z.array(trimmed(120).min(1)).max(20).default([]),
  status: statusSchema.default('active'),
});
export type CarrierInput = z.infer<typeof carrierInput>;

export const UNASSIGNED_BROKER_ID = 'UNASSIGNED';

export const brokerInput = z.object({
  name: trimmed(120).min(1, 'Name is required'),
  code: trimmed(30)
    .min(1, 'Code is required')
    .regex(/^[A-Za-z0-9_-]+$/, 'Letters, digits, - and _ only')
    .transform((s) => s.toUpperCase()),
  /** Broker's share of commission on their policies, in basis points (5000 = 50%). */
  shareBps: bps.default(5000),
  status: statusSchema.default('active'),
});
export type BrokerInput = z.infer<typeof brokerInput>;

export const lineSchema = z.enum(['personal', 'commercial']);

export const clientInput = z.object({
  name: trimmed(200).min(1, 'Client name is required'),
  /** The client's ID/code in your agency management system, when available. */
  externalId: trimmed(60).default(''),
  classification: lineSchema,
  brokerId: z.string().min(1).default(UNASSIGNED_BROKER_ID),
  contact: contactSchema,
  status: statusSchema.default('active'),
});
export type ClientInput = z.infer<typeof clientInput>;

export const policyStatus = z.enum(['active', 'cancelled', 'expired', 'pending']);

export const policyInput = z
  .object({
    clientId: z.string().min(1, 'Client is required'),
    carrierId: z.string().min(1, 'Carrier is required'),
    wholesalerId: z.string().min(1).nullable().default(null),
    policyNumber: trimmed(60).min(1, 'Policy number is required'),
    alternateNumbers: z.array(trimmed(60).min(1)).max(10).default([]),
    policyType: trimmed(80).default(''),
    line: lineSchema,
    namedInsured: trimmed(200).default(''),
    brokerId: z.string().min(1).default(UNASSIGNED_BROKER_ID),
    effectiveDate: isoDate.nullable().default(null),
    expirationDate: isoDate.nullable().default(null),
    premiumCents: cents.nullable().default(null),
    commissionRateBps: bps.nullable().default(null),
    status: policyStatus.default('active'),
  })
  .refine(
    (p) => !p.effectiveDate || !p.expirationDate || p.expirationDate >= p.effectiveDate,
    { message: 'Expiration must be on or after the effective date', path: ['expirationDate'] },
  );
export type PolicyInput = z.infer<typeof policyInput>;

export const settingsInput = z.object({
  agencyName: trimmed(120).min(1),
  snapshotStartMonth: month,
  snapshotMonths: z.number().int().min(1).max(36).default(12),
  revenueBasis: z.literal('statementPeriod').default('statementPeriod'),
  defaultBrokerShareBps: bps.default(5000),
});
export type SettingsInput = z.infer<typeof settingsInput>;

/** Format zod issues as { field: message } for forms. */
export function fieldErrors(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.map((p) => String(p)).join('.') || '_';
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
