import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { checkTerms, searchBook, termEnd, TERM_STATUSES, TERM_STATUS_LABELS, type PolicyTerm, type TermStatus } from '@asm/shared';
import { db } from '../firebase';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { CLASSIFICATION_LABELS, LEDGER_CLASSIFICATIONS, formatBps, formatMonth, parseMoneyToCents, type Client, type LedgerClassification, type LedgerEntry, type Policy } from '@asm/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { useData } from '../data';
import { ClientForm, PolicyForm } from '../forms';
import { Badge, Button, Card, DataTable, Empty, ErrorNote, Field, Modal, Money, PageHeader, Select, Stat, TextInput, type Column } from '../ui';

export function ClientsPage() {
  const { clients, policies, brokerById, revenue } = useData();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const search = useMemo(() => searchBook(clients, policies, query, (c) => brokerById.get(c.brokerId)?.name ?? ''), [clients, policies, query, brokerById]);

  const perClient = useMemo(() => {
    const m = new Map<string, { count: number; t12: number }>();
    for (const p of policies) {
      const s = m.get(p.clientId) ?? { count: 0, t12: 0 };
      s.count++;
      s.t12 += revenue?.byPolicy.get(p.id) ?? 0;
      m.set(p.clientId, s);
    }
    return m;
  }, [policies, revenue]);

  const columns: Column<Client>[] = [
    { key: 'name', header: 'Client', render: (c) => <span className="font-medium text-ink">{c.name}</span>, sort: (c) => c.name },
    { key: 'class', header: 'Class', render: (c) => (c.classification === 'personal' ? <Badge>Personal</Badge> : <Badge tone="blue">Commercial</Badge>), sort: (c) => c.classification },
    { key: 'broker', header: 'Broker', render: (c) => brokerById.get(c.brokerId)?.name ?? '—', sort: (c) => brokerById.get(c.brokerId)?.name ?? '' },
    { key: 'policies', header: 'Policies', align: 'right', render: (c) => perClient.get(c.id)?.count ?? 0, sort: (c) => perClient.get(c.id)?.count ?? 0 },
    { key: 't12', header: 'T12 commission', align: 'right', render: (c) => <Money cents={perClient.get(c.id)?.t12 ?? 0} />, sort: (c) => perClient.get(c.id)?.t12 ?? 0 },
    { key: 'status', header: 'Status', render: (c) => (c.status === 'active' ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>), sort: (c) => c.status },
  ];
  // Searching by policy number: show which policy matched; clicking opens that policy directly.
  const policyHits = (id: string) => search.policiesFor(id);
  if (query && clients.some((c) => policyHits(c.id).length)) {
    columns.splice(1, 0, { key: 'hit', header: 'Matching policy', render: (c) => <span className="font-mono text-xs">{policyHits(c.id).map((p) => p.policyNumber).join(', ') || '—'}</span> });
  }
  const openClient = (c: Client) => {
    const hits = policyHits(c.id);
    navigate(hits.length === 1 ? `/clients/${c.id}?policy=${hits[0].id}` : `/clients/${c.id}`);
  };

  return (
    <div>
      <PageHeader title="Clients & Policies" subtitle={`${clients.length.toLocaleString()} clients · ${policies.length.toLocaleString()} policies`}
        actions={<>
          <Link to="/import"><Button variant="secondary">Import from CSV</Button></Link>
          <Button onClick={() => setAdding(true)}>Add client</Button>
        </>} />
      <Card>
        <DataTable rows={clients} columns={columns} onRowClick={openClient}
          matches={(c) => search.matchesClient(c)} onFilterChange={setQuery} searchPlaceholder="Search customer or policy number…" initialSort={{ key: 'name', dir: 'asc' }}
          empty="No clients yet. Import your client list (Phase 2) or add one by hand." />
      </Card>
      {adding && <ClientForm open onClose={() => setAdding(false)} onSaved={(id) => navigate(`/clients/${id}`)} />}
    </div>
  );
}

