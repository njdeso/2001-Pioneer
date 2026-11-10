import { Fragment, useEffect, useMemo, useState } from 'react';
import { collection, collectionGroup, onSnapshot } from 'firebase/firestore';
import {
  ADVANCE_FLAG_TEXT, ADVANCE_TEMPLATE_HEADERS, MATERIAL_ADVANCE_FLAGS, parseCsv, parseMoneyToCents, reviewPolicyAdvances, UNASSIGNED_BROKER_ID,
  type AdvanceFlagCode, type AdvancePaymentType, type BrokerAdvance, type ParsedAdvanceRow, type Policy, type PolicyTerm,
} from '@asm/shared';
import { api, type AdvanceForm } from '../api';
import { useAuth } from '../auth';
import { useData } from '../data';
import { db } from '../firebase';
import { Badge, Button, Card, ErrorNote, Field, Modal, Money, PageHeader, Select, Stat, TextInput } from '../ui';

/**
 * Broker Buyout (owners only). This first part records commission ACTUALLY PAID to brokers upfront
 * (advance payments) and reviews every broker-owned active policy's current term for missing or
 * inconsistent advances. The settlement calculation, snapshots and reports come next.
 * Nothing here is visible to staff or included in any Pioneer / due-diligence export.
 */

const today = () => new Date().toISOString().slice(0, 10);

function useAdvanceData(enabled: boolean) {
  const [advances, setAdvances] = useState<BrokerAdvance[]>([]);
  const [terms, setTerms] = useState<Map<string, PolicyTerm[]>>(new Map());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const a = onSnapshot(collection(db, 'brokerAdvances'), (s) => setAdvances(s.docs.map((d) => ({ ...(d.data() as BrokerAdvance), id: d.id }))), (e) => setError(e.message));
    const t = onSnapshot(collectionGroup(db, 'terms'), (s) => {
      const m = new Map<string, PolicyTerm[]>();
      for (const d of s.docs) {
        const pid = d.ref.parent.parent?.id;
        if (!pid) continue;
        m.set(pid, [...(m.get(pid) ?? []), { ...(d.data() as PolicyTerm), id: d.id, policyId: pid }]);
      }
      setTerms(m);
    }, (e) => setError(e.message));
    return () => { a(); t(); };
  }, [enabled]);
  return { advances, terms, error };
}

