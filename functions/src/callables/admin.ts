import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineString } from 'firebase-functions/params';
import { settingsInput, trailingTwelveStart, UNASSIGNED_BROKER_ID } from '@asm/shared';
import { audit, auth, db, diff, meta, parse, requireRole, type Actor } from '../lib/core.js';

/** Comma-separated owner email(s), set at deploy time: OWNER_EMAILS="you@example.com" */
const OWNER_EMAILS = defineString('OWNER_EMAILS');

/**
 * First-run bootstrap. A signed-in user whose email is listed in OWNER_EMAILS
 * receives the admin role. Also creates default settings and the Unassigned broker.
 */
export const claimOwner = onCall(async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const email = String(req.auth.token.email ?? '').toLowerCase();
  const owners = OWNER_EMAILS.value().split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!email || !owners.includes(email)) {
    throw new HttpsError('permission-denied', 'This account is not an owner account.');
  }
  await auth.setCustomUserClaims(req.auth.uid, { role: 'admin' });
  const actor: Actor = { uid: req.auth.uid, email, role: 'admin' };

  await db.runTransaction(async (tx) => {
    const userRef = db.collection('users').doc(actor.uid);
    const settingsRef = db.collection('settings').doc('app');
    const brokerRef = db.collection('brokers').doc(UNASSIGNED_BROKER_ID);
    const keyRef = db.collection('brokerCodes').doc(UNASSIGNED_BROKER_ID);
    const [settings, broker] = await Promise.all([tx.get(settingsRef), tx.get(brokerRef)]);

    tx.set(userRef, { email, role: 'admin', ...meta(actor, true) }, { merge: true });
    if (!settings.exists) {
      const today = new Date().toISOString().slice(0, 10);
      tx.set(settingsRef, {
        agencyName: 'Central Insurance Agency',
        snapshotStartMonth: trailingTwelveStart(today),
        snapshotMonths: 12,
        revenueBasis: 'statementPeriod',
        defaultBrokerShareBps: 5000,
        ...meta(actor, true),
      });
    }
    if (!broker.exists) {
      tx.set(brokerRef, { name: 'Unassigned', code: UNASSIGNED_BROKER_ID, shareBps: 0, status: 'active', ...meta(actor, true) });
      tx.set(keyRef, { id: UNASSIGNED_BROKER_ID });
    }
    audit(tx, actor, { action: 'claim_owner', entityType: 'user', entityId: actor.uid, summary: 'Owner role granted' });
  });
  return { role: 'admin' };
});

export const saveSettings = onCall(async (req) => {
  const actor = requireRole(req);
  const data = parse(settingsInput, req.data);
  return db.runTransaction(async (tx) => {
    const ref = db.collection('settings').doc('app');
    const snap = await tx.get(ref);
    const before = snap.exists ? (snap.data() as Record<string, unknown>) : undefined;
    if (before?.lockedAt) {
      throw new HttpsError('failed-precondition', 'The snapshot is locked; settings can no longer change.');
    }
    tx.set(ref, { ...data, ...meta(actor, !before) }, { merge: true });
    audit(tx, actor, { action: 'update', entityType: 'settings', entityId: 'app', summary: 'Updated settings', changes: diff(before, data) });
    return { ok: true };
  });
});
