/**
 * Line of business → Personal / Commercial.
 *
 * The policy's line of business (the `policyType` field, e.g. "Homeowners", "BOP", "Workers Comp") is the
 * source of truth for whether a policy is Personal or Commercial. This module turns that text into a
 * classification and NEVER guesses: a blank, unrecognized or self-contradicting line of business returns
 * `line: null` (manual review).
 *
 * Used by: the one-time correction (scripts/prod-line-correction.mts), the import (importMap.ts) and the
 * policy form. Kept free of imports so the correction script can run it with plain Node.
 */

export type Line = 'personal' | 'commercial';
export type LobDecision = Line | 'review';

export interface LobResult {
  /** null = cannot tell; the policy must be reviewed by a person. */
  line: Line | null;
  basis: 'override' | 'rule' | 'none';
  /** Plain-language reason, shown in previews and import warnings. */
  reason: string;
  /** The phrases that decided it (for the preview's LOB table). */
  matched: string[];
}

/** Lower-case, "&" → "and", punctuation → spaces, single-spaced. "Business-Owners (BOP)" → "business owners bop". */
export function normalizeLob(raw: unknown): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// Phrases are matched as whole words against the normalized text, longest first, and each match is
// removed before shorter phrases are tried: "homeowners association" (Commercial) is consumed before
// "homeowners" (Personal) can match. Keep entries normalized (lower case, single spaces, no punctuation).
const COMMERCIAL: string[] = [
  // explicit wording
  'commercial', 'commerical', 'business', 'businessowners', 'bop', 'cpp', 'cl',
  // home-sounding commercial risks (must be longer than the Personal "home"/"homeowners"/"condo" entries)
  'homeowners association', 'home owners association', 'condo association', 'condominium association',
  'hoa', 'home based business', 'home business', 'nursing home', 'funeral home', 'group home', 'home health', 'home health care', 'home care',
  'apartment building', 'habitational', 'lessors risk', 'lessors risk only', 'lro', 'mixed use',
  // liability / package
  'general liability', 'gl', 'cgl', 'products liability', 'liquor liability', 'liquor', 'dram shop',
  'professional liability', 'errors and omissions', 'e and o', 'e o', 'eo', 'malpractice',
  'directors and officers', 'd and o', 'd o', 'employment practices', 'epli', 'epl', 'cyber',
  // workers comp and NY statutory coverages
  'workers comp', 'workers compensation', 'workmans comp', 'workmens comp', 'work comp', 'wc',
  'disability benefits', 'dbl', 'nys dbl', 'paid family leave', 'pfl',
  // auto / transport
  'business auto', 'commercial auto', 'truck', 'trucks', 'trucking', 'motor truck cargo', 'cargo', 'garage',
  'garagekeepers', 'garage keepers', 'dealer', 'dealers', 'taxi', 'livery', 'limo', 'limousine', 'hired and non owned',
  'hnoa', 'non owned auto', 'fleet',
  // property / contractors / other commercial
  'contractor', 'contractors', 'contractors equipment', 'builders risk', 'builder s risk', 'installation floater',
  'equipment floater', 'bailee', 'spoilage', 'business income', 'commercial property', 'crime', 'fidelity',
  'surety', 'bond', 'bonds', 'restaurant', 'church', 'religious',
];

const PERSONAL: string[] = [
  // explicit wording
  'personal', 'personal lines', 'pl', 'pers',
  // home
  'homeowners', 'homeowner', 'home owners', 'home', 'ho', 'ho 2', 'ho 3', 'ho3', 'ho 4', 'ho4', 'ho 5', 'ho5',
  'ho 6', 'ho6', 'ho 8', 'ho8', 'renters', 'renter', 'tenant homeowners', 'condo', 'condominium', 'condo unit owners',
  'dwelling', 'dwelling fire', 'dp', 'dp 1', 'dp1', 'dp 2', 'dp2', 'dp 3', 'dp3', 'mobile home', 'manufactured home',
  // auto and toys
  'private passenger', 'private passenger auto', 'ppa', 'motorcycle', 'atv', 'snowmobile', 'boat', 'boatowners',
  'watercraft', 'personal watercraft', 'jet ski', 'yacht', 'recreational vehicle', 'rv', 'motorhome', 'motor home',
  'travel trailer', 'camper', 'golf cart', 'antique auto', 'classic car', 'collector car', 'collector vehicle',
  // valuables
  'jewelry', 'jewellery', 'personal articles', 'scheduled personal property', 'valuable articles', 'collectibles',
];

