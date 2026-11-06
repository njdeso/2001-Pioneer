import { onCall, HttpsError } from 'firebase-functions/v2/https';
import {
  clientInput, normalizeName, normalizePolicyNumber, policyInput, policyKey, searchTokens,
} from '@asm/shared';
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
      searchTokens: searchTokens(input.name),
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
    if (carrier.kind !== 'carrier') {
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
      throw new HttpsError('already-exists', 'This carrier already has a policy with that number.', {
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
