import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import {
  detectColumns, IMPORT_FIELDS, MAX_IMPORT_ROWS, normalizeName, parseCsv, toTable, UNASSIGNED_BROKER_ID,
  type ColumnMapping, type ImportField, type ImportOptionsInput, type ImportRecordInput, type ImportPlanSummary,
} from '@asm/shared';
import { db } from '../firebase';
import { api, ApiError, type CommitResult, type StageResult, type StagedRow, type UndoResult } from '../api';
import { useData } from '../data';
import { CarrierForm, BrokerForm } from '../forms';
import { Badge, Button, Card, DataTable, ErrorNote, Field, Modal, PageHeader, Select, Stat, cx, type Column } from '../ui';

const MAX_BYTES = 10 * 1024 * 1024;

interface Sheet { name: string; rows: string[][] }
interface Loaded { fileName: string; fileHash: string; sheets: Sheet[] }

async function sha256(buf: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function readFile(file: File): Promise<Loaded> {
  if (file.size > MAX_BYTES) throw new Error('File is larger than 10 MB.');
  const buf = await file.arrayBuffer();
  const fileHash = await sha256(buf);
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.txt') || lower.endsWith('.tsv')) {
    const text = new TextDecoder('utf-8').decode(buf);
    return { fileName: file.name, fileHash, sheets: [{ name: 'CSV', rows: parseCsv(text) }] };
  }
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) {
    // Loaded on demand so the Excel library is only downloaded when needed.
    const { readXlsx } = await import('@asm/shared/excel');
    const sheets = await readXlsx(buf);
    if (!sheets.length) throw new Error('The workbook has no data.');
    return { fileName: file.name, fileHash, sheets };
  }
  if (lower.endsWith('.xls')) throw new Error('Old .xls files are not supported. Open the file in Excel and save it as .xlsx.');
  throw new Error('Upload a .csv or .xlsx file.');
}

/** Match a free-text carrier/broker value to a record by name, code or alias. */
function autoMatch<T extends { id: string; name: string; code: string; aliases?: string[] }>(value: string, list: T[]): T | undefined {
  const n = normalizeName(value);
  const code = value.trim().toUpperCase();
  return list.find((x) => normalizeName(x.name) === n || x.code === code || (x.aliases ?? []).some((a) => normalizeName(a) === n));
}

type Step = 'upload' | 'map' | 'values' | 'review' | 'done';

export function ImportPage() {
  const [tab, setTab] = useState<'new' | 'history'>('new');
  return (
    <div>
      <PageHeader title="Import Clients" subtitle="Load your client and policy list. Nothing changes until you review and confirm." />
      <div className="mb-4 flex gap-1">
        <Button size="sm" variant={tab === 'new' ? 'primary' : 'secondary'} onClick={() => setTab('new')}>New import</Button>
        <Button size="sm" variant={tab === 'history' ? 'primary' : 'secondary'} onClick={() => setTab('history')}>Import history</Button>
      </div>
      {tab === 'new' ? <ImportWizard onFinished={() => setTab('history')} /> : <ImportHistory />}
    </div>
  );
}

