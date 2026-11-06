import { onCall, HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData, DocumentReference, DocumentSnapshot, Timestamp, WriteBatch } from 'firebase-admin/firestore';
import { z } from 'zod';
import {
  importOptionsInput, importRecordInput, MAX_IMPORT_ROWS, normalizeRecord, planImport, planUndo,
  policyKey, searchTokens, normalizePolicyNumber, UNASSIGNED_BROKER_ID,
  type ExistingClient, type ExistingPolicy, type ImportExisting, type ImportOptionsInput, type ImportPlan,
  type ImportRecordRaw,
} from '@asm/shared';
import { audit, db, FieldValue, idParam, meta, parse, requireRole, type Actor } from '../lib/core.js';

/**
 * Staged client/policy import.
 *   stageImport  — validates and plans; writes ONLY to importBatches (no live records change)
 *   commitImport — re-plans against current data and applies it, recording before-values
 *   undoImport   — reverses a committed import without touching unrelated records
 * Commission ledger entries are never created, changed or deleted by imports.
 */

const stageInput = z.object({
  fileName: z.string().trim().min(1).max(200),
  fileHash: z.string().regex(/^[a-f0-9]{64}$/),
  options: importOptionsInput,
  records: z.array(importRecordInput).min(1).max(MAX_IMPORT_ROWS),
});

async function loadExisting(): Promise<ImportExisting> {
  const [clients, policies, carriers, brokers] = await Promise.all([
    db.collection('clients').get(),
    db.collection('policies').get(),
    db.collection('carriers').get(),
    db.collection('brokers').get(),
  ]);
  return {
    clients: clients.docs.map((d) => {
      const c = d.data();
      return {
        id: d.id, name: c.name, normalizedName: c.normalizedName, externalId: c.externalId ?? '',
        classification: c.classification, brokerId: c.brokerId ?? UNASSIGNED_BROKER_ID, contact: c.contact ?? {},
      } satisfies ExistingClient;
    }),
    policies: policies.docs.map((d) => {
      const p = d.data();
      return {
        id: d.id, clientId: p.clientId, carrierId: p.carrierId, wholesalerId: p.wholesalerId ?? null,
        policyNumber: p.policyNumber, normalizedPolicyNumber: p.normalizedPolicyNumber ?? normalizePolicyNumber(p.policyNumber),
        alternateNumbersNormalized: p.alternateNumbersNormalized ?? [],
        policyType: p.policyType ?? '', line: p.line, namedInsured: p.namedInsured ?? '', brokerId: p.brokerId ?? UNASSIGNED_BROKER_ID,
        effectiveDate: p.effectiveDate ?? null, expirationDate: p.expirationDate ?? null,
        premiumCents: p.premiumCents ?? null, status: p.status ?? 'active',
      } satisfies ExistingPolicy;
    }),
    carrierKinds: new Map(carriers.docs.map((d) => [d.id, d.get('kind') as 'carrier' | 'wholesaler'])),
    brokerIds: new Set(brokers.docs.map((d) => d.id)),
  };
}

function plan(records: ImportRecordRaw[], existing: ImportExisting, options: ImportOptionsInput): ImportPlan {
  return planImport(records.map(normalizeRecord), existing, options);
}

/** Run writes in WriteBatches of at most `size` operations. */
class Chunker {
  private batch: WriteBatch = db.batch();
  private ops = 0;
  constructor(private size = 450) {}
  async add(fn: (b: WriteBatch) => number): Promise<void> {
    const n = fn(this.batch);
    this.ops += n;
    if (this.ops >= this.size) await this.flush();
  }
  async flush(): Promise<void> {
    if (this.ops === 0) return;
    await this.batch.commit();
    this.batch = db.batch();
    this.ops = 0;
  }
}

function chunks<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function rowView(p: ImportPlan['rows'][number], r: ImportRecordRaw) {
  return {
    rowNumber: p.rowNumber,
    clientName: r.clientName,
    policyNumber: r.policyNumber,
    carrier: r.carrierRaw,
    status: p.status,
    clientAction: p.clientAction,
    policyAction: p.policyAction,
    policyChanges: p.policyChanges,
    messages: p.messages,
  };
}

// ---------------------------------------------------------------------------

