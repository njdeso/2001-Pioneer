import type { DocumentReference } from 'firebase-admin/firestore';
import { aiCorrectionAuditEntries, type AiValueCorrection, type ExtractedStatement } from '@asm/shared';
import { audit, db, type Actor, type Writer } from './core.js';

/** Replace a statement's extracted lines (every re-read starts again). Touches nothing outside `lines`. */
export async function replaceLines(stmtRef: DocumentReference, s: ExtractedStatement, payerId: string | null): Promise<void> {
  const existing = await stmtRef.collection('lines').listDocuments();
  for (let i = 0; i < existing.length; i += 450) {
    const b = db.batch();
    existing.slice(i, i + 450).forEach((d) => b.delete(d));
    await b.commit();
  }
  for (let i = 0; i < s.lines.length; i += 450) {
    const b = db.batch();
    for (const l of s.lines.slice(i, i + 450)) {
      b.set(stmtRef.collection('lines').doc(String(l.lineNo).padStart(5, '0')), {
        ...l,
        statementId: stmtRef.id,
        payerId,
        status: l.kind === 'commission' ? 'pending' : 'info',
        match: { status: 'not_started' },
      });
    }
    await b.commit();
  }
}

/**
 * Permanent record of AI-extracted figures corrected by a carrier reading rule: one audit-log entry per
 * corrected figure, staged in the caller's batch (committed with the extraction run it belongs to). The
 * audit log is append-only and admin-read; replaceLines never touches it, so later re-reads keep it.
 */
export function recordAiCorrections(w: Writer, actor: Actor, statementId: string, runId: string, corrections: readonly AiValueCorrection[]): void {
  for (const e of aiCorrectionAuditEntries(statementId, runId, corrections)) audit(w, actor, e);
}
