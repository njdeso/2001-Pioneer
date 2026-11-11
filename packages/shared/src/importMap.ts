import { z } from 'zod';
import { parseMoneyToCents, type Cents } from './money.js';
import { isIsoDate, type IsoDate } from './period.js';

/** Fields an imported client/policy list can supply. Only clientName is required. */
export const IMPORT_FIELDS = [
  { key: 'clientName', label: 'Client name', required: true },
  { key: 'clientExternalId', label: 'Client ID (your system)' },
  { key: 'policyNumber', label: 'Policy number' },
  { key: 'carrier', label: 'Carrier / company' },
  { key: 'wholesaler', label: 'Wholesaler / MGA' },
  { key: 'policyType', label: 'Policy type / LOB' },
  { key: 'line', label: 'Personal / commercial' },
  { key: 'namedInsured', label: 'Named insured' },
  { key: 'broker', label: 'Broker / producer' },
  { key: 'effectiveDate', label: 'Effective date' },
  { key: 'expirationDate', label: 'Expiration date' },
  { key: 'premium', label: 'Premium' },
  { key: 'policyStatus', label: 'Policy status' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'address', label: 'Address' },
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number]['key'];
export type ColumnMapping = Partial<Record<ImportField, number | null>>;

const SYNONYMS: Record<ImportField, string[]> = {
  clientName: ['client', 'clientname', 'customer', 'customername', 'insured', 'insuredname', 'accountname', 'account', 'name', 'fullname', 'businessname'],
  clientExternalId: ['clientid', 'clientcode', 'clientnumber', 'clientno', 'customerid', 'customernumber', 'custid', 'accountid', 'accountnumber', 'accountno', 'lookupcode'],
  policyNumber: ['policynumber', 'policyno', 'policynum', 'policy', 'polnumber', 'polno', 'polnum', 'policyid'],
  carrier: ['carrier', 'carriername', 'company', 'companyname', 'insurancecompany', 'insurer', 'writingcompany', 'writingcarrier', 'issuingcompany'],
  wholesaler: ['wholesaler', 'wholesalername', 'mga', 'wholesalebroker', 'intermediary', 'marketingcompany', 'billingcompany'],
  policyType: ['policytype', 'lineofbusiness', 'lob', 'coverage', 'coveragetype', 'type', 'product', 'policyline'],
  line: ['line', 'personalcommercial', 'perscomm', 'commpers', 'personalorcommercial', 'plcl', 'clpl', 'classification', 'class', 'department', 'division', 'linetype', 'businesstype'],
  namedInsured: ['namedinsured', 'firstnamedinsured'],
  broker: ['broker', 'brokername', 'producer', 'producername', 'agent', 'agentname', 'accountexecutive', 'executive', 'assignedto', 'owner'],
  effectiveDate: ['effectivedate', 'effective', 'effdate', 'eff', 'inceptiondate', 'inception', 'startdate', 'policyeffective', 'policyeffectivedate'],
  expirationDate: ['expirationdate', 'expiration', 'expdate', 'exp', 'expiry', 'expirydate', 'enddate', 'renewaldate', 'policyexpiration', 'policyexpirationdate'],
  premium: ['premium', 'annualpremium', 'writtenpremium', 'totalpremium', 'policypremium', 'prem', 'estimatedpremium'],
  policyStatus: ['status', 'policystatus'],
  phone: ['phone', 'phonenumber', 'telephone', 'tel', 'mobile', 'cell', 'primaryphone'],
  email: ['email', 'emailaddress', 'mail', 'primaryemail'],
  address: ['address', 'mailingaddress', 'street', 'address1', 'streetaddress'],
};

