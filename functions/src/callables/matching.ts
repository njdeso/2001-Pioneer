import { onCall, HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData, DocumentSnapshot, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { z } from 'zod';
import {
  autoMatchLine, matchToPolicy, noMatch, prepareMatchContext, summarizeMatches, policyNumberKey, policyKey, normalizePolicyNumber, MATCH_ENGINE_VERSION,
  HISTORICAL_POLICY_STATUSES, UNASSIGNED_BROKER_ID, withTerm, type HistoricalAttribution, type PolicyTerm,
  type LineMatch, type MatchBroker, type MatchClient, type MatchPolicy, type PreparedContext, type StatementAdjustment,
} from '@asm/shared';
import { audit, db, FieldValue, parse, requireRole, type Actor } from '../lib/core.js';

/**
 * Stage 3B — commission matching.
 *
 * Writes ONLY:
 *   statements/{id}/lines/{lineId}.match   (the match, stored beside the untouched extracted values)
 *   statements/{id}.matching               (summary and progress)
 *   auditLog                                (every manual change, with before/after)
 *
 * Never creates, edits or deletes clients, policies, carriers, brokers or ledger entries, and
 * never posts commission. Refuses statements that have posted lines.
 */

const MATCHABLE = ['needs_review', 'discrepancy'];
const idRe = /^[A-Za-z0-9_-]{1,128}$/;

/** Coverage-term history of every policy (policies/{id}/terms), keyed by policy ID. */
async function loadTerms(): Promise<Map<string, PolicyTerm[]>> {
  const snap = await db.collectionGroup('terms').get();
  const out = new Map<string, PolicyTerm[]>();
  for (const d of snap.docs) {
    const policyId = d.ref.parent.parent?.id;
    if (!policyId || d.ref.parent.parent?.parent.id !== 'policies') continue;
    const t = { ...(d.data() as Omit<PolicyTerm, 'id' | 'policyId'>), id: d.id, policyId };
    out.set(policyId, [...(out.get(policyId) ?? []), t]);
  }
  return out;
}

async function loadContext(payerId: string | null): Promise<PreparedContext> {
  const [policies, clients, brokers] = await Promise.all([
    db.collection('policies').get(),
    db.collection('clients').get(),
    db.collection('brokers').get(),
  ]);
  return prepareMatchContext({
    payerId,
    policies: policies.docs.map((d) => {
      const p = d.data();
      return {
        id: d.id, clientId: p.clientId, carrierId: p.carrierId, wholesalerId: p.wholesalerId ?? null,
        policyNumber: p.policyNumber, normalizedPolicyNumber: p.normalizedPolicyNumber,
        alternateNumbers: p.alternateNumbers ?? [], alternateNumbersNormalized: p.alternateNumbersNormalized ?? [],
        namedInsured: p.namedInsured ?? '', brokerId: p.brokerId, brokerShareBps: typeof p.brokerShareBps === 'number' ? p.brokerShareBps : null, status: p.status,
      } satisfies MatchPolicy;
    }),
    clients: clients.docs.map((d) => ({ id: d.id, name: d.get('name') ?? '', brokerId: d.get('brokerId') }) satisfies MatchClient),
    brokers: brokers.docs.map((d) => ({ id: d.id, name: d.get('name') ?? '', shareBps: Number(d.get('shareBps') ?? 0) }) satisfies MatchBroker),
  });
}

function assertMatchable(snap: DocumentSnapshot): DocumentData {
  if (!snap.exists) throw new HttpsError('not-found', 'Statement not found.');
  const s = snap.data()!;
  if (!MATCHABLE.includes(s.status)) throw new HttpsError('failed-precondition', 'Only extracted statements can be matched.');
  if ((s.postedCents ?? 0) !== 0) throw new HttpsError('failed-precondition', 'Lines from this statement have been posted; matching is locked.');
  if (!s.payerId) throw new HttpsError('failed-precondition', 'Choose the statement’s carrier first.');
  return s;
}

const lineInput = (d: DocumentData) => ({
  policyNumberRaw: String(d.policyNumberRaw ?? ''),
  insuredName: String(d.insuredName ?? ''),
  paidCommissionCents: typeof d.paidCommissionCents === 'number' ? d.paidCommissionCents : null,
  effectiveDate: typeof d.effectiveDate === 'string' ? d.effectiveDate : null,
});

const isMatch = (m: unknown): m is LineMatch => !!m && typeof m === 'object' && ['matched', 'ambiguous', 'unmatched'].includes((m as LineMatch).status);

/** Recompute and store the statement summary from its lines. */
async function writeSummary(statementId: string, adjustments: StatementAdjustment[], actor: Actor, extra: Record<string, unknown> = {}) {
  const ref = db.collection('statements').doc(statementId);
  const lines = await ref.collection('lines').get();
  const summary = summarizeMatches(lines.docs.map((d) => ({
    paidCommissionCents: typeof d.get('paidCommissionCents') === 'number' ? d.get('paidCommissionCents') : null,
    match: isMatch(d.get('match')) ? (d.get('match') as LineMatch) : null,
  })), adjustments);
  await ref.update({ matching: { ...summary, stale: false, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid, ...extra } });
  return summary;
}

// --------------------------------------------------------------------------- automatic matching

const runInput = z.object({
  statementId: z.string().regex(idRe),
  /** Also recompute lines that were matched or unmatched manually. Default: keep them. */
  includeManual: z.boolean().optional().default(false),
});

export const runStatementMatching = onCall({ memory: '512MiB', timeoutSeconds: 300 }, async (req) => {
  const actor = requireRole(req);
  const { statementId, includeManual } = parse(runInput, req.data);
  const ref = db.collection('statements').doc(statementId);
  const stmt = assertMatchable(await ref.get());
  const [ctx, terms] = await Promise.all([loadContext(stmt.payerId), loadTerms()]);
  const lines = await ref.collection('lines').get();

  let changed = 0, keptManual = 0;
  const writes: { doc: QueryDocumentSnapshot; match: LineMatch }[] = [];
  for (const d of lines.docs) {
    const current = d.get('match');
    if (!includeManual && isMatch(current) && current.method === 'manual') { keptManual++; continue; }
    const li = lineInput(d.data());
    const auto = autoMatchLine(li, ctx);
    // The coverage term is added only to matched lines, from the line's effective date and the policy's terms.
    const next = withTerm(auto, li.effectiveDate, auto.policyId ? terms.get(auto.policyId) : undefined);
    writes.push({ doc: d, match: next });
    if (!isMatch(current) || current.status !== next.status || current.policyId !== next.policyId) changed++;
  }
  for (let i = 0; i < writes.length; i += 400) {
    const b = db.batch();
    // Only the match field is written; extracted values are never touched.
    for (const w of writes.slice(i, i + 400)) b.update(w.doc.ref, { match: { ...w.match, matchedAt: FieldValue.serverTimestamp(), matchedBy: 'auto' } });
    await b.commit();
  }
  const summary = await writeSummary(statementId, stmt.adjustments ?? [], actor, { lastRunAt: FieldValue.serverTimestamp(), lastRunBy: actor.uid });
  const b = db.batch();
  audit(b, actor, {
    action: 'match_auto_run', entityType: 'statement', entityId: statementId,
    summary: `Automatic matching (${MATCH_ENGINE_VERSION}): ${summary.matched} matched, ${summary.ambiguous} ambiguous, ${summary.unmatched} unmatched; ${changed} changed, ${keptManual} manual kept${includeManual ? ' (manual matches recomputed)' : ''}`,
  });
  await b.commit();
  return { ...summary, changed, keptManual };
});

// --------------------------------------------------------------------------- manual matching

const manualInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('assign'), statementId: z.string().regex(idRe), lineId: z.string().regex(idRe), policyId: z.string().regex(idRe), note: z.string().trim().max(500).optional().default('') }),
  z.object({ action: z.literal('unmatch'), statementId: z.string().regex(idRe), lineId: z.string().regex(idRe), note: z.string().trim().max(500).optional().default('') }),
  z.object({ action: z.literal('auto'), statementId: z.string().regex(idRe), lineId: z.string().regex(idRe), note: z.string().trim().max(500).optional().default('') }),
  // A past (cancelled/expired) policy that is not in the book: record what is known about it.
  z.object({
    action: z.literal('historical'), statementId: z.string().regex(idRe), lineId: z.string().regex(idRe),
    clientId: z.string().regex(idRe).nullable().default(null),
    insuredName: z.string().trim().min(1, 'Insured name is required').max(200),
    policyNumber: z.string().trim().min(1, 'Policy number is required').max(60),
    carrierId: z.string().regex(idRe).nullable().default(null),
    policyStatus: z.enum(HISTORICAL_POLICY_STATUSES),
    attributedBrokerId: z.string().regex(idRe).nullable().default(null),
    note: z.string().trim().min(3, 'A note is required: how the policy was identified').max(500),
  }),
]);

