import { useEffect, useState, type ReactNode } from 'react';
import {
  formatMonth, DILIGENCE_CATEGORY_LABELS,
  type ReviewerBook, type ReviewerCarrier, type ReviewerOverview, type ReviewerStatement, type ReviewerTransaction, type ReviewerView, type ReviewerExport,
} from '@asm/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { Footer } from '../layout';
import { Badge, Button, Card, DataTable, ErrorNote, Money, Stat, cx } from '../ui';

/**
 * Read-only portal for external due-diligence reviewers (Pioneer Bank; the independent due-diligence
 * company). Everything shown comes from the reviewer callables, which return allowlisted data only —
 * no broker information of any kind. Nothing here can change a record. The owner can open the same
 * portal as a preview (Administration → External Reviewer Access → Preview).
 */

const TABS: { view: ReviewerView; label: string }[] = [
  { view: 'overview', label: 'Commission summary' },
  { view: 'statements', label: 'Statements' },
  { view: 'book', label: 'Clients & policies' },
  { view: 'carriers', label: 'Carriers' },
  { view: 'transactions', label: 'Posted transactions' },
];
const EXPORTS: { kind: ReviewerExport; label: string }[] = [
  { kind: 'summary', label: 'Commission summary (CSV)' },
  { kind: 'statements', label: 'Statements & reconciliation (CSV)' },
  { kind: 'book', label: 'Active clients & policies (CSV)' },
  { kind: 'transactions', label: 'Posted transactions (CSV)' },
];

type Payload = { organization: string; overview?: ReviewerOverview; statements?: ReviewerStatement[]; book?: ReviewerBook; carriers?: ReviewerCarrier[]; transactions?: ReviewerTransaction[]; settings?: { agencyName: string; snapshotStartMonth: string | null; snapshotMonths: number } };

