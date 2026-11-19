import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  formatMonth, pct, DILIGENCE_CATEGORY_LABELS,
  type ReviewerBook, type ReviewerCarrier, type ReviewerOverview, type ReviewerStatement, type ReviewerStatementDetail, type ReviewerTransaction, type ReviewerView, type ReviewerExport,
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
  { kind: 'statementLines', label: 'All statement lines & adjustments (CSV)' },
  { kind: 'book', label: 'Clients & policies, every status (CSV)' },
  { kind: 'transactions', label: 'Posted transactions (CSV)' },
];

type Payload = { organization: string; overview?: ReviewerOverview; statements?: ReviewerStatement[]; book?: ReviewerBook; carriers?: ReviewerCarrier[]; transactions?: ReviewerTransaction[]; settings?: { agencyName: string; snapshotStartMonth: string | null; snapshotMonths: number } };

const STATUS_TONE: Record<ReviewerStatement['status'], 'green' | 'blue' | 'amber' | 'red' | 'slate'> = {
  posted: 'green', approved_not_posted: 'blue', reconciled_not_posted: 'amber', disputed: 'red', not_yet_read: 'slate',
};
const STATUS_SHORT: Record<ReviewerStatement['status'], string> = {
  posted: 'Posted', approved_not_posted: 'Approved — not posted', reconciled_not_posted: 'Reconciled — not posted', disputed: 'Disputed', not_yet_read: 'Not yet read',
};

function saveBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const download = (name: string, text: string) => saveBlob(name, new Blob([text], { type: 'text/csv;charset=utf-8' }));
/** The original file's exact bytes (decoded from the response; never altered). */
function originalBlob(r: { base64: string; contentType: string }): Blob {
  const bin = atob(r.base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: r.contentType });
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
    try { const r = await api.getReviewerExport(kind); download(r.downloadName, r.csv); } catch (e) { setError(e instanceof Error ? e.message : 'Download failed'); } finally { setBusy(null); }
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

