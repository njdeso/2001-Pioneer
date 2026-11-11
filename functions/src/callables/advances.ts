import { onCall, HttpsError } from 'firebase-functions/v2/https';
import type { Transaction } from 'firebase-admin/firestore';
import { z } from 'zod';
import {
  brokerAdvanceInput, MAX_ADVANCE_IMPORT_ROWS, parseAdvanceRows, UNASSIGNED_BROKER_ID,
  type BrokerAdvance, type ImportLookups,
} from '@asm/shared';
import { audit, db, diff, FieldValue, meta, parse, requireRole } from '../lib/core.js';

/**
 * Broker advance-payment records (brokerAdvances) — commission actually paid to a broker upfront for a
 * policy term. Owner (admin) only; readable only by admins (firestore.rules). Append-only: a correction
 * voids the old record and creates a linked replacement in one transaction; every change needs a note
 * and is audit-logged. Imports are staged (advanceImports/{id}/rows) and committed after review.
 */

const idRe = /^[A-Za-z0-9_-]{1,128}$/;
const noteRe = z.string().trim().min(3, 'A note is required').max(500);

async function policyFor(tx: Transaction, policyId: string) {
  const snap = await tx.get(db.collection('policies').doc(policyId));
  if (!snap.exists) throw new HttpsError('not-found', 'Policy not found.');
  return snap;
}

const recordInput = z.object({ advance: brokerAdvanceInput, note: noteRe });

export const recordBrokerAdvance = onCall(async (req) => {
  const actor = requireRole(req, ['admin']);
  const input = parse(recordInput, req.data);
  return db.runTransaction(async (tx) => {
    const [p, b] = await Promise.all([policyFor(tx, input.advance.policyId), tx.get(db.collection('brokers').doc(input.advance.brokerId))]);
    if (!b.exists) throw new HttpsError('not-found', 'Broker not found.');
    const ref = db.collection('brokerAdvances').doc();
    const data = {
      ...input.advance, clientId: String(p.get('clientId')), termId: input.advance.termEffectiveDate, status: 'active',
      source: { kind: 'manual' }, note: input.note, replacesId: null, replacedById: null, voidReason: null, ...meta(actor, true),
    };
    tx.create(ref, data);
    audit(tx, actor, {
      action: 'broker_advance_create', entityType: 'brokerAdvance', entityId: ref.id,
      summary: `Advance ${(input.advance.amountPaidCents / 100).toFixed(2)} to broker ${input.advance.brokerId} for policy ${String(p.get('policyNumber'))}, term ${input.advance.termEffectiveDate} — ${input.note}`,
      changes: diff(undefined, input.advance as unknown as Record<string, unknown>),
    });
    return { id: ref.id };
  });
});

const correctInput = z.object({ advanceId: z.string().regex(idRe), advance: brokerAdvanceInput, note: noteRe });

/** Void an advance and create its corrected replacement, linked both ways. */
export const correctBrokerAdvance = onCall(async (req) => {
  const actor = requireRole(req, ['admin']);
  const input = parse(correctInput, req.data);
  return db.runTransaction(async (tx) => {
    const oldRef = db.collection('brokerAdvances').doc(input.advanceId);
    const [old, p, b] = await Promise.all([tx.get(oldRef), policyFor(tx, input.advance.policyId), tx.get(db.collection('brokers').doc(input.advance.brokerId))]);
    if (!old.exists) throw new HttpsError('not-found', 'Advance not found.');
    if (old.get('status') !== 'active') throw new HttpsError('failed-precondition', 'Only an active advance can be corrected; this one was already voided.');
    if (!b.exists) throw new HttpsError('not-found', 'Broker not found.');
    const ref = db.collection('brokerAdvances').doc();
    tx.update(oldRef, { status: 'voided', replacedById: ref.id, voidReason: `Corrected: ${input.note}`, voidedAt: FieldValue.serverTimestamp(), voidedBy: actor.uid });
    tx.create(ref, {
      ...input.advance, clientId: String(p.get('clientId')), termId: input.advance.termEffectiveDate, status: 'active',
      source: old.get('source') ?? { kind: 'manual' }, note: input.note, replacesId: oldRef.id, replacedById: null, voidReason: null, ...meta(actor, true),
    });
    audit(tx, actor, {
      action: 'broker_advance_correct', entityType: 'brokerAdvance', entityId: ref.id,
      summary: `Corrected advance ${oldRef.id} → ${ref.id} — ${input.note}`,
      changes: diff(old.data() as Record<string, unknown>, input.advance as unknown as Record<string, unknown>),
    });
    return { id: ref.id, voided: oldRef.id };
  });
});

