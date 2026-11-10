import { onCall, HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData, DocumentSnapshot, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { z } from 'zod';
import {
  autoMatchLine, matchToPolicy, noMatch, prepareMatchContext, summarizeMatches, policyNumberKey, MATCH_ENGINE_VERSION,
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
  const ctx = await loadContext(stmt.payerId);
  const lines = await ref.collection('lines').get();

  let changed = 0, keptManual = 0;
  const writes: { doc: QueryDocumentSnapshot; match: LineMatch }[] = [];
  for (const d of lines.docs) {
    const current = d.get('match');
    if (!includeManual && isMatch(current) && current.method === 'manual') { keptManual++; continue; }
    const next = autoMatchLine(lineInput(d.data()), ctx);
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
      next = matchToPolicy(line, ctx.policyById.get(pSnap.id)!, ctx, 'manual');
    } else if (input.action === 'unmatch') {
      next = noMatch(line, 'unmatched', 'manual', ['manually_unmatched'], isMatch(before) ? before.candidates : [], policyNumberKey(line.policyNumberRaw).key);
    } else {
      next = autoMatchLine(line, await loadContext(stmt.payerId));
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
    const label = { assign: 'match_manual_assign', unmatch: 'match_manual_unmatch', auto: 'match_revert_auto' }[input.action];
    audit(tx, actor, {
      action: label,
      entityType: 'statementLine',
      entityId: `${input.statementId}/${input.lineId}`,
      summary: `Line ${lineSnap.get('lineNo')}: ${input.action === 'assign' ? `matched to policy ${next.policyId}` : input.action === 'unmatch' ? 'marked unmatched' : `returned to automatic matching (${next.status})`}${input.note ? ` — ${input.note}` : ''}`,
      changes: {
        status: { before: isMatch(before) ? before.status : null, after: next.status },
        method: { before: isMatch(before) ? before.method : null, after: next.method },
        policyId: { before: isMatch(before) ? before.policyId : null, after: next.policyId },
        brokerId: { before: isMatch(before) ? before.brokerId : null, after: next.brokerId },
        brokerCents: { before: isMatch(before) ? before.brokerCents : null, after: next.brokerCents },
      },
    });
    return { match: next, adjustments: (stmt.adjustments ?? []) as StatementAdjustment[] };
  });

  const summary = await writeSummary(input.statementId, result.adjustments, actor);
  return { match: result.match, summary };
});
