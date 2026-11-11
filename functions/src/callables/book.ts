import { onCall, HttpsError } from 'firebase-functions/v2/https';
import {
  checkTerms, clientInput, normalizeName, normalizePolicyNumber, policyInput, policyKey, policyTermInput, searchTokens, termIdFor,
  type PolicyTerm,
} from '@asm/shared';
import { z } from 'zod';
import { audit, db, diff, idParam, meta, mustExist, parse, requireRole } from '../lib/core.js';

export const saveClient = onCall(async (req) => {
  const actor = requireRole(req);
  const body = (req.data ?? {}) as { id?: unknown; data?: unknown; applyBrokerToPolicies?: unknown };
  const id = idParam(body.id);
  const input = parse(clientInput, body.data);
  const applyBroker = body.applyBrokerToPolicies === true;

  return db.runTransaction(async (tx) => {
    const ref = id ? db.collection('clients').doc(id) : db.collection('clients').doc();
    const snap = await tx.get(ref);
    if (id && !snap.exists) throw new HttpsError('not-found', 'Client not found.');
    await mustExist(tx, db.collection('brokers').doc(input.brokerId), 'Broker');
    const before = snap.exists ? (snap.data() as Record<string, unknown>) : undefined;

    const policySnaps = applyBroker && before
      ? await tx.get(db.collection('policies').where('clientId', '==', ref.id))
      : null;

    const data = {
      ...input,
      normalizedName: normalizeName(input.name),
      searchTokens: searchTokens(input.name, input.externalId),
    };
    tx.set(ref, { ...data, ...meta(actor, !before) }, { merge: true });

    let moved = 0;
    if (policySnaps) {
      for (const p of policySnaps.docs) {
        if (p.get('brokerId') !== input.brokerId) {
          tx.update(p.ref, { brokerId: input.brokerId, ...meta(actor, false) });
          moved++;
        }
      }
    }
    audit(tx, actor, {
      action: before ? 'update' : 'create',
      entityType: 'client',
      entityId: ref.id,
      summary: `${before ? 'Updated' : 'Created'} client${moved ? `; moved ${moved} policies to broker ${input.brokerId}` : ''}`,
      changes: diff(before, data),
    });
    return { id: ref.id, policiesMoved: moved };
  });
});

export const savePolicy = onCall(async (req) => {
  const actor = requireRole(req);
  const body = (req.data ?? {}) as { id?: unknown; data?: unknown };
  const id = idParam(body.id);
  const input = parse(policyInput, body.data);

  return db.runTransaction(async (tx) => {
    const ref = id ? db.collection('policies').doc(id) : db.collection('policies').doc();
    const snap = await tx.get(ref);
    if (id && !snap.exists) throw new HttpsError('not-found', 'Policy not found.');
    const before = snap.exists ? (snap.data() as Record<string, unknown>) : undefined;

    await mustExist(tx, db.collection('clients').doc(input.clientId), 'Client');
    await mustExist(tx, db.collection('brokers').doc(input.brokerId), 'Broker');
    const carrier = await mustExist(tx, db.collection('carriers').doc(input.carrierId), 'Carrier');
    if (carrier.kind !== 'carrier' && input.wholesalerId !== input.carrierId) {
      throw new HttpsError('invalid-argument', 'Choose the underlying insurance carrier, not a wholesaler.', {
        fieldErrors: { carrierId: 'Pick the insurance carrier; put the wholesaler in the Wholesaler field' },
      });
    }
    if (input.wholesalerId) {
      const w = await mustExist(tx, db.collection('carriers').doc(input.wholesalerId), 'Wholesaler');
      if (w.kind !== 'wholesaler') {
        throw new HttpsError('invalid-argument', 'Wholesaler must be a wholesaler.', {
          fieldErrors: { wholesalerId: 'Not a wholesaler' },
        });
      }
    }

    // One policy per carrier + normalized number. The same number at two carriers is allowed.
    const key = policyKey(input.carrierId, input.policyNumber);
    const keyRef = db.collection('policyKeys').doc(key);
    const keySnap = await tx.get(keyRef);
    if (keySnap.exists && keySnap.get('policyId') !== ref.id) {
      throw new HttpsError('already-exists', 'This carrier already has a policy with that number. To record another coverage term (a renewal or an earlier term), open that policy and add a term instead of creating a second policy.', {
        fieldErrors: { policyNumber: 'Duplicate for this carrier' },
        existingPolicyId: keySnap.get('policyId'),
      });
    }
    if (before) {
      const oldKey = policyKey(String(before.carrierId), String(before.policyNumber));
      if (oldKey !== key) tx.delete(db.collection('policyKeys').doc(oldKey));
    }
    if (!keySnap.exists) tx.set(keyRef, { policyId: ref.id });

    const data = {
      ...input,
      normalizedPolicyNumber: normalizePolicyNumber(input.policyNumber),
      alternateNumbersNormalized: input.alternateNumbers.map(normalizePolicyNumber),
      searchTokens: searchTokens(input.policyNumber, input.namedInsured, ...input.alternateNumbers),
    };
    tx.set(ref, { ...data, ...meta(actor, !before) }, { merge: true });
    audit(tx, actor, {
      action: before ? 'update' : 'create',
      entityType: 'policy',
      entityId: ref.id,
      summary: `${before ? 'Updated' : 'Created'} policy`,
      changes: diff(before, data),
    });
    return { id: ref.id };
  });
});