function headerKey(h: string): string {
  return h.toLowerCase().replace(/#/g, 'number').replace(/[^a-z0-9]/g, '');
}

/** Guess which column holds which field. Each column is used at most once. */
export function detectColumns(headers: string[]): ColumnMapping {
  const keys = headers.map(headerKey);
  const used = new Set<number>();
  const mapping: ColumnMapping = {};
  // Pass 1: exact synonym, in synonym priority order.
  for (const f of IMPORT_FIELDS) {
    for (const syn of SYNONYMS[f.key]) {
      const idx = keys.findIndex((k, i) => k === syn && !used.has(i));
      if (idx >= 0) { mapping[f.key] = idx; used.add(idx); break; }
    }
  }
  // Pass 2: header contains a long synonym ("Policy Number (Current)").
  for (const f of IMPORT_FIELDS) {
    if (mapping[f.key] !== undefined) continue;
    for (const syn of SYNONYMS[f.key].filter((s) => s.length >= 8)) {
      const idx = keys.findIndex((k, i) => k.includes(syn) && !used.has(i));
      if (idx >= 0) { mapping[f.key] = idx; used.add(idx); break; }
    }
  }
  // If there's a named insured column but no client column, use it as the client.
  if (mapping.clientName === undefined && mapping.namedInsured !== undefined) {
    mapping.clientName = mapping.namedInsured;
    delete mapping.namedInsured;
  }
  return mapping;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function iso(y: number, m: number, d: number): IsoDate | null {
  const s = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isIsoDate(s) ? s : null;
}

/** Four-digit years before this are placeholders for "no date" (01/01/0001 in many agency/carrier exports). */
const MIN_REAL_YEAR = 1900;

function year2(y: number): number {
  return y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y;
}

/**
 * Parse the date formats agency systems and spreadsheets export.
 * Returns null for blank, or { error } when it can't be read unambiguously.
 * US order (month/day) is assumed for slashed dates.
 */
export function parseFlexibleDate(input: string): IsoDate | null | { error: string } {
  const s = String(input ?? '').trim();
  if (!s) return null;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(s))) {
    if (+m[1] < MIN_REAL_YEAR) return null; // e.g. 0001-01-01: an exporter's "no date" placeholder
    return iso(+m[1], +m[2], +m[3]) ?? { error: `Invalid date "${s}"` };
  }
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:\s.*)?$/.exec(s))) {
    // A four-digit year is used as written (0001 is not 2001); only two-digit years are expanded.
    const y = m[3].length === 4 ? +m[3] : year2(+m[3]);
    if (y < MIN_REAL_YEAR) return null; // e.g. 01/01/0001: an exporter's "no date" placeholder
    return iso(y, +m[1], +m[2]) ?? { error: `Invalid date "${s}"` };
  }
  if ((m = /^(\d{1,2})[-\s]([A-Za-z]{3,9})\.?[-\s,]+(\d{2}|\d{4})$/.exec(s))) {
    const mo = MONTHS[m[2].slice(0, 4).toLowerCase()] ?? MONTHS[m[2].slice(0, 3).toLowerCase()];
    return (mo && iso(year2(+m[3]), mo, +m[1])) || { error: `Invalid date "${s}"` };
  }
  if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s))) {
    const mo = MONTHS[m[1].slice(0, 4).toLowerCase()] ?? MONTHS[m[1].slice(0, 3).toLowerCase()];
    return (mo && iso(+m[3], mo, +m[2])) || { error: `Invalid date "${s}"` };
  }
  // Excel serial day number (1900 date system), e.g. 45962 = 2025-11-01
  if (/^\d{5}$/.test(s)) {
    const serial = Number(s);
    if (serial > 20000 && serial < 80000) {
      const ms = Date.UTC(1899, 11, 30) + serial * 86400000;
      return new Date(ms).toISOString().slice(0, 10);
    }
  }
  return { error: `Unrecognized date "${s}"` };
}

