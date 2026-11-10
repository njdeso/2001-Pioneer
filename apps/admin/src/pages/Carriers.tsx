import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { formatBps, formatMonth, monthlyTotals, sumCents, type Carrier } from '@asm/shared';
import { useData } from '../data';
import { CarrierForm } from '../forms';
import { api } from '../api';
import { Badge, Button, Card, DataTable, Empty, ErrorNote, Money, PageHeader, Stat, type Column } from '../ui';

export function CarriersPage() {
  const { carriers, policies, revenue } = useData();
  const [tab, setTab] = useState<'all' | 'carrier' | 'wholesaler'>('all');
  const [adding, setAdding] = useState(false);
  const navigate = useNavigate();

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of policies) {
      m.set(p.carrierId, (m.get(p.carrierId) ?? 0) + 1);
      if (p.wholesalerId) m.set(p.wholesalerId, (m.get(p.wholesalerId) ?? 0) + 1);
    }
    return m;
  }, [policies]);

  const t12 = (c: Carrier) => (c.kind === 'wholesaler' ? revenue?.byPayer.get(c.id) : revenue?.byCarrier.get(c.id)) ?? 0;
  const rows = carriers.filter((c) => tab === 'all' || c.kind === tab);

  const columns: Column<Carrier>[] = [
    { key: 'name', header: 'Name', render: (c) => <span className="font-medium text-ink">{c.name}</span>, sort: (c) => c.name },
    { key: 'code', header: 'Code', render: (c) => c.code, sort: (c) => c.code },
    { key: 'kind', header: 'Type', render: (c) => (c.kind === 'wholesaler' ? <Badge tone="blue">Wholesaler</Badge> : <Badge>Carrier</Badge>), sort: (c) => c.kind },
    { key: 'method', header: 'Commission', render: (c) => (c.commissionMethod === 'retained' ? <Badge tone="amber">Retained</Badge> : 'Statement'), sort: (c) => c.commissionMethod },
    { key: 'rate', header: 'Std. rate', align: 'right', render: (c) => (c.defaultRateBps != null ? formatBps(c.defaultRateBps) : '—'), sort: (c) => c.defaultRateBps ?? -1 },
    { key: 'policies', header: 'Policies', align: 'right', render: (c) => (counts.get(c.id) ?? 0).toLocaleString(), sort: (c) => counts.get(c.id) ?? 0 },
    { key: 't12', header: 'T12 commission', align: 'right', render: (c) => <Money cents={t12(c)} />, sort: t12 },
    { key: 'status', header: 'Status', render: (c) => (c.status === 'active' ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>), sort: (c) => c.status },
  ];

  return (
    <div>
      <PageHeader title="Insurance Carriers" subtitle="Carriers and the wholesalers that pay commission on their policies"
        actions={<Button onClick={() => setAdding(true)}>Add carrier / wholesaler</Button>} />
      <div className="mb-4 flex gap-1">
        {(['all', 'carrier', 'wholesaler'] as const).map((t) => (
          <Button key={t} size="sm" variant={tab === t ? 'primary' : 'secondary'} onClick={() => setTab(t)}>
            {t === 'all' ? 'All' : t === 'carrier' ? 'Carriers' : 'Wholesalers'}
          </Button>
        ))}
      </div>
      <Card>
        <DataTable rows={rows} columns={columns} onRowClick={(c) => navigate(`/carriers/${c.id}`)}
          searchText={(c) => `${c.name} ${c.code} ${(c.aliases ?? []).join(' ')}`} initialSort={{ key: 'name', dir: 'asc' }}
          empty="No carriers yet. Add your carriers and wholesalers (J&J, Jimcor, RTS, CRC…)." />
      </Card>
      {adding && <CarrierForm open onClose={() => setAdding(false)} />}
    </div>
  );
}