/** Words that by themselves do not say Personal or Commercial. Named in the review reason. */
const AMBIGUOUS: string[] = [
  'auto', 'automobile', 'car', 'umbrella', 'excess', 'flood', 'earthquake', 'inland marine', 'marine', 'property',
  'liability', 'fire', 'package', 'landlord', 'rental', 'rental dwelling', 'life', 'health', 'dental', 'vision',
  'annuity', 'travel', 'pet', 'other', 'misc', 'miscellaneous', 'unknown', 'n a', 'na', 'none', 'tbd',
];

type Entry = { phrase: string; cls: Line | 'ambiguous' };
const ENTRIES: Entry[] = [
  ...COMMERCIAL.map((phrase) => ({ phrase, cls: 'commercial' as const })),
  ...PERSONAL.map((phrase) => ({ phrase, cls: 'personal' as const })),
  ...AMBIGUOUS.map((phrase) => ({ phrase, cls: 'ambiguous' as const })),
].sort((a, b) => b.phrase.length - a.phrase.length || a.phrase.localeCompare(b.phrase));

/**
 * Reviewed per-value decisions, keyed by normalized line of business. They win over the built-in rules,
 * so the owner can settle a value (e.g. "umbrella" → personal) after reading the preview.
 */
export type LobOverrides = Readonly<Record<string, LobDecision>>;

export function classifyLineOfBusiness(raw: unknown, overrides: LobOverrides = {}): LobResult {
  const text = normalizeLob(raw);
  if (!text) return { line: null, basis: 'none', reason: 'Line of business is blank', matched: [] };

  const ov = overrides[text];
  if (ov === 'personal' || ov === 'commercial') return { line: ov, basis: 'override', reason: `Reviewed decision for "${text}"`, matched: [text] };
  if (ov === 'review') return { line: null, basis: 'override', reason: `Marked for manual review: "${text}"`, matched: [text] };

  let rest = ` ${text} `;
  const hits: Record<Line | 'ambiguous', string[]> = { personal: [], commercial: [], ambiguous: [] };
  for (const e of ENTRIES) {
    const needle = ` ${e.phrase} `;
    while (rest.includes(needle)) {
      hits[e.cls].push(e.phrase);
      rest = rest.replace(needle, ' | ');
    }
  }
  const p = hits.personal.length > 0;
  const c = hits.commercial.length > 0;
  if (p && c) {
    return { line: null, basis: 'none', reason: `Conflicting terms: personal (${hits.personal.join(', ')}) and commercial (${hits.commercial.join(', ')})`, matched: [...hits.personal, ...hits.commercial] };
  }
  if (p) return { line: 'personal', basis: 'rule', reason: `Personal line of business (${hits.personal.join(', ')})`, matched: hits.personal };
  if (c) return { line: 'commercial', basis: 'rule', reason: `Commercial line of business (${hits.commercial.join(', ')})`, matched: hits.commercial };
  if (hits.ambiguous.length) return { line: null, basis: 'none', reason: `Could be personal or commercial (${hits.ambiguous.join(', ')})`, matched: hits.ambiguous };
  return { line: null, basis: 'none', reason: `Line of business not recognized: "${text}"`, matched: [] };
}

// ---------------------------------------------------------------------------------------------------------
// One-time correction planning (pure; the script does the reading and writing)
// ---------------------------------------------------------------------------------------------------------

/** The ONLY fields the correction may change. Everything else on a record is never written. */
export const CORRECTION_FIELDS = { clients: 'classification', policies: 'line' } as const;

export interface CorrectionClientIn { id: string; name: string; classification: unknown; updateTime: string }
export interface CorrectionPolicyIn {
  id: string; clientId: unknown; policyNumber: string; policyType: unknown; line: unknown; status: unknown; updateTime: string;
}

export type ExceptionCode =
  | 'policy_lob_blank'
  | 'policy_lob_review'
  | 'policy_client_missing'
  | 'client_no_policies'
  | 'client_has_review_policies'
  | 'client_mixed';

export interface CorrectionException {
  code: ExceptionCode;
  entityType: 'client' | 'policy';
  id: string;
  clientId: string | null;
  detail: string;
}

export interface PolicyDecision {
  id: string; clientId: string; policyNumber: string; status: string; lob: string; lobNormalized: string;
  current: string | null; target: Line | null; action: 'change' | 'unchanged' | 'review';
  basis: LobResult['basis']; reason: string; updateTime: string;
}