/** Move policies to another broker (current-broker attribution for the snapshot). */
export const reassignPolicies = onCall(async (req) => {
  const actor = requireRole(req);
  const body = (req.data ?? {}) as { policyIds?: unknown; brokerId?: unknown };
  const brokerId = idParam(body.brokerId, 'broker');
  if (!brokerId) throw new HttpsError('invalid-argument', 'Broker is required.');
  if (!Array.isArray(body.policyIds) || body.policyIds.length === 0 || body.policyIds.length > 400) {
    throw new HttpsError('invalid-argument', 'Select between 1 and 400 policies.');
  }
  const ids = body.policyIds.map((v) => idParam(v, 'policy')!);

  return db.runTransaction(async (tx) => {
    await mustExist(tx, db.collection('brokers').doc(brokerId), 'Broker');
    const snaps = await Promise.all(ids.map((pid) => tx.get(db.collection('policies').doc(pid))));
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    for (const s of snaps) {
      if (!s.exists) throw new HttpsError('not-found', `Policy ${s.id} not found.`);
      const from = s.get('brokerId');
      if (from === brokerId) continue;
      tx.update(s.ref, { brokerId, ...meta(actor, false) });
      changes[s.id] = { before: from, after: brokerId };
    }
    audit(tx, actor, {
      action: 'reassign',
      entityType: 'policy',
      entityId: brokerId,
      summary: `Moved ${Object.keys(changes).length} policies to broker ${brokerId}`,
      changes,
    });
    return { moved: Object.keys(changes).length };
  });
});

// --------------------------------------------------------------------------- coverage terms

const termIdRe = /^\d{4}-\d{2}-\d{2}$/;
const termSaveInput = z.object({
  policyId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  /** The term being edited (its effective date), or null to add a term. */
  originalTermId: z.string().regex(termIdRe).nullable().default(null),
  term: policyTermInput,
  note: z.string().trim().min(3, 'A note is required: where these dates come from').max(500),
});

/**
 * Add or edit one coverage term of a policy (policies/{id}/terms/{effectiveDate}). The policy record
 * itself (its number, current dates and status) is not changed. The whole term history is checked:
 * no overlaps, one active term at most and only as the latest. Changing a term's effective date (its
 * ID) is refused once posted commission refers to the term.
 */
