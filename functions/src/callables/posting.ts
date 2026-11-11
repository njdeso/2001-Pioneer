import { onCall, HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData, Transaction } from 'firebase-admin/firestore';
import { z } from 'zod';
import {
  buildPostingPlan, planFingerprint, postingReadiness, retainedEntry, reversalOf, LEDGER_CLASSIFICATIONS, MAX_POSTING_ENTRIES,
  type PostingLine, type PostingStatement,
} from '@asm/shared';
import { audit, db, FieldValue, parse, requireRole, type Actor } from '../lib/core.js';
import { duplicateFindings } from '../lib/duplicates.js';

/**
 * Stage 3C — statement approval, commission posting and reversal. ADMIN ONLY (staff can view).
 *
 *   approveStatement   needs_review → approved (readiness re-checked on the server, plan fingerprinted)
 *   unapproveStatement approved → needs_review (reason)
 *   postStatement      approved → posted: every ledger entry created in ONE transaction with
 *                      deterministic IDs (tx.create fails if any already exists), only if the plan still
 *                      matches the approved fingerprint
 *   reverseStatementPosting  posted → needs_review: exact negative twin per entry (reason required);
 *                      originals marked reversed; the statement can be corrected and posted again
 *   recordRetainedCommission / reverseLedgerEntry: retained commission (e.g. Lancer bind documents)
 *
 * The ledger is written ONLY here. Clients, policies and extracted statement lines are never changed.
 */

const idRe = /^[A-Za-z0-9_-]{1,128}$/;
const monthRe = /^\d{4}-(0[1-9]|1[0-2])$/;

async function loadForPosting(tx: Transaction, statementId: string) {
  const ref = db.collection('statements').doc(statementId);
  const snap = await tx.get(ref);
  if (!snap.exists) throw new HttpsError('not-found', 'Statement not found.');
  const s = snap.data()!;
  const linesSnap = await tx.get(ref.collection('lines'));
  const payerSnap = s.payerId ? await tx.get(db.collection('carriers').doc(String(s.payerId))) : null;
  // Every other live statement from this payer for this month, compared by content (same transaction).
  const { findings: duplicates } = await duplicateFindings(statementId, s, linesSnap.docs.map((d) => d.data()), tx);
  const stmt: PostingStatement = {
    id: statementId,
    status: String(s.status),
    payerId: s.payerId ?? null,
    payerKind: payerSnap?.exists ? (payerSnap.get('kind') as 'carrier' | 'wholesaler') : null,
    statementMonth: s.statementMonth ?? null,
    statementDate: s.statementDate ?? null,
    adjustments: Array.isArray(s.adjustments) ? s.adjustments : [],
    postedCents: s.postedCents ?? 0,
    postingSeq: s.postingSeq ?? 0,
    possibleDuplicateOf: s.possibleDuplicateOf ?? null,
    matching: s.matching ? { stale: !!s.matching.stale, balanced: s.matching.balanced !== false } : null,
  };
  const lines: PostingLine[] = linesSnap.docs.map((d) => {
    const l = d.data();
    return {
      id: d.id, lineNo: Number(l.lineNo), insuredName: String(l.insuredName ?? ''), policyNumberRaw: String(l.policyNumberRaw ?? ''),
      paidCommissionCents: typeof l.paidCommissionCents === 'number' ? l.paidCommissionCents : null,
      transactionType: l.transactionType, effectiveDate: l.effectiveDate ?? null, match: l.match ?? null,
    };
  });
  return { ref, raw: s, stmt, lines, duplicates };
}

function blockersError(r: ReturnType<typeof postingReadiness>): HttpsError {
  return new HttpsError('failed-precondition', `Not ready: ${r.blockers.map((b) => b.message).join(' ')}`, { blockers: r.blockers });
}

const actorStamp = (actor: Actor) => ({ by: actor.uid, email: actor.email, at: FieldValue.serverTimestamp() });

// ---------------------------------------------------------------------------- approve / unapprove

const approveInput = z.object({
  statementId: z.string().regex(idRe),
  /** Explicit confirmation that a flagged possible duplicate is a separate statement. */
  confirmNotDuplicate: z.boolean().optional().default(false),
  note: z.string().trim().max(500).optional().default(''),
});