function Steps({ step }: { step: Step }) {
  const steps: [Step, string][] = [['upload', 'Upload'], ['map', 'Columns'], ['values', 'Carriers & brokers'], ['review', 'Review'], ['done', 'Done']];
  const idx = steps.findIndex(([s]) => s === step);
  return (
    <ol className="mb-5 flex flex-wrap gap-2 text-xs">
      {steps.map(([s, label], i) => (
        <li key={s} className={cx('rounded-full px-3 py-1', i === idx ? 'bg-ink text-white' : i < idx ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500')}>
          {i + 1}. {label}
        </li>
      ))}
    </ol>
  );
}

function ImportWizard({ onFinished }: { onFinished: () => void }) {
  const { carriers, brokers } = useData();
  const [step, setStep] = useState<Step>('upload');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [headerRow, setHeaderRow] = useState(1);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [carrierMap, setCarrierMap] = useState<Record<string, string>>({});
  const [wholesalerMap, setWholesalerMap] = useState<Record<string, string>>({});
  const [brokerMap, setBrokerMap] = useState<Record<string, string>>({});
  const [options, setOptions] = useState<ImportOptionsInput>({ defaultLine: 'commercial', defaultBrokerId: UNASSIGNED_BROKER_ID, updateExisting: true, updateBrokerOnExisting: false });
  const [staged, setStaged] = useState<StageResult | null>(null);
  const [committed, setCommitted] = useState<CommitResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ kind: 'carrier' | 'wholesaler' | 'broker'; name: string } | null>(null);

  const table = useMemo(() => {
    if (!loaded) return null;
    const rows = loaded.sheets[sheetIdx]?.rows ?? [];
    return toTable(rows.slice(headerRow - 1));
  }, [loaded, sheetIdx, headerRow]);

  useEffect(() => {
    if (table) setMapping(detectColumns(table.headers));
  }, [table]);

  const col = (f: ImportField, row: string[]) => {
    const i = mapping[f];
    return i === undefined || i === null ? '' : row[i] ?? '';
  };
  const distinct = (f: ImportField) => {
    if (!table || mapping[f] === undefined || mapping[f] === null) return [] as [string, number][];
    const m = new Map<string, number>();
    for (const r of table.rows) { const v = col(f, r).trim(); if (v) m.set(v, (m.get(v) ?? 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const carrierValues = useMemo(() => distinct('carrier'), [table, mapping]); // eslint-disable-line react-hooks/exhaustive-deps
  const wholesalerValues = useMemo(() => distinct('wholesaler'), [table, mapping]); // eslint-disable-line react-hooks/exhaustive-deps
  const brokerValues = useMemo(() => distinct('broker'), [table, mapping]); // eslint-disable-line react-hooks/exhaustive-deps

  const insurers = carriers.filter((c) => c.status === 'active');
  const wholesalers = carriers.filter((c) => c.kind === 'wholesaler' && c.status === 'active');
  const resolveCarrier = (v: string) => (v in carrierMap ? carrierMap[v] : autoMatch(v, insurers)?.id ?? '');
  const resolveWholesaler = (v: string) => (v in wholesalerMap ? wholesalerMap[v] : autoMatch(v, wholesalers)?.id ?? '');
  const resolveBroker = (v: string) => (v in brokerMap ? brokerMap[v] : autoMatch(v, brokers.map((b) => ({ ...b, aliases: [] })))?.id ?? '');

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError(null); setBusy(true);
    try {
      const l = await readFile(file);
      setLoaded(l); setSheetIdx(0); setHeaderRow(1);
      setCarrierMap({}); setWholesalerMap({}); setBrokerMap({});
      setStep('map');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read the file.');
    } finally {
      setBusy(false);
    }
  }

  function buildRecords(): ImportRecordInput[] {
    if (!table) return [];
    return table.rows.map((r, i) => {
      const carrierRaw = col('carrier', r).trim();
      const wholesalerRaw = col('wholesaler', r).trim();
      const brokerRaw = col('broker', r).trim();
      return {
        rowNumber: headerRow + i + 1,
        clientName: col('clientName', r),
        clientExternalId: col('clientExternalId', r),
        policyNumber: col('policyNumber', r),
        carrierRaw, carrierId: carrierRaw ? resolveCarrier(carrierRaw) || null : null,
        wholesalerRaw, wholesalerId: wholesalerRaw ? resolveWholesaler(wholesalerRaw) || null : null,
        brokerRaw, brokerId: brokerRaw ? resolveBroker(brokerRaw) || null : null,
        policyType: col('policyType', r), line: col('line', r), namedInsured: col('namedInsured', r),
        effectiveDate: col('effectiveDate', r), expirationDate: col('expirationDate', r), premium: col('premium', r),
        policyStatus: col('policyStatus', r), phone: col('phone', r), email: col('email', r), address: col('address', r),
      };
    });
  }

  async function stage() {
    if (!loaded) return;
    const records = buildRecords();
    if (records.length > MAX_IMPORT_ROWS) { setError(`Files are limited to ${MAX_IMPORT_ROWS.toLocaleString()} rows; split the file.`); return; }
    setError(null); setBusy(true);
    try {
      const res = await api.stageImport(loaded.fileName, loaded.fileHash, options, records);
      setStaged(res);
      setStep('review');
    } catch (e) {
      setError(e instanceof ApiError ? `${e.message} ${Object.values(e.fieldErrors).slice(0, 3).join('; ')}` : 'Staging failed.');
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!staged) return;
    setError(null); setBusy(true);
    try {
      setCommitted(await api.commitImport(staged.batchId));
      setStep('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Commit failed.');
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    if (staged) await api.discardImport(staged.batchId).catch(() => undefined);
    reset();
  }

  function reset() {
    setStep('upload'); setLoaded(null); setStaged(null); setCommitted(null); setError(null);
  }

  return (
    <Card>
      <Steps step={step} />
      <div className="mb-4"><ErrorNote message={error} /></div>

      {step === 'upload' && (
        <label className={cx('flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-300 px-6 py-14 text-center hover:border-ink', busy && 'opacity-50')}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); void onFile(e.dataTransfer.files[0]); }}>
          <span className="text-sm font-medium text-ink">Drop a CSV or Excel file here, or click to choose</span>
          <span className="mt-1 text-xs text-slate-500">Client and policy list · .csv or .xlsx · up to 10 MB · commissions are not needed</span>
          <input type="file" accept=".csv,.txt,.tsv,.xlsx,.xlsm" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
        </label>
      )}

      {step === 'map' && loaded && table && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-end gap-4 text-sm">
            <div><span className="text-slate-500">File:</span> <span className="font-medium">{loaded.fileName}</span></div>
            {loaded.sheets.length > 1 && (
              <Field label="Sheet"><Select value={String(sheetIdx)} onChange={(e) => setSheetIdx(Number(e.target.value))} options={loaded.sheets.map((s, i) => ({ value: String(i), label: s.name }))} /></Field>
            )}
            <Field label="Header row" hint="If the file has title rows above the headers">
              <Select value={String(headerRow)} onChange={(e) => setHeaderRow(Number(e.target.value))} options={Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: `Row ${i + 1}` }))} />
            </Field>
            <div className="text-slate-500">{table.rows.length.toLocaleString()} data rows</div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {IMPORT_FIELDS.map((f) => (
              <Field key={f.key} label={`${f.label}${'required' in f && f.required ? ' *' : ''}`}>
                <Select value={mapping[f.key] === undefined || mapping[f.key] === null ? '' : String(mapping[f.key])}
                  onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value === '' ? null : Number(e.target.value) })}
                  placeholder="— not in file —" options={table.headers.map((h, i) => ({ value: String(i), label: h }))} />
              </Field>
            ))}
          </div>
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Preview (first 8 rows as mapped)</h3>
            <div className="overflow-x-auto rounded-md border border-slate-200">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-50"><tr>{IMPORT_FIELDS.filter((f) => mapping[f.key] != null).map((f) => <th key={f.key} className="px-2 py-1.5 text-left font-semibold text-slate-500">{f.label}</th>)}</tr></thead>
                <tbody>
                  {table.rows.slice(0, 8).map((r, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      {IMPORT_FIELDS.filter((f) => mapping[f.key] != null).map((f) => <td key={f.key} className="whitespace-nowrap px-2 py-1">{col(f.key, r)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="flex justify-between">
            <Button variant="secondary" onClick={reset}>Start over</Button>
            <Button disabled={mapping.clientName == null} onClick={() => setStep('values')}>Next: carriers & brokers</Button>
          </div>
        </div>
      )}

      {step === 'values' && table && (
        <div className="space-y-6">
          <ValueMapper title="Carrier / company values" values={carrierValues} resolve={resolveCarrier}
            options={insurers.map((c) => ({ value: c.id, label: `${c.name}${c.kind === 'wholesaler' ? ' (wholesaler)' : ''}` }))}
            onChange={(v, id) => setCarrierMap({ ...carrierMap, [v]: id })}
            onAdd={(name) => setAdding({ kind: 'carrier', name })}
            emptyNote={mapping.carrier == null ? 'No carrier column mapped — rows will import as clients only.' : undefined}
            unmappedNote="Unmapped carrier → that row's policy is not imported" />
          {mapping.wholesaler != null && (
            <ValueMapper title="Wholesaler values" values={wholesalerValues} resolve={resolveWholesaler}
              options={wholesalers.map((c) => ({ value: c.id, label: c.name }))}
              onChange={(v, id) => setWholesalerMap({ ...wholesalerMap, [v]: id })}
              onAdd={(name) => setAdding({ kind: 'wholesaler', name })}
              unmappedNote="Unmapped wholesaler → policy recorded as direct" />
          )}
          {mapping.broker != null && (
            <ValueMapper title="Broker / producer values" values={brokerValues} resolve={resolveBroker}
              options={brokers.map((b) => ({ value: b.id, label: b.name }))}
              onChange={(v, id) => setBrokerMap({ ...brokerMap, [v]: id })}
              onAdd={(name) => setAdding({ kind: 'broker', name })}
              unmappedNote="Unmapped broker → default broker below" />
          )}
          <div>
            <h3 className="mb-2 text-sm font-semibold text-ink">Options</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="When the file doesn't say personal/commercial">
                <Select value={options.defaultLine} onChange={(e) => setOptions({ ...options, defaultLine: e.target.value as 'personal' | 'commercial' })}
                  options={[{ value: 'commercial', label: 'Commercial' }, { value: 'personal', label: 'Personal' }]} />
              </Field>
              <Field label="Default broker">
                <Select value={options.defaultBrokerId} onChange={(e) => setOptions({ ...options, defaultBrokerId: e.target.value })}
                  options={brokers.map((b) => ({ value: b.id, label: b.name }))} />
              </Field>
              <label className="flex items-center gap-2 self-end text-sm text-slate-700">
                <input type="checkbox" checked={options.updateExisting} onChange={(e) => setOptions({ ...options, updateExisting: e.target.checked })} />
                Update existing records with values from the file
              </label>
              <label className="flex items-center gap-2 self-end text-sm text-slate-700">
                <input type="checkbox" checked={options.updateBrokerOnExisting} onChange={(e) => setOptions({ ...options, updateBrokerOnExisting: e.target.checked })} />
                Also change brokers on existing records
              </label>
            </div>
            <p className="mt-2 text-xs text-slate-500">Blank cells never erase existing values. Commission history is never changed by an import.</p>
          </div>
          <div className="flex justify-between">
            <Button variant="secondary" onClick={() => setStep('map')}>Back</Button>
            <Button disabled={busy} onClick={() => void stage()}>{busy ? 'Checking…' : 'Check import'}</Button>
          </div>
        </div>
      )}

      {step === 'review' && staged && (
        <Review staged={staged} busy={busy} onBack={() => setStep('values')} onCommit={() => void commit()} onDiscard={() => void discard()} />
      )}

      {step === 'done' && committed && (
        <div className="space-y-4">
          <p className="text-sm font-medium text-emerald-700">Import committed.</p>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Stat label="Clients created" value={committed.clientsCreated} />
            <Stat label="Clients updated" value={committed.clientsUpdated} />
            <Stat label="Policies created" value={committed.policiesCreated} />
            <Stat label="Policies updated" value={committed.policiesUpdated} />
          </div>
          <p className="text-xs text-slate-500">Rows with errors, duplicates and conflicts were skipped. You can undo this import from Import history.</p>
          <div className="flex gap-2">
            <Link to="/clients"><Button>View clients</Button></Link>
            <Button variant="secondary" onClick={() => { reset(); onFinished(); }}>Import history</Button>
            <Button variant="secondary" onClick={reset}>Import another file</Button>
          </div>
        </div>
      )}

      {adding?.kind === 'broker' && <BrokerForm open onClose={() => setAdding(null)} />}
      {adding && adding.kind !== 'broker' && (
        <CarrierForm open onClose={() => setAdding(null)} defaultKind={adding.kind} initialName={adding.name} />
      )}
    </Card>
  );
}

function ValueMapper({ title, values, resolve, options, onChange, onAdd, emptyNote, unmappedNote }: {
  title: string;
  values: [string, number][];
  resolve: (v: string) => string;
  options: { value: string; label: string }[];
  onChange: (value: string, id: string) => void;
  onAdd: (name: string) => void;
  emptyNote?: string;
  unmappedNote: string;
}) {
  const unmapped = values.filter(([v]) => !resolve(v)).length;
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {values.length > 0 && (unmapped ? <Badge tone="amber">{unmapped} unmapped</Badge> : <Badge tone="green">All mapped</Badge>)}
      </div>
      {emptyNote ? <p className="text-sm text-slate-500">{emptyNote}</p> : values.length === 0 ? <p className="text-sm text-slate-500">No values in the file.</p> : (
        <div className="overflow-hidden rounded-md border border-slate-200">
          <table className="min-w-full text-sm">
            <tbody className="divide-y divide-slate-100">
              {values.map(([v, n]) => (
                <tr key={v} className={!resolve(v) ? 'bg-amber-50/50' : ''}>
                  <td className="px-3 py-1.5 font-medium">{v}</td>
                  <td className="px-3 py-1.5 text-xs text-slate-500">{n} rows</td>
                  <td className="w-72 px-3 py-1.5">
                    <Select value={resolve(v)} onChange={(e) => onChange(v, e.target.value)} placeholder="— not mapped —" options={options} className="py-1 text-xs" />
                  </td>
                  <td className="w-24 px-3 py-1.5 text-right">
                    {!resolve(v) && <Button size="sm" variant="ghost" onClick={() => onAdd(v)}>+ Add</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {values.length > 0 && <p className="mt-1 text-xs text-slate-500">{unmappedNote}</p>}
    </div>
  );
}

const ACTION_LABEL: Record<string, string> = {
  create: 'New', update: 'Update', existing: 'Existing', unchanged: 'No change', duplicate: 'Duplicate in file', conflict: 'Conflict', none: '—',
};

function Review({ staged, busy, onBack, onCommit, onDiscard }: {
  staged: StageResult; busy: boolean; onBack: () => void; onCommit: () => void; onDiscard: () => void;
}) {
  const [filter, setFilter] = useState<string>('all');
  const [confirming, setConfirming] = useState(false);
  const s = staged.summary;
  const rows = staged.rows.filter((r) => {
    switch (filter) {
      case 'errors': return r.status === 'error';
      case 'warnings': return r.status === 'warning';
      case 'new': return r.policyAction === 'create' || (r.clientAction === 'create' && r.policyAction === 'none');
      case 'updates': return r.policyAction === 'update' || r.clientAction === 'update';
      case 'skipped': return ['duplicate', 'conflict'].includes(r.policyAction);
      default: return true;
    }
  });
  const actionable = s.clientsNew + s.clientsUpdated + s.policiesNew + s.policiesUpdated;

  const columns: Column<StagedRow & { id: string }>[] = [
    { key: 'row', header: 'Row', render: (r) => r.rowNumber, sort: (r) => r.rowNumber },
    { key: 'status', header: '', render: (r) => (r.status === 'error' ? <Badge tone="red">Error</Badge> : r.status === 'warning' ? <Badge tone="amber">Warning</Badge> : <Badge tone="green">OK</Badge>), sort: (r) => r.status },
    { key: 'client', header: 'Client', render: (r) => <span>{r.clientName} <span className="text-xs text-slate-400">{ACTION_LABEL[r.clientAction]}</span></span>, sort: (r) => r.clientName },
    { key: 'policy', header: 'Policy', render: (r) => r.policyNumber || '—', sort: (r) => r.policyNumber },
    { key: 'carrier', header: 'Carrier', render: (r) => r.carrier || '—' },
    { key: 'action', header: 'Policy action', render: (r) => ACTION_LABEL[r.policyAction], sort: (r) => r.policyAction },
    {
      key: 'notes', header: 'Notes', className: 'whitespace-normal max-w-md',
      render: (r) => (
        <div className="space-y-0.5 text-xs">
          {Object.entries(r.policyChanges ?? {}).map(([k, ch]) => <div key={k} className="text-sky-700">{k}: {String(ch.before ?? '—')} → {String(ch.after)}</div>)}
          {r.messages.map((m, i) => <div key={i} className={m.level === 'error' ? 'text-red-700' : m.level === 'warning' ? 'text-amber-800' : 'text-slate-500'}>{m.text}</div>)}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      {staged.duplicateOf && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          This exact file was imported before. Re-importing is safe — matching records are updated, not duplicated — but check this is intended.
        </div>
      )}
      <SummaryGrid s={s} />
      <div className="flex flex-wrap gap-1">
        {[['all', 'All'], ['errors', `Errors (${s.errors})`], ['warnings', `Warnings (${s.warnings})`], ['new', 'New'], ['updates', 'Updates'], ['skipped', `Skipped (${s.duplicatesInFile + s.conflicts})`]].map(([k, l]) => (
          <Button key={k} size="sm" variant={filter === k ? 'primary' : 'secondary'} onClick={() => setFilter(k)}>{l}</Button>
        ))}
      </div>
      <DataTable rows={rows.map((r) => ({ ...r, id: String(r.rowNumber) }))} columns={columns} pageSize={50} empty="No rows in this view." />
      <div className="flex flex-wrap justify-between gap-2">
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onBack}>Back</Button>
          <Button variant="ghost" onClick={onDiscard}>Discard</Button>
        </div>
        <Button disabled={busy || actionable === 0} onClick={() => setConfirming(true)}>Commit import</Button>
      </div>
      <Modal open={confirming} title="Commit this import?" onClose={() => setConfirming(false)} width="max-w-md">
        <p className="text-sm text-slate-600">
          {s.clientsNew} new clients, {s.clientsUpdated} client updates, {s.policiesNew} new policies and {s.policiesUpdated} policy updates will be applied.
          {s.errors + s.duplicatesInFile + s.conflicts > 0 && ` ${s.errors + s.duplicatesInFile + s.conflicts} rows will be skipped.`}
        </p>
        <p className="mt-2 text-xs text-slate-500">The data is re-checked at commit time. You can undo the import afterwards.</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirming(false)}>Cancel</Button>
          <Button disabled={busy} onClick={() => { setConfirming(false); onCommit(); }}>{busy ? 'Committing…' : 'Commit'}</Button>
        </div>
      </Modal>
    </div>
  );
}

function SummaryGrid({ s }: { s: ImportPlanSummary }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
      <Stat label="Rows" value={s.rows.toLocaleString()} />
      <Stat label="New clients" value={s.clientsNew} />
      <Stat label="Existing clients" value={s.clientsExisting + s.clientsUpdated} sub={s.clientsUpdated ? `${s.clientsUpdated} updated` : undefined} />
      <Stat label="New policies" value={s.policiesNew} />
      <Stat label="Policy updates" value={s.policiesUpdated} sub={`${s.policiesUnchanged} unchanged`} />
      <Stat label="Duplicates in file" value={s.duplicatesInFile} />
      <Stat label="Conflicts" value={s.conflicts} />
      <Stat label="Errors" value={s.errors} sub={`${s.warnings} warnings`} />
    </div>
  );
}

// ---------------------------------------------------------------------------

interface BatchDoc {
  id: string;
  status: 'staged' | 'committing' | 'committed' | 'failed' | 'undoing' | 'undone' | 'discarded';
  fileName: string;
  rowCount: number;
  summary: ImportPlanSummary;
  committedSummary?: CommitResult;
  undoSummary?: UndoResult;
  createdAt?: { toDate?: () => Date };
  failure?: string;
}

const STATUS_TONE: Record<BatchDoc['status'], 'slate' | 'green' | 'amber' | 'red' | 'blue'> = {
  staged: 'blue', committing: 'amber', committed: 'green', failed: 'red', undoing: 'amber', undone: 'slate', discarded: 'slate',
};

function ImportHistory() {
  const [batches, setBatches] = useState<BatchDoc[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmUndo, setConfirmUndo] = useState<BatchDoc | null>(null);
  const [result, setResult] = useState<UndoResult | null>(null);

  useEffect(() => onSnapshot(query(collection(db, 'importBatches'), orderBy('createdAt', 'desc'), limit(50)),
    (s) => setBatches(s.docs.map((d) => ({ id: d.id, ...d.data() }) as BatchDoc))), []);

  async function run(id: string, fn: () => Promise<unknown>) {
    setBusy(id); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'Action failed'); } finally { setBusy(null); }
  }

  const columns: Column<BatchDoc>[] = [
    { key: 'when', header: 'When', render: (b) => b.createdAt?.toDate?.().toLocaleString() ?? '' },
    { key: 'file', header: 'File', render: (b) => <span className="font-medium">{b.fileName}</span> },
    { key: 'rows', header: 'Rows', align: 'right', render: (b) => b.rowCount?.toLocaleString() },
    { key: 'status', header: 'Status', render: (b) => <Badge tone={STATUS_TONE[b.status]}>{b.status}</Badge> },
    {
      key: 'result', header: 'Result', className: 'whitespace-normal text-xs',
      render: (b) => b.status === 'undone' && b.undoSummary
        ? `Removed ${b.undoSummary.policiesDeleted} policies, ${b.undoSummary.clientsDeleted} clients; restored ${b.undoSummary.policiesRestored + b.undoSummary.clientsRestored}; skipped ${b.undoSummary.skipped.length}`
        : b.committedSummary
          ? `+${b.committedSummary.clientsCreated} clients, +${b.committedSummary.policiesCreated} policies, ${b.committedSummary.policiesUpdated + b.committedSummary.clientsUpdated} updated`
          : b.failure ?? `${b.summary?.policiesNew ?? 0} new policies planned`,
    },
    {
      key: 'actions', header: '', align: 'right',
      render: (b) => (
        <div className="flex justify-end gap-1">
          {b.status === 'staged' && <>
            <Button size="sm" disabled={!!busy} onClick={() => void run(b.id, () => api.commitImport(b.id))}>Commit</Button>
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void run(b.id, () => api.discardImport(b.id))}>Discard</Button>
          </>}
          {(b.status === 'committed' || b.status === 'failed') && (
            <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => setConfirmUndo(b)}>{busy === b.id ? 'Undoing…' : 'Undo'}</Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <Card>
      <div className="mb-3"><ErrorNote message={error} /></div>
      {result && (
        <div className="mb-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
          Undo complete: {result.policiesDeleted} policies and {result.clientsDeleted} clients removed, {result.policiesRestored + result.clientsRestored} records restored.
          {result.skipped.length > 0 && <span className="text-amber-800"> {result.skipped.length} records were kept because they were edited after the import, have commission history, or have other policies.</span>}
        </div>
      )}
      <DataTable rows={batches} columns={columns} empty="No imports yet." />
      <Modal open={!!confirmUndo} title="Undo this import?" onClose={() => setConfirmUndo(null)} width="max-w-md">
        <p className="text-sm text-slate-600">
          Records created by <b>{confirmUndo?.fileName}</b> are removed and records it updated get their previous values back.
          Anything edited since the import, any policy with commission history, and any client that has other policies is left alone.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirmUndo(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => {
            const b = confirmUndo!;
            setConfirmUndo(null);
            void run(b.id, async () => setResult(await api.undoImport(b.id)));
          }}>Undo import</Button>
        </div>
      </Modal>
    </Card>
  );
}