export const stageImport = onCall({ memory: '512MiB', timeoutSeconds: 120 }, async (req) => {
  const actor = requireRole(req);
  const input = parse(stageInput, req.data);
  const existing = await loadExisting();
  const result = plan(input.records, existing, input.options);

  const prior = await db.collection('importBatches')
    .where('fileHash', '==', input.fileHash).where('status', '==', 'committed').limit(1).get();
  const duplicateOf = prior.empty ? null : prior.docs[0].id;

  const batchRef = db.collection('importBatches').doc();
  const w = new Chunker();
  await w.add((b) => {
    b.set(batchRef, {
      status: 'staged',
      fileName: input.fileName,
      fileHash: input.fileHash,
      duplicateOf,
      options: input.options,
      summary: result.summary,
      rowCount: input.records.length,
      ...meta(actor, true),
    });
    audit(b, actor, { action: 'stage', entityType: 'import', entityId: batchRef.id, summary: `Staged import of ${input.records.length} rows` });
    return 2;
  });
  const byRow = new Map(input.records.map((r) => [r.rowNumber, r]));
  for (const p of result.rows) {
    const r = byRow.get(p.rowNumber)!;
    await w.add((b) => {
      b.set(batchRef.collection('rows').doc(String(p.rowNumber).padStart(6, '0')), { input: r, ...rowView(p, r) });
      return 1;
    });
  }
  await w.flush();

  return {
    batchId: batchRef.id,
    duplicateOf,
    summary: result.summary,
    rows: result.rows.map((p) => rowView(p, byRow.get(p.rowNumber)!)),
  };
});

// ---------------------------------------------------------------------------

