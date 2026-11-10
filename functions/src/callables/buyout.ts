import { createHash } from 'node:crypto';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import type { Transaction } from 'firebase-admin/firestore';
import {
  adjustmentInput, buyoutConfigInput, buyoutInputsCanonical, canTransition, createSnapshotInput, DEFAULT_BUYOUT_RULES,
  removeAdjustmentInput, setSnapshotStateInput, settleBuyout, toBuyoutInputs, UNASSIGNED_BROKER_ID, valueBuyout,
  type BrokerAdvance, type BuyoutAdjustment, type BuyoutBroker, type BuyoutSnapshot, type PolicyTerm, type SnapshotPolicyRow, type SnapshotState,
} from '@asm/shared';
import { audit, db, FieldValue, meta, parse, requireRole, type Actor } from '../lib/core.js';

/**
 * Broker buyout settlement snapshots (owner/admin only; readable only by admins — firestore.rules).
 * The calculation runs HERE from the live records, never from numbers sent by a browser. A snapshot's
 * per-policy rows are written once and never changed; adjustments re-settle the brokers from those rows.
 * Nothing in this file reads or writes the ledger, statements or any Pioneer export.
 */

const SNAP = 'buyoutSettlements';
const BATCH = 400;
/** Firestore rejects undefined values; computed objects are made plain JSON before writing. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

async function loadLive(closingDate: string) {
  const [pol, brk, car, cli, adv, trm, settings] = await Promise.all([
    db.collection('policies').get(), db.collection('brokers').get(), db.collection('carriers').get(), db.collection('clients').get(),
    db.collection('brokerAdvances').get(), db.collectionGroup('terms').get(), db.collection('settings').doc('app').get(),
  ]);
  const { policies, brokers, carrierRates, carrierRateBps } = toBuyoutInputs({
    policies: pol.docs.map((d) => ({ ...d.data(), id: d.id })), brokers: brk.docs.map((d) => ({ ...d.data(), id: d.id })), carriers: car.docs.map((d) => ({ ...d.data(), id: d.id })),
  });
  const termsByPolicy = new Map<string, PolicyTerm[]>();
  for (const d of trm.docs) {
    const pid = d.ref.parent.parent?.id;
    if (!pid || d.ref.parent.parent?.parent.id !== 'policies') continue;
    termsByPolicy.set(pid, [...(termsByPolicy.get(pid) ?? []), { ...(d.data() as PolicyTerm), id: d.id, policyId: pid }]);
  }
  const advances = adv.docs.map((d) => ({ ...(d.data() as BrokerAdvance), id: d.id }));
  const rules = DEFAULT_BUYOUT_RULES;
  const fingerprint = createHash('sha256').update(buyoutInputsCanonical({ closingDate, rules, policies, termsByPolicy, brokers, advances, carrierRates })).digest('hex');
  return {
    policies, brokers, termsByPolicy, advances, rules, carrierRateBps, fingerprint,
    clientName: new Map<string, string>(cli.docs.map((d) => [d.id, String(d.get('name') ?? '')])),
    carrierName: new Map<string, string>(car.docs.map((d) => [d.id, String(d.get('name') ?? '')])),
    agencyName: String(settings.get('agencyName') ?? ''),
  };
}

async function readRows(id: string, tx?: Transaction): Promise<SnapshotPolicyRow[]> {
  const q = db.collection(SNAP).doc(id).collection('policyRows');
  const s = tx ? await tx.get(q) : await q.get();
  return s.docs.map((d) => d.data() as SnapshotPolicyRow);
}

const historyEntry = (actor: Actor, from: SnapshotState | null, to: SnapshotState, note: string) => ({ at: new Date().toISOString(), by: actor.email || actor.uid, from, to, note });

export const saveBuyoutConfig = onCall(async (req) => {
  const actor = requireRole(req, ['admin']);
  const input = parse(buyoutConfigInput, req.data);
  return db.runTransaction(async (tx) => {
    const ref = db.collection('buyoutConfig').doc('current');
    const before = await tx.get(ref);
    tx.set(ref, { ...input, ...meta(actor, !before.exists) }, { merge: true });
    audit(tx, actor, {
      action: 'buyout_config_update', entityType: 'buyoutConfig', entityId: 'current',
      summary: `Planned closing date ${input.plannedClosingDate ?? '(none)'}${input.closingDateConfirmed ? ' (confirmed)' : ' (planning only)'} — ${input.note}`,
      changes: { plannedClosingDate: { before: before.get('plannedClosingDate') ?? null, after: input.plannedClosingDate }, closingDateConfirmed: { before: before.get('closingDateConfirmed') ?? null, after: input.closingDateConfirmed } },
    });
    return { ok: true };
  });
});

/** Calculate from the live records and store a new draft version for the closing date. */
export const createBuyoutSnapshot = onCall({ timeoutSeconds: 300, memory: '512MiB' }, async (req) => {
  const actor = requireRole(req, ['admin']);
  const input = parse(createSnapshotInput, req.data);
  const live = await loadLive(input.closingDate);
  const v = valueBuyout({ closingDate: input.closingDate, rules: live.rules, policies: live.policies, termsByPolicy: live.termsByPolicy, brokers: live.brokers, advances: live.advances, carrierRateBps: live.carrierRateBps });
  const brokerName = new Map(live.brokers.map((b) => [b.id, b.name]));
  const ref = db.collection(SNAP).doc();
  // Policy rows first; the snapshot only becomes visible when its main document is written.
  const rows: SnapshotPolicyRow[] = v.policies.map((p) => ({ ...p, clientName: live.clientName.get(p.clientId) ?? '', carrierName: live.carrierName.get(p.carrierId) ?? '', brokerName: brokerName.get(p.brokerId) ?? p.brokerId }));
  for (let i = 0; i < rows.length; i += BATCH) {
    const b = db.batch();
    for (const r of rows.slice(i, i + BATCH)) b.set(ref.collection('policyRows').doc(r.policyId), plain(r) as unknown as Record<string, unknown>);
    await b.commit();
  }
  const directory: BuyoutBroker[] = live.brokers.map((b) => ({ id: b.id, name: b.name, shareBps: b.shareBps }));
  return db.runTransaction(async (tx) => {
    const counter = db.collection('buyoutCounters').doc(input.closingDate);
    const c = await tx.get(counter);
    const version = (Number(c.get('lastVersion')) || 0) + 1;
    tx.set(counter, { lastVersion: version, updatedAt: FieldValue.serverTimestamp() });
    const doc: Omit<BuyoutSnapshot, 'id'> = {
      closingDate: input.closingDate, version, state: 'draft', engineVersion: v.engineVersion, rules: v.rules, inputFingerprint: live.fingerprint,
      brokers: v.brokers, totals: v.totals, checks: v.checks, finalizable: v.finalizable, blockers: v.blockers,
      adjustments: [], brokerDirectory: directory, policyCount: rows.length, note: input.note, agencyName: live.agencyName,
      reviewedBy: null, finalizedBy: null, supersededById: null, history: [historyEntry(actor, null, 'draft', input.note)],
    };
    tx.create(ref, { ...plain(doc), ...meta(actor, true) });
    audit(tx, actor, {
      action: 'buyout_snapshot_create', entityType: 'buyoutSettlement', entityId: ref.id,
      summary: `Buyout snapshot v${version} for closing ${input.closingDate}: ${v.totals.eligiblePolicies} eligible policies, ${v.brokers.length} brokers, net ${(v.totals.finalNetCents / 100).toFixed(2)} — ${input.note}`,
    });
    return { id: ref.id, version, finalizable: v.finalizable, blockers: v.blockers };
  });
});

