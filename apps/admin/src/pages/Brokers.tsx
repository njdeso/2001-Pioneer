import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { brokerSplit, formatBps, monthlyTotals, sumCents, UNASSIGNED_BROKER_ID, type Broker, type Policy } from '@asm/shared';
import { useData } from '../data';
import { BrokerForm } from '../forms';
import { api } from '../api';
import { Badge, Button, Card, DataTable, Empty, ErrorNote, Money, PageHeader, Select, Stat, type Column } from '../ui';

export function BrokersPage() {
  const { brokers, clients, policies, revenue } = useData();
  const [adding, setAdding] = useState(false);
  const navigate = useNavigate();

  const stats = useMemo(() => {
    const m = new Map<string, { clients: number; policies: number }>();
    for (const b of brokers) m.set(b.id, { clients: 0, policies: 0 });
    for (const c of clients) { const s = m.get(c.brokerId); if (s) s.clients++; }
    for (const p of policies) { const s = m.get(p.brokerId); if (s) s.policies++; }
    return m;
  }, [brokers, clients, policies]);

  const gross = (b: Broker) => revenue?.byBroker.get(b.id) ?? 0;
  const columns: Column<Broker>[] = [
    { key: 'name', header: 'Broker', render: (b) => <span className="font-medium text-ink">{b.name}</span>, sort: (b) => b.name },
    { key: 'code', header: 'ID', render: (b) => b.code, sort: (b) => b.code },
    { key: 'share', header: 'Share', align: 'right', render: (b) => formatBps(b.shareBps), sort: (b) => b.shareBps },
    { key: 'clients', header: 'Clients', align: 'right', render: (b) => stats.get(b.id)?.clients ?? 0, sort: (b) => stats.get(b.id)?.clients ?? 0 },
    { key: 'policies', header: 'Policies', align: 'right', render: (b) => stats.get(b.id)?.policies ?? 0, sort: (b) => stats.get(b.id)?.policies ?? 0 },
    { key: 'gross', header: 'T12 gross', align: 'right', render: (b) => <Money cents={gross(b)} />, sort: gross },
    { key: 'bshare', header: 'Broker share', align: 'right', render: (b) => <Money cents={brokerSplit(gross(b), b.shareBps).broker} /> },
    { key: 'net', header: 'Agency net', align: 'right', render: (b) => <Money cents={brokerSplit(gross(b), b.shareBps).agency} /> },
    { key: 'status', header: 'Status', render: (b) => (b.status === 'active' ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>) },
  ];

  return (
    <div>
      <PageHeader title="Brokers" subtitle="Internal only — broker information is never included in the buyer package"
        actions={<Button onClick={() => setAdding(true)}>Add broker</Button>} />
      <Card>
        <DataTable rows={brokers} columns={columns} onRowClick={(b) => navigate(`/brokers/${b.id}`)}
          searchText={(b) => `${b.name} ${b.code}`} initialSort={{ key: 'gross', dir: 'desc' }} />
      </Card>
      {adding && <BrokerForm open onClose={() => setAdding(false)} />}
    </div>
  );
}

export function BrokerDetailPage() {
  const { id } = useParams();
  const { brokerById, brokers, policies, clientById, carrierById, revenue } = useData();
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const broker = id ? brokerById.get(id) : undefined;
  const book = useMemo(() => policies.filter((p) => p.brokerId === id), [policies, id]);
  if (!broker) return <Empty title="Broker not found"><Link to="/brokers" className="text-ink underline">Back to brokers</Link></Empty>;

  const bookIds = new Set(book.map((p) => p.id));
  const entries = (revenue?.entries ?? []).filter((e) => e.policyId && bookIds.has(e.policyId));
  const monthly = revenue ? monthlyTotals(entries, revenue.start, revenue.months) : new Map<string, number>();
  const gross = sumCents(monthly.values());
  const split = brokerSplit(gross, broker.shareBps);
  const clientCount = new Set(book.map((p) => p.clientId)).size;

  async function move() {
    if (!target || selected.size === 0) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const res = await api.reassignPolicies([...selected], target);
      setMessage(`Moved ${res.moved} ${res.moved === 1 ? 'policy' : 'policies'} to ${brokerById.get(target)?.name}.`);
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not move policies');
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<Policy>[] = [
    { key: 'num', header: 'Policy #', render: (p) => <Link className="text-ink hover:underline" to={`/clients/${p.clientId}?policy=${p.id}`}>{p.policyNumber}</Link>, sort: (p) => p.policyNumber },
    { key: 'client', header: 'Client', render: (p) => clientById.get(p.clientId)?.name ?? '—', sort: (p) => clientById.get(p.clientId)?.name ?? '' },
    { key: 'carrier', header: 'Carrier', render: (p) => carrierById.get(p.carrierId)?.name ?? '—', sort: (p) => carrierById.get(p.carrierId)?.name ?? '' },
    { key: 'line', header: 'Line', render: (p) => (p.line === 'personal' ? 'Personal' : 'Commercial'), sort: (p) => p.line },
    { key: 'status', header: 'Status', render: (p) => p.status, sort: (p) => p.status },
    { key: 't12', header: 'T12', align: 'right', render: (p) => <Money cents={revenue?.byPolicy.get(p.id) ?? 0} />, sort: (p) => revenue?.byPolicy.get(p.id) ?? 0 },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title={broker.name} subtitle={`${broker.code} · ${formatBps(broker.shareBps)} share · internal only`}
        actions={broker.id !== UNASSIGNED_BROKER_ID ? <Button onClick={() => setEditing(true)}>Edit</Button> : undefined} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat tone="gold" label="T12 gross commission" value={<Money cents={gross} />} />
        <Stat label="Broker share" value={<Money cents={split.broker} />} />
        <Stat label="Agency net" value={<Money cents={split.agency} />} />
        <Stat label="Clients" value={clientCount} />
        <Stat label="Policies" value={book.length} />
      </div>

      <Card title="Book of business"
        actions={
          <div className="flex items-center gap-2">
            <Select value={target} onChange={(e) => setTarget(e.target.value)} placeholder="Move selected to…"
              options={brokers.filter((b) => b.id !== broker.id).map((b) => ({ value: b.id, label: b.name }))} className="w-48 py-1 text-xs" />
            <Button size="sm" disabled={busy || !target || selected.size === 0} onClick={() => void move()}>
              Move {selected.size || ''}
            </Button>
          </div>
        }>
        {message && <p className="mb-3 text-sm text-emerald-700">{message}</p>}
        <div className="mb-3"><ErrorNote message={error} /></div>
        <DataTable rows={book} columns={columns} selectable selected={selected} onSelectedChange={setSelected}
          searchText={(p) => `${p.policyNumber} ${clientById.get(p.clientId)?.name ?? ''} ${carrierById.get(p.carrierId)?.name ?? ''}`}
          empty="No policies assigned to this broker." />
        <p className="mt-2 text-xs text-slate-500">Revenue follows each policy's current broker. Every move is recorded in the audit log.</p>
      </Card>
      {editing && <BrokerForm open onClose={() => setEditing(false)} broker={broker} />}
    </div>
  );
}
