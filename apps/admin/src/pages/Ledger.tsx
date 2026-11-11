import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import {
  filterLedger, formatBps, formatCents, formatMonth, groupPostings, inRange, isMonth, ledgerCsv, ledgerTotals, postingsCsv,
  type CsvVariant, type LedgerEntry, type LedgerFilter, type PostingGroup, type ReportEntry,
} from '@asm/shared';
import { db } from '../firebase';
import { useData } from '../data';
import { Badge, Button, Card, ErrorNote, Field, Money, PageHeader, Select, Stat, TextInput, cx } from '../ui';

/**
 * Ledger report (read-only). Reads posted ledger entries for a statement-month range and computes
 * every figure with the same shared functions as the Dashboard (ledgerTotals) and the dev audit.
 * Nothing on this page writes to Firestore; the ledger is write-protected by the security rules.
 */

type Raw = LedgerEntry & { postedAt?: { toDate?: () => Date } | null };

const toIso = (t: Raw['postedAt']) => (t?.toDate ? t.toDate().toISOString() : null);
const shortTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

function useLedgerRange(from: string, to: string) {
  const [state, setState] = useState<{ rows: ReportEntry[]; loaded: boolean; error: string | null }>({ rows: [], loaded: false, error: null });
  useEffect(() => {
    if (!isMonth(from) || !isMonth(to) || from > to) { setState({ rows: [], loaded: true, error: null }); return; }
    setState((s) => ({ ...s, loaded: false }));
    return onSnapshot(
      query(collection(db, 'ledger'), where('statementPeriod', '>=', from), where('statementPeriod', '<=', to)),
      (snap) => setState({
        rows: snap.docs.map((d) => { const r = { ...(d.data() as Raw), id: d.id }; return { ...r, postedAtIso: toIso(r.postedAt) } as ReportEntry; }),
        loaded: true, error: null,
      }),
      (err) => setState((s) => ({ ...s, loaded: true, error: err.message })),
    );
  }, [from, to]);
  return state;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stateBadge = (s: PostingGroup['state']) =>
  s === 'active' ? <Badge tone="green">Posted</Badge> : s === 'reversed' ? <Badge>Reversed · nets $0.00</Badge> : <Badge tone="red">Partly reversed</Badge>;

const PAGE = 300;

export function LedgerPage() {
  const { ready, revenue, carriers, brokers, carrierById, brokerById, policyById, legacyBroker } = useData();
  const [filter, setFilter] = useState<LedgerFilter>({ postingState: 'all', sourceType: 'all' });
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [tab, setTab] = useState<'postings' | 'transactions'>('postings');
  const [shown, setShown] = useState(PAGE);

  useEffect(() => {
    if (revenue && !from && !to) { setFrom(revenue.range.from); setTo(revenue.range.to); }
  }, [revenue, from, to]);

  const ledger = useLedgerRange(from, to);
  const company = (id: string | null | undefined) => (id ? carrierById.get(id)?.name ?? id : '');
  const brokerName = (id: string | null | undefined) => (id ? brokerById.get(id)?.name ?? id : '');

  const view = useMemo(() => {
    const all = ledger.rows;
    const rows = filterLedger(all, { ...filter, from, to }, legacyBroker);
    const postings = groupPostings(rows, legacyBroker);
    const rangeTotals = ledgerTotals(all.filter((e) => inRange(e, { from, to })), legacyBroker);
    return { rows, postings, totals: ledgerTotals(rows, legacyBroker), rangeTotals, statementIds: [...new Set(all.map((e) => e.statementId).filter((x): x is string => !!x))].sort() };
  }, [ledger.rows, filter, from, to, legacyBroker]);

  if (!ready) return <p className="text-sm text-slate-500">Loading…</p>;

  const isWindow = !!revenue && from === revenue.range.from && to === revenue.range.to;
  const ties = isWindow && revenue
    && view.rangeTotals.grossCents === revenue.total && view.rangeTotals.brokerCents === revenue.brokerShare && view.rangeTotals.agencyCents === revenue.agencyNet;
  const active = view.postings.filter((g) => g.state === 'active').length;
  const reversed = view.postings.filter((g) => g.state === 'reversed').length;
  const partial = view.postings.filter((g) => g.state === 'partially_reversed').length;
  const set = (patch: Partial<LedgerFilter>) => { setFilter((f) => ({ ...f, ...patch })); setShown(PAGE); };
  const lookups = { companyName: company, brokerName, policyNumber: (id: string | null | undefined) => (id ? policyById.get(id)?.policyNumber ?? '' : '') };
  const stamp = `${from}_to_${to}`;
  const exportTx = (v: CsvVariant) => download(`ledger-transactions-${v === 'accounting' ? 'accounting-INTERNAL' : 'due-diligence'}-${stamp}.csv`, ledgerCsv(view.rows, v, lookups, legacyBroker));
  const exportPostings = (v: CsvVariant) => download(`ledger-postings-${v === 'accounting' ? 'accounting-INTERNAL' : 'due-diligence'}-${stamp}.csv`, postingsCsv(view.postings, v, lookups));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Ledger"
        subtitle="Every posted commission transaction, read-only. Totals use the same posted entries and the same calculation as the Dashboard."
      />
      <ErrorNote message={ledger.error} />

      <Card title="Filters">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
          <Field label="From (statement month)"><TextInput type="month" value={from} onChange={(e) => { setFrom(e.target.value); setShown(PAGE); }} /></Field>
          <Field label="To (statement month)"><TextInput type="month" value={to} onChange={(e) => { setTo(e.target.value); setShown(PAGE); }} /></Field>
          <Field label="Carrier or wholesaler">
            <Select value={filter.companyId ?? ''} onChange={(e) => set({ companyId: e.target.value || null })} placeholder="All"
              options={[...carriers].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ value: c.id, label: `${c.name}${c.kind === 'wholesaler' ? ' (wholesaler)' : ''}` }))} />
          </Field>
          <Field label="Broker">
            <Select value={filter.brokerId ?? ''} onChange={(e) => set({ brokerId: e.target.value || null })} placeholder="All"
              options={[...brokers].sort((a, b) => a.name.localeCompare(b.name)).map((b) => ({ value: b.id, label: b.name }))} />
          </Field>
          <Field label="Statement">
            <Select value={filter.statementId ?? ''} onChange={(e) => set({ statementId: e.target.value || null })} placeholder="All"
              options={view.statementIds.map((id) => ({ value: id, label: id }))} />
          </Field>
          <Field label="Posting status">
            <Select value={filter.postingState ?? 'all'} onChange={(e) => set({ postingState: e.target.value as LedgerFilter['postingState'] })}
              options={[{ value: 'all', label: 'All' }, { value: 'active', label: 'Posted (active)' }, { value: 'reversed', label: 'Reversed' }]} />
          </Field>
          <Field label="Source">
            <Select value={filter.sourceType ?? 'all'} onChange={(e) => set({ sourceType: e.target.value as LedgerFilter['sourceType'] })}
              options={[{ value: 'all', label: 'All' }, { value: 'statement', label: 'Statements' }, { value: 'retained', label: 'Retained' }, { value: 'manual', label: 'Manual' }]} />
          </Field>
          <Field label="Search">
            <TextInput value={filter.search ?? ''} placeholder="Policy, insured, posting…" onChange={(e) => set({ search: e.target.value })} />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <Button size="sm" variant="ghost" onClick={() => { setFilter({ postingState: 'all', sourceType: 'all' }); if (revenue) { setFrom(revenue.range.from); setTo(revenue.range.to); } }}>Reset to snapshot window</Button>
          {revenue && <span>Snapshot window: {formatMonth(revenue.range.from)} – {formatMonth(revenue.range.to)}</span>}
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat tone="gold" label="Net commission" value={<Money cents={view.totals.grossCents} />} sub={`${view.totals.entries.toLocaleString()} ledger entries (reversals included)`} />
        <Stat label="Broker share (internal)" value={<Money cents={view.totals.brokerCents} />} sub="As allocated when posted" />
        <Stat label="Agency net (internal)" value={<Money cents={view.totals.agencyCents} />} sub="Gross minus broker share" />
        <Stat label="Postings" value={`${active} posted · ${reversed} reversed`} sub={partial ? <span className="text-red-700">{partial} partly reversed — check the audit</span> : 'Each reversed posting nets to $0.00'} />
      </div>

      {revenue && (
        <p className={cx('text-xs', !isWindow ? 'text-slate-500' : ties ? 'text-emerald-700' : 'text-red-700')}>
          {!isWindow
            ? 'Range differs from the snapshot window, so these totals are not expected to equal the Dashboard.'
            : ties
              ? `✓ Ties to the Dashboard: snapshot-window totals (gross ${formatCents(view.rangeTotals.grossCents)}, broker ${formatCents(view.rangeTotals.brokerCents)}, agency ${formatCents(view.rangeTotals.agencyCents)}) equal the Dashboard's trailing-12-month commission, broker share and agency net.`
              : '✗ The snapshot-window totals here differ from the Dashboard. Reload the page; if it persists, run the ledger audit.'}
          {isWindow && (filter.companyId || filter.brokerId || filter.statementId || filter.search || filter.postingState !== 'all' || filter.sourceType !== 'all') ? ' (Tie-out uses the whole window; the cards above reflect your filters.)' : ''}
        </p>
      )}

      <Card title="Export" >
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={!view.rows.length} onClick={() => exportTx('accounting')}>Transactions — accounting (internal)</Button>
          <Button size="sm" variant="secondary" disabled={!view.postings.length} onClick={() => exportPostings('accounting')}>Postings — accounting (internal)</Button>
          <Button size="sm" variant="secondary" disabled={!view.rows.length} onClick={() => exportTx('due_diligence')}>Transactions — due diligence</Button>
          <Button size="sm" variant="secondary" disabled={!view.postings.length} onClick={() => exportPostings('due_diligence')}>Postings — due diligence</Button>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          CSV of the filtered rows. Accounting exports include brokers, broker/agency splits and who posted; keep them internal.
          Due-diligence exports leave out all broker information, staff emails and notes. Every original entry is followed by its reversal, so column totals equal the net shown above.
        </p>
      </Card>

      <div className="flex gap-2 border-b border-slate-200">
        {(['postings', 'transactions'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={cx('-mb-px border-b-2 px-3 py-2 text-sm', tab === t ? 'border-ink font-semibold text-ink' : 'border-transparent text-slate-500 hover:text-slate-700')}>
            {t === 'postings' ? `Postings (${view.postings.length})` : `Transactions (${view.rows.length})`}
          </button>
        ))}
      </div>

      {!ledger.loaded ? <p className="text-sm text-slate-500">Loading ledger…</p> : tab === 'postings' ? (
        <Card>
          {view.postings.length === 0 ? <p className="text-sm text-slate-500">No postings match.</p> : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase text-slate-500">
                    <th className="py-1 pr-3">Posting</th><th className="pr-3">Month</th><th className="pr-3">Payer</th><th className="pr-3">Status</th>
                    <th className="pr-3 text-right">Entries</th><th className="pr-3 text-right">Posted</th><th className="pr-3 text-right">Reversed</th>
                    <th className="pr-3 text-right">Net</th><th className="pr-3 text-right">Net broker</th><th className="pr-3 text-right">Net agency</th><th>History</th>
                  </tr>
                </thead>
                <tbody>
                  {view.postings.map((g) => (
                    <tr key={g.key} className="border-t border-slate-100 align-top">
                      <td className="py-1.5 pr-3">
                        <div className="font-mono text-xs">{g.postingId ?? g.key}</div>
                        {g.statementId ? <Link to={`/statements/${g.statementId}`} className="text-xs text-ink hover:underline">Statement {g.statementId}</Link> : <span className="text-xs text-slate-500">{g.sourceType}</span>}
                      </td>
                      <td className="pr-3">{g.periods.map(formatMonth).join(', ')}</td>
                      <td className="pr-3">{g.payerIds.map(company).join(', ')}</td>
                      <td className="pr-3">{stateBadge(g.state)}</td>
                      <td className="pr-3 text-right">{g.original.entries}{g.reversal.entries ? ` + ${g.reversal.entries}` : ''}</td>
                      <td className="pr-3 text-right"><Money cents={g.original.grossCents} /></td>
                      <td className="pr-3 text-right">{g.reversal.entries ? <Money cents={g.reversal.grossCents} /> : '—'}</td>
                      <td className="pr-3 text-right font-semibold"><Money cents={g.net.grossCents} /></td>
                      <td className="pr-3 text-right"><Money cents={g.net.brokerCents} /></td>
                      <td className="pr-3 text-right"><Money cents={g.net.agencyCents} /></td>
                      <td className="text-xs text-slate-600">
                        <div>Posted {shortTime(g.postedAtIso)}{g.postedByEmail ? ` by ${g.postedByEmail}` : ''} · broker <Money cents={g.original.brokerCents} />, agency <Money cents={g.original.agencyCents} /></div>
                        {g.reversal.entries > 0 && <div>Reversed {shortTime(g.reversedAtIso)}{g.reversedByEmail ? ` by ${g.reversedByEmail}` : ''}{g.reversalReason ? ` — “${g.reversalReason}”` : ''}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-300 font-semibold">
                    <td className="py-1.5" colSpan={7}>Total ({view.postings.length} postings)</td>
                    <td className="pr-3 text-right"><Money cents={view.totals.grossCents} /></td>
                    <td className="pr-3 text-right"><Money cents={view.totals.brokerCents} /></td>
                    <td className="pr-3 text-right"><Money cents={view.totals.agencyCents} /></td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Card>
      ) : (
        <Card>
          {view.rows.length === 0 ? <p className="text-sm text-slate-500">No transactions match.</p> : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase text-slate-500">
                    <th className="py-1 pr-3">Month</th><th className="pr-3">Entry</th><th className="pr-3">Type</th><th className="pr-3">Policy / insured</th><th className="pr-3">Payer</th>
                    <th className="pr-3">Broker</th><th className="pr-3 text-right">Amount</th><th className="pr-3 text-right">Broker</th><th className="pr-3 text-right">Agency</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sortRows(view.rows).slice(0, shown).map((e) => (
                    <tr key={e.id} className={cx('border-t border-slate-100', e.reversalOf && 'bg-slate-50')}>
                      <td className="py-1 pr-3">{formatMonth(e.statementPeriod)}</td>
                      <td className="pr-3 font-mono text-[11px]">{e.id}</td>
                      <td className="pr-3">{e.reversalOf ? 'Reversal' : e.historical ? 'Past policy (suspense)' : e.level === 'suspense' ? 'Suspense' : e.level === 'carrier' ? 'Adjustment' : e.sourceType === 'retained' ? 'Retained' : 'Commission'}</td>
                      <td className="pr-3">{e.policyNumberRaw || (e.policyId ? policyById.get(e.policyId)?.policyNumber : '') || '—'}<div className="text-xs text-slate-500">{e.insuredName}</div></td>
                      <td className="pr-3">{company(e.payerId)}</td>
                      <td className="pr-3">{e.brokerId ? brokerName(e.brokerId) : '—'}{typeof e.brokerShareBps === 'number' ? <span className="text-xs text-slate-500"> {formatBps(e.brokerShareBps)}{e.brokerShareSource === 'policy' ? ' (policy)' : ''}</span> : null}</td>
                      <td className="pr-3 text-right"><Money cents={e.amountCents} /></td>
                      <td className="pr-3 text-right">{typeof e.brokerCents === 'number' ? <Money cents={e.brokerCents} /> : '—'}</td>
                      <td className="pr-3 text-right">{typeof e.agencyCents === 'number' ? <Money cents={e.agencyCents} /> : '—'}</td>
                      <td>{e.reversalOf ? <span className="text-xs text-slate-500">reverses {e.reversalOf.split('__').slice(-2).join('__')}</span> : e.postingStatus === 'reversed' ? <Badge>Reversed</Badge> : <Badge tone="green">Posted</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {view.rows.length > shown && <div className="mt-3"><Button size="sm" variant="secondary" onClick={() => setShown((n) => n + PAGE)}>Show more ({view.rows.length - shown} remaining)</Button></div>}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function sortRows(rows: ReportEntry[]): ReportEntry[] {
  return [...rows].sort((a, b) =>
    b.statementPeriod.localeCompare(a.statementPeriod) || (a.postingId ?? '').localeCompare(b.postingId ?? '')
    || (a.lineNo ?? 0) - (b.lineNo ?? 0) || (a.reversalOf ?? a.id).localeCompare(b.reversalOf ?? b.id) || (a.reversalOf ? 1 : 0) - (b.reversalOf ? 1 : 0));
}
