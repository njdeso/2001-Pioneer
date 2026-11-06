import type { Cents } from './money.js';
import { normalizeName, normalizePolicyNumber } from './normalize.js';
import type { IsoDate } from './period.js';
import { similarity, type Message, type NormalizedRecord } from './importMap.js';
import { UNASSIGNED_BROKER_ID } from './schemas.js';

/**
 * Import planning: decide, row by row, what an import WOULD do to the live data.
 * Pure function — the server runs it at staging (for review) and again at commit
 * (against the data as it is then), so nothing live changes until you confirm.
 * Commission history is never touched by imports.
 */

export interface ExistingClient {
  id: string;
  name: string;
  normalizedName: string;
  externalId?: string;
  classification: 'personal' | 'commercial';
  brokerId: string;
  contact?: { name?: string; phone?: string; email?: string; address?: string; notes?: string };
}

export interface ExistingPolicy {
  id: string;
  clientId: string;
  carrierId: string;
  wholesalerId: string | null;
  policyNumber: string;
  normalizedPolicyNumber: string;
  alternateNumbersNormalized?: string[];
  policyType: string;
  line: 'personal' | 'commercial';
  namedInsured: string;
  brokerId: string;
  effectiveDate: IsoDate | null;
  expirationDate: IsoDate | null;
  premiumCents: Cents | null;
  status: 'active' | 'cancelled' | 'expired' | 'pending';
}

export interface ImportExisting {
  clients: ExistingClient[];
  policies: ExistingPolicy[];
  carrierKinds: ReadonlyMap<string, 'carrier' | 'wholesaler'>;
  brokerIds: ReadonlySet<string>;
}

export interface ImportOptions {
  /** Classification for new clients/policies when the file doesn't say. */
  defaultLine: 'personal' | 'commercial';
  /** Broker for rows that don't name one. */
  defaultBrokerId: string;
  /** Update existing policies/clients with non-blank values from the file. */
  updateExisting: boolean;
  /** Also change the broker on existing records when the file names a different one. */
  updateBrokerOnExisting: boolean;
}

export type Change = { before: unknown; after: unknown };

export interface PlannedClient {
  key: string; // existing id, or "new:<n>"
  isNew: boolean;
  data: {
    name: string; normalizedName: string; externalId: string;
    classification: 'personal' | 'commercial'; brokerId: string;
    contact: { name: string; phone: string; email: string; address: string; notes: string };
  };
  changes: Record<string, Change>; // for existing clients
  rows: number[];
}

export interface PlannedRow {
  rowNumber: number;
  status: 'ok' | 'warning' | 'error';
  clientKey: string | null;
  clientAction: 'create' | 'existing' | 'update' | 'none';
  policyAction: 'create' | 'update' | 'unchanged' | 'duplicate' | 'conflict' | 'none';
  policyId: string | null; // existing policy id, for update/unchanged
  policyKey: string | null;
  policyData: null | {
    clientKey: string;
    carrierId: string;
    wholesalerId: string | null;
    policyNumber: string;
    normalizedPolicyNumber: string;
    policyType: string;
    line: 'personal' | 'commercial';
    namedInsured: string;
    brokerId: string;
    effectiveDate: IsoDate | null;
    expirationDate: IsoDate | null;
    premiumCents: Cents | null;
    status: 'active' | 'cancelled' | 'expired' | 'pending';
  };
  policyChanges: Record<string, Change>;
  messages: Message[];
}

export interface ImportPlanSummary {
  rows: number;
  errors: number;
  warnings: number;
  clientsNew: number;
  clientsExisting: number;
  clientsUpdated: number;
  policiesNew: number;
  policiesUpdated: number;
  policiesUnchanged: number;
  duplicatesInFile: number;
  conflicts: number;
}

export interface ImportPlan {
  rows: PlannedRow[];
  clients: PlannedClient[];
  summary: ImportPlanSummary;
}

const SIMILAR = 0.88;