export interface ClientDecision {
  id: string; name: string; current: string | null; target: Line | null; action: 'change' | 'unchanged' | 'review';
  reason: string; updateTime: string;
  policies: { total: number; personal: number; commercial: number; review: number };
}

export interface LobSummaryRow {
  lobNormalized: string; examples: string[]; policies: number;
  decision: Line | 'review'; basis: LobResult['basis']; reason: string;
  /** How many of these policies the correction changes. */
  changes: number;
}

export interface CorrectionPlan {
  policies: PolicyDecision[];
  clients: ClientDecision[];
  exceptions: CorrectionException[];
  lobSummary: LobSummaryRow[];
  counts: {
    clientsTotal: number; clientsChange: number; clientsToPersonal: number; clientsToCommercial: number;
    clientsUnchanged: number; clientsReview: number;
    policiesTotal: number; policiesChange: number; policiesToPersonal: number; policiesToCommercial: number;
    policiesUnchanged: number; policiesReview: number;
    policiesByStatus: Record<string, { total: number; change: number; review: number }>;
    exceptionsByCode: Partial<Record<ExceptionCode, number>>;
  };
}

const isLine = (v: unknown): v is Line => v === 'personal' || v === 'commercial';
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/**
 * Decide every policy from its line of business, then every client from its (corrected) policies.
 * Policies of every status count (active, expired, cancelled, pending).
 *
 * Client rule: all Personal → Personal; all Commercial → Commercial; both → keep the current value and flag
 * (the app has no "Mixed" classification); no policies, or any policy needing review → keep and flag.
 */
export function planLineCorrection(input: {
  clients: CorrectionClientIn[];
  policies: CorrectionPolicyIn[];
  overrides?: LobOverrides;
}): CorrectionPlan {
  const overrides = input.overrides ?? {};
  const exceptions: CorrectionException[] = [];
  const clientIds = new Set(input.clients.map((c) => c.id));
  const lobRows = new Map<string, LobSummaryRow>();

  const policies: PolicyDecision[] = [...input.policies].sort((a, b) => a.id.localeCompare(b.id)).map((p) => {
    const lob = str(p.policyType);
    const lobNormalized = normalizeLob(lob);
    const r = classifyLineOfBusiness(lob, overrides);
    const current = isLine(p.line) ? p.line : p.line == null ? null : str(p.line);
    const clientId = str(p.clientId);
    const action: PolicyDecision['action'] = r.line === null ? 'review' : r.line === current ? 'unchanged' : 'change';
    const d: PolicyDecision = {
      id: p.id, clientId, policyNumber: str(p.policyNumber), status: str(p.status) || 'active', lob, lobNormalized,
      current, target: r.line, action, basis: r.basis, reason: r.reason, updateTime: p.updateTime,
    };
    if (r.line === null) {
      exceptions.push({ code: lobNormalized ? 'policy_lob_review' : 'policy_lob_blank', entityType: 'policy', id: p.id, clientId: clientId || null, detail: r.reason });
    }
    if (!clientId || !clientIds.has(clientId)) {
      exceptions.push({ code: 'policy_client_missing', entityType: 'policy', id: p.id, clientId: clientId || null, detail: `Client ${clientId || '(none)'} not found` });
    }
    const key = lobNormalized || '(blank)';
    const row = lobRows.get(key) ?? { lobNormalized: key, examples: [], policies: 0, decision: r.line ?? 'review', basis: r.basis, reason: r.reason, changes: 0 };
    row.policies++;
    if (action === 'change') row.changes++;
    if (row.examples.length < 3 && lob.trim() && !row.examples.includes(lob.trim())) row.examples.push(lob.trim());
    lobRows.set(key, row);
    return d;
  });

  const byClient = new Map<string, PolicyDecision[]>();
  for (const d of policies) {
    const list = byClient.get(d.clientId) ?? [];
    list.push(d);
    byClient.set(d.clientId, list);
  }

  const clients: ClientDecision[] = [...input.clients].sort((a, b) => a.id.localeCompare(b.id)).map((c) => {
    const ps = byClient.get(c.id) ?? [];
    const counts = {
      total: ps.length,
      personal: ps.filter((p) => p.target === 'personal').length,
      commercial: ps.filter((p) => p.target === 'commercial').length,
      review: ps.filter((p) => p.target === null).length,
    };
    const current = isLine(c.classification) ? c.classification : c.classification == null ? null : str(c.classification);
    const base = { id: c.id, name: c.name, current, updateTime: c.updateTime, policies: counts };
    const flag = (code: ExceptionCode, detail: string): ClientDecision => {
      exceptions.push({ code, entityType: 'client', id: c.id, clientId: c.id, detail });
      return { ...base, target: null, action: 'review', reason: detail };
    };
    if (counts.total === 0) return flag('client_no_policies', 'Client has no policies');
    if (counts.review > 0) return flag('client_has_review_policies', `${counts.review} of ${counts.total} policies need review of their line of business`);
    if (counts.personal > 0 && counts.commercial > 0) {
      return flag('client_mixed', `Both types: ${counts.personal} Personal and ${counts.commercial} Commercial policies (no "Mixed" classification; current value kept)`);
    }
    const target: Line = counts.personal > 0 ? 'personal' : 'commercial';
    const label = target === 'personal' ? 'Personal' : 'Commercial';
    return {
      ...base, target,
      action: target === current ? 'unchanged' : 'change',
      reason: counts.total === 1 ? `Its only policy is ${label}` : `All ${counts.total} policies are ${label}`,
    };
  });

  const policiesByStatus: CorrectionPlan['counts']['policiesByStatus'] = {};
  for (const p of policies) {
    const s = (policiesByStatus[p.status] ??= { total: 0, change: 0, review: 0 });
    s.total++;
    if (p.action === 'change') s.change++;
    if (p.action === 'review') s.review++;
  }
  const exceptionsByCode: CorrectionPlan['counts']['exceptionsByCode'] = {};
  for (const e of exceptions) exceptionsByCode[e.code] = (exceptionsByCode[e.code] ?? 0) + 1;

  const n = <T,>(xs: T[], f: (x: T) => boolean) => xs.filter(f).length;
  return {
    policies,
    clients,
    exceptions,
    lobSummary: [...lobRows.values()].sort((a, b) => b.policies - a.policies || a.lobNormalized.localeCompare(b.lobNormalized)),
    counts: {
      clientsTotal: clients.length,
      clientsChange: n(clients, (c) => c.action === 'change'),
      clientsToPersonal: n(clients, (c) => c.action === 'change' && c.target === 'personal'),
      clientsToCommercial: n(clients, (c) => c.action === 'change' && c.target === 'commercial'),
      clientsUnchanged: n(clients, (c) => c.action === 'unchanged'),
      clientsReview: n(clients, (c) => c.action === 'review'),
      policiesTotal: policies.length,
      policiesChange: n(policies, (p) => p.action === 'change'),
      policiesToPersonal: n(policies, (p) => p.action === 'change' && p.target === 'personal'),
      policiesToCommercial: n(policies, (p) => p.action === 'change' && p.target === 'commercial'),
      policiesUnchanged: n(policies, (p) => p.action === 'unchanged'),
      policiesReview: n(policies, (p) => p.action === 'review'),
      policiesByStatus,
      exceptionsByCode,
    },
  };
}