const voidInput = z.object({ advanceId: z.string().regex(idRe), note: noteRe });

export const voidBrokerAdvance = onCall(async (req) => {
  const actor = requireRole(req, ['admin']);
  const input = parse(voidInput, req.data);
  return db.runTransaction(async (tx) => {
    const ref = db.collection('brokerAdvances').doc(input.advanceId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Advance not found.');
    if (snap.get('status') !== 'active') throw new HttpsError('failed-precondition', 'This advance was already voided.');
    tx.update(ref, { status: 'voided', voidReason: input.note, voidedAt: FieldValue.serverTimestamp(), voidedBy: actor.uid });
    audit(tx, actor, { action: 'broker_advance_void', entityType: 'brokerAdvance', entityId: ref.id, summary: `Voided advance — ${input.note}`, changes: { status: { before: 'active', after: 'voided' } } });
    return { voided: ref.id };
  });
});

// --------------------------------------------------------------------------- import

const stageInput = z.object({
  fileName: z.string().trim().min(1).max(200),
  fileHash: z.string().regex(/^[a-f0-9]{64}$/),
  headers: z.array(z.string().max(200)).min(1).max(60),
  rows: z.array(z.array(z.string().max(500)).max(60)).max(MAX_ADVANCE_IMPORT_ROWS),
});

/** Validate an advance-payment file against the book and stage it for review. Creates no advances. */
export const stageAdvanceImport = onCall({ memory: '512MiB', timeoutSeconds: 120 }, async (req) => {
  const actor = requireRole(req, ['admin']);
  const input = parse(stageInput, req.data);
  const dup = await db.collection('advanceImports').where('fileHash', '==', input.fileHash).where('status', '==', 'committed').limit(1).get();
  if (!dup.empty) throw new HttpsError('already-exists', `This file was already imported (${String(dup.docs[0].get('fileName'))}).`);
  const [brokers, carriers, policies, existing] = await Promise.all([
    db.collection('brokers').get(), db.collection('carriers').get(), db.collection('policies').get(),
    db.collection('brokerAdvances').where('status', '==', 'active').get(),
  ]);
  const lk: ImportLookups = {
    brokers: brokers.docs.map((d) => ({ id: d.id, name: String(d.get('name') ?? ''), code: d.get('code') })),
    carriers: carriers.docs.map((d) => ({ id: d.id, name: String(d.get('name') ?? ''), code: d.get('code') })),
    policies: policies.docs.map((d) => ({ id: d.id, clientId: String(d.get('clientId')), carrierId: String(d.get('carrierId')), wholesalerId: d.get('wholesalerId') ?? null, policyNumber: String(d.get('policyNumber') ?? ''), alternateNumbers: d.get('alternateNumbers') ?? [] })),
    existing: existing.docs.map((d) => d.data() as BrokerAdvance),
  };
  const parsed = parseAdvanceRows(input.headers, input.rows, lk);
  if (parsed.missingColumns.length) throw new HttpsError('invalid-argument', `Missing required columns: ${parsed.missingColumns.join(', ')}. Download the template for the expected headers.`);
  const ref = db.collection('advanceImports').doc();
  const counts = { rows: parsed.rows.length, ok: parsed.rows.filter((r) => r.ok).length, errors: parsed.rows.filter((r) => !r.ok).length, warnings: parsed.rows.filter((r) => r.warnings.length).length };
  const totalOk = parsed.rows.reduce((s, r) => s + (r.advance?.amountPaidCents ?? 0), 0);
  await ref.set({ fileName: input.fileName, fileHash: input.fileHash, status: 'staged', counts, totalOkCents: totalOk, ...meta(actor, true) });
  for (let i = 0; i < parsed.rows.length; i += 400) {
    const b = db.batch();
    for (const r of parsed.rows.slice(i, i + 400)) b.set(ref.collection('rows').doc(String(r.rowNo).padStart(5, '0')), r);
    await b.commit();
  }
  await db.collection('auditLog').add({ at: FieldValue.serverTimestamp(), actor: actor.uid, actorEmail: actor.email, action: 'advance_import_stage', entityType: 'advanceImport', entityId: ref.id, summary: `Staged ${input.fileName}: ${counts.ok} valid, ${counts.errors} with errors`, changes: {} });
  return { importId: ref.id, counts, totalOkCents: totalOk, rows: parsed.rows };
});

const commitInput = z.object({ importId: z.string().regex(idRe), note: noteRe });

/** Create an advance for every valid staged row. Idempotent: row N always becomes advance imp_{importId}_{N}. */
export const commitAdvanceImport = onCall({ memory: '512MiB', timeoutSeconds: 300 }, async (req) => {
  const actor = requireRole(req, ['admin']);
  const input = parse(commitInput, req.data);
  const ref = db.collection('advanceImports').doc(input.importId);
  const claim = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) throw new HttpsError('not-found', 'Import not found.');
    if (s.get('status') === 'committed') return { already: true, fileName: String(s.get('fileName')) };
    if (s.get('status') !== 'staged' && s.get('status') !== 'committing') throw new HttpsError('failed-precondition', `This import is ${String(s.get('status'))}.`);
    tx.update(ref, { status: 'committing', ...meta(actor, false) });
    return { already: false, fileName: String(s.get('fileName')) };
  });
  if (claim.already) return { created: 0, already: true };
  const rows = await ref.collection('rows').where('ok', '==', true).get();
  let created = 0;
  for (let i = 0; i < rows.docs.length; i += 200) {
    const chunk = rows.docs.slice(i, i + 200);
    await db.runTransaction(async (tx) => {
      const ids = chunk.map((d) => db.collection('brokerAdvances').doc(`imp_${input.importId}_${d.id}`));
      const snaps = await tx.getAll(...ids);
      snaps.forEach((s, k) => {
        if (s.exists) return; // already created by an interrupted earlier commit
        const r = chunk[k].data() as { rowNo: number; advance: BrokerAdvance & { note: string } };
        const { note, ...a } = r.advance;
        if (a.brokerId === UNASSIGNED_BROKER_ID) return;
        tx.create(ids[k], {
          ...a, termId: a.termEffectiveDate, status: 'active', source: { kind: 'import', importId: input.importId, fileName: claim.fileName, rowNo: r.rowNo },
          note: note || input.note, replacesId: null, replacedById: null, voidReason: null, ...meta(actor, true),
        });
        created++;
      });
    });
  }
  await db.runTransaction(async (tx) => {
    tx.update(ref, { status: 'committed', committedAt: FieldValue.serverTimestamp(), committedBy: actor.uid, createdCount: rows.size, ...meta(actor, false) });
    audit(tx, actor, { action: 'advance_import_commit', entityType: 'advanceImport', entityId: ref.id, summary: `Imported ${rows.size} advance(s) from ${claim.fileName} — ${input.note}`, changes: {} });
  });
  return { created, already: false };
});

const discardInput = z.object({ importId: z.string().regex(idRe) });

export const discardAdvanceImport = onCall(async (req) => {
  const actor = requireRole(req, ['admin']);
  const input = parse(discardInput, req.data);
  const ref = db.collection('advanceImports').doc(input.importId);
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) throw new HttpsError('not-found', 'Import not found.');
    if (s.get('status') !== 'staged') throw new HttpsError('failed-precondition', 'Only a staged import can be discarded.');
    tx.update(ref, { status: 'discarded', ...meta(actor, false) });
    audit(tx, actor, { action: 'advance_import_discard', entityType: 'advanceImport', entityId: ref.id, summary: `Discarded staged import ${String(s.get('fileName'))}`, changes: {} });
    return { discarded: ref.id };
  });
});
