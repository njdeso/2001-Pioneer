import { Fragment, useEffect, useMemo, useState } from 'react';
import { collection, doc, getDocs, onSnapshot } from 'firebase/firestore';
import {
  brokerStatementModel, EXCLUSION_TEXT, flagText, parseMoneyToCents, reconciliationModel, SNAPSHOT_STATE_LABELS, statementFileStem, toBuyoutInputs, valueBuyout,
  type BrokerAdvance, type BuyoutConfig, type BuyoutSnapshot, type PolicyTerm, type PolicyValuation, type SnapshotPolicyRow, type SnapshotState,
} from '@asm/shared';
import { api } from '../api';
import { useData } from '../data';
import { db } from '../firebase';
import { Badge, Button, Card, ErrorNote, Field, Modal, Money, Select, Stat, TextInput } from '../ui';

/**
 * Settlement dashboard (owners only): a live preview of the buyout at the closing date, calculated in
 * the browser with the same engine the server uses, and the stored settlement snapshots (versions)
 * with their adjustments, review/finalize workflow and statement downloads. Only snapshots are final:
 * the server recalculates from the live records when a snapshot is created and refuses to finalize
 * if anything changed since.
 */

const STATE_TONE: Record<SnapshotState, 'slate' | 'green' | 'amber' | 'blue' | 'red'> = { draft: 'amber', reviewed: 'blue', finalized: 'green', superseded: 'slate', discarded: 'slate' };

