import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { brokerInput, carrierInput, UNASSIGNED_BROKER_ID } from '@asm/shared';
import { audit, db, diff, idParam, meta, parse, requireRole, type Actor } from '../lib/core.js';

/**
 * Save a document whose `code` must be unique within its collection.
 * Uniqueness is enforced with a key document created in the same transaction.
 */
async function saveWithUniqueCode(opts: {
  actor: Actor;
  collection: 'carriers' | 'brokers';
  keyCollection: 'carrierCodes' | 'brokerCodes';
  entityType: string;
  id?: string;
  data: Record<string, unknown> & { code: string; name: string };
}): Promise<{ id: string }> {
  const { actor, collection, keyCollection, entityType, data } = opts;
  return db.runTransaction(async (tx) => {
    const ref = opts.id ? db.collection(collection).doc(opts.id) : db.collection(collection).doc();
    const snap = await tx.get(ref);
    if (opts.id && !snap.exists) throw new HttpsError('not-found', `${entityType} not found.`);
    const before = snap.exists ? (snap.data() as Record<string, unknown>) : undefined;

    const newKey = db.collection(keyCollection).doc(data.code);
    const keySnap = await tx.get(newKey);
    if (keySnap.exists && keySnap.get('id') !== ref.id) {
      throw new HttpsError('already-exists', `Code ${data.code} is already used.`, {
        fieldErrors: { code: 'This code is already used' },
      });
    }
    if (before && before.code !== data.code) {
      tx.delete(db.collection(keyCollection).doc(String(before.code)));
    }
    if (!keySnap.exists) tx.set(newKey, { id: ref.id });

    tx.set(ref, { ...data, ...meta(actor, !before) }, { merge: true });
    audit(tx, actor, {
      action: before ? 'update' : 'create',
      entityType,
      entityId: ref.id,
      summary: `${before ? 'Updated' : 'Created'} ${entityType} ${data.code}`,
      changes: diff(before, data),
    });
    return { id: ref.id };
  });
}

export const saveCarrier = onCall(async (req) => {
  const actor = requireRole(req);
  const body = (req.data ?? {}) as { id?: unknown; data?: unknown };
  const data = parse(carrierInput, body.data);
  return saveWithUniqueCode({
    actor, collection: 'carriers', keyCollection: 'carrierCodes', entityType: 'carrier',
    id: idParam(body.id), data,
  });
});

export const saveBroker = onCall(async (req) => {
  const actor = requireRole(req);
  const body = (req.data ?? {}) as { id?: unknown; data?: unknown };
  const id = idParam(body.id);
  const data = parse(brokerInput, body.data);
  if (id === UNASSIGNED_BROKER_ID) {
    data.code = UNASSIGNED_BROKER_ID;
    data.status = 'active';
    data.shareBps = 0;
  }
  return saveWithUniqueCode({
    actor, collection: 'brokers', keyCollection: 'brokerCodes', entityType: 'broker', id, data,
  });
});
