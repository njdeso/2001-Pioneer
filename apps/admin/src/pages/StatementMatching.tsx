import { useMemo, useState, type ReactNode } from 'react';
import {
  formatBps, matchToPolicy, MATCH_REASON_TEXT, TERM_RESOLUTION_TEXT, nameEvidence, prepareMatchContext, TRANSACTION_TYPE_LABELS, UNASSIGNED_BROKER_ID,
  type Cents, type ExtractedLine, type LineMatch, type MatchCandidate, type MatchSummary, type NameEvidence, type Policy, displayName } from '@asm/shared';
import { api } from '../api';
import { useData } from '../data';
import { Badge, Button, Card, ErrorNote, Field, Modal, Money, Select, Stat, TextArea, TextInput, cx } from '../ui';

/**
 * Stage 3B review UI. Every change goes through the server (setLineMatch / runStatementMatching),
 * which writes only the line's match, the statement's matching summary and the audit log.
 * The extracted values shown on the left of the dialog are never edited.
 */

export type StoredMatch = LineMatch & { note?: string; matchedByEmail?: string | null; previous?: unknown };
export type MatchLine = ExtractedLine & { id: string; status: 'pending' | 'info'; match?: StoredMatch | { status: 'not_started' } };
export type MatchingInfo = MatchSummary & { stale?: boolean; lastRunAt?: { toDate?: () => Date } };
export type MatchFilter = 'any' | 'matched' | 'ambiguous' | 'unmatched' | 'manual' | 'not_run';

export const lineMatch = (l: MatchLine): StoredMatch | null =>
  l.match && l.match.status !== 'not_started' ? (l.match as StoredMatch) : null;

export function matchFilterFn(f: MatchFilter): (l: MatchLine) => boolean {
  return (l) => {
    const m = lineMatch(l);
    switch (f) {
      case 'matched': return m?.status === 'matched';
      case 'ambiguous': return m?.status === 'ambiguous';
      case 'unmatched': return m?.status === 'unmatched';
      case 'manual': return m?.method === 'manual';
      case 'not_run': return !m;
      default: return true;
    }
  };
}

const NAME_TEXT: Record<NameEvidence, string> = { strong: 'name agrees', partial: 'name partly agrees', none: 'name differs', unknown: 'no name to compare' };
const NUMBER_TEXT: Record<MatchCandidate['numberEvidence'], string> = { exact: 'same policy number', alternate: 'alternate number', leading_zeros: 'same digits except leading zeros', none: 'name only (number differs)' };

export function MatchBadge({ m }: { m: StoredMatch | null }) {
  if (!m) return <Badge>Not matched yet</Badge>;
  if (m.historical) return <Badge tone="amber">Past policy (not in book)</Badge>;
  const tone = m.status === 'matched' ? 'green' : m.status === 'ambiguous' ? 'amber' : 'red';
  const label = m.status === 'matched' ? (m.method === 'manual' ? 'Matched (manual)' : m.confidence === 'high' ? 'Matched' : 'Matched — check') : m.status === 'ambiguous' ? 'Ambiguous' : m.method === 'manual' ? 'Unmatched (manual)' : 'Unmatched';
  return <Badge tone={tone}>{label}</Badge>;
}

/** "Matched to" cell: client, policy, carrier. */
export function MatchedTo({ m }: { m: StoredMatch | null }) {
  const { clientById, policyById, carrierById } = useData();
  if (m?.historical) {
    const h = m.historical;
    return (
      <div className="text-xs leading-tight">
        <div className="font-medium text-ink">{h.clientId ? displayName(clientById.get(h.clientId)?.name) || h.clientId : h.insuredName}</div>
        <div className="font-mono text-slate-600">{h.policyNumber} <span className="font-sans text-amber-700">({h.policyStatus})</span></div>
        <div className="text-slate-500">{carrierById.get(h.carrierId ?? '')?.name ?? h.carrierId} · suspense, not in book</div>
      </div>
    );
  }
  if (!m?.policyId) return <span className="text-xs text-slate-400">{m ? MATCH_REASON_TEXT[m.reasons.find((r) => r !== 'number_and_carrier') ?? m.reasons[0]] ?? '' : ''}</span>;
  const p = policyById.get(m.policyId);
  return (
    <div className="text-xs leading-tight">
      <div className="font-medium text-ink">{displayName(clientById.get(m.clientId ?? '')?.name) || m.clientId}</div>
      <div className="font-mono text-slate-600">{p?.policyNumber ?? m.policyId}</div>
      {m.term ? <div className="text-slate-500">Term {m.term.effectiveDate} → {m.term.endDate} ({m.term.status})</div>
        : m.termResolution && m.termResolution !== 'no_terms' ? <div className="text-amber-700">{TERM_RESOLUTION_TEXT[m.termResolution]}</div> : null}
      <div className="text-slate-500">{carrierById.get(m.carrierId ?? '')?.name ?? m.carrierId}</div>
    </div>
  );
}

