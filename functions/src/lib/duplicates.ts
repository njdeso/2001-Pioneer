import { createHash } from 'node:crypto';
import type { DocumentData, Transaction } from 'firebase-admin/firestore';
import { assessDuplicates, contentCanonical, LIVE_STATUSES, type DupLine, type DupStatement, type DuplicateFinding, type SeparateConfirmation } from '@asm/shared';
import { db } from './core.js';

/**
 * Server side of statement duplicate detection (statements/duplicates.ts holds the rules).
 * Compares a statement's STORED lines with those of every other live statement from the same payer and
 * month. Reads only. Inside approve/post it runs in the same transaction as the posting itself.
 */

export const digestOf = (lines: DupLine[]) => createHash('sha256').update(contentCanonical(lines)).digest('hex');

export function toDupStatement(id: string, d: DocumentData, lines: DupLine[]): DupStatement {
  return {
    id, status: String(d.status ?? ''), fileName: String(d.fileName ?? ''), payerId: d.payerId ?? null, statementMonth: d.statementMonth ?? null,
    classification: d.classification ?? null, agencyCode: d.agencyCode ?? null, officeCode: d.officeCode ?? null, statementDate: d.statementDate ?? null,
    title: String(d.title ?? ''), statedTotalCents: typeof d.statementTotalCents === 'number' ? d.statementTotalCents : null,
    postedCents: Number(d.postedCents ?? 0), lines, digest: digestOf(lines),
  };
}

/** Findings for one statement. `tx` given: every read is part of that transaction. */
export async function duplicateFindings(statementId: string, data: DocumentData, currentLines: DupLine[], tx?: Transaction): Promise<{ current: DupStatement; others: DupStatement[]; findings: DuplicateFinding[] }> {
  const current = toDupStatement(statementId, data, currentLines);
  if (!current.payerId || !current.statementMonth) return { current, others: [], findings: [] };
  const q = db.collection('statements').where('payerId', '==', current.payerId).where('statementMonth', '==', current.statementMonth);
  const snap = tx ? await tx.get(q) : await q.get();
  const others: DupStatement[] = [];
  for (const d of snap.docs) {
    if (d.id === statementId || !(LIVE_STATUSES as readonly string[]).includes(String(d.get('status')))) continue;
    const lq = d.ref.collection('lines');
    const ls = tx ? await tx.get(lq) : await lq.get();
    others.push(toDupStatement(d.id, d.data(), ls.docs.map((x) => x.data() as DupLine)));
  }
  const confirmations = (data.separateConfirmations ?? {}) as Record<string, SeparateConfirmation>;
  return { current, others, findings: assessDuplicates(current, others, confirmations) };
}
