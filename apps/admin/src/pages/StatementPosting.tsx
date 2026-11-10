import { useMemo, useState } from 'react';
import { buildPostingPlan, formatMonth, postingReadiness, type PostingLine, type PostingStatement } from '@asm/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { useData } from '../data';
import { Badge, Button, Card, ErrorNote, Field, Modal, Money, Stat, TextArea } from '../ui';
import type { MatchingInfo, MatchLine } from './StatementMatching';

/**
 * Stage 3C: approval and posting. The browser only previews; the server re-checks everything,
 * fingerprints the plan at approval and refuses to post if anything changed. Admin only.
 */

export interface PostingInfo {
  status: string;
  payerId?: string | null;
  statementMonth?: string | null;
  statementDate?: string | null;
  adjustments?: { label: string; amountCents: number }[];
  postedCents?: number;
  postingSeq?: number;
  possibleDuplicateOf?: string | null;
  matching?: MatchingInfo | null;
  approval?: { email?: string; note?: string; totals?: { entries: number; amountCents: number; brokerCents: number; agencyCents: number }; duplicateAcknowledged?: boolean } | null;
  posting?: { postingId: string; seq: number; email?: string; totals: { entries: number; amountCents: number; brokerCents: number; agencyCents: number; suspenseCents: number; adjustmentsCents: number } } | null;
  reversals?: { postingId: string; reason: string; email?: string; amountCents: number; entries: number; at: string }[];
}