async function claimBatch(batchId: string, from: string[], to: string): Promise<DocumentData> {
  return db.runTransaction(async (tx) => {
    const ref = db.collection('importBatches').doc(batchId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Import not found.');
    const status = snap.get('status');
    if (!from.includes(status)) throw new HttpsError('failed-precondition', `This import is ${status}.`);
    tx.update(ref, { status: to, statusChangedAt: FieldValue.serverTimestamp() });
    return snap.data()!;
  });
}

export const commitImport = onCall({ memory: '1GiB', timeoutSeconds: 540 }, async (req) => {
  const actor = requireRole(req);
  const batchId = idParam((req.data as { batchId?: unknown })?.batchId, 'import');
  if (!batchId) throw new HttpsError('invalid-argument', 'Import is required.');
  const batchDoc = await claimBatch(batchId, ['staged'], 'committing');
  const batchRef = db.collection('importBatches').doc(batchId);

  try {
    const rowSnaps = await batchRef.collection('rows').orderBy('rowNumber').get();
    const records = rowSnaps.docs.map((d) => importRecordInput.parse(d.get('input')));
    const options = importOptionsInput.parse(batchDoc.options);
    const existing = await loadExisting();
    const result = plan(records, existing, options); // authoritative: data as it is right now

    const w = new Chunker(400);
    const clientIds = new Map<string, string>(); // plan key → doc id
    let clientsCreated = 0, clientsUpdated = 0, policiesCreated = 0, policiesUpdated = 0;
    const tag = { importBatchId: batchId };

    // Clients
    for (const c of result.clients) {
      if (c.isNew) {
        const ref = db.collection('clients').doc();
        clientIds.set(c.key, ref.id);
        await w.add((b) => {
          b.create(ref, {
            name: c.data.name, externalId: c.data.externalId, classification: c.data.classification,
            brokerId: c.data.brokerId, contact: c.data.contact, status: 'active',
            normalizedName: c.data.normalizedName, searchTokens: searchTokens(c.data.name, c.data.externalId),
            ...tag, ...meta(actor, true),
          });
          b.set(batchRef.collection('results').doc(`client_${ref.id}`), { type: 'client', action: 'create', id: ref.id });
          return 2;
        });
        clientsCreated++;
      } else {
        clientIds.set(c.key, c.key);
        if (!Object.keys(c.changes).length) continue;
        const ref = db.collection('clients').doc(c.key);
        const update: Record<string, unknown> = { ...meta(actor, false) };
        const before: Record<string, unknown> = {};
        for (const [field, ch] of Object.entries(c.changes)) { update[field] = ch.after; before[field] = ch.before; }
        if ('externalId' in c.changes) update.searchTokens = searchTokens(c.data.name, c.data.externalId);
        await w.add((b) => {
          b.update(ref, update);
          b.set(batchRef.collection('results').doc(`client_${ref.id}`), { type: 'client', action: 'update', id: ref.id, before });
          return 2;
        });
        clientsUpdated++;
      }
    }

    // Policies
    for (const r of result.rows) {
      if (r.policyAction === 'create' && r.policyData) {
        const d = r.policyData;
        const clientId = clientIds.get(d.clientKey);
        if (!clientId) continue;
        const ref = db.collection('policies').doc();
        const keyRef = db.collection('policyKeys').doc(policyKey(d.carrierId, d.policyNumber));
        await w.add((b) => {
          b.create(keyRef, { policyId: ref.id });
          b.create(ref, {
            clientId, carrierId: d.carrierId, wholesalerId: d.wholesalerId, policyNumber: d.policyNumber,
            normalizedPolicyNumber: d.normalizedPolicyNumber, alternateNumbers: [], alternateNumbersNormalized: [],
            policyType: d.policyType, line: d.line, namedInsured: d.namedInsured, brokerId: d.brokerId,
            effectiveDate: d.effectiveDate, expirationDate: d.expirationDate, premiumCents: d.premiumCents,
            commissionRateBps: null, status: d.status,
            searchTokens: searchTokens(d.policyNumber, d.namedInsured),
            ...tag, ...meta(actor, true),
          });
          b.set(batchRef.collection('results').doc(`policy_${ref.id}`), { type: 'policy', action: 'create', id: ref.id, rowNumber: r.rowNumber });
          return 3;
        });
        policiesCreated++;
      } else if (r.policyAction === 'update' && r.policyId) {
        const ref = db.collection('policies').doc(r.policyId);
        const update: Record<string, unknown> = { ...meta(actor, false) };
        const before: Record<string, unknown> = {};
        for (const [field, ch] of Object.entries(r.policyChanges)) { update[field] = ch.after; before[field] = ch.before; }
        await w.add((b) => {
          b.update(ref, update);
          b.set(batchRef.collection('results').doc(`policy_${ref.id}`), { type: 'policy', action: 'update', id: ref.id, before, rowNumber: r.rowNumber });
          return 2;
        });
        policiesUpdated++;
      }
    }
    await w.flush();

    const committedSummary = { ...result.summary, clientsCreated, clientsUpdated, policiesCreated, policiesUpdated };
    const fin = db.batch();
    fin.update(batchRef, { status: 'committed', committedAt: FieldValue.serverTimestamp(), committedBy: actor.uid, committedSummary });
    audit(fin, actor, {
      action: 'commit', entityType: 'import', entityId: batchId,
      summary: `Import committed: ${clientsCreated} clients created, ${clientsUpdated} updated; ${policiesCreated} policies created, ${policiesUpdated} updated`,
    });
    await fin.commit();
    return committedSummary;
  } catch (err) {
    // Partial writes are recorded in results/, so a failed import can still be undone.
    await batchRef.update({ status: 'failed', failedAt: FieldValue.serverTimestamp(), failure: err instanceof Error ? err.message.slice(0, 300) : 'error' });
    if (err instanceof HttpsError) throw err;
    throw new HttpsError('aborted', 'The import stopped part-way. Records written so far can be removed with Undo.');
  }
});

// ---------------------------------------------------------------------------

export const undoImport = onCall({ memory: '1GiB', timeoutSeconds: 540 }, async (req) => {
  const actor: Actor = requireRole(req);
  const batchId = idParam((req.data as { batchId?: unknown })?.batchId, 'import');
  if (!batchId) throw new HttpsError('invalid-argument', 'Import is required.');
  const batchDoc = await claimBatch(batchId, ['committed', 'failed'], 'undoing');
  const batchRef = db.collection('importBatches').doc(batchId);
  const refTime = ((batchDoc.committedAt ?? batchDoc.failedAt ?? batchDoc.statusChangedAt) as Timestamp | undefined)?.toMillis() ?? Date.now();

  try {
    const results = (await batchRef.collection('results').get()).docs.map((d) => d.data() as {
      type: 'client' | 'policy'; action: 'create' | 'update'; id: string; before?: Record<string, unknown>;
    });
    const getAll = async (col: string, ids: string[]) => {
      const out = new Map<string, DocumentSnapshot>();
      for (const part of chunks(ids, 300)) {
        if (!part.length) continue;
        const snaps = await db.getAll(...part.map((id) => db.collection(col).doc(id)));
        snaps.forEach((s) => out.set(s.id, s));
      }
      return out;
    };
    const modified = (s?: DocumentSnapshot) =>
      !!s?.exists && ((s.get('updatedAt') as Timestamp | undefined)?.toMillis() ?? 0) > refTime + 1000;

    const createdP = results.filter((r) => r.type === 'policy' && r.action === 'create').map((r) => r.id);
    const updatedP = results.filter((r) => r.type === 'policy' && r.action === 'update');
    const createdC = results.filter((r) => r.type === 'client' && r.action === 'create').map((r) => r.id);
    const updatedC = results.filter((r) => r.type === 'client' && r.action === 'update');

    const pSnaps = await getAll('policies', [...createdP, ...updatedP.map((r) => r.id)]);
    const cSnaps = await getAll('clients', [...createdC, ...updatedC.map((r) => r.id)]);

    const withLedger = new Set<string>();
    for (const part of chunks(createdP, 30)) {
      const q = await db.collection('ledger').where('policyId', 'in', part).select('policyId').get();
      q.docs.forEach((d) => withLedger.add(d.get('policyId')));
    }
    const clientPolicies = new Map<string, string[]>();
    for (const part of chunks(createdC, 30)) {
      const q = await db.collection('policies').where('clientId', 'in', part).select('clientId').get();
      q.docs.forEach((d) => {
        const list = clientPolicies.get(d.get('clientId')) ?? [];
        list.push(d.id);
        clientPolicies.set(d.get('clientId'), list);
      });
    }

    const u = planUndo({
      createdPolicies: createdP.map((id) => ({ id, exists: !!pSnaps.get(id)?.exists, modifiedSince: modified(pSnaps.get(id)), hasLedger: withLedger.has(id) })),
      updatedPolicies: updatedP.map((r) => ({ id: r.id, exists: !!pSnaps.get(r.id)?.exists, modifiedSince: modified(pSnaps.get(r.id)), before: r.before ?? {} })),
      createdClients: createdC.map((id) => ({ id, exists: !!cSnaps.get(id)?.exists, modifiedSince: modified(cSnaps.get(id)), policyIds: clientPolicies.get(id) ?? [] })),
      updatedClients: updatedC.map((r) => ({ id: r.id, exists: !!cSnaps.get(r.id)?.exists, modifiedSince: modified(cSnaps.get(r.id)), before: r.before ?? {} })),
    });

    const w = new Chunker(400);
    for (const id of u.deletePolicies) {
      const s = pSnaps.get(id)!;
      const key = policyKey(String(s.get('carrierId')), String(s.get('policyNumber')));
      await w.add((b) => {
        b.delete(s.ref);
        b.delete(db.collection('policyKeys').doc(key));
        return 2;
      });
    }
    const restore = async (ref: DocumentReference, before: Record<string, unknown>) =>
      w.add((b) => { b.update(ref, { ...before, ...meta(actor, false) }); return 1; });
    for (const r of u.restorePolicies) await restore(db.collection('policies').doc(r.id), r.before);
    for (const id of u.deleteClients) await w.add((b) => { b.delete(db.collection('clients').doc(id)); return 1; });
    for (const r of u.restoreClients) await restore(db.collection('clients').doc(r.id), r.before);
    await w.flush();

    const undoSummary = {
      policiesDeleted: u.deletePolicies.length, policiesRestored: u.restorePolicies.length,
      clientsDeleted: u.deleteClients.length, clientsRestored: u.restoreClients.length,
      skipped: u.skipped.slice(0, 200),
    };
    const fin = db.batch();
    fin.update(batchRef, { status: 'undone', undoneAt: FieldValue.serverTimestamp(), undoneBy: actor.uid, undoSummary });
    audit(fin, actor, {
      action: 'undo', entityType: 'import', entityId: batchId,
      summary: `Import undone: ${u.deletePolicies.length} policies and ${u.deleteClients.length} clients removed, ${u.restorePolicies.length + u.restoreClients.length} records restored, ${u.skipped.length} skipped`,
    });
    await fin.commit();
    return undoSummary;
  } catch (err) {
    await batchRef.update({ status: batchDoc.status, undoError: err instanceof Error ? err.message.slice(0, 300) : 'error' });
    if (err instanceof HttpsError) throw err;
    throw new HttpsError('aborted', 'Undo stopped part-way; you can run it again.');
  }
});

/** Discard a staged import that was never committed. */
export const discardImport = onCall(async (req) => {
  const actor = requireRole(req);
  const batchId = idParam((req.data as { batchId?: unknown })?.batchId, 'import');
  if (!batchId) throw new HttpsError('invalid-argument', 'Import is required.');
  await claimBatch(batchId, ['staged'], 'discarded');
  const fin = db.batch();
  audit(fin, actor, { action: 'discard', entityType: 'import', entityId: batchId, summary: 'Staged import discarded' });
  await fin.commit();
  return { ok: true };
});
