import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { collection, doc, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { ref as storageRef, uploadBytesResumable } from 'firebase/storage';
import {
  formatBps, formatMonth, TRANSACTION_TYPE_LABELS,
  type Cents, type LineIssue, type ReconciliationResult, type StatedTotals, type StatementAdjustment,
} from '@asm/shared';
import { db, storage } from '../firebase';
import { api } from '../api';
import { useData } from '../data';
import { Badge, Button, Card, DataTable, Empty, ErrorNote, Field, Modal, Money, PageHeader, Select, Stat, TextArea, cx, type Column } from '../ui';
import { BrokerCell, MatchBadge, MatchDialog, MatchedTo, MatchingPanel, lineMatch, matchFilterFn, type MatchFilter, type MatchingInfo, type MatchLine } from './StatementMatching';

// ---------------------------------------------------------------------------
// Shared

const MAX_BYTES = 20 * 1024 * 1024;
const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
};

interface StatementDoc {
  id: string;
  status: 'awaiting_upload' | 'processing' | 'needs_review' | 'discrepancy' | 'extraction_failed' | 'discarded';
  fileName: string;
  fileType: 'pdf' | 'xlsx' | 'csv';
  size: number;
  method?: string;
  carrierName?: string;
  agencyCode?: string | null;
  officeCode?: string | null;
  statementMonth?: string | null;
  statementDate?: string | null;
  pageCount?: number | null;
  payerId?: string | null;
  payerNote?: string;
  possibleDuplicateOf?: string | null;
  stated?: StatedTotals;
  adjustments?: StatementAdjustment[];
  statementIssues?: LineIssue[];
  reconciliation?: ReconciliationResult;
  reconciled?: boolean;
  statementTotalCents?: Cents | null;
  extractedCommissionCents?: Cents;
  postedCents?: Cents;
  pendingCents?: Cents;
  failure?: { code: string; message: string; httpStatus?: number; errorType?: string | null; requestId?: string | null } | null;
  discardReason?: string;
  matching?: MatchingInfo | null;
  createdAt?: { toDate?: () => Date };
}

type LineDoc = MatchLine;

const STATUS: Record<StatementDoc['status'], { label: string; tone: 'slate' | 'green' | 'amber' | 'red' | 'blue' }> = {
  awaiting_upload: { label: 'Awaiting upload', tone: 'slate' },
  processing: { label: 'Processing', tone: 'blue' },
  needs_review: { label: 'Reconciled — review', tone: 'green' },
  discrepancy: { label: 'Discrepancy', tone: 'red' },
  extraction_failed: { label: 'Processing failed', tone: 'red' },
  discarded: { label: 'Discarded', tone: 'slate' },
};

const METHOD: Record<string, string> = { 'travelers-pl-v1': 'Parsed (Travelers)', ai: 'AI (PDF)', 'table-ai': 'AI (spreadsheet)' };

