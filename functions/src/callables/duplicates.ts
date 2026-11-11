import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { confirmationRefusal, STATEMENT_CLASSIFICATIONS, STATEMENT_CLASSIFICATION_LABELS, type DupLine, type SeparateConfirmation } from '@asm/shared';
import { audit, db, FieldValue, parse, requireRole } from '../lib/core.js';
import { duplicateFindings } from '../lib/duplicates.js';

/**
 * Same-month statements from one carrier (e.g. Personal and Commercial Lines):
 *   checkStatementDuplicates  — read-only: this statement compared with every other live same-month one
 *   setStatementClassification — Personal Lines / Commercial Lines / Other (metadata only, audited)
 *   confirmSeparateStatement   — owner confirms two statements are separate (reason required, audited,
 *                                recorded on BOTH statements with each one's content digest).
 * None of these changes lines, matching, approvals, postings or ledger entries.
 */

const idRe = /^[A-Za-z0-9_-]{1,128}$/;

async function load(statementId: string) {
  const ref = db.collection('statements').doc(statementId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Statement not found.');
  const lines = (await ref.collection('lines').get()).docs.map((d) => d.data() as DupLine);
  return { ref, data: snap.data()!, lines };
}

export const checkStatementDuplicates = onCall(async (req) => {
  requireRole(req, ['admin', 'staff']);
  const { statementId } = parse(z.object({ statementId: z.string().regex(idRe) }), req.data);
  const { data, lines } = await load(statementId);
  const { findings, current } = await duplicateFindings(statementId, data, lines);
  return { statementId, classification: current.classification ?? null, lineCount: lines.length, findings };
});

export const setStatementClassification = onCall(async (req) => {
  const actor = requireRole(req, ['admin', 'staff']);
  const input = parse(z.object({ statementId: z.string().regex(idRe), classification: z.enum(STATEMENT_CLASSIFICATIONS) }), req.data);
  return db.runTransaction(async (tx) => {
    const ref = db.collection('statements').doc(input.statementId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Statement not found.');
    const before = snap.get('classification') ?? null;
    if (before === input.classification) return { classification: before };
    tx.update(ref, { classification: input.classification, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid });
    audit(tx, actor, {
      action: 'statement_classify', entityType: 'statement', entityId: input.statementId,
      summary: `Classified as ${STATEMENT_CLASSIFICATION_LABELS[input.classification]}${before ? ` (was ${STATEMENT_CLASSIFICATION_LABELS[before as keyof typeof STATEMENT_CLASSIFICATION_LABELS] ?? before})` : ''}`,
      changes: { classification: { before, after: input.classification } },
    });
    return { classification: input.classification };
  });
});

export const confirmSeparateStatement = onCall(async (req) => {
  const actor = requireRole(req, ['admin']);
  const input = parse(z.object({ statementId: z.string().regex(idRe), otherStatementId: z.string().regex(idRe), reason: z.string().trim().max(500) }), req.data);
  if (input.statementId === input.otherStatementId) throw new HttpsError('invalid-argument', 'Choose a different statement.');
  return db.runTransaction(async (tx) => {
    const ref = db.collection('statements').doc(input.statementId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Statement not found.');
    const lines = (await tx.get(ref.collection('lines'))).docs.map((d) => d.data() as DupLine);
    const { current, others, findings } = await duplicateFindings(input.statementId, snap.data()!, lines, tx);
    const f = findings.find((x) => x.otherId === input.otherStatementId);
    const refusal = confirmationRefusal(f, input.reason, current.classification);
    if (refusal) throw new HttpsError('failed-precondition', refusal);
    const other = others.find((o) => o.id === input.otherStatementId)!;
    const at = new Date().toISOString();
    const mine: SeparateConfirmation = { by: actor.uid, email: actor.email, at, reason: input.reason, digest: current.digest, otherDigest: other.digest };
    const theirs: SeparateConfirmation = { by: actor.uid, email: actor.email, at, reason: input.reason, digest: other.digest, otherDigest: current.digest };
    tx.update(ref, { [`separateConfirmations.${other.id}`]: mine, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid });
    tx.update(db.collection('statements').doc(other.id), { [`separateConfirmations.${current.id}`]: theirs, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid });
    const label = (c: string | null | undefined) => (c ? STATEMENT_CLASSIFICATION_LABELS[c as keyof typeof STATEMENT_CLASSIFICATION_LABELS] : 'unclassified');
    const summary = (a: typeof current, b: typeof other) =>
      `Confirmed separate from statement ${b.id} ("${b.fileName}", ${label(b.classification)}, ${f!.sharedLines} shared line(s)); this one is ${label(a.classification)} — ${input.reason}`;
    audit(tx, actor, { action: 'statement_confirm_separate', entityType: 'statement', entityId: current.id, summary: summary(current, other) });
    audit(tx, actor, { action: 'statement_confirm_separate', entityType: 'statement', entityId: other.id, summary: summary(other, current) });
    return { confirmed: true, statementId: current.id, otherStatementId: other.id };
  });
});