export const approveStatement = onCall(async (req) => {
  const actor = requireRole(req, ['admin']);
  const input = parse(approveInput, req.data);
  return db.runTransaction(async (tx) => {
    const { ref, stmt, lines, duplicates } = await loadForPosting(tx, input.statementId);
    if (stmt.status !== 'needs_review') throw new HttpsError('failed-precondition', `Only a reconciled statement awaiting review can be approved (this one is "${stmt.status}").`);
    // Same-month statements must each be confirmed separate (confirmSeparateStatement); the old one-click
    // confirmNotDuplicate flag is no longer accepted as a substitute for new approvals.
    const opts = { duplicates };
    const r = postingReadiness(stmt, lines, opts);
    if (!r.ready) throw blockersError(r);
    const plan = buildPostingPlan(stmt, lines, opts);
    if (!plan.balanced) throw new HttpsError('internal', 'The posting plan does not balance; nothing was approved.');
    const fingerprint = planFingerprint(plan);
    tx.update(ref, {
      status: 'approved',
      approval: { ...actorStamp(actor), note: input.note, fingerprint, postingId: plan.postingId, totals: plan.totals, duplicateAcknowledged: false, separateFrom: duplicates.filter((d) => d.confirmed).map((d) => d.otherId), warnings: r.warnings },
      updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid,
    });
    audit(tx, actor, {
      action: 'statement_approve', entityType: 'statement', entityId: input.statementId,
      summary: `Approved for posting: ${plan.totals.entries} entries, ${(plan.totals.amountCents / 100).toFixed(2)} (broker ${(plan.totals.brokerCents / 100).toFixed(2)}, agency ${(plan.totals.agencyCents / 100).toFixed(2)})${duplicates.length ? `; separate from ${duplicates.length} other same-month statement(s), each confirmed` : ''}${input.note ? ` — ${input.note}` : ''}`,
      changes: { status: { before: 'needs_review', after: 'approved' } },
    });
    return { status: 'approved', fingerprint, totals: plan.totals, warnings: r.warnings };
  });
});

const reasonInput = z.object({ statementId: z.string().regex(idRe), reason: z.string().trim().min(3).max(500) });