export function CarrierDetailPage() {
  const { id } = useParams();
  const { carrierById, policies, clientById, brokerById, revenue } = useData();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const carrier = id ? carrierById.get(id) : undefined;
  if (!carrier) return <Empty title="Carrier not found"><Link to="/carriers" className="text-ink underline">Back to carriers</Link></Empty>;

  const isWholesaler = carrier.kind === 'wholesaler';
  const related = policies.filter((p) => (isWholesaler ? p.wholesalerId === carrier.id : p.carrierId === carrier.id));
  const entries = (revenue?.entries ?? []).filter((e) => (isWholesaler ? e.payerId === carrier.id : e.carrierId === carrier.id));
  const monthly = revenue ? monthlyTotals(entries, revenue.start, revenue.months) : new Map<string, number>();
  const total = sumCents(monthly.values());

  async function toggleStatus() {
    if (!carrier) return;
    setError(null);
    try {
      const { id: _id, createdAt, createdBy, updatedAt, updatedBy, ...data } = carrier;
      await api.saveCarrier({ ...data, status: carrier.status === 'active' ? 'inactive' : 'active' }, carrier.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update status');
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={carrier.name}
        subtitle={<span className="flex flex-wrap gap-2">{carrier.code} · {isWholesaler ? 'Wholesaler / MGA' : 'Insurance carrier'}
          {carrier.commissionMethod === 'retained' && <Badge tone="amber">Commission retained from premium</Badge>}
          {carrier.status !== 'active' && <Badge>Inactive</Badge>}</span>}
        actions={<>
          <Button variant="secondary" onClick={() => void toggleStatus()}>{carrier.status === 'active' ? 'Deactivate' : 'Reactivate'}</Button>
          <Button onClick={() => setEditing(true)}>Edit</Button>
        </>}
      />
      <ErrorNote message={error} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat tone="gold" label={isWholesaler ? 'T12 paid by this wholesaler' : 'T12 commission on this carrier'} value={<Money cents={total} />} />
        <Stat label="Policies" value={related.length.toLocaleString()} />
        <Stat label="Standard rate" value={carrier.defaultRateBps != null ? formatBps(carrier.defaultRateBps) : '—'} />
      </div>

      <Card title="Monthly commission, snapshot window">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-xs uppercase text-slate-500">
                {[...monthly.keys()].map((m) => <th key={m} className="px-2 py-1 text-right font-medium">{formatMonth(m)}</th>)}
                <th className="px-2 py-1 text-right font-semibold text-ink">Total</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                {[...monthly.entries()].map(([m, v]) => <td key={m} className="px-2 py-2 text-right"><Money cents={v} /></td>)}
                <td className="px-2 py-2 text-right font-semibold"><Money cents={total} /></td>
              </tr>
            </tbody>
          </table>
        </div>
        {entries.length === 0 && <p className="mt-2 text-xs text-slate-500">No statements posted for this {isWholesaler ? 'wholesaler' : 'carrier'} yet. Monthly totals appear here once its statements are approved and posted; every transaction is listed in the Ledger.</p>}
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card title="Contact">
          <dl className="space-y-2 text-sm">
            {(['name', 'phone', 'email', 'address'] as const).map((k) => (
              <div key={k} className="flex justify-between gap-3"><dt className="capitalize text-slate-500">{k}</dt><dd className="text-right">{carrier.contact?.[k] || '—'}</dd></div>
            ))}
            {carrier.contact?.notes && <p className="whitespace-pre-wrap border-t pt-2 text-slate-600">{carrier.contact.notes}</p>}
            {carrier.aliases?.length > 0 && <p className="border-t pt-2 text-xs text-slate-500">Also appears as: {carrier.aliases.join(', ')}</p>}
          </dl>
        </Card>
        <Card title={isWholesaler ? 'Policies placed through this wholesaler' : 'Policies with this carrier'} className="lg:col-span-2">
          <DataTable rows={related} pageSize={10}
            columns={[
              { key: 'num', header: 'Policy #', render: (p) => <Link className="text-ink hover:underline" to={`/clients/${p.clientId}?policy=${p.id}`}>{p.policyNumber}</Link>, sort: (p) => p.policyNumber },
              { key: 'client', header: 'Client', render: (p) => clientById.get(p.clientId)?.name ?? '—', sort: (p) => clientById.get(p.clientId)?.name ?? '' },
              { key: 'type', header: 'Type', render: (p) => p.policyType || '—' },
              { key: 'broker', header: 'Broker', render: (p) => brokerById.get(p.brokerId)?.name ?? '—' },
              { key: 't12', header: 'T12', align: 'right', render: (p) => <Money cents={revenue?.byPolicy.get(p.id) ?? 0} />, sort: (p) => revenue?.byPolicy.get(p.id) ?? 0 },
            ]}
            searchText={(p) => `${p.policyNumber} ${clientById.get(p.clientId)?.name ?? ''}`}
            empty="No policies yet." />
        </Card>
      </div>
      {editing && <CarrierForm open onClose={() => setEditing(false)} carrier={carrier} />}
    </div>
  );
}