/** One applied change, as recorded in the apply result (and in each audit entry). */
export interface AppliedChange {
  collection: 'clients' | 'policies';
  id: string;
  field: 'classification' | 'line';
  before: string | null;
  after: Line;
  /** The record's update time right after the correction wrote it. */
  writeTime: string;
}

export interface RollbackDecision {
  restore: AppliedChange[];
  skipped: { change: AppliedChange; reason: string }[];
}

/**
 * Undo only what the correction itself left in place: a record is restored when it still holds the
 * corrected value AND has not been written since (same update time). Anything edited afterwards is skipped
 * and reported, never overwritten.
 */
export function planLineRollback(
  applied: AppliedChange[],
  current: ReadonlyMap<string, { exists: boolean; value: unknown; updateTime: string | null }>,
): RollbackDecision {
  const out: RollbackDecision = { restore: [], skipped: [] };
  for (const ch of applied) {
    if (CORRECTION_FIELDS[ch.collection] !== ch.field) { out.skipped.push({ change: ch, reason: `field ${ch.field} is not a correction field` }); continue; }
    const now = current.get(`${ch.collection}/${ch.id}`);
    if (!now || !now.exists) out.skipped.push({ change: ch, reason: 'record no longer exists' });
    else if (now.value !== ch.after) out.skipped.push({ change: ch, reason: `value is now "${str(now.value)}", not "${ch.after}" (changed after the correction)` });
    else if (now.updateTime !== ch.writeTime) out.skipped.push({ change: ch, reason: 'record was edited after the correction' });
    else out.restore.push(ch);
  }
  return out;
}