function download(name: string, bytes: Uint8Array, type: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
const PDF = 'application/pdf';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function BuyoutSettlement({ advances, terms }: { advances: BrokerAdvance[]; terms: Map<string, PolicyTerm[]> }) {
  const { policies, brokers, carriers, clientById, carrierById, brokerById } = useData();
  const [config, setConfig] = useState<(BuyoutConfig & { updatedBy?: string }) | null>(null);
  const [snaps, setSnaps] = useState<BuyoutSnapshot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState('');
  const [editConfig, setEditConfig] = useState(false);
  const [openSnap, setOpenSnap] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const a = onSnapshot(doc(db, 'buyoutConfig/current'), (s) => {
      const c = s.exists() ? (s.data() as BuyoutConfig) : null;
      setConfig(c);
      setClosing((cur) => cur || c?.plannedClosingDate || '');
    }, (e) => setError(e.message));
    const b = onSnapshot(collection(db, 'buyoutSettlements'), (s) => setSnaps(s.docs.map((d) => ({ ...(d.data() as BuyoutSnapshot), id: d.id }))), (e) => setError(e.message));
    return () => { a(); b(); };
  }, []);

  const preview = useMemo(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(closing)) return null;
    const i = toBuyoutInputs({ policies: policies as never[], brokers: brokers as never[], carriers: carriers as never[] });
    return valueBuyout({ closingDate: closing, policies: i.policies, brokers: i.brokers, termsByPolicy: terms, advances, carrierRateBps: i.carrierRateBps });
  }, [closing, policies, brokers, carriers, terms, advances]);

  const versions = [...snaps].sort((a, b) => b.closingDate.localeCompare(a.closingDate) || b.version - a.version);

  return (
    <div className="space-y-6">
      <ErrorNote message={error} />
      <Card title="Closing date" actions={<Button size="sm" variant="secondary" onClick={() => setEditConfig(true)}>Set planned closing date</Button>}>
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Calculate as of closing date" hint="The closing date is the first unearned day"><TextInput type="date" value={closing} onChange={(e) => setClosing(e.target.value)} /></Field>
          <div className="text-sm">
            {config?.plannedClosingDate
              ? <>Planned closing date: <b>{config.plannedClosingDate}</b> {config.closingDateConfirmed ? <Badge tone="green">Confirmed</Badge> : <Badge tone="amber">Planning only — not confirmed</Badge>}</>
              : <span className="text-slate-500">No planned closing date saved yet.</span>}
          </div>
        </div>
      </Card>

      {preview && <Preview v={preview} closing={closing} onSnapshot={() => setCreating(true)} names={{ client: (id) => clientById.get(id)?.name ?? id, carrier: (id) => carrierById.get(id)?.name ?? id, broker: (id) => brokerById.get(id)?.name ?? id }} />}

      <Card title="Settlement versions">
        {!versions.length ? <p className="text-sm text-slate-500">No snapshots yet. A snapshot freezes the calculation for a closing date so it can be reviewed, adjusted, finalized and sent to brokers.</p> : (
          <table className="min-w-full text-sm">
            <thead><tr className="text-left text-xs uppercase text-slate-500"><th className="py-1 pr-3">Closing</th><th className="pr-3">Version</th><th className="pr-3">State</th><th className="pr-3 text-right">Policies</th><th className="pr-3 text-right">Net settlements</th><th className="pr-3">Finalizable</th><th className="pr-3">Note</th><th /></tr></thead>
            <tbody>
              {versions.map((s) => (
                <tr key={s.id} className="border-t border-slate-100">
                  <td className="py-1.5 pr-3">{s.closingDate}</td><td className="pr-3">v{s.version}</td>
                  <td className="pr-3"><Badge tone={STATE_TONE[s.state]}>{SNAPSHOT_STATE_LABELS[s.state]}</Badge></td>
                  <td className="pr-3 text-right">{s.totals.eligiblePolicies}</td><td className="pr-3 text-right"><Money cents={s.totals.finalNetCents} /></td>
                  <td className="pr-3">{s.finalizable ? <Badge tone="green">Yes</Badge> : <Badge tone="red">{s.blockers.length} blocker{s.blockers.length === 1 ? '' : 's'}</Badge>}</td>
                  <td className="max-w-xs truncate pr-3 text-xs text-slate-600">{s.note}</td>
                  <td className="text-right"><Button size="sm" variant="secondary" onClick={() => setOpenSnap(s.id)}>Open</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {editConfig && <ConfigModal config={config} onClose={() => setEditConfig(false)} />}
      {creating && <CreateSnapshotModal closing={closing} blockers={preview?.blockers ?? []} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpenSnap(id); }} />}
      {openSnap && snaps.find((s) => s.id === openSnap) && <SnapshotModal snap={snaps.find((s) => s.id === openSnap)!} onClose={() => setOpenSnap(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- live preview

function Preview({ v, closing, onSnapshot, names }: { v: ReturnType<typeof valueBuyout>; closing: string; onSnapshot: () => void; names: { client: (id: string) => string; carrier: (id: string) => string; broker: (id: string) => string } }) {
  const [broker, setBroker] = useState('');
  const [carrier, setCarrier] = useState('');
  const [status, setStatus] = useState<'all' | 'included' | 'excluded'>('included');
  const [exc, setExc] = useState<'all' | 'material' | 'flagged'>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const t = v.totals;
  const rows = v.policies.filter((p) => {
    if (broker && p.brokerId !== broker) return false;
    if (carrier && p.carrierId !== carrier) return false;
    if (status === 'included' && !p.included) return false;
    if (status === 'excluded' && p.included) return false;
    if (exc === 'material' && !p.material) return false;
    if (exc === 'flagged' && !p.flags.length) return false;
    const s = q.trim().toLowerCase();
    return !s || `${p.policyNumber} ${names.client(p.clientId)}`.toLowerCase().includes(s);
  });
  const brokerIds = [...new Set(v.policies.map((p) => p.brokerId))];
  const carrierIds = [...new Set(v.policies.map((p) => p.carrierId))];
  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <Stat label="Eligible policies" value={t.eligiblePolicies} sub={`${t.excludedPolicies} excluded`} />
        <Stat label="Gross buyout (1.5×)" value={<Money cents={t.grossBuyoutCents} />} sub={<>Annualized broker <Money cents={t.annualizedBrokerCents} /></>} />
        <Stat label="Outstanding unearned advances" value={<Money cents={t.outstandingAdvanceCents} />} />
        <Stat tone="gold" label="Net settlements" value={<Money cents={t.finalNetCents} />} sub={<>Closing <Money cents={t.installmentsCents[0]} /> · then <Money cents={t.installmentsCents[1]} /> · <Money cents={t.installmentsCents[2]} /></>} />
        <Stat label="Requiring review" value={t.policiesRequiringReview} sub={`${t.missingAdvances} missing advance${t.missingAdvances === 1 ? '' : 's'}`} />
      </div>
      <Card title={`Live preview — closing ${closing}`} actions={<Button size="sm" onClick={onSnapshot}>Create settlement snapshot</Button>}>
        <p className="mb-3 text-xs text-slate-500">Calculated from the current records; nothing is saved until you create a snapshot. Bonuses and profit sharing are not part of the buyout and are not shown here.</p>
        {v.blockers.length > 0 && <div className="mb-3 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-800"><b>Cannot be finalized yet:</b><ul className="ml-5 list-disc">{v.blockers.map((b) => <li key={b}>{b}</li>)}</ul></div>}
        {v.checks.some((c) => !c.pass) && <div className="mb-3 text-sm text-red-700">Failed checks: {v.checks.filter((c) => !c.pass).map((c) => c.name).join('; ')}</div>}
        <h3 className="mb-1 text-sm font-semibold">Brokers and payment schedule (50 % / 25 % / 25 %)</h3>
        <div className="mb-4 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead><tr className="text-left text-xs uppercase text-slate-500"><th className="py-1 pr-3">Broker</th><th className="pr-3 text-right">Policies</th><th className="pr-3 text-right">Gross</th><th className="pr-3 text-right">Unearned</th><th className="pr-3 text-right">Net</th>{v.brokers[0]?.installments.map((i) => <th key={i.label} className="pr-3 text-right">{i.label}<div className="font-normal normal-case">{i.dueDate}</div></th>)}<th>Status</th></tr></thead>
            <tbody>
              {v.brokers.map((b) => (
                <tr key={b.brokerId} className="border-t border-slate-100">
                  <td className="py-1.5 pr-3">{b.brokerName}</td><td className="pr-3 text-right">{b.policies}</td>
                  <td className="pr-3 text-right"><Money cents={b.grossBuyoutCents} /></td><td className="pr-3 text-right"><Money cents={b.outstandingAdvanceCents} /></td><td className="pr-3 text-right font-semibold"><Money cents={b.finalNetCents} /></td>
                  {b.installments.map((i) => <td key={i.label} className="pr-3 text-right"><Money cents={i.amountCents} /></td>)}
                  <td>{b.flags.includes('negative_broker_settlement') ? <Badge tone="red">Negative — resolve manually</Badge> : b.materialPolicies ? <Badge tone="amber">{b.materialPolicies} to review</Badge> : <Badge tone="green">OK</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3 className="mb-1 text-sm font-semibold">Policies</h3>
        <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-5">
          <Field label="Broker"><Select value={broker} onChange={(e) => setBroker(e.target.value)} placeholder="All" options={brokerIds.map((id) => ({ value: id, label: names.broker(id) }))} /></Field>
          <Field label="Carrier"><Select value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="All" options={carrierIds.map((id) => ({ value: id, label: names.carrier(id) }))} /></Field>
          <Field label="Status"><Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} options={[{ value: 'included', label: 'Included' }, { value: 'excluded', label: 'Excluded' }, { value: 'all', label: 'All' }]} /></Field>
          <Field label="Exceptions"><Select value={exc} onChange={(e) => setExc(e.target.value as typeof exc)} options={[{ value: 'all', label: 'All' }, { value: 'material', label: 'Blocking finalization' }, { value: 'flagged', label: 'Any flag' }]} /></Field>
          <Field label="Search"><TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Policy or customer" /></Field>
        </div>
        <PolicyTable rows={rows} names={names} open={open} setOpen={setOpen} />
      </Card>
    </>
  );
}

function PolicyTable({ rows, names, open, setOpen }: { rows: PolicyValuation[]; names: { client: (id: string) => string; carrier: (id: string) => string; broker: (id: string) => string }; open: string | null; setOpen: (id: string | null) => void }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead><tr className="text-left text-xs uppercase text-slate-500"><th className="py-1 pr-3">Customer / policy</th><th className="pr-3">Broker</th><th className="pr-3">Term at closing</th><th className="pr-3 text-right">Gross</th><th className="pr-3 text-right">Unearned</th><th className="pr-3 text-right">Net</th><th className="pr-3">Status</th><th /></tr></thead>
        <tbody>
          {rows.slice(0, 500).map((p) => (
            <Fragment key={p.policyId}>
              <tr className="border-t border-slate-100 align-top">
                <td className="py-1.5 pr-3"><div className="font-medium">{names.client(p.clientId)}</div><div className="font-mono text-xs text-slate-600">{p.policyNumber} · {names.carrier(p.carrierId)}</div></td>
                <td className="pr-3">{names.broker(p.brokerId)}<div className="text-xs text-slate-500">{(p.brokerShareBps / 100).toFixed(2)}%</div></td>
                <td className="pr-3 text-xs">{p.term ? `${p.term.effectiveDate} → ${p.term.expirationDate}` : '—'}{p.included && <div className="text-slate-500">{p.remainingDays} of {p.termDays} days unearned</div>}</td>
                <td className="pr-3 text-right"><Money cents={p.grossBuyoutCents} /></td><td className="pr-3 text-right"><Money cents={p.outstandingAdvanceCents} /></td><td className="pr-3 text-right font-semibold"><Money cents={p.netContributionCents} /></td>
                <td className="pr-3">
                  {p.included ? <Badge tone="green">Included</Badge> : <Badge>Excluded</Badge>}
                  {p.flags.map((f) => <div key={f}><Badge tone={p.material ? 'red' : 'amber'}>{flagText(f)}</Badge></div>)}
                </td>
                <td className="text-right"><Button size="sm" variant="ghost" onClick={() => setOpen(open === p.policyId ? null : p.policyId)}>{open === p.policyId ? 'Hide' : 'Detail'}</Button></td>
              </tr>
              {open === p.policyId && <tr><td colSpan={8} className="bg-slate-50 p-3 text-xs"><Calc p={p} /></td></tr>}
            </Fragment>
          ))}
        </tbody>
      </table>
      {rows.length > 500 && <p className="mt-2 text-xs text-slate-500">Showing 500 of {rows.length}; narrow the filters.</p>}
      {!rows.length && <p className="py-3 text-sm text-slate-500">No policies match.</p>}
    </div>
  );
}

const $ = (c: number) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Calc({ p }: { p: PolicyValuation }) {
  if (!p.included) return <p>{p.exclusion ? EXCLUSION_TEXT[p.exclusion] : p.explanation}</p>;
  return (
    <div className="space-y-0.5 font-mono">
      <p className="font-sans">{p.explanation}</p>
      <p>Term commission {$(p.basis?.cents ?? 0)} ({p.basis?.source === 'advance' ? 'verified, advance record' : p.basis ? 'premium × rate — fallback' : 'none'})</p>
      <p>Annualized = {$(p.basis?.cents ?? 0)} × 365 ÷ {p.termDays} = {$(p.annualizedAgencyCents)}</p>
      <p>Broker {(p.brokerShareBps / 100).toFixed(2)}% = {$(p.annualizedBrokerCents)} → gross 1.5× = {$(p.grossBuyoutCents)}</p>
      <p>Unearned advance = {$(p.advancePaidCents)} paid × {p.remainingDays} ÷ {p.termDays} = {$(p.outstandingAdvanceCents)} (earned {$(p.earnedAdvanceCents)})</p>
      <p className="font-semibold">Net = {$(p.grossBuyoutCents)} − {$(p.outstandingAdvanceCents)} = {$(p.netContributionCents)}</p>
      {p.advanceIds.length > 0 && <p className="font-sans text-slate-500">Advance records: {p.advanceIds.join(', ')}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- modals

function ConfigModal({ config, onClose }: { config: BuyoutConfig | null; onClose: () => void }) {
  const [date, setDate] = useState(config?.plannedClosingDate ?? '');
  const [confirmed, setConfirmed] = useState(config?.closingDateConfirmed ?? false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    try { await api.saveBuyoutConfig({ plannedClosingDate: date || null, closingDateConfirmed: confirmed, note }); onClose(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open title="Planned closing date" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Planned closing date"><TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> This closing date is confirmed (leave unchecked while it is only a planning date)</label>
        <Field label="Note (required)"><TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. January 2027 planning period" /></Field>
        <ErrorNote message={err} />
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={busy || note.trim().length < 3} onClick={save}>Save</Button></div>
      </div>
    </Modal>
  );
}

function CreateSnapshotModal({ closing, blockers, onClose, onCreated }: { closing: string; blockers: string[]; onClose: () => void; onCreated: (id: string) => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try { const r = await api.createBuyoutSnapshot({ closingDate: closing, note }); onCreated(r.id); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  return (
    <Modal open title={`Create settlement snapshot — closing ${closing}`} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p>The server recalculates from the current records and stores a new <b>draft</b> version. Existing versions are never changed.</p>
        {blockers.length > 0 && <p className="text-amber-800">The preview has {blockers.length} blocker(s); you can still take a draft snapshot, but it cannot be finalized until they are resolved and a new snapshot is taken.</p>}
        <Field label="Note (required)"><TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. First review with corrected advances" /></Field>
        <ErrorNote message={err} />
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={busy || note.trim().length < 3} onClick={go}>{busy ? 'Calculating…' : 'Create snapshot'}</Button></div>
      </div>
    </Modal>
  );
}

function SnapshotModal({ snap, onClose }: { snap: BuyoutSnapshot; onClose: () => void }) {
  const [rows, setRows] = useState<SnapshotPolicyRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<'reviewed' | 'draft' | 'finalized' | 'discarded' | null>(null);
  const [note, setNote] = useState('');
  const [adj, setAdj] = useState({ brokerId: '', amount: '', reason: '' });
  const [removing, setRemoving] = useState<{ id: string; reason: string } | null>(null);
  const [showRows, setShowRows] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    getDocs(collection(db, `buyoutSettlements/${snap.id}/policyRows`)).then((s) => setRows(s.docs.map((d) => d.data() as SnapshotPolicyRow))).catch((e) => setErr(e.message));
  }, [snap.id]);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); return true; } catch (e) { setErr(e instanceof Error ? e.message : String(e)); return false; } finally { setBusy(false); } };
  const editable = snap.state === 'draft';
  const nameOf = (id: string) => snap.brokerDirectory.find((b) => b.id === id)?.name ?? id;

  const dl = async (kind: 'pdf' | 'xlsx', brokerId?: string) => {
    if (!rows) return;
    await run(async () => {
      const r = await import('@asm/shared/buyout-reports');
      const now = new Date().toISOString();
      if (brokerId) {
        const m = brokerStatementModel(snap, rows, brokerId, now);
        download(`${statementFileStem(m)}.${kind}`, kind === 'pdf' ? await r.brokerStatementPdf(m) : await r.brokerStatementXlsx(m), kind === 'pdf' ? PDF : XLSX);
      } else {
        const m = reconciliationModel(snap, rows, now);
        download(`${statementFileStem({ kind: 'reconciliation', closingDate: snap.closingDate, version: snap.version, final: snap.state === 'finalized' })}.${kind}`, kind === 'pdf' ? await r.reconciliationPdf(m) : await r.reconciliationXlsx(m), kind === 'pdf' ? PDF : XLSX);
      }
    });
  };

  let amountCents: number | null = null;
  try { amountCents = adj.amount.trim() ? parseMoneyToCents(adj.amount) : null; } catch { amountCents = null; }

  return (
    <Modal open width="max-w-6xl" title={`Settlement v${snap.version} — closing ${snap.closingDate}`} onClose={onClose}>
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={STATE_TONE[snap.state]}>{SNAPSHOT_STATE_LABELS[snap.state]}</Badge>
          <span className="text-slate-600">{snap.totals.eligiblePolicies} eligible · net <Money cents={snap.totals.finalNetCents} /> · engine {snap.engineVersion} · fingerprint <span className="font-mono">{snap.inputFingerprint.slice(0, 12)}</span></span>
          <span className="ml-auto flex gap-2">
            {snap.state === 'draft' && <Button size="sm" variant="secondary" onClick={() => setAction('reviewed')}>Mark reviewed</Button>}
            {snap.state === 'reviewed' && <Button size="sm" variant="secondary" onClick={() => setAction('draft')}>Reopen as draft</Button>}
            {snap.state === 'reviewed' && <Button size="sm" disabled={!snap.finalizable} onClick={() => setAction('finalized')}>Finalize</Button>}
            {(snap.state === 'draft' || snap.state === 'reviewed') && <Button size="sm" variant="ghost" onClick={() => setAction('discarded')}>Discard</Button>}
          </span>
        </div>
        {snap.blockers.length > 0 && <div className="rounded border border-red-200 bg-red-50 p-2 text-red-800"><b>Cannot be finalized:</b><ul className="ml-5 list-disc">{snap.blockers.map((b) => <li key={b}>{b}</li>)}</ul></div>}
        {snap.state === 'superseded' && <p className="text-slate-600">Superseded by a later finalized version.</p>}
        {action && (
          <div className="rounded border border-slate-200 bg-slate-50 p-3">
            <p className="mb-2">{action === 'finalized' ? 'Finalizing re-checks the live records: if any policy, term, advance or broker share changed since this snapshot, it is refused. A finalized version can never be changed; an earlier finalized version for this closing date becomes superseded.' : `Change to ${SNAPSHOT_STATE_LABELS[action]}.`}</p>
            <div className="flex items-end gap-2"><Field label="Note (required)" className="flex-1"><TextInput value={note} onChange={(e) => setNote(e.target.value)} /></Field>
              <Button disabled={busy || note.trim().length < 3} onClick={async () => { if (await run(() => api.setBuyoutSnapshotState({ snapshotId: snap.id, to: action, note }))) { setAction(null); setNote(''); } }}>Confirm</Button>
              <Button variant="secondary" onClick={() => setAction(null)}>Cancel</Button></div>
          </div>
        )}
        <ErrorNote message={err} />

        <div className="overflow-x-auto">
          <table className="min-w-full">
            <thead><tr className="text-left text-xs uppercase text-slate-500"><th className="py-1 pr-3">Broker</th><th className="pr-3 text-right">Policies</th><th className="pr-3 text-right">Gross</th><th className="pr-3 text-right">Unearned</th><th className="pr-3 text-right">Adjust.</th><th className="pr-3 text-right">Net</th>{snap.brokers[0]?.installments.map((i) => <th key={i.label} className="pr-3 text-right">{i.label}<div className="font-normal normal-case">{i.dueDate}</div></th>)}<th>Statement</th></tr></thead>
            <tbody>
              {snap.brokers.map((b) => (
                <tr key={b.brokerId} className="border-t border-slate-100">
                  <td className="py-1.5 pr-3">{b.brokerName}{b.flags.includes('negative_broker_settlement') && <div><Badge tone="red">Negative — resolve manually</Badge></div>}</td>
                  <td className="pr-3 text-right">{b.policies}</td><td className="pr-3 text-right"><Money cents={b.grossBuyoutCents} /></td><td className="pr-3 text-right"><Money cents={b.outstandingAdvanceCents} /></td>
                  <td className="pr-3 text-right"><Money cents={b.adjustmentsCents} /></td><td className="pr-3 text-right font-semibold"><Money cents={b.finalNetCents} /></td>
                  {b.installments.map((i) => <td key={i.label} className="pr-3 text-right"><Money cents={i.amountCents} /></td>)}
                  <td className="whitespace-nowrap"><Button size="sm" variant="secondary" disabled={!rows || busy} onClick={() => dl('pdf', b.brokerId)}>PDF</Button> <Button size="sm" variant="secondary" disabled={!rows || busy} onClick={() => dl('xlsx', b.brokerId)}>Excel</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div>
          <h3 className="mb-1 font-semibold">Adjustments</h3>
          {!snap.adjustments.length && <p className="text-slate-500">None.</p>}
          {snap.adjustments.map((a) => (
            <div key={a.id} className="flex items-center gap-3 border-t border-slate-100 py-1">
              <span className="w-48">{nameOf(a.brokerId)}</span><Money cents={a.amountCents} /><span className="flex-1 text-slate-600">{a.reason}</span>
              {editable && (removing?.id === a.id
                ? <><TextInput value={removing.reason} onChange={(e) => setRemoving({ id: a.id, reason: e.target.value })} placeholder="Reason for removing" /><Button size="sm" disabled={busy || removing.reason.trim().length < 3} onClick={async () => { if (await run(() => api.removeBuyoutAdjustment({ snapshotId: snap.id, adjustmentId: a.id, reason: removing.reason }))) setRemoving(null); }}>Remove</Button></>
                : <Button size="sm" variant="ghost" onClick={() => setRemoving({ id: a.id, reason: '' })}>Remove</Button>)}
            </div>
          ))}
          {editable ? (
            <div className="mt-2 grid grid-cols-1 items-end gap-2 md:grid-cols-[1fr_140px_2fr_auto]">
              <Field label="Broker"><Select value={adj.brokerId} onChange={(e) => setAdj({ ...adj, brokerId: e.target.value })} placeholder="Choose" options={snap.brokers.map((b) => ({ value: b.brokerId, label: b.brokerName }))} /></Field>
              <Field label="Amount (+ or −)"><TextInput value={adj.amount} onChange={(e) => setAdj({ ...adj, amount: e.target.value })} placeholder="-125.00" /></Field>
              <Field label="Reason (required)"><TextInput value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} /></Field>
              <Button disabled={busy || !adj.brokerId || !amountCents || adj.reason.trim().length < 3} onClick={async () => { if (await run(() => api.addBuyoutAdjustment({ snapshotId: snap.id, brokerId: adj.brokerId, amountCents: amountCents!, reason: adj.reason }))) setAdj({ brokerId: '', amount: '', reason: '' }); }}>Add adjustment</Button>
            </div>
          ) : <p className="mt-1 text-xs text-slate-500">Adjustments can only be changed while the version is a draft.</p>}
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded border border-slate-200 p-3">
          <span className="font-semibold">Internal reconciliation (owner only — never send to Pioneer or a broker):</span>
          <Button size="sm" variant="secondary" disabled={!rows || busy} onClick={() => dl('pdf')}>PDF</Button>
          <Button size="sm" variant="secondary" disabled={!rows || busy} onClick={() => dl('xlsx')}>Excel</Button>
        </div>

        <div>
          <h3 className="mb-1 font-semibold">Checks</h3>
          <ul className="space-y-0.5">{snap.checks.map((c) => <li key={c.name}>{c.pass ? '✅' : '❌'} {c.name}{c.detail && <span className="text-slate-500"> — {c.detail}</span>}</li>)}</ul>
        </div>

        <div>
          <Button size="sm" variant="ghost" onClick={() => setShowRows(!showRows)}>{showRows ? 'Hide' : 'Show'} the {snap.policyCount} stored policy rows</Button>
          {showRows && rows && <PolicyTable rows={rows} names={{ client: (id) => rows.find((r) => r.clientId === id)?.clientName ?? id, carrier: (id) => rows.find((r) => r.carrierId === id)?.carrierName ?? id, broker: nameOf }} open={open} setOpen={setOpen} />}
        </div>

        {snap.history && snap.history.length > 0 && (
          <div>
            <h3 className="mb-1 font-semibold">Version history</h3>
            <ul className="space-y-0.5 text-xs text-slate-600">{snap.history.map((h, i) => <li key={i}>{h.at.slice(0, 16).replace('T', ' ')} UTC — {h.by}: {h.from ? `${h.from} → ` : ''}{h.to} — {h.note}</li>)}</ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