async function resettle(snapshotId: string, actor: Actor, change: (adj: BuyoutAdjustment[], brokers: BuyoutBroker[]) => { adjustments: BuyoutAdjustment[]; action: string; summary: string }) {
  return db.runTransaction(async (tx) => {
    const ref = db.collection(SNAP).doc(snapshotId);
    const s = await tx.get(ref);
    if (!s.exists) throw new HttpsError('not-found', 'Snapshot not found.');
    const snap = s.data() as BuyoutSnapshot;
    if (snap.state !== 'draft') throw new HttpsError('failed-precondition', `Adjustments can only be changed on a draft. This version is ${snap.state}; create a new version to revise it.`);
    const rows = await readRows(snapshotId, tx);
    const { adjustments, action, summary } = change(snap.adjustments ?? [], snap.brokerDirectory);
    const v = settleBuyout({ closingDate: snap.closingDate, rules: snap.rules, policies: rows, brokers: snap.brokerDirectory, adjustments, expectedPolicyCount: snap.policyCount });
    tx.update(ref, { ...plain({ adjustments, brokers: v.brokers, totals: v.totals, checks: v.checks, finalizable: v.finalizable, blockers: v.blockers }), ...meta(actor, false) });
    audit(tx, actor, { action, entityType: 'buyoutSettlement', entityId: snapshotId, summary });
    return { finalizable: v.finalizable, blockers: v.blockers };
  });
}