/** Personal Lines vs Commercial Lines — always shown as PRELIMINARY until the classification correction is reconciled. */
function LineBreakdownView({ l }: { l: NonNullable<ReviewerOverview['lines']> }) {
  const c = l.commission;
  const row = (label: string, n: number, total: number) => (
    <tr className="border-t border-slate-100"><td className="py-1">{label}</td><td className="text-right">{n.toLocaleString()}</td><td className="text-right text-slate-600">{pct(n, total)}</td></tr>
  );
  const money = (label: string, cents: number, bold = false) => (
    <tr className={cx('border-t', bold ? 'border-slate-300 font-semibold' : 'border-slate-100')}><td className="py-1">{label}</td><td className="text-right"><Money cents={cents} /></td><td className="text-right text-slate-600">{pct(cents, c.total)}</td></tr>
  );
  const head = <thead><tr className="text-left text-xs uppercase text-slate-500"><th /><th className="text-right">Personal</th><th className="text-right">Commercial</th><th className="text-right">Unclassified</th><th className="text-right">Not attributable</th><th className="text-right">Total</th></tr></thead>;
  const cells = (x: typeof c) => (<><td className="text-right"><Money cents={x.personal} /></td><td className="text-right"><Money cents={x.commercial} /></td><td className="text-right"><Money cents={x.unclassified} /></td><td className="text-right"><Money cents={x.notAttributable} /></td><td className="text-right font-medium"><Money cents={x.total} /></td></>);
  return (
    <div className="space-y-3 rounded border-2 border-amber-400 bg-amber-50/40 p-3">
      <div className="rounded border border-amber-300 bg-amber-100 p-2 text-sm text-amber-950">
        <div className="font-semibold">Personal Lines vs Commercial Lines — PRELIMINARY</div>
        <div className="text-xs">{l.notice}</div>
        {!l.tiesToSummaryTotal && <div className="mt-1 text-xs font-semibold text-red-700">These amounts do not tie to the posted commission total. Do not rely on this breakdown; contact the agency.</div>}
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Personal Lines commission (preliminary)" value={<Money cents={c.personal} />} sub={`${pct(c.personal, c.total)} of ${formatMonth(l.from)} – ${formatMonth(l.to)} posted`} />
        <Stat label="Commercial Lines commission (preliminary)" value={<Money cents={c.commercial} />} sub={`${pct(c.commercial, c.total)} of posted`} />
        <Stat label="Active policies: Personal / Commercial" value={`${l.activePolicies.personal.toLocaleString()} / ${l.activePolicies.commercial.toLocaleString()}`} sub={`of ${l.activePolicies.total.toLocaleString()} active (preliminary)`} />
        <Stat label="Clients: Personal / Commercial / Mixed" value={`${l.clients.personal.toLocaleString()} / ${l.clients.commercial.toLocaleString()} / ${l.clients.mixed.toLocaleString()}`} sub={`of ${l.clients.total.toLocaleString()} clients (preliminary)`} />
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <Section title="Clients (each counted once, by active policies)">
          <table className="min-w-full text-sm"><tbody>
            {row('Personal Lines', l.clients.personal, l.clients.total)}{row('Commercial Lines', l.clients.commercial, l.clients.total)}
            {row('Mixed (both lines)', l.clients.mixed, l.clients.total)}{row('Has an unclassified policy', l.clients.unclassified, l.clients.total)}
            {row('No active policies', l.clients.noActivePolicies, l.clients.total)}{row('Total clients', l.clients.total, l.clients.total)}
          </tbody></table>
        </Section>
        <Section title="Active policies">
          <table className="min-w-full text-sm"><tbody>
            {row('Personal Lines', l.activePolicies.personal, l.activePolicies.total)}{row('Commercial Lines', l.activePolicies.commercial, l.activePolicies.total)}
            {row('Unclassified', l.activePolicies.unclassified, l.activePolicies.total)}{row('Total active', l.activePolicies.total, l.activePolicies.total)}
            {row('All policies, every status', l.allPolicies.total, l.allPolicies.total)}
          </tbody></table>
        </Section>
        <Section title={`Posted commission ${formatMonth(l.from)} – ${formatMonth(l.to)} (rolling 12 months)`}>
          <table className="min-w-full text-sm"><tbody>
            {money('Personal Lines', c.personal)}{money('Commercial Lines', c.commercial)}{money('Policy unclassified', c.unclassified)}
            {money('Not attributable to a line (bonuses, profit sharing, adjustments, unmatched)', c.notAttributable)}{money('Total posted', c.total, true)}
          </tbody></table>
        </Section>
      </div>
      <Section title="Monthly posted commission by line">
        <table className="min-w-full text-sm">{head}<tbody>{l.byMonth.map((m) => <tr key={m.month} className="border-t border-slate-100"><td className="py-1">{formatMonth(m.month)}</td>{cells(m.cents)}</tr>)}</tbody></table>
      </Section>
      <Section title="By carrier and line">
        <table className="min-w-full text-sm">{head}<tbody>{l.byCarrier.map((x) => <tr key={x.name} className="border-t border-slate-100"><td className="py-1">{x.name}</td>{cells(x.cents)}</tr>)}</tbody></table>
      </Section>
      <div className="grid gap-3 lg:grid-cols-2">
        <Section title="Carrier bonuses and profit sharing (carrier-level, not attributed to a line)">
          <table className="min-w-full text-sm"><thead><tr className="text-left text-xs uppercase text-slate-500"><th>Carrier</th><th className="text-right">Bonus</th><th className="text-right">Profit sharing</th></tr></thead><tbody>
            {l.bonusProfitSharing.byCarrier.map((b) => <tr key={b.name} className="border-t border-slate-100"><td className="py-1">{b.name}</td><td className="text-right"><Money cents={b.bonusCents} /></td><td className="text-right"><Money cents={b.profitSharingCents} /></td></tr>)}
            <tr className="border-t border-slate-300 font-semibold"><td className="py-1">Total</td><td className="text-right"><Money cents={l.bonusProfitSharing.bonusCents} /></td><td className="text-right"><Money cents={l.bonusProfitSharing.profitSharingCents} /></td></tr>
          </tbody></table>
        </Section>
        <Section title="Cross-check: posted commission by carrier statement marking (independent of policy classification)">
          <table className="min-w-full text-sm"><tbody>
            {money('Personal Lines statements', l.byStatementMarking.personal)}{money('Commercial Lines statements', l.byStatementMarking.commercial)}
            {money('Other statements', l.byStatementMarking.other)}{money('Statements not marked', l.byStatementMarking.unmarked)}
            {money('Not from a statement (retained, manual)', l.byStatementMarking.notFromStatement)}{money('Total', l.byStatementMarking.total, true)}
          </tbody></table>
        </Section>
      </div>
    </div>
  );
}

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
      {o.lines && <LineBreakdownView l={o.lines} />}
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
  const [openId, setOpenId] = useState<string | null>(null);
  const toggle = (id: string) => setOpenId((cur) => (cur === id ? null : id));
  return (
    <div className="space-y-4">
      <Section title="Commission statements">
        <p className="mb-2 text-xs text-slate-600">Only <b>Posted</b> statements are included in the commission totals. Disputed statements do not reconcile to the carrier's printed total and are shown with both figures. Open a statement for its commission lines and the carrier's original document.</p>
        {/* A row click opens the statement (as on the internal Statements page); so does the Open button. */}
        <DataTable rows={rows} searchText={(r) => `${r.payer} ${r.statementMonth ?? ''} ${STATUS_SHORT[r.status]}`} pageSize={50}
          onRowClick={(r) => toggle(r.id)}
          columns={[
            { key: 'open', header: '', render: (r) => <Button size="sm" variant={openId === r.id ? 'primary' : 'secondary'} onClick={(e) => { e.stopPropagation(); toggle(r.id); }}>{openId === r.id ? 'Close' : 'Open'}</Button> },
            { key: 'month', header: 'Month', render: (r) => (r.statementMonth ? formatMonth(r.statementMonth) : '—'), sort: (r) => r.statementMonth ?? '' },
            { key: 'payer', header: 'Carrier / wholesaler', render: (r) => r.payer, sort: (r) => r.payer },
            { key: 'status', header: 'Status', render: (r) => <Badge tone={STATUS_TONE[r.status]}>{STATUS_SHORT[r.status]}</Badge>, sort: (r) => r.status },
            { key: 'carrier', header: 'Carrier printed total', align: 'right', render: (r) => <Money cents={r.carrierTotalCents} /> },
            { key: 'extracted', header: 'Extracted', align: 'right', render: (r) => <Money cents={r.extractedCents} /> },
            { key: 'posted', header: 'Posted', align: 'right', render: (r) => <Money cents={r.postedCents} /> },
          ]} />
      </Section>
      {openId && <StatementDetailView key={openId} statementId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function StatementDetailView({ statementId, onClose }: { statementId: string; onClose: () => void }) {
  const [d, setD] = useState<ReviewerStatementDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>('load');
  const [viewer, setViewer] = useState<string | null>(null);
  // The detail opens below the statement list: bring it into view, so opening never looks like nothing happened.
  const panel = useRef<HTMLDivElement | null>(null);
  useEffect(() => { panel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [statementId]);
  useEffect(() => {
    api.getReviewerData<{ statement: ReviewerStatementDetail }>('statement', statementId)
      .then((r) => setD(r.statement)).catch((e) => setError(e instanceof Error ? e.message : 'Could not load')).finally(() => setBusy(null));
    return () => { setViewer((u) => { if (u) URL.revokeObjectURL(u); return null; }); };
  }, [statementId]);
  const original = async (mode: 'view' | 'download') => {
    setError(null); setBusy(mode);
    try {
      const r = await api.getReviewerStatementFile(statementId);
      const blob = originalBlob(r);
      if (mode === 'download' || r.contentType !== 'application/pdf') saveBlob(r.downloadName, blob);
      else setViewer((u) => { if (u) URL.revokeObjectURL(u); return URL.createObjectURL(blob); });
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not open the original'); } finally { setBusy(null); }
  };
  const csv = async () => {
    setError(null); setBusy('csv');
    try { const r = await api.getReviewerExport('statement', statementId); download(r.downloadName, r.csv); } catch (e) { setError(e instanceof Error ? e.message : 'Download failed'); } finally { setBusy(null); }
  };
  const st = d?.statement;
  return (
    <div ref={panel} className="scroll-mt-4">
    <Card title={st ? `${st.payer} — ${st.statementMonth ? formatMonth(st.statementMonth) : 'undated'}` : 'Statement'}
      actions={<div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={!!busy || !st?.hasOriginal} title={st && !st.hasOriginal ? 'The original document was not stored for this statement.' : undefined} onClick={() => void original('view')}>{busy === 'view' ? 'Opening…' : 'View original'}</Button>
        <Button size="sm" variant="secondary" disabled={!!busy || !st?.hasOriginal} onClick={() => void original('download')}>{busy === 'download' ? 'Preparing…' : 'Download original'}</Button>
        <Button size="sm" variant="secondary" disabled={!!busy || !d} onClick={() => void csv()}>{busy === 'csv' ? 'Preparing…' : 'Statement detail (CSV)'}</Button>
        <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
      </div>}>
      <ErrorNote message={error} />
      {busy === 'load' && <p className="text-sm text-slate-500">Loading…</p>}
      {st && !st.hasOriginal && <p className="mb-2 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">The carrier's original document was not stored for this statement. Contact the agency for a copy.</p>}
      {viewer && <iframe title="Original statement" src={viewer} className="mb-3 h-[75vh] w-full rounded border border-slate-200" />}
      {d && st && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Badge tone={STATUS_TONE[st.status]}>{STATUS_SHORT[st.status]}</Badge>
            <span>Carrier printed total <b><Money cents={d.carrierPrinted.statementTotalCents} /></b></span>
            <span>Extracted <b><Money cents={st.extractedCents} /></b></span>
            <span>Posted <b><Money cents={st.postedCents} /></b></span>
            <span>{st.reconciled ? <Badge tone="green">Reconciles to carrier total</Badge> : <Badge tone="red">Does not reconcile</Badge>}</span>
          </div>
          {st.checks.length > 0 && (
            <table className="min-w-full text-sm"><thead><tr className="text-left text-xs uppercase text-slate-500"><th>Check</th><th className="text-right">Carrier printed</th><th className="text-right">Extracted</th><th className="text-right">Difference</th><th /></tr></thead><tbody>
              {st.checks.map((c, i) => <tr key={i} className="border-t border-slate-100"><td className="py-1">{c.label}</td><td className="text-right"><Money cents={c.carrierPrintedCents} /></td><td className="text-right"><Money cents={c.extractedCents} /></td><td className="text-right"><Money cents={c.differenceCents} /></td><td className="pl-2">{c.ok ? <Badge tone="green">OK</Badge> : <Badge tone="red">Differs</Badge>}</td></tr>)}
            </tbody></table>
          )}
          <DataTable rows={d.lines.map((l) => ({ ...l, id: String(l.lineNo) }))} searchText={(l) => `${l.insured} ${l.policyNumber} ${l.transactionCode} ${l.matchedClient ?? ''}`} pageSize={100}
            columns={[
              { key: 'n', header: 'Line', render: (l) => l.lineNo, sort: (l) => l.lineNo },
              { key: 'ins', header: 'Insured (as printed)', render: (l) => l.insured || '—', sort: (l) => l.insured },
              { key: 'pol', header: 'Policy', render: (l) => l.policyNumber || '—' },
              { key: 'code', header: 'Transaction', render: (l) => l.transactionCode || l.transactionType },
              { key: 'eff', header: 'Effective', render: (l) => l.effectiveDate ?? '—' },
              { key: 'pfc', header: 'Premium for commission', align: 'right', render: (l) => <Money cents={l.premiumForCommissionCents} /> },
              { key: 'tp', header: 'Transaction premium', align: 'right', render: (l) => <Money cents={l.transactionPremiumCents} /> },
              { key: 'rate', header: 'Rate', align: 'right', render: (l) => (l.rateBps === null ? '—' : `${(l.rateBps / 100).toFixed(2)}%`) },
              { key: 'comm', header: 'Commission', align: 'right', render: (l) => <Money cents={l.commissionCents} />, sort: (l) => l.commissionCents ?? 0 },
              { key: 'fee', header: 'Fee', align: 'right', render: (l) => <Money cents={l.feeCents} /> },
              { key: 'm', header: 'Matched policy', render: (l) => (l.matched ? `${l.matchedPolicyNumber ?? ''} · ${l.matchedClient ?? ''}` : <Badge tone="slate">Not matched</Badge>) },
            ]} />
          {d.adjustments.length > 0 && (
            <table className="min-w-full text-sm"><thead><tr className="text-left text-xs uppercase text-slate-500"><th>Adjustment</th><th>Kind</th><th className="text-right">Amount</th></tr></thead><tbody>
              {d.adjustments.map((a, i) => <tr key={i} className="border-t border-slate-100"><td className="py-1">{a.label}</td><td>{a.kind}</td><td className="text-right"><Money cents={a.amountCents} /></td></tr>)}
            </tbody></table>
          )}
          <p className="text-xs text-slate-600">{d.totals.lines} lines · commission <Money cents={d.totals.commissionCents} /> · adjustments <Money cents={d.totals.adjustmentsCents} /> · premium for commission <Money cents={d.totals.premiumForCommissionCents} />. Commission amounts are the full amounts paid by the carrier.</p>
        </div>
      )}
    </Card>
    </div>
  );
}

function BookView({ b }: { b: ReviewerBook }) {
  return (
    <Section title={`Policies (${b.policies.length}: ${Object.entries(b.policiesByStatus).map(([k, v]) => `${v} ${k}`).join(', ')}) · clients (${b.clients.length})`}>
      <DataTable rows={b.policies} searchText={(p) => `${p.client} ${p.policyNumber} ${p.carrier} ${p.policyType} ${p.statusLabel}`} pageSize={50}
        columns={[
          { key: 'client', header: 'Client', render: (p) => p.client, sort: (p) => p.client },
          { key: 'num', header: 'Policy', render: (p) => p.policyNumber, sort: (p) => p.policyNumber },
          { key: 'carrier', header: 'Carrier', render: (p) => p.carrier + (p.wholesaler ? ` (via ${p.wholesaler})` : ''), sort: (p) => p.carrier },
          { key: 'type', header: 'Type', render: (p) => p.policyType || p.line },
          { key: 'term', header: 'Term', render: (p) => `${p.effectiveDate ?? '—'} → ${p.expirationDate ?? '—'}` },
          { key: 'status', header: 'Status', render: (p) => <Badge tone={p.status === 'active' ? 'green' : p.status === 'pending' ? 'blue' : 'slate'}>{p.statusLabel}</Badge>, sort: (p) => p.status },
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