export function ClientDetailPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const { clientById, policies, carrierById, brokerById, revenue } = useData();
  const [editing, setEditing] = useState(false);
  const [policyForm, setPolicyForm] = useState<{ policy?: Policy } | null>(null);
  const client = id ? clientById.get(id) : undefined;
  const list = useMemo(() => policies.filter((p) => p.clientId === id), [policies, id]);
  if (!client) return <Empty title="Client not found"><Link to="/clients" className="text-ink underline">Back to clients</Link></Empty>;

  const t12 = list.reduce((a, p) => a + (revenue?.byPolicy.get(p.id) ?? 0), 0);
  const viewing = params.get('policy') ? list.find((p) => p.id === params.get('policy')) : undefined;

  const columns: Column<Policy>[] = [
    { key: 'num', header: 'Policy #', render: (p) => <span className="font-medium text-ink">{p.policyNumber}</span>, sort: (p) => p.policyNumber },
    { key: 'carrier', header: 'Carrier', render: (p) => carrierById.get(p.carrierId)?.name ?? '—', sort: (p) => carrierById.get(p.carrierId)?.name ?? '' },
    { key: 'via', header: 'Via', render: (p) => (p.wholesalerId ? carrierById.get(p.wholesalerId)?.name : 'Direct') ?? '—' },
    { key: 'type', header: 'Type', render: (p) => p.policyType || '—', sort: (p) => p.policyType },
    { key: 'term', header: 'Term', render: (p) => (p.effectiveDate ? `${p.effectiveDate} → ${p.expirationDate ?? '?'}` : '—'), sort: (p) => p.effectiveDate ?? '' },
    { key: 'broker', header: 'Broker', render: (p) => brokerById.get(p.brokerId)?.name ?? '—' },
    { key: 'status', header: 'Status', render: (p) => p.status },
    { key: 't12', header: 'T12', align: 'right', render: (p) => <Money cents={revenue?.byPolicy.get(p.id) ?? 0} />, sort: (p) => revenue?.byPolicy.get(p.id) ?? 0 },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title={client.name}
        subtitle={<span className="flex gap-2">{client.classification === 'personal' ? 'Personal lines' : 'Commercial lines'} · Broker: {brokerById.get(client.brokerId)?.name ?? '—'}
          {client.status !== 'active' && <Badge>Inactive</Badge>}</span>}
        actions={<>
          <Button variant="secondary" onClick={() => setEditing(true)}>Edit client</Button>
          <Button onClick={() => setPolicyForm({})}>Add policy</Button>
        </>} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat tone="gold" label="T12 commission" value={<Money cents={t12} />} />
        <Stat label="Policies" value={list.length} />
        <Stat label="Carriers" value={new Set(list.map((p) => p.carrierId)).size} />
        <Stat label="Contact" value={<span className="text-sm font-normal">{client.contact?.phone || client.contact?.email || '—'}</span>} />
      </div>

      <Card title="Policies">
        {list.length > 0 && <p className="mb-2 text-xs text-slate-500">Click a policy to open its details, coverage terms (renewals, earlier terms, cancellation) and commission history.</p>}
        <DataTable rows={list} columns={columns} onRowClick={(p) => setParams({ policy: p.id })} empty="No policies yet." />
      </Card>

      {editing && <ClientForm open onClose={() => setEditing(false)} client={client} />}
      {policyForm && <PolicyForm open onClose={() => setPolicyForm(null)} client={client} policy={policyForm.policy} />}
      {viewing && !policyForm && (
        <PolicyDetail policy={viewing} onClose={() => setParams({})} onEdit={() => setPolicyForm({ policy: viewing })} />
      )}
    </div>
  );
}

