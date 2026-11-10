import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { CLASSIFICATION_LABELS, formatBps, formatMonth, type Client, type Policy } from '@asm/shared';
import { useData } from '../data';
import { ClientForm, PolicyForm } from '../forms';
import { Badge, Button, Card, DataTable, Empty, Modal, Money, PageHeader, Stat, type Column } from '../ui';

export function ClientsPage() {
  const { clients, policies, brokerById, revenue } = useData();
  const [adding, setAdding] = useState(false);
  const navigate = useNavigate();

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

  return (
    <div>
      <PageHeader title="Clients & Policies" subtitle={`${clients.length.toLocaleString()} clients · ${policies.length.toLocaleString()} policies`}
        actions={<>
          <Link to="/import"><Button variant="secondary">Import from CSV</Button></Link>
          <Button onClick={() => setAdding(true)}>Add client</Button>
        </>} />
      <Card>
        <DataTable rows={clients} columns={columns} onRowClick={(c) => navigate(`/clients/${c.id}`)}
          searchText={(c) => `${c.name} ${brokerById.get(c.brokerId)?.name ?? ''}`} initialSort={{ key: 'name', dir: 'asc' }}
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
      <h3 className="mb-2 mt-5 text-sm font-semibold text-ink">Commission history (posted ledger)</h3>
      {entries.length === 0 ? (
        <p className="text-sm text-slate-500">No commission posted for this policy in the snapshot window yet.</p>
      ) : (
        <table className="min-w-full text-sm">
          <thead><tr className="text-left text-xs uppercase text-slate-500"><th className="py-1">Statement month</th><th>Type</th><th>Source</th><th className="text-right">Amount</th></tr></thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-t border-slate-100">
                <td className="py-1">{formatMonth(e.statementPeriod)}</td>
                <td>{CLASSIFICATION_LABELS[e.classification]}</td>
                <td>{e.sourceType}</td>
                <td className="text-right"><Money cents={e.amountCents} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="mt-5 flex justify-end"><Button onClick={onEdit}>Edit policy</Button></div>
    </Modal>
  );
}