export function BrokerCell({ m }: { m: StoredMatch | null }) {
  const { brokerById } = useData();
  if (!m?.policyId) return <span className="text-slate-400">—</span>;
  const b = brokerById.get(m.brokerId ?? '');
  return <span className="text-xs">{b?.name ?? m.brokerId}{m.brokerShareBps != null && <span className="text-slate-500"> · {formatBps(m.brokerShareBps)}{m.brokerShareSource === 'policy' ? ' (policy)' : ''}</span>}</span>;
}

// --------------------------------------------------------------------------- progress card

export function MatchingPanel({ statementId, payerId, matching, lines, canMatch }: {
  statementId: string; payerId: string | null | undefined; matching: MatchingInfo | null | undefined; lines: MatchLine[]; canMatch: boolean;
}) {
  const { brokerById } = useData();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const s = matching;
  const pct = s && s.commissionLineCount ? Math.round((s.matchedCommissionLines / s.commissionLineCount) * 100) : 0;
  const anyRun = lines.some((l) => lineMatch(l));

  async function run(includeManual: boolean) {
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await api.runStatementMatching(statementId, includeManual);
      setNotice(`${r.matched} matched, ${r.ambiguous} ambiguous, ${r.unmatched} unmatched${r.keptManual ? `; ${r.keptManual} manual matches kept` : ''}.`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Matching failed'); } finally { setBusy(false); }
  }

  return (
    <Card
      title={<span className="flex items-center gap-2">Commission matching {s?.stale && <Badge tone="amber">Carrier changed — re-run</Badge>}{s && !s.balanced && <Badge tone="red">Totals do not balance</Badge>}</span>}
      actions={canMatch && (
        <div className="flex gap-2">
          <Button size="sm" disabled={busy || !payerId} onClick={() => void run(false)}>{busy ? 'Matching…' : anyRun ? 'Re-run automatic matching' : 'Run automatic matching'}</Button>
          {anyRun && <Button size="sm" variant="ghost" disabled={busy || !payerId} onClick={() => { if (window.confirm('Recompute every line, including lines you matched or unmatched manually?')) void run(true); }}>Re-run including manual</Button>}
        </div>
      )}
    >
      <ErrorNote message={error} />
      {notice && <p className="mb-2 text-sm text-emerald-700">{notice}</p>}
      {!payerId && <p className="text-sm text-amber-800">Choose the statement’s carrier first. Policy numbers are matched only within that carrier (or the wholesaler that paid).</p>}
      {!s && payerId && <p className="text-sm text-slate-600">Not matched yet. Automatic matching uses the policy number within this statement’s carrier, with the insured name as supporting evidence. Nothing is posted and no client or policy is created or changed.</p>}
      {s && (
        <>
          <div className="mb-1 flex items-center justify-between text-xs text-slate-600">
            <span>{s.matchedCommissionLines} of {s.commissionLineCount} commission lines matched</span><span>{pct}%</span>
          </div>
          <div className="mb-4 h-2 w-full overflow-hidden rounded bg-slate-100"><div className="h-2 rounded bg-emerald-500" style={{ width: `${pct}%` }} /></div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            <Stat label="Matched" value={<Money cents={s.matchedCommissionCents} />} sub={`${s.matched} lines${s.manual ? ` · ${s.manual} manual` : ''}`} />
            <Stat label="Ambiguous" value={<Money cents={s.ambiguousCommissionCents} />} sub={`${s.ambiguous} lines — confirm`} />
            <Stat label="Unmatched" value={<Money cents={s.unmatchedCommissionCents} />} sub={`${s.unmatched} lines`} />
            <Stat label="Broker commission" value={<Money cents={s.brokerCents} />} sub="On matched lines" />
            <Stat label="Agency commission" value={<Money cents={s.agencyCents} />} sub="On matched lines" />
            <Stat label="Statement adjustments" value={<Money cents={s.adjustmentsCents} />} sub="Agency only, not split" />
          </div>
          {s.byBroker.length > 0 && (
            <table className="mt-4 min-w-full text-sm">
              <thead><tr className="text-left text-xs uppercase text-slate-500"><th className="py-1">Broker</th><th className="text-right">Lines</th><th className="text-right">Commission</th><th className="text-right">Broker</th><th className="text-right">Agency</th></tr></thead>
              <tbody>{s.byBroker.map((b) => (
                <tr key={b.brokerId} className="border-t border-slate-100">
                  <td className="py-1">{brokerById.get(b.brokerId)?.name ?? (b.brokerId === UNASSIGNED_BROKER_ID ? 'Unassigned' : b.brokerId)}</td>
                  <td className="text-right">{b.lines}</td>
                  <td className="text-right"><Money cents={b.commissionCents} /></td>
                  <td className="text-right"><Money cents={b.brokerCents} /></td>
                  <td className="text-right"><Money cents={b.agencyCents} /></td>
                </tr>
              ))}</tbody>
            </table>
          )}
          <p className="mt-3 text-xs text-slate-500">
            Commission on this statement: <Money cents={s.commissionCents} /> = matched + ambiguous + unmatched{s.balanced ? ' (balances to the cent)' : ' — DOES NOT BALANCE'}.
            Broker shares use each policy’s broker and that broker’s percentage; chargebacks reduce both shares. Nothing here is posted — approval and posting come in Stage 3C.
          </p>
        </>
      )}
    </Card>
  );
}

// --------------------------------------------------------------------------- match dialog

/** The same matching context the server builds, for previewing a manual match's split. */
function useMatchPreview(payerId: string | null) {
  const { policies, clients, brokers } = useData();
  return useMemo(() => prepareMatchContext({
    payerId,
    policies: policies.map((p) => ({ ...p, wholesalerId: p.wholesalerId ?? null })),
    clients: clients.map((c) => ({ id: c.id, name: c.name })),
    brokers: brokers.map((b) => ({ id: b.id, name: b.name, shareBps: b.shareBps })),
  }), [policies, clients, brokers, payerId]);
}

export function MatchDialog({ statementId, payerId, line, onClose }: { statementId: string; payerId: string | null; line: MatchLine | null; onClose: () => void }) {
  const { clientById, carrierById, brokerById, policies, policyById, carriers } = useData();
  const ctx = useMatchPreview(payerId);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'payer' | 'all'>('payer');
  const [chosen, setChosen] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [past, setPast] = useState(false);

  const m = line ? lineMatch(line) : null;
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const qn = q.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (q.length < 2) return [] as Policy[];
    return policies.filter((p) => {
      if (scope === 'payer' && payerId && p.carrierId !== payerId && p.wholesalerId !== payerId) return false;
      const client = clientById.get(p.clientId);
      return (qn.length >= 2 && (p.normalizedPolicyNumber ?? '').includes(qn))
        || (client?.name ?? '').toLowerCase().includes(q) || (p.namedInsured ?? '').toLowerCase().includes(q)
        || (client?.externalId ?? '').toLowerCase().includes(q);
    }).slice(0, 25);
  }, [query, scope, payerId, policies, clientById]);

  if (!line) return null;
  const preview = chosen && ctx.policyById.get(chosen) ? matchToPolicy(line, ctx.policyById.get(chosen)!, ctx, 'manual') : null;

  async function save(input: Parameters<typeof api.setLineMatch>[0]) {
    setBusy(true); setError(null);
    try { await api.setLineMatch(input); onClose(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not save'); } finally { setBusy(false); }
  }

  const policyRow = (p: Policy, extra?: ReactNode) => {
    const c = clientById.get(p.clientId);
    const ne = nameEvidence(line.insuredName, c?.name, p.namedInsured);
    const b = brokerById.get(p.brokerId || UNASSIGNED_BROKER_ID);
    const share = (p.brokerId || UNASSIGNED_BROKER_ID) === UNASSIGNED_BROKER_ID ? 0 : p.brokerShareBps ?? b?.shareBps ?? 0;
    return (
      <button key={p.id} type="button" onClick={() => setChosen(p.id)}
        className={cx('flex w-full items-start justify-between gap-3 rounded border px-3 py-2 text-left text-xs', chosen === p.id ? 'border-ink bg-amber-50' : 'border-slate-200 hover:bg-slate-50')}>
        <span>
          <span className="block font-medium text-ink">{displayName(c?.name) || p.clientId}</span>
          <span className="block font-mono text-slate-700">{p.policyNumber}{p.status !== 'active' && <span className="ml-1 text-amber-700">({p.status})</span>}</span>
          <span className="block text-slate-500">{carrierById.get(p.carrierId)?.name ?? p.carrierId}{p.wholesalerId ? ` via ${carrierById.get(p.wholesalerId)?.name ?? p.wholesalerId}` : ''} · {displayName(p.namedInsured) || '—'}</span>
        </span>
        <span className="shrink-0 text-right text-slate-600">
          <span className="block">{b?.name ?? 'Unassigned'} · {formatBps(share)}{p.brokerShareBps != null ? ' (policy)' : ''}</span>
          <span className={cx('block', ne === 'strong' ? 'text-emerald-700' : ne === 'none' ? 'text-red-700' : 'text-slate-500')}>{NAME_TEXT[ne]}</span>
          {extra}
        </span>
      </button>
    );
  };

  return (
    <Modal open={!!line} title={`Match line ${line.lineNo}`} onClose={onClose} width="max-w-5xl">
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase text-slate-500">As extracted from the statement (never changed)</h3>
          <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1 rounded border border-slate-200 bg-slate-50 p-3 text-sm">
            <dt className="text-slate-500">Insured</dt><dd>{line.insuredName || '—'}</dd>
            <dt className="text-slate-500">Policy # printed</dt><dd className="font-mono">{line.policyNumberRaw || '—'}</dd>
            <dt className="text-slate-500">Used for matching</dt><dd className="font-mono">{m?.policyNumberKey ?? (m ? <span className="text-red-700">not readable</span> : '—')}</dd>
            <dt className="text-slate-500">Type</dt><dd>{TRANSACTION_TYPE_LABELS[line.transactionType] ?? line.transactionType}</dd>
            <dt className="text-slate-500">Effective</dt><dd>{line.effectiveDate ?? (line.transactionCodeRaw || '—')}</dd>
            <dt className="text-slate-500">Paid commission</dt><dd className="font-semibold"><Money cents={line.paidCommissionCents} /></dd>
            <dt className="text-slate-500">Payment received</dt><dd><Money cents={line.paymentReceivedCents} /></dd>
            <dt className="text-slate-500">Rate</dt><dd>{line.rateBps != null ? formatBps(line.rateBps) : '—'}</dd>
            <dt className="text-slate-500">Page</dt><dd>{line.page ?? '—'}</dd>
          </dl>
          <h3 className="mb-2 mt-4 text-xs font-semibold uppercase text-slate-500">Current match</h3>
          <div className="rounded border border-slate-200 p-3 text-sm">
            <div className="flex items-center gap-2"><MatchBadge m={m} />{m?.method === 'manual' && m.matchedByEmail && <span className="text-xs text-slate-500">by {m.matchedByEmail}</span>}</div>
            {m?.policyId && <div className="mt-2"><MatchedTo m={m} /></div>}
            {m?.policyId && (
              <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                <div><div className="text-slate-500">Broker</div><BrokerCell m={m} /></div>
                <div><div className="text-slate-500">Broker share</div><Money cents={m.brokerCents} /></div>
                <div><div className="text-slate-500">Agency share</div><Money cents={m.agencyCents} /></div>
              </div>
            )}
            {m && <ul className="mt-2 list-disc pl-5 text-xs text-slate-600">{m.reasons.map((r) => <li key={r}>{MATCH_REASON_TEXT[r] ?? r}</li>)}</ul>}
            {m?.note && <p className="mt-1 text-xs text-slate-600">Note: {m.note}</p>}
          </div>
        </div>

        <div>
          {m && m.candidates.length > 0 && (
            <>
              <h3 className="mb-2 text-xs font-semibold uppercase text-slate-500">Suggestions</h3>
              <div className="mb-4 space-y-1">{m.candidates.map((c) => {
                const p = policyById.get(c.policyId);
                return p ? policyRow(p, <span className="block text-slate-500">{NUMBER_TEXT[c.numberEvidence]}{c.samePayer ? '' : ' · other carrier'}</span>) : null;
              })}</div>
            </>
          )}
          <h3 className="mb-2 text-xs font-semibold uppercase text-slate-500">Search clients and policies</h3>
          <div className="mb-2 flex gap-2">
            <TextInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Policy number, client or insured name, client ID" className="flex-1" autoFocus />
            <Select value={scope} onChange={(e) => setScope(e.target.value as 'payer' | 'all')}
              options={[{ value: 'payer', label: payerId ? `${carriers.find((c) => c.id === payerId)?.name ?? 'This carrier'} only` : 'This carrier' }, { value: 'all', label: 'All carriers' }]} />
          </div>
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {query.trim().length >= 2 && !results.length && <p className="text-xs text-slate-500">No policies found. Policies are never created here — add the client and policy first if it is missing.</p>}
            {results.map((p) => policyRow(p))}
          </div>

          {preview && (
            <div className="mt-3 rounded border border-ink/30 bg-amber-50 p-3 text-xs">
              <div className="font-semibold text-ink">Preview</div>
              <div className="mt-1 grid grid-cols-3 gap-2">
                <div><div className="text-slate-500">Commission</div><Money cents={preview.commissionCents} /></div>
                <div><div className="text-slate-500">Broker ({formatBps(preview.brokerShareBps ?? 0)})</div><Money cents={preview.brokerCents} /></div>
                <div><div className="text-slate-500">Agency</div><Money cents={preview.agencyCents} /></div>
              </div>
              {preview.reasons.filter((r) => r !== 'manual').map((r) => <p key={r} className="mt-1 text-amber-800">{MATCH_REASON_TEXT[r]}</p>)}
            </div>
          )}
          {past ? (
            <PastPolicyForm statementId={statementId} payerId={payerId} line={line} existing={m?.historical ?? null} busy={busy}
              onCancel={() => setPast(false)} onSave={(input) => void save(input)} />
          ) : (
            <p className="mt-3 text-xs text-slate-500">
              Commission on a cancelled or expired policy that was never imported?{' '}
              <button type="button" className="text-ink underline" onClick={() => setPast(true)}>Record it as a past policy…</button>{' '}
              It posts to suspense (no change to totals), linked to the customer if you choose one; the policy is not added to the book.
            </p>
          )}
          <Field label="Note (kept in the audit log)" className="mt-3"><TextArea value={note} onChange={(e) => setNote(e.target.value)} rows={2} /></Field>
          <ErrorNote message={error} />
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            {m?.method === 'manual' && <Button variant="ghost" disabled={busy} onClick={() => void save({ action: 'auto', statementId, lineId: line.id, note })}>Return to automatic</Button>}
            {!(m?.status === 'unmatched' && m.method === 'manual') && <Button variant="secondary" disabled={busy} onClick={() => void save({ action: 'unmatch', statementId, lineId: line.id, note })}>Mark unmatched</Button>}
            <Button disabled={busy || !chosen} onClick={() => chosen && void save({ action: 'assign', statementId, lineId: line.id, policyId: chosen, note })}>{busy ? 'Saving…' : 'Match to selected policy'}</Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export const centsOrZero = (c: Cents | null | undefined) => c ?? 0;

/**
 * Record a line as commission on a past policy that is not in the book (e.g. a cancelled Travelers
 * policy of a customer who still has other active policies). Information only: the line posts to
 * suspense like any unmatched line; the broker attribution is for internal reporting and never makes
 * the policy eligible for a broker buyout. Nothing is ever chosen automatically.
 */
function PastPolicyForm({ statementId, payerId, line, existing, busy, onCancel, onSave }: {
  statementId: string; payerId: string | null; line: MatchLine; existing: StoredMatch['historical'] | null; busy: boolean;
  onCancel: () => void; onSave: (input: Parameters<typeof api.setLineMatch>[0]) => void;
}) {
  const { clients, carriers, brokers } = useData();
  const [q, setQ] = useState('');
  const [clientId, setClientId] = useState<string | null>(existing?.clientId ?? null);
  const [insuredName, setInsuredName] = useState(existing?.insuredName ?? line.insuredName ?? '');
  const [policyNumber, setPolicyNumber] = useState(existing?.policyNumber ?? line.policyNumberRaw ?? '');
  const [carrierId, setCarrierId] = useState<string>(existing?.carrierId ?? payerId ?? '');
  const [policyStatus, setPolicyStatus] = useState<'cancelled' | 'expired' | 'unknown'>(existing?.policyStatus ?? 'cancelled');
  const [brokerId, setBrokerId] = useState<string>(existing?.attributedBrokerId ?? '');
  const [note, setNote] = useState(existing?.note ?? '');
  const found = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t.length < 2 ? [] : clients.filter((c) => c.name.toLowerCase().includes(t) || (c.externalId ?? '').toLowerCase().includes(t)).slice(0, 12);
  }, [q, clients]);
  const chosen = clientId ? clients.find((c) => c.id === clientId) : null;
  return (
    <div className="mt-3 space-y-2 rounded border border-amber-300 bg-amber-50 p-3 text-xs">
      <div className="font-semibold text-amber-900">Past policy (not in the book)</div>
      <Field label="Existing customer (optional)">
        {chosen ? (
          <div className="flex items-center justify-between"><span className="font-medium">{chosen.name}</span><button type="button" className="text-ink underline" onClick={() => setClientId(null)}>change</button></div>
        ) : (
          <>
            <TextInput value={q} placeholder="Search customers by name or ID" onChange={(e) => setQ(e.target.value)} />
            <div className="mt-1 max-h-32 space-y-0.5 overflow-y-auto">{found.map((c) => (
              <button key={c.id} type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-white" onClick={() => { setClientId(c.id); setQ(''); }}>{displayName(c.name)}{c.externalId ? <span className="text-slate-500"> · {c.externalId}</span> : null}</button>
            ))}</div>
          </>
        )}
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Insured name on the policy"><TextInput value={insuredName} onChange={(e) => setInsuredName(e.target.value)} /></Field>
        <Field label="Policy number"><TextInput value={policyNumber} onChange={(e) => setPolicyNumber(e.target.value)} /></Field>
        <Field label="Insurance carrier">
          <Select value={carrierId} onChange={(e) => setCarrierId(e.target.value)} options={[...carriers].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ value: c.id, label: c.name }))} />
        </Field>
        <Field label="Policy status">
          <Select value={policyStatus} onChange={(e) => setPolicyStatus(e.target.value as typeof policyStatus)} options={[{ value: 'cancelled', label: 'Cancelled' }, { value: 'expired', label: 'Expired' }, { value: 'unknown', label: 'Not known' }]} />
        </Field>
      </div>
      <Field label="Broker (internal reporting only; never creates broker-buyout eligibility)">
        <Select value={brokerId} onChange={(e) => setBrokerId(e.target.value)} placeholder="Not attributed"
          options={brokers.filter((b) => b.id !== 'UNASSIGNED').sort((a, b) => a.name.localeCompare(b.name)).map((b) => ({ value: b.id, label: b.name }))} />
      </Field>
      <Field label="How was it identified? (required; kept in the audit log)"><TextArea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
        <Button size="sm" disabled={busy || note.trim().length < 3 || !insuredName.trim() || !policyNumber.trim()} onClick={() => onSave({
          action: 'historical', statementId, lineId: line.id, clientId, insuredName: insuredName.trim(), policyNumber: policyNumber.trim(),
          carrierId: carrierId || null, policyStatus, attributedBrokerId: brokerId || null, note: note.trim(),
        })}>{busy ? 'Saving…' : 'Save as past policy'}</Button>
      </div>
    </div>
  );
}