function PolicyDetail({ policy, onClose, onEdit }: { policy: Policy; onClose: () => void; onEdit: () => void }) {
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const [recording, setRecording] = useState(false);
  const [reversing, setReversing] = useState<LedgerEntry | null>(null);
  const { carrierById, brokerById, revenue } = useData();
  const entries = (revenue?.entries ?? []).filter((e) => e.policyId === policy.id)
    .sort((a, b) => a.statementPeriod.localeCompare(b.statementPeriod));
  const carrier = carrierById.get(policy.carrierId);
  const rate = policy.commissionRateBps ?? carrier?.defaultRateBps ?? null;
  const rows: [string, ReactNode][] = [
    ['Carrier', carrier?.name ?? '—'],
    ['Placed through', policy.wholesalerId ? carrierById.get(policy.wholesalerId)?.name ?? '—' : 'Direct'],
    ['Policy type', policy.policyType || '—'],
    ['Line', policy.line === 'personal' ? 'Personal' : 'Commercial'],
    ['Named insured', policy.namedInsured || '—'],
    ['Broker', brokerById.get(policy.brokerId)?.name ?? '—'],
    ['Broker share', policy.brokerShareBps != null ? `${formatBps(policy.brokerShareBps)} (this policy)` : `${formatBps(brokerById.get(policy.brokerId)?.shareBps ?? 0)} (broker standard)`],
    ['Term', policy.effectiveDate ? `${policy.effectiveDate} → ${policy.expirationDate ?? '?'}` : '—'],
    ['Premium', <Money key="p" cents={policy.premiumCents} />],
    ['Commission rate', rate != null ? `${formatBps(rate)}${policy.commissionRateBps == null ? ' (carrier standard)' : ''}` : '—'],
    ['Alternate numbers', policy.alternateNumbers?.length ? policy.alternateNumbers.join(', ') : '—'],
    ['Status', policy.status],
  ];
  return (
    <Modal open title={`Policy ${policy.policyNumber}`} onClose={onClose} width="max-w-3xl">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {rows.map(([k, v]) => <div key={k} className="flex justify-between gap-3 border-b border-slate-100 py-1"><dt className="text-slate-500">{k}</dt><dd className="text-right">{v}</dd></div>)}
      </dl>
      <PolicyTerms policy={policy} canEdit={isAdmin} />
      <h3 className="mb-2 mt-5 text-sm font-semibold text-ink">Commission history (posted ledger)</h3>
      {entries.length === 0 ? (
        <p className="text-sm text-slate-500">No commission posted for this policy in the snapshot window yet.</p>
      ) : (
        <table className="min-w-full text-sm">
          <thead><tr className="text-left text-xs uppercase text-slate-500"><th className="py-1">Statement month</th><th>Type</th><th>Source</th><th className="text-right">Amount</th><th className="text-right">Broker</th><th className="text-right">Agency</th><th>Status</th><th /></tr></thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-t border-slate-100">
                <td className="py-1">{formatMonth(e.statementPeriod)}</td>
                <td>{CLASSIFICATION_LABELS[e.classification]}</td>
                <td>{e.reversalOf ? 'reversal' : e.sourceType}</td>
                <td className="text-right"><Money cents={e.amountCents} /></td>
                <td className="text-right">{typeof e.brokerCents === 'number' ? <Money cents={e.brokerCents} /> : '—'}{e.brokerShareSource === 'policy' ? <span className="text-xs text-slate-500"> (policy %)</span> : null}</td>
                <td className="text-right">{typeof e.agencyCents === 'number' ? <Money cents={e.agencyCents} /> : '—'}</td>
                <td>{e.postingStatus === 'reversed' ? <Badge>Reversed</Badge> : e.reversalOf ? <Badge tone="amber">Reversal</Badge> : <Badge tone="green">Posted</Badge>}</td>
                <td className="text-right">{isAdmin && e.sourceType !== 'statement' && !e.reversalOf && e.postingStatus === 'posted' && <Button size="sm" variant="ghost" onClick={() => setReversing(e)}>Reverse…</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="mt-5 flex justify-end gap-2">
        {isAdmin && <Button variant="secondary" onClick={() => setRecording(true)}>Record retained commission</Button>}
        <Button onClick={onEdit}>Edit policy</Button>
      </div>
      {recording && <RetainedForm policy={policy} onClose={() => setRecording(false)} />}
      {reversing && <ReverseEntryForm entry={reversing} onClose={() => setReversing(null)} />}
    </Modal>
  );
}

/**
 * Retained commission: commission the agency kept out of premium (e.g. from a bind document), posted
 * directly to the ledger and split by the policy's applicable broker share. Admin only; each form
 * submission has its own request ID, so a double click or retry can never post it twice.
 */
function RetainedForm({ policy, onClose }: { policy: Policy; onClose: () => void }) {
  const { brokerById } = useData();
  const [requestId] = useState(() => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`));
  const [f, setF] = useState({ month: new Date().toISOString().slice(0, 7), amount: '', date: '', classification: 'new_business' as LedgerClassification, note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const broker = brokerById.get(policy.brokerId);
  const share = policy.brokerId === 'UNASSIGNED' ? 0 : policy.brokerShareBps ?? broker?.shareBps ?? 0;
  async function save() {
    setError(null);
    let cents: number;
    try { cents = parseMoneyToCents(f.amount); } catch { setError('Enter an amount like 245.00 (negative for a return).'); return; }
    if (!cents) { setError('Enter a non-zero amount.'); return; }
    if (f.note.trim().length < 3) { setError('Add a note (e.g. the bind document reference).'); return; }
    setBusy(true);
    try {
      await api.recordRetainedCommission({ requestId, policyId: policy.id, statementPeriod: f.month, amountCents: cents, transactionDate: f.date || null, classification: f.classification, note: f.note.trim() });
      onClose();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not record'); } finally { setBusy(false); }
  }
  return (
    <Modal open title={`Retained commission — ${policy.policyNumber}`} onClose={onClose}>
      <p className="mb-3 text-sm text-slate-600">Records commission the agency retained out of premium. It posts to the ledger immediately for the month you choose and is split with {broker?.name ?? 'the broker'} at {formatBps(share)}. It can be reversed later with a reason.</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Revenue month"><TextInput type="month" value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })} /></Field>
        <Field label="Amount retained"><TextInput value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} inputMode="decimal" placeholder="245.00" /></Field>
        <Field label="Date (optional)"><TextInput type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Type"><Select value={f.classification} onChange={(e) => setF({ ...f, classification: e.target.value as LedgerClassification })} options={LEDGER_CLASSIFICATIONS.map((c) => ({ value: c, label: CLASSIFICATION_LABELS[c] }))} /></Field>
        <Field label="Note (required)" className="col-span-2"><TextInput value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Bind document / reference" /></Field>
      </div>
      <ErrorNote message={error} />
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={busy} onClick={() => void save()}>{busy ? 'Posting…' : 'Post retained commission'}</Button></div>
    </Modal>
  );
}

function ReverseEntryForm({ entry, onClose }: { entry: LedgerEntry; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal open title="Reverse ledger entry" onClose={onClose}>
      <p className="text-sm text-slate-600">Creates an exact negative entry (<Money cents={-entry.amountCents} />). The original stays, marked reversed.</p>
      <Field label="Reason (required)" className="mt-3"><TextInput value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
      <ErrorNote message={error} />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="danger" disabled={busy || reason.trim().length < 3} onClick={() => { setBusy(true); api.reverseLedgerEntry(entry.id, reason).then(onClose, (e) => { setError(e instanceof Error ? e.message : 'Failed'); setBusy(false); }); }}>Reverse</Button>
      </div>
    </Modal>
  );
}

/**
 * Coverage-term history of ONE policy record: several consecutive terms under the same policy number
 * (renewals, an earlier expired term, a cancelled term) without a second policy or client record.
 * Statement lines are assigned to a term from their effective date when the dates decide it.
 */
function PolicyTerms({ policy, canEdit }: { policy: Policy; canEdit: boolean }) {
  const [terms, setTerms] = useState<PolicyTerm[]>([]);
  const [editing, setEditing] = useState<PolicyTerm | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => onSnapshot(collection(db, 'policies', policy.id, 'terms'),
    (snap) => setTerms(snap.docs.map((d) => ({ ...(d.data() as PolicyTerm), id: d.id, policyId: policy.id })).sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))),
    (e) => setError(e.message)), [policy.id]);
  const problems = checkTerms(terms);
  return (
    <div className="mt-5">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">Coverage terms</h3>
        {canEdit && <Button size="sm" variant="secondary" onClick={() => setEditing('new')}>Add term</Button>}
      </div>
      <ErrorNote message={error} />
      {terms.length === 0 ? (
        <p className="text-xs text-slate-500">No term history recorded. The policy’s own dates ({policy.effectiveDate ?? '?'} → {policy.expirationDate ?? '?'}) are its current term. Add terms to record renewals, earlier terms or a cancellation under this same policy number.</p>
      ) : (
        <table className="min-w-full text-sm">
          <thead><tr className="text-left text-xs uppercase text-slate-500"><th className="py-1">Effective</th><th>Scheduled expiration</th><th>Cancelled</th><th>Coverage ends</th><th>Status</th><th /></tr></thead>
          <tbody>{terms.map((t) => (
            <tr key={t.id} className="border-t border-slate-100">
              <td className="py-1">{t.effectiveDate}</td><td>{t.scheduledExpirationDate}</td><td>{t.cancellationDate ?? '—'}</td><td>{termEnd(t)}</td>
              <td><Badge tone={t.status === 'active' ? 'green' : t.status === 'cancelled' ? 'red' : undefined}>{t.status}</Badge></td>
              <td className="text-right">{canEdit && <Button size="sm" variant="ghost" onClick={() => setEditing(t)}>Edit</Button>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {problems.map((p) => <p key={p.code + p.termIds.join()} className={p.severity === 'error' ? 'mt-1 text-xs text-red-700' : 'mt-1 text-xs text-amber-700'}>{p.message}</p>)}
      {editing && <TermForm policy={policy} term={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function TermForm({ policy, term, onClose }: { policy: Policy; term: PolicyTerm | null; onClose: () => void }) {
  const [effectiveDate, setEffective] = useState(term?.effectiveDate ?? '');
  const [scheduledExpirationDate, setExpiration] = useState(term?.scheduledExpirationDate ?? '');
  const [cancellationDate, setCancelled] = useState(term?.cancellationDate ?? '');
  const [status, setStatus] = useState<TermStatus>((term?.status as TermStatus) ?? 'expired');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  async function save() {
    setBusy(true); setError(null); setFieldErrors({});
    try {
      await api.savePolicyTerm({ policyId: policy.id, originalTermId: term?.id ?? null, note, term: { effectiveDate, scheduledExpirationDate, cancellationDate: status === 'cancelled' ? cancellationDate || null : null, status, note } });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
      if (e instanceof Error && 'fieldErrors' in e) setFieldErrors((e as { fieldErrors: Record<string, string> }).fieldErrors);
    } finally { setBusy(false); }
  }
  async function remove() {
    if (!term || !window.confirm(`Remove the term starting ${term.effectiveDate}?`)) return;
    setBusy(true); setError(null);
    try { await api.removePolicyTerm({ policyId: policy.id, termId: term.id, note }); onClose(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not remove'); } finally { setBusy(false); }
  }
  return (
    <Modal open title={`${term ? 'Edit' : 'Add'} coverage term — policy ${policy.policyNumber}`} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Effective date" error={fieldErrors['term.effectiveDate']}><TextInput type="date" value={effectiveDate} onChange={(e) => setEffective(e.target.value)} /></Field>
        <Field label="Scheduled expiration" error={fieldErrors['term.scheduledExpirationDate']}><TextInput type="date" value={scheduledExpirationDate} onChange={(e) => setExpiration(e.target.value)} /></Field>
        <Field label="Status"><Select value={status} onChange={(e) => setStatus(e.target.value as TermStatus)} options={TERM_STATUSES.map((s) => ({ value: s, label: TERM_STATUS_LABELS[s] }))} /></Field>
        <Field label="Actual cancellation date" error={fieldErrors['term.cancellationDate']} hint={status === 'cancelled' ? 'Required for a cancelled term' : 'Only for a cancelled term'}>
          <TextInput type="date" value={cancellationDate} disabled={status !== 'cancelled'} onChange={(e) => setCancelled(e.target.value)} />
        </Field>
      </div>
      <Field label="Where do these dates come from? (required; kept in the audit log)" className="mt-3" error={fieldErrors.note}><TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Travelers cancellation notice dated 8/13/2026" /></Field>
      <p className="mt-2 text-xs text-slate-500">The policy record (number, current dates and status) is not changed. Terms may not overlap; only the latest term can be active.</p>
      <ErrorNote message={error} />
      <div className="mt-4 flex justify-between gap-2">
        <div>{term && <Button variant="ghost" disabled={busy || note.trim().length < 3} onClick={() => void remove()}>Remove term…</Button>}</div>
        <div className="flex gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={busy || note.trim().length < 3 || !effectiveDate || !scheduledExpirationDate} onClick={() => void save()}>{busy ? 'Saving…' : 'Save term'}</Button></div>
      </div>
    </Modal>
  );
}