export const savePolicyTerm = onCall(async (req) => {
  const actor = requireRole(req);
  const input = parse(termSaveInput, req.data);
  const policyRef = db.collection('policies').doc(input.policyId);
  const newId = termIdFor(input.term.effectiveDate);
  return db.runTransaction(async (tx) => {
    const [pSnap, termsSnap] = await Promise.all([tx.get(policyRef), tx.get(policyRef.collection('terms'))]);
    if (!pSnap.exists) throw new HttpsError('not-found', 'Policy not found.');
    const existing = termsSnap.docs.map((d) => ({ ...(d.data() as Omit<PolicyTerm, 'id' | 'policyId'>), id: d.id, policyId: input.policyId }));
    const original = input.originalTermId ? existing.find((t) => t.id === input.originalTermId) : undefined;
    if (input.originalTermId && !original) throw new HttpsError('not-found', 'That term no longer exists. Reload and try again.');
    if (!input.originalTermId && existing.some((t) => t.id === newId)) throw new HttpsError('already-exists', `This policy already has a term starting ${newId}. Edit that term instead.`);
    if (original && original.id !== newId) {
      if (existing.some((t) => t.id === newId)) throw new HttpsError('already-exists', `This policy already has a term starting ${newId}.`);
      const used = await tx.get(db.collection('ledger').where('policyId', '==', input.policyId).where('termId', '==', original.id).limit(1));
      if (!used.empty) throw new HttpsError('failed-precondition', 'Posted commission refers to this term, so its effective date cannot change. Add a separate term instead.');
    }
    const next = [...existing.filter((t) => t.id !== input.originalTermId), { ...input.term, id: newId, policyId: input.policyId }];
    const problems = checkTerms(next);
    const errors = problems.filter((p) => p.severity === 'error');
    if (errors.length) throw new HttpsError('invalid-argument', errors.map((e) => e.message).join(' '), { problems: errors });
    const data = { ...input.term, policyId: input.policyId, policyNumber: pSnap.get('policyNumber'), carrierId: pSnap.get('carrierId') };
    if (original && original.id !== newId) tx.delete(policyRef.collection('terms').doc(original.id));
    tx.set(policyRef.collection('terms').doc(newId), { ...data, ...meta(actor, !original || original.id !== newId) }, { merge: !!original && original.id === newId });
    audit(tx, actor, {
      action: original ? 'policy_term_update' : 'policy_term_create',
      entityType: 'policyTerm', entityId: `${input.policyId}/${newId}`,
      summary: `${original ? 'Updated' : 'Added'} term ${newId} → ${input.term.scheduledExpirationDate} (${input.term.status}${input.term.cancellationDate ? `, cancelled ${input.term.cancellationDate}` : ''}) on policy ${String(pSnap.get('policyNumber'))} — ${input.note}`,
      changes: diff(original as unknown as Record<string, unknown> | undefined, { ...input.term }),
    });
    return { termId: newId, warnings: problems.filter((p) => p.severity === 'warning') };
  });
});

const termRemoveInput = z.object({
  policyId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  termId: z.string().regex(termIdRe),
  note: z.string().trim().min(3, 'A note is required').max(500),
});

/** Remove a coverage term entered by mistake. Refused once posted commission refers to it. */
export const removePolicyTerm = onCall(async (req) => {
  const actor = requireRole(req);
  const input = parse(termRemoveInput, req.data);
  const ref = db.collection('policies').doc(input.policyId).collection('terms').doc(input.termId);
  return db.runTransaction(async (tx) => {
    const [snap, used] = await Promise.all([
      tx.get(ref),
      tx.get(db.collection('ledger').where('policyId', '==', input.policyId).where('termId', '==', input.termId).limit(1)),
    ]);
    if (!snap.exists) throw new HttpsError('not-found', 'Term not found.');
    if (!used.empty) throw new HttpsError('failed-precondition', 'Posted commission refers to this term, so it cannot be removed. Correct its dates or status instead.');
    tx.delete(ref);
    audit(tx, actor, {
      action: 'policy_term_remove', entityType: 'policyTerm', entityId: `${input.policyId}/${input.termId}`,
      summary: `Removed term ${input.termId} (${String(snap.get('status'))}) — ${input.note}`,
      changes: diff(snap.data() as Record<string, unknown>, {}),
    });
    return { removed: input.termId };
  });
});