export function planImport(records: NormalizedRecord[], existing: ImportExisting, options: ImportOptions): ImportPlan {
  const byExternal = new Map<string, ExistingClient>();
  const byName = new Map<string, ExistingClient[]>();
  for (const c of existing.clients) {
    if (c.externalId) byExternal.set(c.externalId.toLowerCase(), c);
    const list = byName.get(c.normalizedName) ?? [];
    list.push(c);
    byName.set(c.normalizedName, list);
  }
  const policyByKey = new Map<string, ExistingPolicy>();
  for (const p of existing.policies) {
    policyByKey.set(`${p.carrierId}__${p.normalizedPolicyNumber}`, p);
    for (const alt of p.alternateNumbersNormalized ?? []) {
      const k = `${p.carrierId}__${alt}`;
      if (!policyByKey.has(k)) policyByKey.set(k, p);
    }
  }
  const brokerOk = (id: string | null) => (id && existing.brokerIds.has(id) ? id : null);
  const defaultBroker = brokerOk(options.defaultBrokerId) ?? UNASSIGNED_BROKER_ID;

  const clients = new Map<string, PlannedClient>();
  const newByExternal = new Map<string, string>();
  const newByName = new Map<string, string>();
  const seenPolicyKeys = new Map<string, number>();
  let newCount = 0;
  const rows: PlannedRow[] = [];

  for (const rec of records) {
    const messages: Message[] = [...rec.messages];
    const row: PlannedRow = {
      rowNumber: rec.rowNumber, status: 'ok', clientKey: null, clientAction: 'none', policyAction: 'none',
      policyId: null, policyKey: null, policyData: null, policyChanges: {}, messages,
    };
    rows.push(row);
    if (messages.some((m) => m.level === 'error')) { finish(row); continue; }

    // ---------- Client ----------
    const norm = normalizeName(rec.client.name);
    const ext = rec.client.externalId.toLowerCase();
    let existingClient: ExistingClient | undefined;
    let key: string | undefined;

    if (ext) {
      existingClient = byExternal.get(ext);
      if (!existingClient) {
        key = newByExternal.get(ext);
        const sameName = (byName.get(norm) ?? []).filter((c) => !c.externalId);
        if (!key && sameName.length === 1) {
          existingClient = sameName[0]; // existing client without an ID yet: adopt it
          messages.push({ level: 'info', text: `Matched existing client "${existingClient.name}" by name and will record its Client ID` });
        } else if (!key && (byName.get(norm) ?? []).some((c) => c.externalId && c.externalId.toLowerCase() !== ext)) {
          messages.push({ level: 'warning', text: `Another client named "${rec.client.name}" exists with a different Client ID; a new client will be created` });
        }
      }
    } else {
      const matches = byName.get(norm) ?? [];
      if (matches.length > 1) {
        messages.push({ level: 'error', text: `${matches.length} existing clients are named "${rec.client.name}"; add a Client ID column to tell them apart` });
        finish(row);
        continue;
      }
      existingClient = matches[0];
      if (!existingClient) key = newByName.get(norm);
    }

    const recordBroker = brokerOk(rec.brokerId);
    let planned: PlannedClient;
    if (existingClient) {
      planned = clients.get(existingClient.id) ?? {
        key: existingClient.id, isNew: false,
        data: {
          name: existingClient.name, normalizedName: existingClient.normalizedName, externalId: existingClient.externalId ?? '',
          classification: existingClient.classification, brokerId: existingClient.brokerId,
          contact: {
            name: existingClient.contact?.name ?? '', phone: existingClient.contact?.phone ?? '',
            email: existingClient.contact?.email ?? '', address: existingClient.contact?.address ?? '', notes: existingClient.contact?.notes ?? '',
          },
        },
        changes: {}, rows: [],
      };
      clients.set(planned.key, planned);
      if (options.updateExisting) {
        const set = (field: string, before: unknown, after: unknown, apply: () => void) => {
          if (after !== '' && after !== null && after !== undefined && before !== after && !(field in planned.changes)) {
            planned.changes[field] = { before, after };
            apply();
          }
        };
        set('externalId', planned.data.externalId || '', rec.client.externalId, () => { planned.data.externalId = rec.client.externalId; });
        set('contact.phone', planned.data.contact.phone, rec.client.contact.phone, () => { planned.data.contact.phone = rec.client.contact.phone; });
        set('contact.email', planned.data.contact.email, rec.client.contact.email, () => { planned.data.contact.email = rec.client.contact.email; });
        set('contact.address', planned.data.contact.address, rec.client.contact.address, () => { planned.data.contact.address = rec.client.contact.address; });
        if (recordBroker && (options.updateBrokerOnExisting || planned.data.brokerId === UNASSIGNED_BROKER_ID)) {
          set('brokerId', planned.data.brokerId, recordBroker, () => { planned.data.brokerId = recordBroker; });
        }
      } else if (!planned.data.externalId && rec.client.externalId) {
        planned.changes.externalId = { before: '', after: rec.client.externalId };
        planned.data.externalId = rec.client.externalId;
      }
      row.clientAction = Object.keys(planned.changes).length ? 'update' : 'existing';
    } else if (key) {
      planned = clients.get(key)!;
      row.clientAction = 'create';
    } else {
      key = `new:${++newCount}`;
      if (ext) newByExternal.set(ext, key); else newByName.set(norm, key);
      planned = {
        key, isNew: true,
        data: {
          name: rec.client.name, normalizedName: norm, externalId: rec.client.externalId,
          classification: rec.client.classification ?? rec.policy?.line ?? options.defaultLine,
          brokerId: recordBroker ?? defaultBroker,
          contact: { name: '', phone: rec.client.contact.phone, email: rec.client.contact.email, address: rec.client.contact.address, notes: '' },
        },
        changes: {}, rows: [],
      };
      clients.set(key, planned);
      row.clientAction = 'create';
      // Similar-name warning against existing clients (e.g. "Smith Trucking" vs "Smith Truckng")
      for (const c of existing.clients) {
        if (c.normalizedName !== norm && similarity(c.normalizedName, norm) >= SIMILAR) {
          messages.push({ level: 'warning', text: `New client is similar to existing client "${c.name}" — check it isn't the same` });
          break;
        }
      }
    }
    planned.rows.push(rec.rowNumber);
    row.clientKey = planned.key;

    // ---------- Policy ----------
    const p = rec.policy;
    if (!p) { finish(row); continue; }
    const kind = existing.carrierKinds.get(p.carrierId);
    if (!kind) { messages.push({ level: 'error', text: 'Mapped carrier no longer exists' }); finish(row); continue; }
    let carrierId = p.carrierId;
    let wholesalerId = p.wholesalerId;
    if (wholesalerId && existing.carrierKinds.get(wholesalerId) !== 'wholesaler') {
      messages.push({ level: 'error', text: 'Mapped wholesaler is not a wholesaler' }); finish(row); continue;
    }
    if (kind === 'wholesaler') {
      if (wholesalerId && wholesalerId !== carrierId) {
        messages.push({ level: 'error', text: 'Carrier column maps to a wholesaler and a different wholesaler is also given' }); finish(row); continue;
      }
      wholesalerId = carrierId; // underlying carrier unknown; policy keyed to the wholesaler
      messages.push({ level: 'info', text: 'Underlying carrier unknown — policy recorded under the wholesaler' });
    }
    const normalized = normalizePolicyNumber(p.policyNumber);
    if (!normalized) { messages.push({ level: 'error', text: 'Policy number has no letters or digits' }); finish(row); continue; }
    const pkey = `${carrierId}__${normalized}`;
    row.policyKey = pkey;

    const firstRow = seenPolicyKeys.get(pkey);
    if (firstRow !== undefined) {
      row.policyAction = 'duplicate';
      messages.push({ level: 'warning', text: `Same carrier and policy number as row ${firstRow}; this row is skipped` });
      finish(row);
      continue;
    }
    seenPolicyKeys.set(pkey, rec.rowNumber);

    const line = p.line ?? planned.data.classification;
    const ex = policyByKey.get(pkey);
    if (ex) {
      row.policyId = ex.id;
      if (planned.isNew || ex.clientId !== planned.key) {
        row.policyAction = 'conflict';
        const owner = existing.clients.find((c) => c.id === ex.clientId);
        messages.push({ level: 'warning', text: `Policy already exists under client "${owner?.name ?? ex.clientId}"; row skipped` });
        finish(row);
        continue;
      }
      if (!options.updateExisting) { row.policyAction = 'unchanged'; finish(row); continue; }
      const ch: Record<string, Change> = {};
      const set = (field: keyof ExistingPolicy, after: unknown) => {
        if (after === null || after === undefined || after === '') return;
        if (ex[field] !== after) ch[field] = { before: ex[field] ?? null, after };
      };
      set('policyType', p.policyType);
      if (p.line) set('line', p.line);
      set('namedInsured', p.namedInsured);
      set('effectiveDate', p.effectiveDate);
      set('expirationDate', p.expirationDate);
      set('premiumCents', p.premiumCents);
      set('status', p.status);
      if (wholesalerId && wholesalerId !== ex.wholesalerId) set('wholesalerId', wholesalerId);
      if (recordBroker && (options.updateBrokerOnExisting || ex.brokerId === UNASSIGNED_BROKER_ID)) set('brokerId', recordBroker);
      row.policyChanges = ch;
      row.policyAction = Object.keys(ch).length ? 'update' : 'unchanged';
      finish(row);
      continue;
    }

    row.policyAction = 'create';
    row.policyData = {
      clientKey: planned.key,
      carrierId, wholesalerId,
      policyNumber: p.policyNumber, normalizedPolicyNumber: normalized,
      policyType: p.policyType, line,
      namedInsured: p.namedInsured || planned.data.name,
      brokerId: recordBroker ?? planned.data.brokerId ?? defaultBroker,
      effectiveDate: p.effectiveDate, expirationDate: p.expirationDate,
      premiumCents: p.premiumCents, status: p.status ?? 'active',
    };
    finish(row);
  }

  function finish(r: PlannedRow) {
    r.status = r.messages.some((m) => m.level === 'error') ? 'error'
      : r.messages.some((m) => m.level === 'warning') ? 'warning' : 'ok';
  }

  // A new client whose every row failed is not created (no orphan clients from bad rows).
  const rowByNumber = new Map(rows.map((r) => [r.rowNumber, r]));
  for (const [k, c] of clients) {
    if (c.isNew && c.rows.every((n) => rowByNumber.get(n)?.status === 'error')) {
      clients.delete(k);
      for (const n of c.rows) { const r = rowByNumber.get(n)!; r.clientKey = null; r.clientAction = 'none'; }
    }
  }
  const plannedClients = [...clients.values()];
  const summary: ImportPlanSummary = {
    rows: rows.length,
    errors: rows.filter((r) => r.status === 'error').length,
    warnings: rows.filter((r) => r.status === 'warning').length,
    clientsNew: plannedClients.filter((c) => c.isNew).length,
    clientsExisting: plannedClients.filter((c) => !c.isNew && !Object.keys(c.changes).length).length,
    clientsUpdated: plannedClients.filter((c) => !c.isNew && Object.keys(c.changes).length).length,
    policiesNew: rows.filter((r) => r.policyAction === 'create').length,
    policiesUpdated: rows.filter((r) => r.policyAction === 'update').length,
    policiesUnchanged: rows.filter((r) => r.policyAction === 'unchanged').length,
    duplicatesInFile: rows.filter((r) => r.policyAction === 'duplicate').length,
    conflicts: rows.filter((r) => r.policyAction === 'conflict').length,
  };
  return { rows, clients: plannedClients, summary };
}