export function StatusBadge({ status }: { status: StatementDoc['status'] }) {
  const s = STATUS[status] ?? { label: status, tone: 'slate' as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

async function sha256(buf: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function useStatements() {
  const [rows, setRows] = useState<StatementDoc[]>([]);
  useEffect(() => onSnapshot(query(collection(db, 'statements'), orderBy('createdAt', 'desc'), limit(300)),
    (s) => setRows(s.docs.map((d) => ({ id: d.id, ...d.data() }) as StatementDoc))), []);
  return rows;
}

// ---------------------------------------------------------------------------
// Upload

interface UploadItem {
  key: string;
  file: File;
  state: 'hashing' | 'registering' | 'uploading' | 'processing' | 'done' | 'duplicate' | 'error';
  progress: number;
  statementId?: string;
  message?: string;
}

export function StatementUploadPage() {
  const [items, setItems] = useState<UploadItem[]>([]);
  const update = (key: string, patch: Partial<UploadItem>) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  async function handle(file: File) {
    const key = `${file.name}-${file.size}-${Date.now()}-${Math.random()}`;
    setItems((xs) => [{ key, file, state: 'hashing', progress: 0 }, ...xs]);
    const ext = file.name.toLowerCase().split('.').pop() ?? '';
    const type = ext === 'xlsm' ? 'xlsx' : ext;
    if (!CONTENT_TYPES[type]) return update(key, { state: 'error', message: 'Only PDF, Excel (.xlsx) and CSV files are accepted.' });
    if (file.size > MAX_BYTES) return update(key, { state: 'error', message: 'Files are limited to 20 MB.' });
    try {
      const hash = await sha256(await file.arrayBuffer());
      update(key, { state: 'registering' });
      const reg = await api.registerStatementUpload(file.name, hash, file.size);
      if (reg.duplicate) {
        return update(key, { state: 'duplicate', statementId: reg.statementId, message: 'This exact file was already uploaded.' });
      }
      update(key, { state: 'uploading', statementId: reg.statementId, message: reg.resumed ? 'Completing an earlier upload of this file that never reached storage.' : undefined });
      await new Promise<void>((resolve, reject) => {
        const task = uploadBytesResumable(storageRef(storage, reg.uploadPath), file, { contentType: CONTENT_TYPES[type] });
        task.on('state_changed', (snap) => update(key, { progress: Math.round((snap.bytesTransferred / snap.totalBytes) * 100) }), reject, () => resolve());
      });
      update(key, { state: 'processing', progress: 100 });
      const res = await api.processStatement(reg.statementId);
      update(key, {
        state: res.status === 'extraction_failed' ? 'error' : 'done',
        message: res.status === 'extraction_failed' ? res.failure?.message
          : res.reconciled ? `Reconciled exactly — ${res.lines} lines ready for review.`
            : `Extracted ${res.lines} lines, but totals do not reconcile. Review the discrepancy.`,
      });
    } catch (e) {
      update(key, { state: 'error', message: e instanceof Error ? e.message : 'Upload failed.' });
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Upload Commission Statements" subtitle="PDF, Excel or CSV statements from carriers and wholesalers. Nothing is posted from this screen." />
      <Card>
        <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-300 px-6 py-14 text-center hover:border-ink"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); [...e.dataTransfer.files].forEach((f) => void handle(f)); }}>
          <span className="text-sm font-medium text-ink">Drop statements here, or click to choose</span>
          <span className="mt-1 text-xs text-slate-500">PDF · XLSX · CSV · up to 20 MB each · duplicate files are detected by fingerprint</span>
          <input type="file" multiple accept=".pdf,.xlsx,.xlsm,.csv" className="hidden" onChange={(e) => { [...(e.target.files ?? [])].forEach((f) => void handle(f)); e.target.value = ''; }} />
        </label>
      </Card>
      {items.length > 0 && (
        <Card title="This session">
          <ul className="divide-y divide-slate-100 text-sm">
            {items.map((it) => (
              <li key={it.key} className="flex flex-wrap items-center gap-3 py-2">
                <span className="min-w-0 flex-1 truncate font-medium">{it.file.name}</span>
                <span className="text-xs text-slate-500">
                  {it.state === 'uploading' ? `Uploading ${it.progress}%` : it.state === 'processing' ? 'Reading and reconciling…' : it.state === 'hashing' ? 'Fingerprinting…' : it.state === 'registering' ? 'Checking for duplicates…' : ''}
                </span>
                {it.state === 'done' && <Badge tone="green">Done</Badge>}
                {it.state === 'duplicate' && <Badge tone="amber">Duplicate</Badge>}
                {it.state === 'error' && <Badge tone="red">Problem</Badge>}
                {it.message && <span className={cx('w-full text-xs', it.state === 'error' ? 'text-red-700' : 'text-slate-600')}>{it.message}</span>}
                {it.statementId && ['done', 'duplicate', 'error'].includes(it.state) && (
                  <Link to={`/statements/${it.statementId}`} className="text-xs text-ink underline">Open statement</Link>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Queue

export function StatementQueuePage() {
  const rows = useStatements();
  const { carrierById } = useData();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDiscarded, setShowDiscarded] = useState(false);

  async function run(id: string, method: 'auto' | 'ai') {
    setBusy(id); setError(null);
    try { await api.processStatement(id, method); } catch (e) { setError(e instanceof Error ? e.message : 'Processing failed'); } finally { setBusy(null); }
  }

  const visible = rows.filter((r) => showDiscarded || r.status !== 'discarded');
  const columns: Column<StatementDoc>[] = [
    { key: 'when', header: 'Uploaded', render: (r) => r.createdAt?.toDate?.().toLocaleDateString() ?? '', sort: (r) => r.createdAt?.toDate?.().getTime() ?? 0 },
    { key: 'file', header: 'File', render: (r) => <span className="font-medium text-ink">{r.fileName}</span>, sort: (r) => r.fileName },
    { key: 'carrier', header: 'Carrier', render: (r) => (r.payerId ? carrierById.get(r.payerId)?.name : r.carrierName ? <span className="text-amber-800">{r.carrierName} (not set up)</span> : '—') ?? '—' },
    { key: 'month', header: 'Month', render: (r) => (r.statementMonth ? formatMonth(r.statementMonth) : '—'), sort: (r) => r.statementMonth ?? '' },
    { key: 'method', header: 'Method', render: (r) => (r.method ? METHOD[r.method] ?? r.method : '—') },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} />, sort: (r) => r.status },
    { key: 'stated', header: 'Carrier total', align: 'right', render: (r) => <Money cents={r.statementTotalCents ?? null} /> },
    { key: 'extracted', header: 'Extracted', align: 'right', render: (r) => <Money cents={r.reconciliation ? r.reconciliation.totals.commissionCents + r.reconciliation.totals.adjustmentsCents : null} /> },
    {
      key: 'actions', header: '', align: 'right',
      render: (r) => (
        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          {['awaiting_upload', 'extraction_failed'].includes(r.status) && (
            <Button size="sm" disabled={!!busy} onClick={() => void run(r.id, 'auto')}>{busy === r.id ? 'Working…' : r.status === 'awaiting_upload' ? 'Process' : 'Retry'}</Button>
          )}
          {['extraction_failed', 'discrepancy', 'needs_review'].includes(r.status) && (
            <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void run(r.id, 'ai')}>Re-read with AI</Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="AI Processing Queue" subtitle="Every uploaded statement, how it was read, and whether it reconciles to the carrier's totals."
        actions={<Link to="/statements"><Button>Upload statements</Button></Link>} />
      <ErrorNote message={error} />
      <label className="flex items-center gap-2 text-xs text-slate-600">
        <input type="checkbox" checked={showDiscarded} onChange={(e) => setShowDiscarded(e.target.checked)} /> Show discarded
      </label>
      <Card>
        <DataTable rows={visible} columns={columns} onRowClick={(r) => navigate(`/statements/${r.id}`)} searchText={(r) => `${r.fileName} ${r.carrierName ?? ''} ${r.statementMonth ?? ''}`}
          empty="No statements uploaded yet." />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Review

type LineTab = 'all' | 'commission' | 'payment_only' | 'negative' | 'issues';

export function StatementReviewPage() {
  const { id } = useParams();
  const { carriers, carrierById, brokers, clientById, policyById } = useData();
  const [stmt, setStmt] = useState<StatementDoc | null | undefined>(undefined);
  const [lines, setLines] = useState<LineDoc[]>([]);
  const [tab, setTab] = useState<LineTab>('all');
  const [matchFilter, setMatchFilter] = useState<MatchFilter>('any');
  const [brokerFilter, setBrokerFilter] = useState('');
  const [matching, setMatching] = useState<LineDoc | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [payer, setPayer] = useState('');
  const [discarding, setDiscarding] = useState(false);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!id) return;
    const u1 = onSnapshot(doc(db, 'statements', id), (s) => setStmt(s.exists() ? ({ id: s.id, ...s.data() } as StatementDoc) : null));
    const u2 = onSnapshot(query(collection(db, 'statements', id, 'lines'), orderBy('lineNo')),
      (s) => setLines(s.docs.map((d) => ({ id: d.id, ...d.data() }) as LineDoc)));
    return () => { u1(); u2(); };
  }, [id]);

  const byMatch = useMemo(() => matchFilterFn(matchFilter), [matchFilter]);
  const filtered = useMemo(() => lines.filter((l) => {
    if (!byMatch(l)) return false;
    if (brokerFilter && lineMatch(l)?.brokerId !== brokerFilter) return false;
    switch (tab) {
      case 'commission': return l.kind === 'commission';
      case 'payment_only': return l.kind === 'payment_only';
      case 'negative': return (l.paidCommissionCents ?? 0) < 0;
      case 'issues': return l.issues?.length > 0;
      default: return true;
    }
  }), [lines, tab, byMatch, brokerFilter]);

  if (stmt === undefined) return <p className="text-sm text-slate-500">Loading…</p>;
  if (stmt === null) return <Empty title="Statement not found"><Link to="/queue" className="text-ink underline">Back to the queue</Link></Empty>;

  const rec = stmt.reconciliation;
  const t = rec?.totals;
  const canMatch = ['needs_review', 'discrepancy'].includes(stmt.status) && (stmt.postedCents ?? 0) === 0;
  const matchCounts = {
    matched: lines.filter(matchFilterFn('matched')).length, ambiguous: lines.filter(matchFilterFn('ambiguous')).length,
    unmatched: lines.filter(matchFilterFn('unmatched')).length, manual: lines.filter(matchFilterFn('manual')).length, not_run: lines.filter(matchFilterFn('not_run')).length,
  };
  const issuesCount = lines.filter((l) => l.issues?.length).length;

  async function act(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'Action failed'); } finally { setBusy(false); }
  }
  async function openOriginal() {
    await act(async () => {
      const { url } = await api.getStatementFileUrl(stmt!.id);
      if (stmt!.fileType === 'pdf') setFileUrl(url);
      else window.open(url, '_blank', 'noopener');
    });
  }

  const columns: Column<LineDoc>[] = [
    { key: 'n', header: '#', render: (l) => l.lineNo, sort: (l) => l.lineNo },
    { key: 'page', header: 'Pg', render: (l) => l.page ?? '—' },
    { key: 'insured', header: 'Insured', render: (l) => l.insuredName, sort: (l) => l.insuredName },
    { key: 'policy', header: 'Policy # (as printed)', render: (l) => <span className="font-mono text-xs">{l.policyNumberRaw}</span>, sort: (l) => l.policyNumberNormalized },
    { key: 'type', header: 'Type', render: (l) => TRANSACTION_TYPE_LABELS[l.transactionType] ?? l.transactionType, sort: (l) => l.transactionType },
    { key: 'eff', header: 'Eff. date', render: (l) => l.effectiveDate ?? (l.transactionCodeRaw || '—') },
    { key: 'payment', header: 'Payment rec’d', align: 'right', render: (l) => <Money cents={l.paymentReceivedCents} className="text-slate-500" /> },
    { key: 'paid', header: 'Paid commission', align: 'right', render: (l) => <Money cents={l.paidCommissionCents} className="font-semibold" />, sort: (l) => l.paidCommissionCents ?? 0 },
    { key: 'rate', header: 'Rate', align: 'right', render: (l) => (l.rateBps != null ? formatBps(l.rateBps) : '—') },
    { key: 'term', header: 'Term comm. (ref)', align: 'right', render: (l) => <Money cents={l.termCommissionCents} className="text-slate-500" /> },
    { key: 'prem', header: 'Prem. for comm.', align: 'right', render: (l) => <Money cents={l.premiumForCommissionCents} /> },
    { key: 'txn', header: 'Txn premium', align: 'right', render: (l) => <Money cents={l.transactionPremiumCents} /> },
    { key: 'match', header: 'Match', render: (l) => <MatchBadge m={lineMatch(l)} />, sort: (l) => lineMatch(l)?.status ?? 'zz' },
    { key: 'matchedTo', header: 'Matched to', className: 'whitespace-normal min-w-[12rem]', render: (l) => <MatchedTo m={lineMatch(l)} /> },
    { key: 'broker', header: 'Broker', render: (l) => <BrokerCell m={lineMatch(l)} /> },
    { key: 'brokerCents', header: 'Broker comm.', align: 'right', render: (l) => { const m = lineMatch(l); return m?.policyId ? <Money cents={m.brokerCents} /> : '—'; } },
    { key: 'agencyCents', header: 'Agency comm.', align: 'right', render: (l) => { const m = lineMatch(l); return m?.policyId ? <Money cents={m.agencyCents} /> : '—'; } },
    {
      key: 'act', header: '',
      render: (l) => canMatch && stmt.payerId ? <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); setMatching(l); }}>{lineMatch(l)?.status === 'matched' ? 'Review' : 'Match…'}</Button> : null,
    },
    {
      key: 'issues', header: 'Checks', className: 'whitespace-normal max-w-xs',
      render: (l) => l.issues?.length
        ? <div className="space-y-0.5 text-xs">{l.issues.map((i, k) => <div key={k} className={i.level === 'error' ? 'text-red-700' : 'text-amber-800'}>{i.text}</div>)}</div>
        : <span className="text-xs text-emerald-700">✓</span>,
    },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title={stmt.payerId ? `${carrierById.get(stmt.payerId)?.name ?? stmt.carrierName} — ${stmt.statementMonth ? formatMonth(stmt.statementMonth) : ''}` : stmt.fileName}
        subtitle={<span className="flex flex-wrap items-center gap-2">
          <StatusBadge status={stmt.status} /> {stmt.fileName} · {stmt.method ? METHOD[stmt.method] ?? stmt.method : 'not read yet'}
          {stmt.agencyCode && <> · agency code {stmt.agencyCode}</>}{stmt.statementDate && <> · dated {stmt.statementDate}</>}{stmt.pageCount ? <> · {stmt.pageCount} pages</> : null}
        </span>}
        actions={<>
          <Button variant="secondary" disabled={busy || !['needs_review', 'discrepancy', 'extraction_failed'].includes(stmt.status)} onClick={() => void openOriginal()}>View original</Button>
          {stmt.status !== 'discarded' && stmt.status !== 'processing' && <Button variant="ghost" onClick={() => setDiscarding(true)}>Discard…</Button>}
        </>}
      />
      <ErrorNote message={error} />

      {stmt.status === 'extraction_failed' && stmt.failure && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <b>Processing failed:</b> {stmt.failure.message}
          {(stmt.failure.httpStatus || stmt.failure.requestId) && (
            <div className="mt-1 font-mono text-xs text-red-700">
              {stmt.failure.code}{stmt.failure.httpStatus ? ` · HTTP ${stmt.failure.httpStatus}` : ''}{stmt.failure.errorType ? ` · ${stmt.failure.errorType}` : ''}{stmt.failure.requestId ? ` · ${stmt.failure.requestId}` : ''}
            </div>
          )}
          {stmt.failure.code.startsWith('ai_') && <div className="mt-1 text-xs">Use <Link className="underline" to="/settings">Settings → Test AI connection</Link> to check the key and model before retrying.</div>}
          <div className="mt-2 flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void act(() => api.processStatement(stmt.id, 'auto'))}>Retry</Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act(() => api.processStatement(stmt.id, 'ai'))}>Retry with AI</Button>
          </div>
        </div>
      )}
      {stmt.status === 'discarded' && <div className="rounded-md bg-slate-100 px-4 py-2 text-sm text-slate-700">Discarded: {stmt.discardReason}. The original file and extracted lines are preserved.</div>}
      {stmt.possibleDuplicateOf && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          Another file for the same carrier, agency code and month is already loaded (<Link className="underline" to={`/statements/${stmt.possibleDuplicateOf}`}>open it</Link>).
          If this is a revised statement, keep both for now; the revision workflow arrives in Stage 3E.
        </div>
      )}
      {['needs_review', 'discrepancy'].includes(stmt.status) && !stmt.payerId && (
        <Card title="Which carrier is this statement from?">
          <p className="mb-3 text-sm text-slate-600">{stmt.payerNote}</p>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Carrier / wholesaler">
              <Select value={payer} onChange={(e) => setPayer(e.target.value)} placeholder="Choose…" options={carriers.map((c) => ({ value: c.id, label: c.name }))} className="w-64" />
            </Field>
            <Button disabled={busy || !payer} onClick={() => void act(() => api.setStatementPayer(stmt.id, payer))}>Save</Button>
            <Link to="/carriers" className="text-xs text-ink underline">Add a carrier</Link>
          </div>
        </Card>
      )}

      {rec && t && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Stat tone="gold" label="Carrier statement total" value={<Money cents={stmt.statementTotalCents ?? null} />} sub="Monthly commission payable" />
            <Stat label="Extracted commission" value={<Money cents={t.commissionCents + t.adjustmentsCents} />} sub={rec.reconciled ? 'Matches to the cent' : 'Does not match'} />
            <Stat label="Posted" value={<Money cents={stmt.postedCents ?? 0} />} sub="Posting arrives in Stage 3C" />
            <Stat label="Pending" value={<Money cents={stmt.pendingCents ?? 0} />} sub="Not in revenue until approved" />
            <Stat label="Lines" value={t.lineCount} sub={`${t.commissionLineCount} commission · ${t.paymentOnlyLineCount} payment-only · ${t.negativeLineCount} negative`} />
          </div>

          <Card title={<span className="flex items-center gap-2">Reconciliation {rec.reconciled ? <Badge tone="green">Exact</Badge> : <Badge tone="red">Discrepancy</Badge>}</span>}>
            <table className="min-w-full text-sm">
              <thead><tr className="text-left text-xs uppercase text-slate-500"><th className="py-1">Check</th><th className="text-right">Carrier printed</th><th className="text-right">Extracted</th><th className="text-right">Difference</th><th /></tr></thead>
              <tbody>
                {rec.checks.map((c) => (
                  <tr key={c.key} className="border-t border-slate-100">
                    <td className="py-1.5">{c.label}{!c.required && <span className="ml-1 text-xs text-slate-400">(optional)</span>}</td>
                    <td className="text-right"><Money cents={c.statedCents} /></td>
                    <td className="text-right"><Money cents={c.extractedCents} /></td>
                    <td className="text-right">{c.differenceCents === null ? '—' : <Money cents={c.differenceCents} className={c.differenceCents ? 'font-semibold text-red-700' : ''} />}</td>
                    <td className="pl-3">{c.ok ? <span className="text-emerald-700">✓</span> : <span className="text-red-700">✕</span>}</td>
                  </tr>
                ))}
                {(stmt.adjustments ?? []).map((a) => (
                  <tr key={a.label} className="border-t border-slate-100 text-xs text-slate-500">
                    <td className="py-1 pl-4">Statement adjustment: {a.label}</td><td className="text-right"><Money cents={a.amountCents} /></td><td colSpan={3} />
                  </tr>
                ))}
              </tbody>
            </table>
            {stmt.stated?.ytdCommissionPayableCents != null && <p className="mt-2 text-xs text-slate-500">Carrier year-to-date commission payable (reference): <Money cents={stmt.stated.ytdCommissionPayableCents} /></p>}
            {!rec.reconciled && (
              <ul className="mt-3 list-disc space-y-0.5 pl-5 text-sm text-red-700">{rec.blockingReasons.map((b, i) => <li key={i}>{b}</li>)}</ul>
            )}
            {(stmt.statementIssues ?? []).filter((i) => i.level === 'warning').map((i, k) => <p key={k} className="mt-2 text-sm text-amber-800">{i.text}</p>)}
            <p className="mt-3 text-xs text-slate-500">
              Payment received is premium collected by the carrier and is never counted as commission. Policy term commission is shown for reference only.
              Nothing on this screen posts commission: matching (Stage 3B) and approval and posting (Stage 3C) come next.
            </p>
          </Card>
        </>
      )}

      {fileUrl && (
        <Card title="Original statement" actions={<Button size="sm" variant="ghost" onClick={() => setFileUrl(null)}>Close</Button>}>
          <iframe title="Original statement" src={fileUrl} className="h-[70vh] w-full rounded border border-slate-200" />
          <p className="mt-1 text-xs text-slate-500">Link expires in 5 minutes. Viewing is recorded in the audit log.</p>
        </Card>
      )}

      {['needs_review', 'discrepancy'].includes(stmt.status) && (
        <MatchingPanel statementId={stmt.id} payerId={stmt.payerId} matching={stmt.matching} lines={lines} canMatch={canMatch} />
      )}

      {lines.length > 0 && (
        <Card title="Extracted transactions">
          <div className="mb-3 flex flex-wrap gap-1">
            {([['all', `All (${lines.length})`], ['commission', `Commission (${t?.commissionLineCount ?? 0})`], ['payment_only', `Payment-only (${t?.paymentOnlyLineCount ?? 0})`],
              ['negative', `Negative (${t?.negativeLineCount ?? 0})`], ['issues', `With checks (${issuesCount})`]] as [LineTab, string][]).map(([k, l]) => (
              <Button key={k} size="sm" variant={tab === k ? 'primary' : 'secondary'} onClick={() => setTab(k)}>{l}</Button>
            ))}
          </div>
          <div className="mb-3 flex flex-wrap items-center gap-1">
            <span className="mr-1 text-xs font-medium uppercase text-slate-500">Match</span>
            {([['any', `Any (${lines.length})`], ['matched', `Matched (${matchCounts.matched})`], ['ambiguous', `Ambiguous (${matchCounts.ambiguous})`],
              ['unmatched', `Unmatched (${matchCounts.unmatched})`], ['manual', `Manual (${matchCounts.manual})`], ['not_run', `Not matched yet (${matchCounts.not_run})`]] as [MatchFilter, string][]).map(([k, l]) => (
              <Button key={k} size="sm" variant={matchFilter === k ? 'primary' : 'secondary'} onClick={() => setMatchFilter(k)}>{l}</Button>
            ))}
            <Select value={brokerFilter} onChange={(e) => setBrokerFilter(e.target.value)} placeholder="All brokers" className="ml-2 w-44"
              options={brokers.map((b) => ({ value: b.id, label: b.name }))} />
          </div>
          <DataTable rows={filtered} columns={columns} pageSize={50}
            searchText={(l) => { const m = lineMatch(l); return `${l.insuredName} ${l.policyNumberRaw} ${l.policyNumberNormalized} ${m?.clientId ? clientById.get(m.clientId)?.name ?? '' : ''} ${m?.policyId ? policyById.get(m.policyId)?.policyNumber ?? '' : ''}`; }} />
        </Card>
      )}

      {matching && (
        <MatchDialog key={matching.id} statementId={stmt.id} payerId={stmt.payerId ?? null}
          line={lines.find((l) => l.id === matching.id) ?? matching} onClose={() => setMatching(null)} />
      )}

      <Modal open={discarding} title="Discard this statement?" onClose={() => setDiscarding(false)} width="max-w-md">
        <p className="text-sm text-slate-600">The statement is set aside. Its original file and extracted lines are kept for the audit trail, and the same file can be uploaded again.</p>
        <Field label="Reason" className="mt-3"><TextArea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setDiscarding(false)}>Cancel</Button>
          <Button variant="danger" disabled={busy || !reason.trim()} onClick={() => void act(async () => { await api.discardStatement(stmt.id, reason); setDiscarding(false); })}>Discard</Button>
        </div>
      </Modal>
    </div>
  );
}
