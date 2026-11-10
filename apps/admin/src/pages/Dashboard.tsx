import { Link } from 'react-router';
import { CARRIER_LEVEL_BUCKET, formatMonth, formatWindow, UNASSIGNED_BROKER_ID } from '@asm/shared';
import { useData } from '../data';
import { BarList, Card, Money, PageHeader, Stat } from '../ui';

export function DashboardPage() {
  const { ready, settings, carriers, brokers, clients, policies, carrierById, brokerById, revenue } = useData();
  if (!ready) return <p className="text-sm text-slate-500">Loading…</p>;

  const activeClients = clients.filter((c) => c.status === 'active').length;
  const activePolicies = policies.filter((p) => p.status === 'active').length;
  const insurerCount = carriers.filter((c) => c.kind === 'carrier' && c.status === 'active').length;
  const wholesalerCount = carriers.filter((c) => c.kind === 'wholesaler' && c.status === 'active').length;
  const brokerCount = brokers.filter((b) => b.id !== UNASSIGNED_BROKER_ID && b.status === 'active').length;
  const posted = revenue?.entries.length ?? 0;

  const monthly = revenue ? [...revenue.monthly.entries()] : [];
  const maxMonth = Math.max(1, ...monthly.map(([, v]) => Math.abs(v)));

  const byPayer = revenue ? [...revenue.byPayer.entries()].map(([id, cents]) => ({
    id, cents, label: carrierById.get(id)?.name ?? 'Unknown payer',
    hint: carrierById.get(id)?.kind === 'wholesaler' ? 'wholesaler' : undefined,
  })).sort((a, b) => b.cents - a.cents) : [];

  const byBroker = revenue ? [...revenue.byBroker.entries()].map(([id, cents]) => ({
    id, cents,
    label: id === CARRIER_LEVEL_BUCKET ? 'Carrier-level (bonuses, unallocated)' : brokerById.get(id)?.name ?? 'Unknown broker',
  })).sort((a, b) => b.cents - a.cents) : [];

  const personal = revenue?.byLine.get('personal') ?? 0;
  const commercial = revenue?.byLine.get('commercial') ?? 0;
  const carrierLevel = revenue?.byLine.get('carrier_level') ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        subtitle={settings ? `Snapshot window ${formatWindow(settings.snapshotStartMonth, settings.snapshotMonths)} · revenue month = statement period` : 'Set the snapshot window in Settings'}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat tone="gold" label="Trailing 12-month commission" value={<Money cents={revenue?.total ?? 0} />}
          sub={posted ? `${posted.toLocaleString()} posted ledger entries` : 'No statements posted yet'} />
        <Stat label="Broker share (internal)" value={<Money cents={revenue?.brokerShare ?? 0} />} sub="As allocated when posted" />
        <Stat label="Agency net (internal)" value={<Money cents={revenue?.agencyNet ?? 0} />} sub="Gross minus broker share" />
        <Stat label="Average month" value={<Money cents={revenue ? Math.trunc(revenue.total / revenue.months) : 0} />} sub="Window total ÷ months (display only)" />
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <Stat label="Active clients" value={activeClients.toLocaleString()} />
        <Stat label="Active policies" value={activePolicies.toLocaleString()} />
        <Stat label="Brokers" value={brokerCount} />
        <Stat label="Carriers" value={insurerCount} />
        <Stat label="Wholesalers" value={wholesalerCount} />
      </div>

      <Card title="Monthly commission (statement period)">
        {posted === 0 ? (
          <p className="text-sm text-slate-500">Monthly figures appear here once commission statements are approved and posted (Statements → review → Approve → Post). Every bar is the sum of posted ledger entries for that statement month.</p>
        ) : (
          <div className="flex h-48 items-end gap-2">
            {monthly.map(([m, v]) => (
              <div key={m} className="flex flex-1 flex-col items-center gap-1" title={`${formatMonth(m)}`}>
                <div className="num text-[10px] text-slate-500"><Money cents={v} /></div>
                <div className={v < 0 ? 'w-full rounded-t bg-red-400' : 'w-full rounded-t bg-ink'} style={{ height: `${(Math.abs(v) / maxMonth) * 140}px` }} />
                <div className="text-[10px] text-slate-500">{formatMonth(m).slice(0, 3)}</div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card title="Commission by payer" actions={<Link to="/carriers" className="text-xs text-ink hover:underline">All carriers</Link>}>
          <BarList items={byPayer} />
        </Card>
        <Card title="Commission by broker (internal)" actions={<Link to="/brokers" className="text-xs text-ink hover:underline">All brokers</Link>}>
          <BarList items={byBroker} />
        </Card>
        <Card title="Personal vs. commercial">
          <BarList items={posted ? [
            { id: 'c', label: 'Commercial', cents: commercial },
            { id: 'p', label: 'Personal', cents: personal },
            ...(carrierLevel ? [{ id: 'k', label: 'Carrier-level', cents: carrierLevel }] : []),
          ] : []} />
        </Card>
      </div>

      <Card title="Snapshot progress">
        <ul className="grid gap-2 text-sm sm:grid-cols-2">
          <Progress done={carriers.length > 0} label="Carriers and wholesalers set up" to="/carriers" />
          <Progress done={brokers.length > 1} label="Brokers set up" to="/brokers" />
          <Progress done={clients.length > 0} label="Client list loaded (Phase 2 import)" to="/clients" />
          <Progress done={posted > 0} label="Commission statements posted (Phases 3–4)" />
        </ul>
      </Card>
    </div>
  );
}

function Progress({ done, label, to }: { done: boolean; label: string; to?: string }) {
  const body = (
    <span className="flex items-center gap-2">
      <span className={done ? 'text-emerald-600' : 'text-slate-300'}>{done ? '●' : '○'}</span>
      <span className={done ? 'text-slate-700' : 'text-slate-500'}>{label}</span>
    </span>
  );
  return <li>{to ? <Link to={to} className="hover:underline">{body}</Link> : body}</li>;
}