// ---------------------------------------------------------------------------
// Undo planning
// ---------------------------------------------------------------------------

export interface UndoCreated { id: string; exists: boolean; modifiedSince: boolean; hasLedger?: boolean; policyIds?: string[] }
export interface UndoUpdated { id: string; exists: boolean; modifiedSince: boolean; before: Record<string, unknown> }

export interface UndoPlan {
  deletePolicies: string[];
  restorePolicies: { id: string; before: Record<string, unknown> }[];
  deleteClients: string[];
  restoreClients: { id: string; before: Record<string, unknown> }[];
  skipped: { id: string; type: 'policy' | 'client'; reason: string }[];
}

/**
 * Decide how to undo an import without touching unrelated records:
 * - created policies are deleted unless edited since, or they have commission history;
 * - created clients are deleted only if every policy they now have is also being deleted;
 * - updated records get their prior values back unless edited since.
 */
export function planUndo(input: {
  createdPolicies: UndoCreated[];
  updatedPolicies: UndoUpdated[];
  createdClients: UndoCreated[]; // policyIds = ALL policies currently under the client
  updatedClients: UndoUpdated[];
}): UndoPlan {
  const plan: UndoPlan = { deletePolicies: [], restorePolicies: [], deleteClients: [], restoreClients: [], skipped: [] };
  for (const p of input.createdPolicies) {
    if (!p.exists) continue;
    if (p.hasLedger) plan.skipped.push({ id: p.id, type: 'policy', reason: 'has posted commission' });
    else if (p.modifiedSince) plan.skipped.push({ id: p.id, type: 'policy', reason: 'edited after the import' });
    else plan.deletePolicies.push(p.id);
  }
  const deleting = new Set(plan.deletePolicies);
  for (const p of input.updatedPolicies) {
    if (!p.exists) continue;
    if (p.modifiedSince) plan.skipped.push({ id: p.id, type: 'policy', reason: 'edited after the import' });
    else plan.restorePolicies.push({ id: p.id, before: p.before });
  }
  for (const c of input.createdClients) {
    if (!c.exists) continue;
    const remaining = (c.policyIds ?? []).filter((id) => !deleting.has(id));
    if (remaining.length) plan.skipped.push({ id: c.id, type: 'client', reason: `still has ${remaining.length} policies` });
    else if (c.modifiedSince) plan.skipped.push({ id: c.id, type: 'client', reason: 'edited after the import' });
    else plan.deleteClients.push(c.id);
  }
  for (const c of input.updatedClients) {
    if (!c.exists) continue;
    if (c.modifiedSince) plan.skipped.push({ id: c.id, type: 'client', reason: 'edited after the import' });
    else plan.restoreClients.push({ id: c.id, before: c.before });
  }
  return plan;
}