const STATUS_TONE: Record<ReviewerStatement['status'], 'green' | 'blue' | 'amber' | 'red' | 'slate'> = {
  posted: 'green', approved_not_posted: 'blue', reconciled_not_posted: 'amber', disputed: 'red', not_yet_read: 'slate',
};
const STATUS_SHORT: Record<ReviewerStatement['status'], string> = {
  posted: 'Posted', approved_not_posted: 'Approved — not posted', reconciled_not_posted: 'Reconciled — not posted', disputed: 'Disputed', not_yet_read: 'Not yet read',
};

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ReviewerPortal({ preview = false }: { preview?: boolean }) {
  const { user, logout } = useAuth();
  const [tab, setTab] = useState<ReviewerView>('overview');
  const [data, setData] = useState<Partial<Record<ReviewerView, Payload>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async (view: ReviewerView) => {
    setError(null); setBusy(view);
    try { const d = await api.getReviewerData<Payload>(view); setData((x) => ({ ...x, [view]: d })); } catch (e) { setError(e instanceof Error ? e.message : 'Could not load'); } finally { setBusy(null); }
  };
  useEffect(() => { if (!data[tab]) void load(tab); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const exportCsv = async (kind: ReviewerExport) => {
    setError(null); setBusy(kind);
    try { const r = await api.getReviewerExport(kind); download(r.fileName, r.csv); } catch (e) { setError(e instanceof Error ? e.message : 'Download failed'); } finally { setBusy(null); }
  };

  const d = data[tab];
  const org = d?.organization ?? Object.values(data)[0]?.organization ?? '';
  return (
    <div className="min-h-screen bg-slate-50">
      {!preview && (
        <header className="border-b border-slate-200 bg-white px-6 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-ink">Acquisition due diligence — read-only</div>
              <div className="text-xs text-slate-500">{org || 'Loading…'} · {user?.email}</div>
            </div>
            <Button size="sm" variant="secondary" onClick={() => void logout()}>Sign out</Button>
          </div>
        </header>
      )}
      <main className="mx-auto max-w-7xl space-y-4 p-6">
        {preview && <p className="rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">Owner preview: this is exactly what external reviewers see. It contains no broker information.</p>}
        <nav className="flex flex-wrap gap-2">
          {TABS.map((t) => (
            <button key={t.view} onClick={() => setTab(t.view)} className={cx('rounded-full px-3 py-1 text-sm', tab === t.view ? 'bg-ink text-white' : 'bg-white text-slate-700 ring-1 ring-slate-200')}>{t.label}</button>
          ))}
          <span className="flex-1" />
          <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void load(tab)}>{busy === tab ? 'Refreshing…' : 'Refresh'}</Button>
        </nav>
        <ErrorNote message={error} />
        {!d ? <p className="text-sm text-slate-500">{busy ? 'Loading…' : ''}</p> : (
          <>
            {tab === 'overview' && d.overview && <OverviewView o={d.overview} />}
            {tab === 'statements' && d.statements && <StatementsView rows={d.statements} />}
            {tab === 'book' && d.book && <BookView b={d.book} />}
            {tab === 'carriers' && d.carriers && <CarriersView rows={d.carriers} />}
            {tab === 'transactions' && d.transactions && <TransactionsView rows={d.transactions} />}
          </>
        )}
        <Card title="Downloads">
          <div className="flex flex-wrap gap-2">
            {EXPORTS.map((x) => <Button key={x.kind} size="sm" variant="secondary" disabled={!!busy} onClick={() => void exportCsv(x.kind)}>{busy === x.kind ? 'Preparing…' : x.label}</Button>)}
          </div>
          <p className="mt-2 text-xs text-slate-500">Prepared live from the agency's records at the time of download. Confidential — use only under the applicable confidentiality agreement.</p>
        </Card>
      </main>
      {!preview && <Footer />}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) { return <Card title={title}>{children}</Card>; }

function OverviewView({ o }: { o: ReviewerOverview }) {
  const tone = o.status === 'READY' ? 'border-emerald-300 bg-emerald-50 text-emerald-900' : o.status === 'CHECKS_FAILED' || o.status === 'NO_PERIOD' ? 'border-red-300 bg-red-50 text-red-900' : 'border-amber-300 bg-amber-50 text-amber-900';
  return (
    <div className="space-y-4">
      <div className={cx('rounded border p-3 text-sm', tone)}>
        <div className="font-semibold">{o.statusLabel}</div>
        <div>{o.statusText}</div>
        {o.notices.map((n, i) => <div key={i} className="mt-1 text-xs">{n}</div>)}
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat tone="gold" label={`Posted commission ${o.from ? `${formatMonth(o.from)} – ${formatMonth(o.to)}` : ''}`} value={<Money cents={o.postedTotal.total ?? 0} />} sub="Rolling 12 months, posted ledger only" />
        {o.notPosted.filter((x) => x.count).map((x) => (
          <Stat key={x.status} label={`${STATUS_SHORT[x.status]} (${x.count})`} value={<Money cents={x.carrierTotalCents} />} sub="Carrier printed total — NOT included" />
        ))}
      </div>
      <Section title="Posted commission by category">
        <table className="min-w-full text-sm"><tbody>
          {Object.entries(o.postedTotal).filter(([k]) => k !== 'total').map(([k, v]) => (
            <tr key={k} className="border-t border-slate-100"><td className="py-1">{DILIGENCE_CATEGORY_LABELS[k as keyof typeof DILIGENCE_CATEGORY_LABELS] ?? k}</td><td className="text-right"><Money cents={v} /></td></tr>
          ))}
          <tr className="border-t border-slate-300 font-semibold"><td className="py-1">Total</td><td className="text-right"><Money cents={o.postedTotal.total ?? 0} /></td></tr>
        </tbody></table>
      </Section>
      <Section title="Monthly posted commission">
        <table className="min-w-full text-sm"><thead><tr className="text-left text-xs uppercase text-slate-500"><th>Month</th><th className="text-right">Posted</th><th className="text-right">Posted statements</th></tr></thead><tbody>
          {o.byMonth.map((m) => <tr key={m.month} className="border-t border-slate-100"><td className="py-1">{formatMonth(m.month)}</td><td className="text-right"><Money cents={m.totalCents} /></td><td className="text-right">{m.hasPostedStatement ? 'Yes' : <Badge tone="amber">None posted</Badge>}</td></tr>)}
        </tbody></table>
      </Section>
      <Section title="By paying carrier / wholesaler">
        <table className="min-w-full text-sm"><thead><tr className="text-left text-xs uppercase text-slate-500"><th>Carrier / wholesaler</th><th>Kind</th><th className="text-right">Posted</th><th className="text-right">Months with postings</th></tr></thead><tbody>
          {o.byPayer.map((p) => <tr key={p.name} className="border-t border-slate-100"><td className="py-1">{p.name}</td><td>{p.kind}</td><td className="text-right"><Money cents={p.totalCents} /></td><td className="text-right">{p.monthsWithPostings}</td></tr>)}
        </tbody></table>
      </Section>
      <Section title="By underlying carrier">
        <table className="min-w-full text-sm"><tbody>{o.byCarrier.map((c) => <tr key={c.name} className="border-t border-slate-100"><td className="py-1">{c.name}</td><td className="text-right"><Money cents={c.totalCents} /></td></tr>)}</tbody></table>
      </Section>
      <Section title="Reconciliation checks">
        <table className="min-w-full text-sm"><tbody>{o.checks.map((c) => <tr key={c.name} className="border-t border-slate-100 align-top"><td className="py-1 pr-3">{c.pass ? <Badge tone="green">PASS</Badge> : <Badge tone="red">FAIL</Badge>}</td><td className="pr-3">{c.name}</td><td className="text-xs text-slate-500">{c.detail}</td></tr>)}</tbody></table>
      </Section>
    </div>
  );
}

function StatementsView({ rows }: { rows: ReviewerStatement[] }) {
  return (
    <Section title="Commission statements">
      <p className="mb-2 text-xs text-slate-600">Only <b>Posted</b> statements are included in the commission totals. Disputed statements do not reconcile to the carrier's printed total and are shown with both figures.</p>
      <DataTable rows={rows} searchText={(r) => `${r.payer} ${r.statementMonth ?? ''} ${STATUS_SHORT[r.status]}`} pageSize={50}
        columns={[
          { key: 'month', header: 'Month', render: (r) => (r.statementMonth ? formatMonth(r.statementMonth) : '—'), sort: (r) => r.statementMonth ?? '' },
          { key: 'payer', header: 'Carrier / wholesaler', render: (r) => r.payer, sort: (r) => r.payer },
          { key: 'status', header: 'Status', render: (r) => <Badge tone={STATUS_TONE[r.status]}>{STATUS_SHORT[r.status]}</Badge>, sort: (r) => r.status },
          { key: 'carrier', header: 'Carrier printed total', align: 'right', render: (r) => <Money cents={r.carrierTotalCents} /> },
          { key: 'extracted', header: 'Extracted', align: 'right', render: (r) => <Money cents={r.extractedCents} /> },
          { key: 'posted', header: 'Posted', align: 'right', render: (r) => <Money cents={r.postedCents} /> },
        ]} />
    </Section>
  );
}

function BookView({ b }: { b: ReviewerBook }) {
  return (
    <Section title={`Active policies (${b.policies.length}) · clients (${b.clients.length})`}>
      <DataTable rows={b.policies} searchText={(p) => `${p.client} ${p.policyNumber} ${p.carrier} ${p.policyType}`} pageSize={50}
        columns={[
          { key: 'client', header: 'Client', render: (p) => p.client, sort: (p) => p.client },
          { key: 'num', header: 'Policy', render: (p) => p.policyNumber, sort: (p) => p.policyNumber },
          { key: 'carrier', header: 'Carrier', render: (p) => p.carrier + (p.wholesaler ? ` (via ${p.wholesaler})` : ''), sort: (p) => p.carrier },
          { key: 'type', header: 'Type', render: (p) => p.policyType || p.line },
          { key: 'term', header: 'Term', render: (p) => `${p.effectiveDate ?? '—'} → ${p.expirationDate ?? '—'}` },
          { key: 'prem', header: 'Annual premium', align: 'right', render: (p) => <Money cents={p.annualPremiumCents} /> },
          { key: 'comm', header: 'Posted commission (period)', align: 'right', render: (p) => <Money cents={p.windowCommissionCents} />, sort: (p) => p.windowCommissionCents },
        ]} />
    </Section>
  );
}

function CarriersView({ rows }: { rows: ReviewerCarrier[] }) {
  return (
    <Section title="Insurance carriers and wholesalers">
      <DataTable rows={rows} searchText={(c) => c.name} pageSize={50}
        columns={[
          { key: 'name', header: 'Name', render: (c) => c.name, sort: (c) => c.name },
          { key: 'kind', header: 'Kind', render: (c) => c.kind },
          { key: 'method', header: 'Commission paid', render: (c) => (c.commissionMethod === 'retained' ? 'Retained from premium' : 'By statement') },
          { key: 'status', header: 'Status', render: (c) => c.status },
        ]} />
    </Section>
  );
}

function TransactionsView({ rows }: { rows: ReviewerTransaction[] }) {
  return (
    <Section title={`Posted transactions in the reporting period (${rows.length})`}>
      <DataTable rows={rows} searchText={(t) => `${t.payer} ${t.client} ${t.policyNumber} ${t.category}`} pageSize={50}
        columns={[
          { key: 'period', header: 'Period', render: (t) => formatMonth(t.statementPeriod), sort: (t) => t.statementPeriod },
          { key: 'payer', header: 'Paid by', render: (t) => t.payer, sort: (t) => t.payer },
          { key: 'client', header: 'Client', render: (t) => t.client || '—' },
          { key: 'policy', header: 'Policy', render: (t) => t.policyNumber || '—' },
          { key: 'cat', header: 'Category', render: (t) => t.category },
          { key: 'amt', header: 'Amount', align: 'right', render: (t) => <Money cents={t.amountCents} />, sort: (t) => t.amountCents },
          { key: 'st', header: '', render: (t) => (t.isReversal ? <Badge tone="slate">Reversal</Badge> : t.postingStatus === 'reversed' ? <Badge tone="slate">Reversed</Badge> : null) },
        ]} />
    </Section>
  );
}
