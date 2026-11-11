import { Link } from 'react-router';
import { useCallback, useEffect, useState } from 'react';
import { RELATION_TEXT, STATEMENT_CLASSIFICATIONS, STATEMENT_CLASSIFICATION_LABELS, confirmationRefusal, formatMonth, type DuplicateFinding, type StatementClassification } from '@asm/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { Badge, Button, Card, ErrorNote, Field, Money, Select, TextArea } from '../ui';

/**
 * Same-month statements from this carrier. Several a month are normal (Personal / Commercial Lines), so
 * each one is compared by CONTENT on the server; an owner confirms the separate ones, and an identical /
 * same statement can never be posted alongside its twin (the server enforces this at approval and posting).
 */

export interface DuplicateCheck { statementId: string; classification: StatementClassification | null; lineCount: number; findings: DuplicateFinding[] }

export function useDuplicateCheck(statementId: string, refreshKey: string) {
  const [check, setCheck] = useState<DuplicateCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    if (!statementId) return;
    api.checkStatementDuplicates(statementId).then((c) => { setCheck(c); setError(null); }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [statementId]);
  useEffect(() => { load(); }, [load, refreshKey]);
  return { check, error, reload: load };
}

export function ClassificationPicker({ statementId, value, onSaved }: { statementId: string; value: StatementClassification | null | undefined; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex items-end gap-2">
      <Field label="Statement type">
        <Select value={value ?? ''} placeholder="Not classified" disabled={busy}
          options={STATEMENT_CLASSIFICATIONS.map((c) => ({ value: c, label: STATEMENT_CLASSIFICATION_LABELS[c] }))}
          onChange={async (e) => {
            const v = e.target.value as StatementClassification;
            if (!v) return;
            setBusy(true); setError(null);
            try { await api.setStatementClassification(statementId, v); onSaved(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
          }} />
      </Field>
      <ErrorNote message={error} />
    </div>
  );
}

const label = (c: StatementClassification | null) => (c ? STATEMENT_CLASSIFICATION_LABELS[c] : 'Not classified');

export function DuplicateReview({ statementId, month, check, error, reload }: { statementId: string; month: string | null | undefined; check: DuplicateCheck | null; error: string | null; reload: () => void }) {
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const [confirming, setConfirming] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [actError, setActError] = useState<string | null>(null);
  if (error) return <ErrorNote message={`Could not check for other statements this month: ${error}`} />;
  if (!check || check.findings.length === 0) return null;

  const hard = check.findings.filter((f) => f.hard);
  const open = check.findings.filter((f) => !f.hard && !f.confirmed);
  const tone = hard.length ? 'border-red-200 bg-red-50' : open.length ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50';

  async function confirm(f: DuplicateFinding) {
    setBusy(true); setActError(null);
    try { await api.confirmSeparateStatement(statementId, f.otherId, reason); setConfirming(null); setReason(''); reload(); }
    catch (e) { setActError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  return (
    <Card title={<span className="flex items-center gap-2">Other statements from this carrier for {month ? formatMonth(month) : 'this month'}
      {hard.length ? <Badge tone="red">Same statement found</Badge> : open.length ? <Badge tone="amber">{open.length} to confirm</Badge> : <Badge tone="green">All confirmed separate</Badge>}</span>}>
      <div className={`rounded-md border p-3 text-sm ${tone}`}>
        {hard.length > 0
          ? <p className="font-medium text-red-900">This file has the same content as another statement. Only one of them may be posted — discard the extra copy.</p>
          : open.length > 0
            ? <p className="text-amber-900">More than one statement for the same month is normal (for example Personal and Commercial Lines). Compare the details below; an owner then confirms each one as a separate statement. Approval and posting stay blocked until then.</p>
            : <p className="text-emerald-900">Each same-month statement has been confirmed as separate.</p>}
      </div>
      <ErrorNote message={actError} />
      <div className="mt-3 space-y-3">
        {check.findings.map((f) => {
          const refusal = confirmationRefusal(f, reason, check.classification);
          return (
            <div key={f.otherId} className="rounded-md border border-slate-200 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Link to={`/statements/${f.otherId}`} className="font-medium text-ink underline">{f.other.fileName || f.otherId}</Link>
                <Badge>{f.other.status.replace('_', ' ')}</Badge>
                <Badge tone={f.other.classification ? 'blue' : 'slate'}>{label(f.other.classification)}</Badge>
                {f.hard ? <Badge tone="red">Same statement</Badge> : f.confirmed ? <Badge tone="green">Confirmed separate</Badge> : <Badge tone="amber">Not yet confirmed</Badge>}
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-700 md:grid-cols-4">
                <div><dt className="text-slate-500">Statement date</dt><dd>{f.other.statementDate ?? '—'}</dd></div>
                <div><dt className="text-slate-500">Agency / office code</dt><dd>{f.other.agencyCode ?? '—'} / {f.other.officeCode ?? '—'}</dd></div>
                <div><dt className="text-slate-500">Printed total</dt><dd><Money cents={f.other.statedTotalCents} /></dd></div>
                <div><dt className="text-slate-500">Lines / posted</dt><dd>{f.other.lineCount} · <Money cents={f.other.postedCents} /></dd></div>
                {f.other.title && <div className="col-span-2 md:col-span-4"><dt className="text-slate-500">Title</dt><dd>{f.other.title}</dd></div>}
              </dl>
              <p className="mt-2 font-medium">{RELATION_TEXT[f.relation]}</p>
              <ul className="ml-4 list-disc text-xs text-slate-600">{f.evidence.map((e) => <li key={e}>{e}</li>)}</ul>
              {f.confirmation && f.confirmed && <p className="mt-2 text-xs text-emerald-800">Confirmed separate by {f.confirmation.email} on {f.confirmation.at.slice(0, 10)}: {f.confirmation.reason}</p>}
              {f.confirmation && !f.confirmed && !f.hard && <p className="mt-2 text-xs text-amber-800">An earlier confirmation ({f.confirmation.email}, {f.confirmation.at.slice(0, 10)}) no longer applies because a statement's lines changed. Confirm again.</p>}
              {!f.hard && !f.confirmed && isAdmin && (confirming === f.otherId ? (
                <div className="mt-3 space-y-2">
                  <Field label="Why are these separate statements? (required)">
                    <TextArea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Commercial Lines statement; the other is Personal Lines for the same month" />
                  </Field>
                  {refusal && <p className="text-xs text-amber-800">{refusal}</p>}
                  <div className="flex gap-2">
                    <Button size="sm" disabled={busy || !!refusal} onClick={() => void confirm(f)}>Confirm separate statement</Button>
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setConfirming(null); setReason(''); setActError(null); }}>Cancel</Button>
                  </div>
                </div>
              ) : <Button className="mt-3" size="sm" variant="secondary" onClick={() => { setConfirming(f.otherId); setReason(''); setActError(null); }}>Confirm separate statement…</Button>)}
              {!f.hard && !f.confirmed && !isAdmin && <p className="mt-2 text-xs text-slate-500">An owner confirms separate statements.</p>}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