export const unapproveStatement = onCall(async (req) => {
  const actor = requireRole(req, ['admin']);
  const input = parse(reasonInput, req.data);
  return db.runTransaction(async (tx) => {
    const ref = db.collection('statements').doc(input.statementId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Statement not found.');
    if (snap.get('status') !== 'approved') throw new HttpsError('failed-precondition', 'Only an approved statement can be returned to review.');
    tx.update(ref, { status: 'needs_review', approval: null, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid });
    audit(tx, actor, { action: 'statement_unapprove', entityType: 'statement', entityId: input.statementId, summary: `Approval withdrawn: ${input.reason}`, changes: { status: { before: 'approved', after: 'needs_review' } } });
    return { status: 'needs_review' };
  });
});

// ---------------------------------------------------------------------------- post

export const postStatement = onCall({ timeoutSeconds: 120, memory: '512MiB' }, async (req) => {
  const actor = requireRole(req, ['admin']);
  const { statementId } = parse(z.object({ statementId: z.string().regex(idRe) }), req.data);
  return db.runTransaction(async (tx) => {
    const { ref, raw, stmt, lines, duplicates } = await loadForPosting(tx, statementId);
    if (stmt.status === 'posted') throw new HttpsError('already-exists', 'This statement is already posted.');
    if (stmt.status !== 'approved' || !raw.approval?.fingerprint) throw new HttpsError('failed-precondition', 'Approve the statement before posting.');
    // Re-checked at posting: an identical / same statement always blocks (even if approved earlier); an
    // approval given before pairwise confirmation existed keeps its old acknowledgement for the rest.
    const opts = { duplicates, legacyDuplicateAcknowledged: !!raw.approval.duplicateAcknowledged };
    const r = postingReadiness(stmt, lines, opts);
    if (!r.ready) throw blockersError(r);
    const plan = buildPostingPlan(stmt, lines, opts);
    if (!plan.balanced) throw new HttpsError('internal', 'The posting plan does not balance; nothing was posted.');
    if (plan.entries.length > MAX_POSTING_ENTRIES) throw new HttpsError('failed-precondition', 'Too many entries for one posting.');
    const fingerprint = planFingerprint(plan);
    if (fingerprint !== raw.approval.fingerprint) {
      throw new HttpsError('failed-precondition', 'The statement changed after it was approved. Return it to review and approve it again.');
    }
    const stamp = FieldValue.serverTimestamp();
    for (const e of plan.entries) {
      // create() fails the whole transaction if an entry with this ID already exists: no double posting.
      tx.create(db.collection('ledger').doc(e.id), {
        ...e, createdAt: stamp, postedAt: stamp, postedBy: actor.uid, postedByEmail: actor.email,
        approvedAt: raw.approval.at ?? null, approvedBy: raw.approval.by ?? null, approvedByEmail: raw.approval.email ?? null,
      });
    }
    tx.update(ref, {
      status: 'posted',
      postedCents: plan.totals.amountCents,
      pendingCents: 0,
      postingSeq: plan.seq,
      posting: { postingId: plan.postingId, seq: plan.seq, fingerprint, totals: plan.totals, ...actorStamp(actor) },
      updatedAt: stamp, updatedBy: actor.uid,
    });
    audit(tx, actor, {
      action: 'statement_post', entityType: 'statement', entityId: statementId,
      summary: `Posted ${plan.totals.entries} ledger entries for ${stmt.statementMonth}: ${(plan.totals.amountCents / 100).toFixed(2)} (broker ${(plan.totals.brokerCents / 100).toFixed(2)}, agency ${(plan.totals.agencyCents / 100).toFixed(2)}, suspense ${(plan.totals.suspenseCents / 100).toFixed(2)})`,
      changes: { status: { before: 'approved', after: 'posted' }, postedCents: { before: 0, after: plan.totals.amountCents } },
    });
    return { status: 'posted', postingId: plan.postingId, totals: plan.totals };
  });
});

// ---------------------------------------------------------------------------- reverse statement

export const reverseStatementPosting = onCall({ timeoutSeconds: 120, memory: '512MiB' }, async (req) => {
  const actor = requireRole(req, ['admin']);
  const input = parse(reasonInput, req.data);
  return db.runTransaction(async (tx) => {
    const ref = db.collection('statements').doc(input.statementId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Statement not found.');
    const s = snap.data()!;
    if (s.status !== 'posted' || !s.posting?.postingId) throw new HttpsError('failed-precondition', 'Only a posted statement can be reversed.');
    const entries = (await tx.get(db.collection('ledger').where('postingId', '==', s.posting.postingId))).docs;
    const originals = entries.filter((d) => !d.get('reversalOf'));
    if (!originals.length) throw new HttpsError('failed-precondition', 'No ledger entries found for this posting.');
    if (originals.some((d) => d.get('postingStatus') !== 'posted')) throw new HttpsError('failed-precondition', 'Part of this posting is already reversed.');
    const stamp = FieldValue.serverTimestamp();
    let total = 0;
    for (const d of originals) {
      const rev = reversalOf({ ...(d.data() as DocumentData), id: d.id } as Parameters<typeof reversalOf>[0], input.reason);
      total += rev.amountCents;
      const { createdAt: _c, postedAt: _p, ...rest } = rev as unknown as Record<string, unknown>;
      tx.create(db.collection('ledger').doc(rev.id), { ...rest, createdAt: stamp, postedAt: stamp, postedBy: actor.uid, postedByEmail: actor.email, reversalReason: input.reason });
      tx.update(d.ref, { postingStatus: 'reversed', reversedAt: stamp, reversedBy: actor.uid, reversalId: rev.id });
    }
    if (total !== -Number(s.postedCents ?? 0)) throw new HttpsError('internal', 'Reversal total does not equal the posted total; nothing was reversed.');
    tx.update(ref, {
      status: 'needs_review', postedCents: 0, posting: null, approval: null,
      reversals: FieldValue.arrayUnion({ postingId: s.posting.postingId, reason: input.reason, by: actor.uid, email: actor.email, amountCents: total, entries: originals.length, at: new Date().toISOString() }),
      updatedAt: stamp, updatedBy: actor.uid,
    });
    audit(tx, actor, {
      action: 'statement_reverse', entityType: 'statement', entityId: input.statementId,
      summary: `Reversed posting ${s.posting.postingId} (${originals.length} entries, ${(total / 100).toFixed(2)}): ${input.reason}`,
      changes: { status: { before: 'posted', after: 'needs_review' }, postedCents: { before: s.postedCents, after: 0 } },
    });
    return { status: 'needs_review', reversedEntries: originals.length, reversedCents: total };
  });
});

// ---------------------------------------------------------------------------- retained commission

const retainedInput = z.object({
  /** Client-generated ID; the same request can never create a second entry. */
  requestId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  policyId: z.string().regex(idRe),
  statementPeriod: z.string().regex(monthRe),
  amountCents: z.number().int().refine((n) => n !== 0 && Math.abs(n) <= 100_000_000, 'Enter a non-zero amount'),
  transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().default(null),
  classification: z.enum(LEDGER_CLASSIFICATIONS).default('new_business'),
  note: z.string().trim().min(3).max(500),
});

export const recordRetainedCommission = onCall(async (req) => {
  const actor = requireRole(req, ['admin']);
  const input = parse(retainedInput, req.data);
  return db.runTransaction(async (tx) => {
    const entryRef = db.collection('ledger').doc(`retained__${input.requestId}`);
    const existing = await tx.get(entryRef);
    if (existing.exists) return { entryId: entryRef.id, duplicate: true };
    const pSnap = await tx.get(db.collection('policies').doc(input.policyId));
    if (!pSnap.exists) throw new HttpsError('not-found', 'Policy not found.');
    const p = pSnap.data()!;
    const bSnap = await tx.get(db.collection('brokers').doc(String(p.brokerId || 'UNASSIGNED')));
    const policy = { id: pSnap.id, clientId: p.clientId, carrierId: p.carrierId, wholesalerId: p.wholesalerId ?? null, policyNumber: p.policyNumber, brokerId: p.brokerId, brokerShareBps: typeof p.brokerShareBps === 'number' ? p.brokerShareBps : null };
    const entry = retainedEntry({
      requestId: input.requestId, policy, payerId: p.wholesalerId || p.carrierId,
      brokers: new Map(bSnap.exists ? [[bSnap.id, { id: bSnap.id, shareBps: Number(bSnap.get('shareBps') ?? 0) }]] : []),
      amountCents: input.amountCents, statementPeriod: input.statementPeriod, transactionDate: input.transactionDate,
      classification: input.classification, note: input.note,
    });
    const stamp = FieldValue.serverTimestamp();
    tx.create(entryRef, { ...entry, createdAt: stamp, postedAt: stamp, postedBy: actor.uid, postedByEmail: actor.email, approvedAt: stamp, approvedBy: actor.uid, approvedByEmail: actor.email });
    audit(tx, actor, {
      action: 'retained_record', entityType: 'ledger', entityId: entryRef.id,
      summary: `Retained commission ${(entry.amountCents / 100).toFixed(2)} on policy ${p.policyNumber} for ${input.statementPeriod} (broker ${(entry.brokerCents / 100).toFixed(2)}, agency ${(entry.agencyCents / 100).toFixed(2)}): ${input.note}`,
    });
    return { entryId: entryRef.id, duplicate: false, brokerCents: entry.brokerCents, agencyCents: entry.agencyCents };
  });
});

export const reverseLedgerEntry = onCall(async (req) => {
  const actor = requireRole(req, ['admin']);
  const input = parse(z.object({ entryId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), reason: z.string().trim().min(3).max(500) }), req.data);
  return db.runTransaction(async (tx) => {
    const ref = db.collection('ledger').doc(input.entryId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Ledger entry not found.');
    const e = snap.data()!;
    if (e.sourceType === 'statement') throw new HttpsError('failed-precondition', 'Statement entries are reversed by reversing the whole statement posting.');
    if (e.reversalOf) throw new HttpsError('failed-precondition', 'A reversal cannot itself be reversed.');
    if (e.postingStatus !== 'posted') throw new HttpsError('failed-precondition', 'This entry is already reversed.');
    const rev = reversalOf({ ...(e as DocumentData), id: snap.id } as Parameters<typeof reversalOf>[0], input.reason);
    const stamp = FieldValue.serverTimestamp();
    const { createdAt: _c, postedAt: _p, ...rest } = rev as unknown as Record<string, unknown>;
    tx.create(db.collection('ledger').doc(rev.id), { ...rest, createdAt: stamp, postedAt: stamp, postedBy: actor.uid, postedByEmail: actor.email, reversalReason: input.reason });
    tx.update(ref, { postingStatus: 'reversed', reversedAt: stamp, reversedBy: actor.uid, reversalId: rev.id });
    audit(tx, actor, { action: 'ledger_reverse', entityType: 'ledger', entityId: snap.id, summary: `Reversed ${e.sourceType} entry ${(e.amountCents / 100).toFixed(2)}: ${input.reason}`, changes: { postingStatus: { before: 'posted', after: 'reversed' } } });
    return { reversalId: rev.id };
  });
});