const brief = (m: unknown) => (isMatch(m) ? { status: m.status, method: m.method, policyId: m.policyId, clientId: m.clientId, brokerId: m.brokerId, brokerShareBps: m.brokerShareBps, brokerCents: m.brokerCents, agencyCents: m.agencyCents } : null);

/**
 * Assign a line to a policy, mark it unmatched, or return it to automatic matching.
 * The line's extracted values and the source file are never changed.
 */
export const setLineMatch = onCall(async (req) => {
  const actor = requireRole(req);
  const input = parse(manualInput, req.data);
  const ref = db.collection('statements').doc(input.statementId);
  const lineRef = ref.collection('lines').doc(input.lineId);

  const result = await db.runTransaction(async (tx) => {
    const [stmtSnap, lineSnap] = await Promise.all([tx.get(ref), tx.get(lineRef)]);
    const stmt = assertMatchable(stmtSnap);
    if (!lineSnap.exists) throw new HttpsError('not-found', 'Statement line not found.');
    const line = lineInput(lineSnap.data()!);
    const before = lineSnap.get('match');

    let next: LineMatch;
    if (input.action === 'assign') {
      const pSnap = await tx.get(db.collection('policies').doc(input.policyId));
      if (!pSnap.exists) throw new HttpsError('not-found', 'Policy not found.');
      const p = pSnap.data()!;
      const [cSnap, bSnap] = await Promise.all([
        tx.get(db.collection('clients').doc(String(p.clientId))),
        tx.get(db.collection('brokers').doc(String(p.brokerId || 'UNASSIGNED'))),
      ]);
      const ctx = prepareMatchContext({
        payerId: stmt.payerId,
        policies: [{ id: pSnap.id, clientId: p.clientId, carrierId: p.carrierId, wholesalerId: p.wholesalerId ?? null, policyNumber: p.policyNumber, namedInsured: p.namedInsured ?? '', brokerId: p.brokerId, brokerShareBps: typeof p.brokerShareBps === 'number' ? p.brokerShareBps : null, status: p.status }],
        clients: cSnap.exists ? [{ id: cSnap.id, name: cSnap.get('name') ?? '' }] : [],
        brokers: bSnap.exists ? [{ id: bSnap.id, shareBps: Number(bSnap.get('shareBps') ?? 0) }] : [],
      });
      const termSnap = await tx.get(db.collection('policies').doc(pSnap.id).collection('terms'));
      const policyTerms = termSnap.docs.map((t) => ({ ...(t.data() as Omit<PolicyTerm, 'id' | 'policyId'>), id: t.id, policyId: pSnap.id }));
      next = withTerm(matchToPolicy(line, ctx.policyById.get(pSnap.id)!, ctx, 'manual'), line.effectiveDate, policyTerms);
    } else if (input.action === 'historical') {
      const carrierId = input.carrierId ?? String(stmt.payerId);
      const [cSnap, carSnap, bSnap] = await Promise.all([
        input.clientId ? tx.get(db.collection('clients').doc(input.clientId)) : Promise.resolve(null),
        tx.get(db.collection('carriers').doc(carrierId)),
        input.attributedBrokerId ? tx.get(db.collection('brokers').doc(input.attributedBrokerId)) : Promise.resolve(null),
      ]);
      if (cSnap && !cSnap.exists) throw new HttpsError('not-found', 'Customer not found.');
      if (!carSnap.exists) throw new HttpsError('not-found', 'Carrier not found.');
      if (bSnap && !bSnap.exists) throw new HttpsError('not-found', 'Broker not found.');
      if (input.attributedBrokerId === UNASSIGNED_BROKER_ID) throw new HttpsError('invalid-argument', 'Leave the broker empty instead of choosing Unassigned.');
      // A policy that IS in the book must be matched to that policy, not recorded as historical.
      if (normalizePolicyNumber(input.policyNumber)) {
        const keySnap = await tx.get(db.collection('policyKeys').doc(policyKey(carrierId, input.policyNumber)));
        if (keySnap.exists) throw new HttpsError('failed-precondition', `Policy ${input.policyNumber} at this carrier is in the book (policy ${String(keySnap.get('policyId') ?? '')}). Match the line to that policy instead.`);
      }
      const historical: HistoricalAttribution = {
        clientId: input.clientId, insuredName: input.insuredName, policyNumber: input.policyNumber, carrierId,
        policyStatus: input.policyStatus, attributedBrokerId: input.attributedBrokerId, buyoutEligible: false, note: input.note,
      };
      next = { ...noMatch(line, 'unmatched', 'manual', ['historical_policy'], [], policyNumberKey(line.policyNumberRaw).key), historical };
    } else if (input.action === 'unmatch') {
      next = noMatch(line, 'unmatched', 'manual', ['manually_unmatched'], isMatch(before) ? before.candidates : [], policyNumberKey(line.policyNumberRaw).key);
    } else {
      const [actx, terms] = await Promise.all([loadContext(stmt.payerId), loadTerms()]);
      const auto = autoMatchLine(line, actx);
      next = withTerm(auto, line.effectiveDate, auto.policyId ? terms.get(auto.policyId) : undefined);
    }

    tx.update(lineRef, {
      match: {
        ...next,
        note: input.note,
        matchedAt: FieldValue.serverTimestamp(),
        matchedBy: input.action === 'auto' ? 'auto' : actor.uid,
        matchedByEmail: input.action === 'auto' ? null : actor.email,
        previous: brief(before),
      },
    });
    const label = { assign: 'match_manual_assign', unmatch: 'match_manual_unmatch', auto: 'match_revert_auto', historical: 'match_manual_historical' }[input.action];
    audit(tx, actor, {
      action: label,
      entityType: 'statementLine',
      entityId: `${input.statementId}/${input.lineId}`,
      summary: `Line ${lineSnap.get('lineNo')}: ${input.action === 'assign' ? `matched to policy ${next.policyId}` : input.action === 'unmatch' ? 'marked unmatched' : input.action === 'historical' ? `identified as past policy ${input.policyNumber} (${input.policyStatus})${input.clientId ? ` of customer ${input.clientId}` : ''}${input.attributedBrokerId ? `, attributed to broker ${input.attributedBrokerId} for reporting only` : ''}` : `returned to automatic matching (${next.status})`}${input.note ? ` — ${input.note}` : ''}`,
      changes: {
        status: { before: isMatch(before) ? before.status : null, after: next.status },
        method: { before: isMatch(before) ? before.method : null, after: next.method },
        policyId: { before: isMatch(before) ? before.policyId : null, after: next.policyId },
        brokerId: { before: isMatch(before) ? before.brokerId : null, after: next.brokerId },
        brokerCents: { before: isMatch(before) ? before.brokerCents : null, after: next.brokerCents },
        historical: { before: isMatch(before) ? (before as LineMatch).historical ?? null : null, after: next.historical ?? null },
        termId: { before: isMatch(before) ? (before as LineMatch).term?.termId ?? null : null, after: next.term?.termId ?? null },
      },
    });
    return { match: next, adjustments: (stmt.adjustments ?? []) as StatementAdjustment[] };
  });

  const summary = await writeSummary(input.statementId, result.adjustments, actor);
  return { match: result.match, summary };
});