export function interpretLine(input: string): 'personal' | 'commercial' | null {
  const s = String(input ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return null;
  if (['personal', 'personallines', 'pl', 'pers', 'p', 'individual', 'homeauto'].includes(s)) return 'personal';
  if (['commercial', 'commerciallines', 'cl', 'comm', 'c', 'business', 'bus', 'commercialauto'].includes(s)) return 'commercial';
  if (s.startsWith('pers')) return 'personal';
  if (s.startsWith('comm') || s.startsWith('bus')) return 'commercial';
  return null;
}

export type PolicyStatusValue = 'active' | 'cancelled' | 'expired' | 'pending';

export function interpretStatus(input: string): PolicyStatusValue | null {
  const s = String(input ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return null;
  if (['active', 'inforce', 'current', 'a', 'live', 'renewed', 'bound', 'issued'].includes(s)) return 'active';
  if (['cancelled', 'canceled', 'cancel', 'cxl', 'cancellation', 'x', 'flatcancel'].includes(s) || s.startsWith('cancel')) return 'cancelled';
  if (['expired', 'lapsed', 'nonrenewed', 'nonrenewal', 'inactive', 'e'].includes(s)) return 'expired';
  if (['pending', 'quote', 'quoted', 'submitted', 'p'].includes(s)) return 'pending';
  return null;
}

/**
 * One row as sent from the browser after column and value mapping.
 * Text is kept raw; the server re-parses it with the same functions.
 */
const raw = (max: number) => z.string().max(max).optional().default('');
const optId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable().optional().default(null);

export const importRecordInput = z.object({
  rowNumber: z.number().int().min(1),
  clientName: raw(200),
  clientExternalId: raw(60),
  policyNumber: raw(60),
  carrierRaw: raw(120),
  carrierId: optId,
  wholesalerRaw: raw(120),
  wholesalerId: optId,
  brokerRaw: raw(120),
  brokerId: optId,
  policyType: raw(80),
  line: raw(40),
  namedInsured: raw(200),
  effectiveDate: raw(40),
  expirationDate: raw(40),
  premium: raw(40),
  policyStatus: raw(40),
  phone: raw(40),
  email: raw(200),
  address: raw(300),
});
export type ImportRecordInput = z.input<typeof importRecordInput>;
export type ImportRecordRaw = z.output<typeof importRecordInput>;

export interface Message { level: 'error' | 'warning' | 'info'; text: string }

export interface NormalizedRecord {
  rowNumber: number;
  client: {
    name: string;
    externalId: string;
    classification: 'personal' | 'commercial' | null;
    contact: { phone: string; email: string; address: string };
  };
  brokerId: string | null;
  policy: null | {
    policyNumber: string;
    carrierId: string;
    wholesalerId: string | null;
    policyType: string;
    line: 'personal' | 'commercial' | null;
    namedInsured: string;
    effectiveDate: IsoDate | null;
    expirationDate: IsoDate | null;
    premiumCents: Cents | null;
    status: PolicyStatusValue | null;
  };
  messages: Message[];
}

/** Parse and validate one mapped row. Never throws; problems become messages. */
export function normalizeRecord(input: ImportRecordRaw): NormalizedRecord {
  const messages: Message[] = [];
  const r = input;
  const name = r.clientName.trim().replace(/\s+/g, ' ');
  if (!name) messages.push({ level: 'error', text: 'Client name is blank' });

  const line = interpretLine(r.line);
  if (r.line.trim() && !line) messages.push({ level: 'warning', text: `Could not read personal/commercial value "${r.line}"; default used` });

  const email = r.email.trim();
  const emailOk = !email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!emailOk) messages.push({ level: 'warning', text: `Email "${email}" looks invalid and was skipped` });

  const out: NormalizedRecord = {
    rowNumber: r.rowNumber,
    client: {
      name,
      externalId: r.clientExternalId.trim(),
      classification: line,
      contact: { phone: r.phone.trim(), email: emailOk ? email : '', address: r.address.trim() },
    },
    brokerId: r.brokerId ?? null,
    policy: null,
    messages,
  };
  if (r.brokerRaw.trim() && !r.brokerId) messages.push({ level: 'warning', text: `Broker "${r.brokerRaw}" is not mapped; default broker used` });

  const hasPolicyNumber = !!r.policyNumber.trim();
  const hasCarrier = !!r.carrierId || !!r.carrierRaw.trim();
  if (!hasPolicyNumber && !hasCarrier) return out; // client-only row

  if (!hasPolicyNumber) { messages.push({ level: 'error', text: 'Carrier given but policy number is blank' }); return out; }
  if (!r.carrierId) {
    messages.push({ level: 'error', text: r.carrierRaw.trim() ? `Carrier "${r.carrierRaw}" is not mapped to a carrier` : 'Policy has no carrier' });
    return out;
  }
  if (r.wholesalerRaw.trim() && !r.wholesalerId) {
    messages.push({ level: 'warning', text: `Wholesaler "${r.wholesalerRaw}" is not mapped; recorded as direct` });
  }

  const dateField = (v: string, label: string): IsoDate | null => {
    const d = parseFlexibleDate(v);
    if (d && typeof d === 'object') { messages.push({ level: 'warning', text: `${label}: ${d.error}; left blank` }); return null; }
    return d;
  };
  const effectiveDate = dateField(r.effectiveDate, 'Effective date');
  let expirationDate = dateField(r.expirationDate, 'Expiration date');
  if (effectiveDate && expirationDate && expirationDate < effectiveDate) {
    messages.push({ level: 'warning', text: 'Expiration is before effective date; expiration left blank' });
    expirationDate = null;
  }

  let premiumCents: Cents | null = null;
  if (r.premium.trim()) {
    try {
      premiumCents = parseMoneyToCents(r.premium);
      if (premiumCents < 0) messages.push({ level: 'warning', text: 'Premium is negative' });
    } catch {
      messages.push({ level: 'warning', text: `Premium "${r.premium}" could not be read; left blank` });
    }
  }

  const status = interpretStatus(r.policyStatus);
  if (r.policyStatus.trim() && !status) messages.push({ level: 'warning', text: `Unknown policy status "${r.policyStatus}"; set to active` });

  out.policy = {
    policyNumber: r.policyNumber.trim(),
    carrierId: r.carrierId,
    wholesalerId: r.wholesalerId ?? null,
    policyType: r.policyType.trim(),
    line,
    namedInsured: r.namedInsured.trim(),
    effectiveDate,
    expirationDate,
    premiumCents,
    status,
  };
  return out;
}

/** Levenshtein similarity in [0, 1] for "possible duplicate" warnings. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

export const importOptionsInput = z.object({
  defaultLine: z.enum(['personal', 'commercial']).default('commercial'),
  defaultBrokerId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).default('UNASSIGNED'),
  updateExisting: z.boolean().default(true),
  updateBrokerOnExisting: z.boolean().default(false),
});
export type ImportOptionsInput = z.output<typeof importOptionsInput>;

export const MAX_IMPORT_ROWS = 10000;
