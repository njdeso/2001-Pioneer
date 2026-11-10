import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { collection, onSnapshot } from 'firebase/firestore';
import {
  buildDiligenceSummary, clientPolicyExport, diligenceSummaryCsv, formatMonth,
  DILIGENCE_CATEGORIES, DILIGENCE_CATEGORY_LABELS,
  type DiligenceCarrier, type DiligenceCheck, type DiligenceClient, type DiligencePolicy, type DiligenceStatement, type ReportEntry,
} from '@asm/shared';
import { db } from '../firebase';
import { useData } from '../data';
import { Badge, Button, Card, ErrorNote, Money, PageHeader, Stat, cx } from '../ui';

/**
 * Buyer-facing due-diligence exports (read-only). Figures come from the posted ledger (the same
 * entries and calculation as the Dashboard and the Ledger report) and the client/policy records.
 * No broker or internal compensation information is included. Completeness is computed: the
 * summary is stamped PRELIMINARY unless every month and carrier has posted statements.
 */

function useStatements() {
  const [state, setState] = useState<{ rows: DiligenceStatement[]; loaded: boolean; error: string | null }>({ rows: [], loaded: false, error: null });
  useEffect(() => onSnapshot(collection(db, 'statements'),
    (snap) => setState({ rows: snap.docs.map((d) => { const x = d.data(); return { id: d.id, status: String(x.status ?? ''), statementMonth: (x.statementMonth as string) ?? null, payerId: (x.payerId as string) ?? null }; }), loaded: true, error: null }),
    (err) => setState((s) => ({ ...s, loaded: true, error: err.message }))), []);
  return state;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const tone = { READY: 'border-emerald-300 bg-emerald-50 text-emerald-900', REVIEW: 'border-amber-300 bg-amber-50 text-amber-900', INCOMPLETE: 'border-amber-300 bg-amber-50 text-amber-900', CHECKS_FAILED: 'border-red-300 bg-red-50 text-red-900', NO_PERIOD: 'border-red-300 bg-red-50 text-red-900' } as const;

function Checks({ checks }: { checks: DiligenceCheck[] }) {
  return (
    <table className="min-w-full text-sm">
      <tbody>
        {checks.map((c) => (
          <tr key={c.name} className="border-t border-slate-100 align-top">
            <td className="py-1 pr-3">{c.pass ? <Badge tone="green">PASS</Badge> : <Badge tone="red">FAIL</Badge>}</td>
            <td className="py-1 pr-3">{c.name}</td>
            <td className="py-1 text-xs text-slate-500">{c.detail}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function DueDiligencePage() {
  const { ready, settings, revenue, carriers, clients, policies } = useData();
  const statements = useStatements();

  const view = useMemo(() => {
    if (!settings) return null;
    const entries = (revenue?.entries ?? []) as ReportEntry[];
    const summary = buildDiligenceSummary({
      entries, start: settings.snapshotStartMonth, months: settings.snapshotMonths,
      carriers: carriers as unknown as DiligenceCarrier[], policies: policies as unknown as DiligencePolicy[], statements: statements.rows,
    });
    const cp = clientPolicyExport({
      clients: clients as unknown as DiligenceClient[], policies: policies as unknown as DiligencePolicy[], carriers: carriers as unknown as DiligenceCarrier[],
      entries, start: settings.snapshotStartMonth, months: settings.snapshotMonths, policyAttributedCents: summary.policyAttributedCents,
    });
    return { summary, cp };
  }, [settings, revenue, carriers, clients, policies, statements.rows]);

  if (!ready || !statements.loaded) return <p className="text-sm text-slate-500">Loading…</p>;
  if (!view) return <p className="text-sm text-slate-500">Set the snapshot window in Settings first.</p>;
  const { summary: s, cp } = view;
  const agency = settings?.agencyName ?? 'Agency';
  const period = `${s.from}_to_${s.to}`;
  const stamp = s.status === 'READY' ? '' : '-PRELIMINARY';
  const summaryBlocked = s.status === 'CHECKS_FAILED' || s.status === 'NO_PERIOD';
  const cpBlocked = cp.checks.some((c) => !c.pass);
  const covered = s.byMonth.filter((m) => m.hasPostedStatement).length;

  return (
    <div className="space-y-6">
      <PageHeader title="Due Diligence Package"
        subtitle="Buyer-facing exports from the posted ledger and the client and policy records. No broker or internal compensation information is included." />
      <ErrorNote message={statements.error} />

      <p className="text-sm text-slate-600">
        Reporting period: <b>{formatMonth(s.from)} – {formatMonth(s.to)}</b> (statement months), the saved snapshot window in <Link to="/settings" className="text-ink underline">Settings</Link>.
        Entries outside this period are not included.
      </p>
      <div className={cx('rounded-lg border p-4', tone[s.status])}>
        <div className="text-sm font-semibold">{s.statusLabel}</div>
        <p className="mt-1 text-sm">{s.statusText}</p>
        {s.notices.length > 0 && <ul className="mt-2 list-disc pl-5 text-xs">{s.notices.map((n) => <li key={n}>{n}</li>)}</ul>}
        {s.status !== 'READY' && <p className="mt-2 text-xs">Exported files carry this status at the top. Do not describe them as a complete 12-month history.</p>}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat tone="gold" label={`Commission, ${formatMonth(s.from)} – ${formatMonth(s.to)}`} value={<Money cents={s.total.total} />} sub={s.status === 'READY' ? 'Posted ledger' : 'Posted so far — not complete'} />
        <Stat label="Months with posted statements" value={`${covered} of ${s.months.length}`} sub={s.missingMonths.length ? `${s.missingMonths.length} missing` : 'All months'} />
        <Stat label="Paying carriers / wholesalers" value={s.byPayer.length} sub={s.carrierGaps.length ? `${s.carrierGaps.length} with month gaps` : 'No gaps found'} />
        <Stat label="Clients / policies exported" value={`${clients.length} / ${cp.policyRows}`} sub={`${cp.clientsWithoutPolicies} clients without policies`} />
      </div>

      <Card title="Downloads (CSV for Excel)">
        <div className="flex flex-wrap gap-2">
          <Button disabled={summaryBlocked} onClick={() => download(`${agency.replace(/[^A-Za-z0-9]+/g, '-')}-commission-summary${stamp}-${period}.csv`, diligenceSummaryCsv(s, { agencyName: agency, preparedAtIso: new Date().toISOString() }))}>
            Commission summary{stamp ? ' (preliminary)' : ''}
          </Button>
          <Button variant="secondary" disabled={cpBlocked} onClick={() => download(`${agency.replace(/[^A-Za-z0-9]+/g, '-')}-clients-and-policies-${new Date().toISOString().slice(0, 10)}.csv`, cp.csv)}>
            Clients &amp; policies
          </Button>
        </div>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-slate-600">
          <li><b>Commission summary:</b> status and reconciliation checks, totals by category (matched commission, unmatched commission, statement adjustments, retained commission), monthly totals, totals by paying carrier or wholesaler, a carrier × month grid and totals by underlying insurance carrier.</li>
          <li><b>Clients &amp; policies:</b> one row per policy (insured, carrier, wholesaler, line, type, number, effective and expiration dates, status, premium, agency commission rate, posted commission in the period), plus clients without policies. No broker, contact details, notes or staff information.</li>
          <li>Transaction detail for the buyer: <Link to="/ledger" className="text-ink underline">Ledger</Link> → <i>Transactions — due diligence</i>.</li>
          {summaryBlocked && <li className="text-red-700">The summary download is disabled until every reconciliation check passes.</li>}
          {cpBlocked && <li className="text-red-700">The client &amp; policy download is disabled until its checks pass.</li>}
        </ul>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Reconciliation checks — commission summary"><Checks checks={s.checks} /></Card>
        <Card title="Reconciliation checks — clients & policies"><Checks checks={cp.checks} /></Card>
      </div>

      <Card title="Monthly commission (statement month)">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead><tr className="text-left text-xs uppercase text-slate-500">
              <th className="py-1 pr-3">Month</th>{DILIGENCE_CATEGORIES.map((c) => <th key={c} className="pr-3 text-right">{DILIGENCE_CATEGORY_LABELS[c]}</th>)}<th className="pr-3 text-right">Total</th><th>Posted statements</th>
            </tr></thead>
            <tbody>
              {s.byMonth.map((m) => (
                <tr key={m.month} className="border-t border-slate-100">
                  <td className="py-1 pr-3">{formatMonth(m.month)}</td>
                  {DILIGENCE_CATEGORIES.map((c) => <td key={c} className="pr-3 text-right"><Money cents={m.totals[c]} /></td>)}
                  <td className="pr-3 text-right font-semibold"><Money cents={m.totals.total} /></td>
                  <td>{m.hasPostedStatement ? <Badge tone="green">{m.statementPostings}</Badge> : <Badge tone="amber">Missing</Badge>}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr className="border-t-2 border-slate-300 font-semibold">
              <td className="py-1">Total</td>{DILIGENCE_CATEGORIES.map((c) => <td key={c} className="pr-3 text-right"><Money cents={s.total[c]} /></td>)}<td className="pr-3 text-right"><Money cents={s.total.total} /></td><td />
            </tr></tfoot>
          </table>
        </div>
      </Card>

      <Card title="By paying carrier or wholesaler">
        {s.byPayer.length === 0 ? <p className="text-sm text-slate-500">Nothing posted in the period yet.</p> : (
          <table className="min-w-full text-sm">
            <thead><tr className="text-left text-xs uppercase text-slate-500"><th className="py-1 pr-3">Paid by</th><th className="pr-3 text-right">Total</th><th>Months with posted statements</th></tr></thead>
            <tbody>{s.byPayer.map((p) => (
              <tr key={p.id} className="border-t border-slate-100"><td className="py-1 pr-3">{p.name}{p.kind === 'wholesaler' ? <span className="text-xs text-slate-500"> (wholesaler)</span> : null}</td><td className="pr-3 text-right"><Money cents={p.totals.total} /></td><td>{p.monthsWithPostings} of {s.months.length}</td></tr>
            ))}</tbody>
          </table>
        )}
        {s.carrierGaps.length > 0 && <p className="mt-3 text-xs text-amber-800">Carriers with active policies and months with nothing posted: {s.carrierGaps.map((g) => `${g.name} (${g.missingMonths.map(formatMonth).join(', ')})`).join('; ')}.</p>}
      </Card>

      <p className="text-xs text-slate-500">Still to come (Phase 5): locking the snapshot and a formatted PDF/Excel package with statement copies.</p>
    </div>
  );
}