export function PostingPanel({ statementId, stmt, lines }: { statementId: string; stmt: PostingInfo; lines: MatchLine[] }) {
  const { role } = useAuth();
  const { carrierById } = useData();
  const isAdmin = role === 'admin';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ackDuplicate, setAckDuplicate] = useState(false);
  const [note, setNote] = useState('');
  const [reasonFor, setReasonFor] = useState<null | 'unapprove' | 'reverse'>(null);
  const [reason, setReason] = useState('');

  const ps: PostingStatement = {
    id: statementId, status: stmt.status, payerId: stmt.payerId ?? null, payerKind: stmt.payerId ? carrierById.get(stmt.payerId)?.kind ?? null : null,
    statementMonth: stmt.statementMonth ?? null, statementDate: stmt.statementDate ?? null, adjustments: stmt.adjustments ?? [],
    postedCents: stmt.postedCents ?? 0, postingSeq: stmt.postingSeq ?? 0, possibleDuplicateOf: stmt.possibleDuplicateOf ?? null,
    matching: stmt.matching ? { stale: !!stmt.matching.stale, balanced: stmt.matching.balanced !== false } : null,
  };
  const pl = lines as unknown as PostingLine[];
  const readiness = useMemo(() => postingReadiness(ps, pl, { duplicateAcknowledged: ackDuplicate || !!stmt.approval?.duplicateAcknowledged }), [stmt, lines, ackDuplicate]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = useMemo(() => { try { return readiness.ready ? buildPostingPlan(ps, pl, { duplicateAcknowledged: true }) : null; } catch { return null; } }, [readiness]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true); setError(null); setNotice(null);
    try { await fn(); setNotice(done); setReasonFor(null); setReason(''); } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); } finally { setBusy(false); }
  }

  const totals = stmt.posting?.totals ?? stmt.approval?.totals ?? preview?.totals;
  const posted = stmt.status === 'posted';
  const approved = stmt.status === 'approved';
  const dupFlag = readiness.blockers.some((b) => b.code === 'possible_duplicate') || (!!stmt.possibleDuplicateOf && !stmt.approval);

  return (
    <Card title={<span className="flex items-center gap-2">Approval &amp; posting {posted ? <Badge tone="green">Posted</Badge> : approved ? <Badge tone="blue">Approved</Badge> : readiness.ready ? <Badge tone="green">Ready to approve</Badge> : <Badge tone="amber">Not ready</Badge>}</span>}>
      <ErrorNote message={error} />
      {notice && <p className="mb-2 text-sm text-emerald-700">{notice}</p>}
      {!isAdmin && <p className="mb-2 text-sm text-slate-600">Only an administrator can approve, post or reverse statements.</p>}

      {!posted && !approved && readiness.blockers.length > 0 && (
        <ul className="mb-3 space-y-1 text-sm text-amber-900">
          {readiness.blockers.map((b) => <li key={b.code}>• {b.message}{b.lineNos?.length ? <span className="text-xs text-slate-500"> (lines {b.lineNos.slice(0, 12).join(', ')}{b.lineNos.length > 12 ? '…' : ''})</span> : null}</li>)}
        </ul>
      )}
      {readiness.warnings.length > 0 && !posted && (
        <ul className="mb-3 space-y-1 text-xs text-slate-600">{readiness.warnings.map((w) => <li key={w.code}>Note: {w.message}{w.lineNos?.length ? ` (lines ${w.lineNos.slice(0, 12).join(', ')})` : ''}</li>)}</ul>
      )}

      {totals && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat label={posted ? 'Posted' : 'To post'} value={<Money cents={totals.amountCents} />} sub={`${totals.entries} ledger entries · ${stmt.statementMonth ? formatMonth(stmt.statementMonth) : ''}`} />
          <Stat label="Broker commission" value={<Money cents={totals.brokerCents} />} />
          <Stat label="Agency commission" value={<Money cents={totals.agencyCents} />} />
          {'suspenseCents' in totals && <Stat label="Suspense (no policy)" value={<Money cents={(totals as { suspenseCents: number }).suspenseCents} />} sub="100 % agency" />}
          {'adjustmentsCents' in totals && <Stat label="Statement adjustments" value={<Money cents={(totals as { adjustmentsCents: number }).adjustmentsCents} />} sub="Carrier-level, agency" />}
        </div>
      )}

      {posted && stmt.posting && <p className="mt-3 text-xs text-slate-600">Posting {stmt.posting.postingId} by {stmt.posting.email}. These entries are in the rolling-12-month reports for {stmt.statementMonth ? formatMonth(stmt.statementMonth) : 'the statement month'}.</p>}
      {approved && stmt.approval && <p className="mt-3 text-xs text-slate-600">Approved by {stmt.approval.email}{stmt.approval.note ? ` — ${stmt.approval.note}` : ''}. Matching is locked until it is posted or returned to review.</p>}
      {(stmt.reversals ?? []).length > 0 && (
        <div className="mt-3 text-xs text-slate-600">Earlier postings reversed: {(stmt.reversals ?? []).map((r) => `${r.postingId} (${(r.amountCents / 100).toFixed(2)}, ${r.reason})`).join('; ')}</div>
      )}

      {isAdmin && (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          {!posted && !approved && (
            <>
              {dupFlag && (
                <label className="flex items-center gap-2 text-sm text-amber-900">
                  <input type="checkbox" checked={ackDuplicate} onChange={(e) => setAckDuplicate(e.target.checked)} />
                  I confirm this is a separate statement, not a duplicate
                </label>
              )}
              <Field label="Approval note (optional)" className="min-w-[16rem] flex-1"><TextArea rows={1} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
              <Button disabled={busy || !readiness.ready} onClick={() => void act(() => api.approveStatement(statementId, ackDuplicate, note), 'Approved. Review the totals, then post.')}>Approve for posting</Button>
            </>
          )}
          {approved && (
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setReasonFor('unapprove')}>Return to review</Button>
              <Button disabled={busy} onClick={() => { if (window.confirm(`Post ${totals ? (totals.amountCents / 100).toFixed(2) : ''} to the ledger for ${stmt.statementMonth}? Posted entries appear in the financial reports. A posting can only be undone by a reversal.`)) void act(() => api.postStatement(statementId), 'Posted to the ledger.'); }}>Post to ledger</Button>
            </>
          )}
          {posted && <Button variant="danger" disabled={busy} onClick={() => setReasonFor('reverse')}>Reverse posting…</Button>}
        </div>
      )}

      <Modal open={!!reasonFor} title={reasonFor === 'reverse' ? 'Reverse this posting' : 'Return to review'} onClose={() => setReasonFor(null)}>
        <p className="text-sm text-slate-600">
          {reasonFor === 'reverse'
            ? 'Creates an exact negative entry for every posted entry (the originals stay, marked reversed), so the reports net to zero. The statement returns to review and can be corrected and posted again.'
            : 'Withdraws the approval. Matching can be changed again.'}
        </p>
        <Field label="Reason (required, kept in the audit log)" className="mt-3"><TextArea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setReasonFor(null)}>Cancel</Button>
          <Button variant={reasonFor === 'reverse' ? 'danger' : 'primary'} disabled={busy || reason.trim().length < 3}
            onClick={() => void act(() => (reasonFor === 'reverse' ? api.reverseStatementPosting(statementId, reason) : api.unapproveStatement(statementId, reason)), reasonFor === 'reverse' ? 'Posting reversed. The statement is back in review.' : 'Returned to review.')}>
            {reasonFor === 'reverse' ? 'Reverse posting' : 'Return to review'}
          </Button>
        </div>
      </Modal>
    </Card>
  );
}