/** Owner-only positive or negative settlement adjustment, with a mandatory reason; applied before installment allocation. */
export const addBuyoutAdjustment = onCall(async (req) => {
  const actor = requireRole(req, ['admin']);
  const input = parse(adjustmentInput, req.data);
  return resettle(input.snapshotId, actor, (adj, brokers) => {
    if (!brokers.some((b) => b.id === input.brokerId) || input.brokerId === UNASSIGNED_BROKER_ID) throw new HttpsError('invalid-argument', 'Choose a broker in this snapshot.');
    const a: BuyoutAdjustment & { createdBy: string; createdAt: string } = { id: `adj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`, brokerId: input.brokerId, amountCents: input.amountCents, reason: input.reason, createdBy: actor.email || actor.uid, createdAt: new Date().toISOString() };
    return { adjustments: [...adj, a], action: 'buyout_adjustment_add', summary: `Adjustment ${(input.amountCents / 100).toFixed(2)} for broker ${input.brokerId} — ${input.reason}` };
  });
});

export const removeBuyoutAdjustment = onCall(async (req) => {
  const actor = requireRole(req, ['admin']);
  const input = parse(removeAdjustmentInput, req.data);
  return resettle(input.snapshotId, actor, (adj) => {
    const a = adj.find((x) => x.id === input.adjustmentId);
    if (!a) throw new HttpsError('not-found', 'Adjustment not found.');
    return { adjustments: adj.filter((x) => x.id !== input.adjustmentId), action: 'buyout_adjustment_remove', summary: `Removed adjustment ${(a.amountCents / 100).toFixed(2)} for broker ${a.brokerId} (${a.reason}) — ${input.reason}` };
  });
});

/** draft ⇄ reviewed → finalized; draft/reviewed → discarded. Finalized versions are immutable. */
export const setBuyoutSnapshotState = onCall({ timeoutSeconds: 120 }, async (req) => {
  const actor = requireRole(req, ['admin']);
  const input = parse(setSnapshotStateInput, req.data);
  let liveFingerprint: string | null = null;
  if (input.to === 'finalized') {
    const pre = await db.collection(SNAP).doc(input.snapshotId).get();
    if (!pre.exists) throw new HttpsError('not-found', 'Snapshot not found.');
    liveFingerprint = (await loadLive(String(pre.get('closingDate')))).fingerprint;
  }
  return db.runTransaction(async (tx) => {
    const ref = db.collection(SNAP).doc(input.snapshotId);
    const s = await tx.get(ref);
    if (!s.exists) throw new HttpsError('not-found', 'Snapshot not found.');
    const snap = s.data() as BuyoutSnapshot;
    if (!canTransition(snap.state, input.to)) throw new HttpsError('failed-precondition', `A ${snap.state} version cannot be changed to ${input.to}.`);
    const update: Record<string, unknown> = { state: input.to, history: [...(snap.history ?? []), historyEntry(actor, snap.state, input.to, input.note)], ...meta(actor, false) };
    if (input.to === 'reviewed') update.reviewedBy = actor.email || actor.uid;
    if (input.to === 'finalized') {
      if (liveFingerprint !== snap.inputFingerprint) throw new HttpsError('failed-precondition', 'The policies, terms, advances or broker shares have changed since this snapshot was taken. Create a new version and review it.');
      const rows = await readRows(input.snapshotId, tx);
      const v = settleBuyout({ closingDate: snap.closingDate, rules: snap.rules, policies: rows, brokers: snap.brokerDirectory, adjustments: snap.adjustments ?? [], expectedPolicyCount: snap.policyCount });
      if (!v.finalizable) throw new HttpsError('failed-precondition', `Cannot finalize: ${v.blockers.join(' ')}`);
      if (v.totals.finalNetCents !== snap.totals.finalNetCents) throw new HttpsError('failed-precondition', 'Stored totals do not match a recalculation from the stored policy rows. Create a new version.');
      const others = await tx.get(db.collection(SNAP).where('closingDate', '==', snap.closingDate).where('state', '==', 'finalized'));
      for (const o of others.docs) {
        if (o.id === input.snapshotId) continue;
        tx.update(o.ref, { state: 'superseded', supersededById: input.snapshotId, history: [...((o.get('history') as unknown[]) ?? []), historyEntry(actor, 'finalized', 'superseded', `Superseded by v${snap.version}`)], ...meta(actor, false) });
      }
      update.finalizedBy = actor.email || actor.uid;
      update.finalizedAt = FieldValue.serverTimestamp();
    }
    tx.update(ref, update);
    audit(tx, actor, { action: `buyout_snapshot_${input.to}`, entityType: 'buyoutSettlement', entityId: input.snapshotId, summary: `Buyout v${snap.version} (${snap.closingDate}): ${snap.state} → ${input.to} — ${input.note}` });
    return { state: input.to };
  });
});