export function BrokerBuyoutPage() {
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const { ready, policies, brokers, brokerById, clientById, carrierById } = useData();
  const { advances, terms, error } = useAdvanceData(isAdmin);
  const [asOf, setAsOf] = useState(today());
  const [brokerFilter, setBrokerFilter] = useState('');
  const [flagFilter, setFlagFilter] = useState<'all' | 'material' | AdvanceFlagCode>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState<{ policy: Policy; advance?: BrokerAdvance } | null>(null);
  const [tab, setTab] = useState<'review' | 'import'>('review');

  const reviews = useMemo(() => {
    const withAdvances = new Set(advances.map((a) => a.policyId));
    return policies
      .filter((p) => ((p.brokerId || UNASSIGNED_BROKER_ID) !== UNASSIGNED_BROKER_ID && p.status === 'active') || withAdvances.has(p.id))
      .map((p) => ({ policy: p, r: reviewPolicyAdvances({ policy: { ...p, brokerId: p.brokerId || UNASSIGNED_BROKER_ID }, terms: terms.get(p.id) ?? [], advances, brokerShareBps: (id) => brokerById.get(id)?.shareBps ?? 0, asOf }) }));
  }, [policies, advances, terms, brokerById, asOf]);

  if (!isAdmin) return <PageHeader title="Broker Buyout" subtitle="Owners only." />;
  if (!ready) return <p className="text-sm text-slate-500">Loading…</p>;

  const shown = reviews.filter(({ policy, r }) => {
    if (brokerFilter && policy.brokerId !== brokerFilter) return false;
    if (flagFilter === 'material' && !r.material) return false;
    if (flagFilter !== 'all' && flagFilter !== 'material' && !r.flags.includes(flagFilter)) return false;
    const t = q.trim().toLowerCase();
    if (t && !`${policy.policyNumber} ${clientById.get(policy.clientId)?.name ?? ''}`.toLowerCase().includes(t)) return false;
    return true;
  });
  const owned = reviews.filter(({ policy }) => policy.brokerId && policy.brokerId !== UNASSIGNED_BROKER_ID && policy.status === 'active');
  const missing = owned.filter(({ r }) => r.flags.includes('missing_advance')).length;
  const material = reviews.filter(({ r }) => r.material).length;

  return (
    <div className="space-y-6">
      <PageHeader title="Broker Buyout" subtitle="Owners only. Advance payments actually paid to brokers, reviewed against each broker-owned policy’s current term. Settlement calculation, snapshots and reports come next." />
      <ErrorNote message={error} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Broker-owned active policies" value={owned.length} />
        <Stat label="Advance records (active)" value={advances.filter((a) => a.status === 'active').length} sub={`${advances.filter((a) => a.status === 'voided').length} voided`} />
        <Stat tone={missing ? 'gold' : undefined} label="Missing advance for current term" value={missing} />
        <Stat label="Policies requiring review" value={material} sub="Material advance issues" />
      </div>
      <div className="flex gap-2 border-b border-slate-200">
        {(['review', 'import'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t ? 'border-ink font-semibold text-ink' : 'border-transparent text-slate-500'}`}>{t === 'review' ? 'Advance review' : 'Import advances'}</button>
        ))}
      </div>
      {tab === 'import' ? <AdvanceImport /> : (
        <Card>
          <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Field label="Review as of" hint="Which term is current; the closing date later"><TextInput type="date" value={asOf} onChange={(e) => setAsOf(e.target.value || today())} /></Field>
            <Field label="Broker"><Select value={brokerFilter} onChange={(e) => setBrokerFilter(e.target.value)} placeholder="All" options={brokers.filter((b) => b.id !== UNASSIGNED_BROKER_ID).map((b) => ({ value: b.id, label: b.name }))} /></Field>
            <Field label="Issues"><Select value={flagFilter} onChange={(e) => setFlagFilter(e.target.value as typeof flagFilter)} options={[{ value: 'all', label: 'All policies' }, { value: 'material', label: 'Requiring review' }, ...Object.entries(ADVANCE_FLAG_TEXT).map(([k, v]) => ({ value: k, label: v }))]} /></Field>
            <Field label="Search"><TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Policy or customer" /></Field>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead><tr className="text-left text-xs uppercase text-slate-500"><th className="py-1 pr-3">Customer / policy</th><th className="pr-3">Broker</th><th className="pr-3">Current term</th><th className="pr-3 text-right">Paid</th><th className="pr-3 text-right">Expected</th><th className="pr-3">Review</th><th /></tr></thead>
              <tbody>
                {shown.slice(0, 500).map(({ policy, r }) => (
                  <Fragment key={policy.id}>
                    <tr className="border-t border-slate-100 align-top">
                      <td className="py-1.5 pr-3"><div className="font-medium">{clientById.get(policy.clientId)?.name ?? policy.clientId}</div><div className="font-mono text-xs text-slate-600">{policy.policyNumber} · {carrierById.get(policy.carrierId)?.name ?? ''}</div></td>
                      <td className="pr-3">{brokerById.get(policy.brokerId)?.name ?? policy.brokerId}<div className="text-xs text-slate-500">{(r.applicableShareBps / 100).toFixed(2)}%</div></td>
                      <td className="pr-3 text-xs">{r.term ? `${r.term.effectiveDate} → ${r.term.expirationDate}` : '—'}{r.term && <div className="text-slate-500">from {r.term.source === 'terms' ? 'term history' : 'policy dates'}</div>}</td>
                      <td className="pr-3 text-right"><Money cents={r.paidCents} /></td>
                      <td className="pr-3 text-right">{r.expectedCents === null ? '—' : <Money cents={r.expectedCents} />}</td>
                      <td className="pr-3">{r.flags.length === 0 ? <Badge tone="green">OK</Badge> : r.flags.map((f) => <div key={f}><Badge tone={MATERIAL_ADVANCE_FLAGS.has(f) ? 'red' : 'amber'}>{ADVANCE_FLAG_TEXT[f]}</Badge></div>)}</td>
                      <td className="whitespace-nowrap text-right">
                        <Button size="sm" variant="ghost" onClick={() => setOpen(open === policy.id ? null : policy.id)}>{open === policy.id ? 'Hide' : 'Records'}</Button>
                        <Button size="sm" variant="secondary" onClick={() => setForm({ policy })}>Add advance</Button>
                      </td>
                    </tr>
                    {open === policy.id && (
                      <tr><td colSpan={7} className="bg-slate-50 p-2">
                        <AdvanceRecords advances={advances.filter((a) => a.policyId === policy.id)} onCorrect={(a) => setForm({ policy, advance: a })} />
                      </td></tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
            {shown.length > 500 && <p className="mt-2 text-xs text-slate-500">Showing 500 of {shown.length}; narrow the filters.</p>}
          </div>
        </Card>
      )}
      {form && <AdvanceFormModal policy={form.policy} advance={form.advance} onClose={() => setForm(null)} />}
    </div>
  );
}

function AdvanceRecords({ advances, onCorrect }: { advances: BrokerAdvance[]; onCorrect: (a: BrokerAdvance) => void }) {
  const { brokerById } = useData();
  const [voiding, setVoiding] = useState<BrokerAdvance | null>(null);
  if (!advances.length) return <p className="text-xs text-slate-500">No advance records for this policy.</p>;
  return (
    <>
      <table className="min-w-full text-xs">
        <thead><tr className="text-left uppercase text-slate-500"><th className="py-1 pr-2">Term</th><th className="pr-2">Broker</th><th className="pr-2 text-right">Basis</th><th className="pr-2">%</th><th className="pr-2 text-right">Paid</th><th className="pr-2">Date / ref</th><th className="pr-2">Type</th><th className="pr-2">Source / note</th><th className="pr-2">Status</th><th /></tr></thead>
        <tbody>{[...advances].sort((a, b) => a.termEffectiveDate.localeCompare(b.termEffectiveDate)).map((a) => (
          <tr key={a.id} className={`border-t border-slate-200 ${a.status === 'voided' ? 'text-slate-400 line-through' : ''}`}>
            <td className="py-1 pr-2">{a.termEffectiveDate} → {a.termExpirationDate}</td>
            <td className="pr-2">{brokerById.get(a.brokerId)?.name ?? a.brokerId}</td>
            <td className="pr-2 text-right">{a.commissionBasisCents === null ? '—' : <Money cents={a.commissionBasisCents} />}</td>
            <td className="pr-2">{a.brokerShareBps === null ? '—' : `${(a.brokerShareBps / 100).toFixed(2)}%`}</td>
            <td className="pr-2 text-right"><Money cents={a.amountPaidCents} /></td>
            <td className="pr-2">{a.paymentDate ?? '—'} {a.paymentReference}</td>
            <td className="pr-2">{a.paymentType === 'renewal' ? 'Renewal' : a.paymentType === 'new_business' ? 'New business' : '—'}</td>
            <td className="pr-2">{a.source.kind === 'import' ? `Import ${a.source.fileName ?? ''} row ${a.source.rowNo ?? ''}` : 'Manual'}{a.note ? ` — ${a.note}` : ''}{a.voidReason ? ` (voided: ${a.voidReason})` : ''}</td>
            <td className="pr-2 no-underline">{a.status}</td>
            <td className="whitespace-nowrap text-right">{a.status === 'active' && <><Button size="sm" variant="ghost" onClick={() => onCorrect(a)}>Correct</Button><Button size="sm" variant="ghost" onClick={() => setVoiding(a)}>Void</Button></>}</td>
          </tr>
        ))}</tbody>
      </table>
      {voiding && <VoidModal advance={voiding} onClose={() => setVoiding(null)} />}
    </>
  );
}

function VoidModal({ advance, onClose }: { advance: BrokerAdvance; onClose: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal open title="Void advance record" onClose={onClose}>
      <p className="text-sm">The record is kept, marked voided, with your reason in the audit log.</p>
      <Field label="Reason (required)" className="mt-3"><TextInput value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <ErrorNote message={error} />
      <div className="mt-4 flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button disabled={busy || note.trim().length < 3} onClick={async () => { setBusy(true); setError(null); try { await api.voidBrokerAdvance({ advanceId: advance.id, note }); onClose(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not void'); } finally { setBusy(false); } }}>Void</Button></div>
    </Modal>
  );
}

function AdvanceFormModal({ policy, advance, onClose }: { policy: Policy; advance?: BrokerAdvance; onClose: () => void }) {
  const { brokers } = useData();
  const [f, setF] = useState({
    brokerId: advance?.brokerId ?? (policy.brokerId !== UNASSIGNED_BROKER_ID ? policy.brokerId : ''),
    termEffectiveDate: advance?.termEffectiveDate ?? policy.effectiveDate ?? '', termExpirationDate: advance?.termExpirationDate ?? policy.expirationDate ?? '',
    basis: advance?.commissionBasisCents != null ? (advance.commissionBasisCents / 100).toFixed(2) : '', share: advance?.brokerShareBps != null ? String(advance.brokerShareBps / 100) : '',
    paid: advance ? (advance.amountPaidCents / 100).toFixed(2) : '', paymentDate: advance?.paymentDate ?? '', paymentReference: advance?.paymentReference ?? '',
    paymentType: (advance?.paymentType ?? '') as AdvancePaymentType | '',
  });
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  async function save() {
    setBusy(true); setError(null); setFieldErrors({});
    try {
      const a: AdvanceForm = {
        policyId: policy.id, brokerId: f.brokerId, termEffectiveDate: f.termEffectiveDate, termExpirationDate: f.termExpirationDate,
        commissionBasisCents: f.basis.trim() ? parseMoneyToCents(f.basis) : null,
        brokerShareBps: f.share.trim() ? Math.round(Number(f.share) * 100) : null,
        amountPaidCents: parseMoneyToCents(f.paid), paymentDate: f.paymentDate || null, paymentReference: f.paymentReference, paymentType: f.paymentType || null,
      };
      if (advance) await api.correctBrokerAdvance({ advanceId: advance.id, advance: a, note });
      else await api.recordBrokerAdvance({ advance: a, note });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
      if (e && typeof e === 'object' && 'fieldErrors' in e) setFieldErrors((e as { fieldErrors: Record<string, string> }).fieldErrors);
    } finally { setBusy(false); }
  }
  const fe = (k: string) => fieldErrors[`advance.${k}`];
  return (
    <Modal open title={`${advance ? 'Correct' : 'Record'} advance payment — policy ${policy.policyNumber}`} onClose={onClose}>
      {advance && <p className="mb-2 text-xs text-slate-600">The original record is kept and marked voided; this becomes its replacement.</p>}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Broker paid" error={fe('brokerId')}><Select value={f.brokerId} onChange={set('brokerId')} placeholder="Choose" options={brokers.filter((b) => b.id !== UNASSIGNED_BROKER_ID).map((b) => ({ value: b.id, label: b.name }))} /></Field>
        <Field label="Payment type"><Select value={f.paymentType} onChange={set('paymentType')} placeholder="Not known" options={[{ value: 'new_business', label: 'New business' }, { value: 'renewal', label: 'Renewal' }]} /></Field>
        <Field label="Term effective" error={fe('termEffectiveDate')}><TextInput type="date" value={f.termEffectiveDate} onChange={set('termEffectiveDate')} /></Field>
        <Field label="Term expiration" error={fe('termExpirationDate')}><TextInput type="date" value={f.termExpirationDate} onChange={set('termExpirationDate')} /></Field>
        <Field label="Full-term commission basis" hint="Agency commission the advance was based on"><TextInput value={f.basis} onChange={set('basis')} placeholder="e.g. 1000.00" /></Field>
        <Field label="Broker %"><TextInput value={f.share} onChange={set('share')} placeholder="e.g. 50" /></Field>
        <Field label="Amount actually paid" error={fe('amountPaidCents')}><TextInput value={f.paid} onChange={set('paid')} placeholder="e.g. 500.00" /></Field>
        <Field label="Payment date"><TextInput type="date" value={f.paymentDate} onChange={set('paymentDate')} /></Field>
        <Field label="Payment reference"><TextInput value={f.paymentReference} onChange={set('paymentReference')} placeholder="Check #, transfer ID" /></Field>
      </div>
      <Field label="Audit note (required)" className="mt-3" error={fieldErrors.note}><TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder="Source of this payment information" /></Field>
      <ErrorNote message={error} />
      <div className="mt-4 flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={busy || note.trim().length < 3 || !f.paid.trim()} onClick={() => void save()}>{busy ? 'Saving…' : advance ? 'Save correction' : 'Record advance'}</Button></div>
    </Modal>
  );
}

async function sha256(buf: ArrayBuffer) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join(''); }

function AdvanceImport() {
  const [staged, setStaged] = useState<{ importId: string; fileName: string; counts: { rows: number; ok: number; errors: number; warnings: number }; totalOkCents: number; rows: ParsedAdvanceRow[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [note, setNote] = useState('');
  async function onFile(file: File) {
    setBusy(true); setError(null); setNotice(null); setStaged(null);
    try {
      const buf = await file.arrayBuffer();
      let table: string[][];
      if (/\.(csv|txt|tsv)$/i.test(file.name)) table = parseCsv(new TextDecoder('utf-8').decode(buf));
      else if (/\.xlsx$/i.test(file.name)) { const { readXlsx } = await import('@asm/shared/excel'); const sheets = await readXlsx(buf); table = sheets[0]?.rows ?? []; }
      else throw new Error('Upload a .csv or .xlsx file.');
      if (table.length < 2) throw new Error('The file has no data rows.');
      const r = await api.stageAdvanceImport({ fileName: file.name, fileHash: await sha256(buf), headers: table[0], rows: table.slice(1) });
      setStaged({ ...r, fileName: file.name });
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not read the file'); } finally { setBusy(false); }
  }
  const template = () => {
    const url = URL.createObjectURL(new Blob([`﻿${ADVANCE_TEMPLATE_HEADERS.join(',')}\r\n`], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'broker-advance-payments-template.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <Card title="Import historical advance payments (CSV or Excel)">
      <p className="text-xs text-slate-600">One row per payment actually made to a broker. Required columns: broker (code or name), policy number, term effective, term expiration, amount paid. Optional: carrier (needed when a number exists at several carriers), commission basis, broker %, payment date, reference, payment type (new business / renewal), notes. Rows are validated against the book and staged; nothing is recorded until you commit.</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input type="file" accept=".csv,.xlsx,.txt,.tsv" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ''; }} />
        <Button size="sm" variant="ghost" onClick={template}>Download template</Button>
      </div>
      <ErrorNote message={error} />
      {notice && <p className="mt-2 text-sm text-emerald-700">{notice}</p>}
      {staged && (
        <div className="mt-4 space-y-3">
          <p className="text-sm"><b>{staged.fileName}</b>: {staged.counts.ok} valid row(s) totalling <Money cents={staged.totalOkCents} />, {staged.counts.errors} with errors (not imported), {staged.counts.warnings} with warnings.</p>
          <div className="max-h-96 overflow-auto">
            <table className="min-w-full text-xs">
              <thead><tr className="text-left uppercase text-slate-500"><th className="py-1 pr-2">Row</th><th className="pr-2">Status</th><th className="pr-2">Policy / term</th><th className="pr-2 text-right">Paid</th><th>Messages</th></tr></thead>
              <tbody>{staged.rows.map((r) => (
                <tr key={r.rowNo} className="border-t border-slate-100 align-top">
                  <td className="py-1 pr-2">{r.rowNo}</td>
                  <td className="pr-2">{r.ok ? <Badge tone="green">OK</Badge> : <Badge tone="red">Error</Badge>}</td>
                  <td className="pr-2">{r.advance ? `${r.advance.policyId} · ${r.advance.termEffectiveDate}` : '—'}</td>
                  <td className="pr-2 text-right">{r.advance ? <Money cents={r.advance.amountPaidCents} /> : '—'}</td>
                  <td>{[...r.errors.map((m) => <div key={m} className="text-red-700">{m}</div>), ...r.warnings.map((m) => <div key={m} className="text-amber-700">{m}</div>)]}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <Field label="Audit note for this import (required)"><TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Broker payment ledger 2024–2026 from the accountant" /></Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={async () => { setBusy(true); try { await api.discardAdvanceImport({ importId: staged.importId }); setStaged(null); setNotice('Import discarded.'); } catch (e) { setError(e instanceof Error ? e.message : 'Could not discard'); } finally { setBusy(false); } }}>Discard</Button>
            <Button disabled={busy || !staged.counts.ok || note.trim().length < 3} onClick={async () => { setBusy(true); try { const r = await api.commitAdvanceImport({ importId: staged.importId, note }); setNotice(`${r.created} advance record(s) created.`); setStaged(null); } catch (e) { setError(e instanceof Error ? e.message : 'Could not import'); } finally { setBusy(false); } }}>Import {staged.counts.ok} valid row(s)</Button>
          </div>
        </div>
      )}
    </Card>
  );
}
