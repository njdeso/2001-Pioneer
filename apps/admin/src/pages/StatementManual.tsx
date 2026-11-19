import { useMemo, useRef, useState } from 'react';
import {
  draftFromExtracted, emptyManualDraft, formatMonth, manualDraftToStatement, manualEditBlocker, MANUAL_CSV_TEMPLATE, parseManualCsv,
  parseMoneyToCents, parsePercentToBps, reconcileStatement, TRANSACTION_TYPE_LABELS, TRANSACTION_TYPES, validateManualDraft,
  type Cents, type ExtractedLine, type ManualDraft, type ManualLine, type StatedTotals, type TransactionType,
} from '@asm/shared';
import { api } from '../api';
import { Badge, Button, Card, ErrorNote, Field, Modal, Money, Select, TextArea, TextInput } from '../ui';

/**
 * Manual reconciliation of a statement that automatic reading could not read, or read wrongly.
 * The person keys (or corrects) lines and the totals exactly as printed, with the original open beside them.
 * Applying stores an ordinary statement through the same server code as an AI read, so reconciliation (exact to
 * the cent), duplicate checks, matching, approval and posting are unchanged. Unfinished work can be saved and
 * resumed. Not available once anything from the statement was approved or posted.
 */

export interface ManualStatementInfo {
  id: string;
  status: string;
  originalPath?: string | null;
  postedCents?: number;
  postingSeq?: number;
  reversals?: unknown[];
  payerId?: string | null;
  statementMonth?: string | null;
  statementDate?: string | null;
  agencyCode?: string | null;
  stated?: Partial<StatedTotals> | null;
  adjustments?: { label: string; amountCents: number }[];
  method?: string;
  manualDraft?: (ManualDraft & { savedAt?: { toDate?: () => Date } | null; savedBy?: string; appliedAt?: { toDate?: () => Date } | null }) | null;
  manualReconciliation?: { by?: string; reason?: string; basedOn?: string; at?: { toDate?: () => Date } } | null;
}

/** Editable form of a line: amounts as typed, converted to cents only when saving. */
interface Row { insuredName: string; policyNumberRaw: string; effectiveDate: string; transactionType: TransactionType; kind: 'commission' | 'payment_only'; commission: string; premium: string; rate: string; payment: string; page: string; note: string }
interface Head { payerId: string; statementMonth: string; statementDate: string; agencyCode: string; commissionTotal: string; monthPayable: string; ytd: string; reason: string; basedOn: 'blank' | 'extracted'; adjustments: { label: string; amount: string }[] }

const c2s = (c: Cents | null | undefined) => (c === null || c === undefined ? '' : (c / 100).toFixed(2));
const toRow = (l: ManualLine): Row => ({
  insuredName: l.insuredName, policyNumberRaw: l.policyNumberRaw, effectiveDate: l.effectiveDate ?? '', transactionType: l.transactionType, kind: l.kind,
  commission: c2s(l.paidCommissionCents), premium: c2s(l.premiumForCommissionCents), rate: l.rateBps === null ? '' : String(l.rateBps / 100),
  payment: c2s(l.paymentReceivedCents), page: l.page === null ? '' : String(l.page), note: l.note,
});
const blankRow = (): Row => ({ insuredName: '', policyNumberRaw: '', effectiveDate: '', transactionType: 'other', kind: 'commission', commission: '', premium: '', rate: '', payment: '', page: '', note: '' });
const toHead = (d: ManualDraft): Head => ({
  payerId: d.payerId, statementMonth: d.statementMonth ?? '', statementDate: d.statementDate ?? '', agencyCode: d.agencyCode,
  commissionTotal: c2s(d.stated.commissionPayableCents), monthPayable: c2s(d.stated.monthCommissionPayableCents), ytd: c2s(d.stated.ytdCommissionPayableCents),
  reason: d.reason, basedOn: d.basedOn, adjustments: d.adjustments.map((a) => ({ label: a.label, amount: c2s(a.amountCents) })),
});

/** Build the draft from what is typed; amount typos are reported here, before anything is sent. */
function toDraft(h: Head, rows: Row[]): { draft: ManualDraft; typing: string[] } {
  const typing: string[] = [];
  const money = (v: string, label: string): Cents | null => {
    if (!v.trim()) return null;
    try { return parseMoneyToCents(v); } catch { typing.push(`${label}: "${v}" is not an amount.`); return null; }
  };
  const draft: ManualDraft = {
    payerId: h.payerId, statementMonth: h.statementMonth || null, statementDate: h.statementDate || null, agencyCode: h.agencyCode,
    stated: { commissionPayableCents: money(h.commissionTotal, 'Printed commission total'), monthCommissionPayableCents: money(h.monthPayable, 'Printed month payable'), ytdCommissionPayableCents: money(h.ytd, 'Printed year-to-date') },
    adjustments: h.adjustments.map((a, i) => ({ label: a.label, amountCents: money(a.amount, `Adjustment ${i + 1}`) ?? 0 })),
    lines: rows.map((r, i) => {
      let rateBps: number | null = null;
      if (r.rate.trim()) { try { rateBps = parsePercentToBps(r.rate); } catch { typing.push(`Line ${i + 1}: "${r.rate}" is not a rate.`); } }
      const page = r.page.trim() ? Number(r.page) : null;
      if (page !== null && !Number.isSafeInteger(page)) typing.push(`Line ${i + 1}: page "${r.page}" is not a number.`);
      return {
        insuredName: r.insuredName, policyNumberRaw: r.policyNumberRaw, effectiveDate: r.effectiveDate || null, transactionType: r.transactionType, kind: r.kind,
        paidCommissionCents: r.kind === 'payment_only' ? null : money(r.commission, `Line ${i + 1} commission`),
        premiumForCommissionCents: money(r.premium, `Line ${i + 1} premium`), rateBps,
        paymentReceivedCents: money(r.payment, `Line ${i + 1} payment received`), transactionPremiumCents: null,
        page: page !== null && Number.isSafeInteger(page) ? page : null, note: r.note,
      };
    }),
    reason: h.reason, basedOn: h.basedOn,
  };
  return { draft, typing };
}

const TYPE_OPTIONS = TRANSACTION_TYPES.map((t) => ({ value: t, label: TRANSACTION_TYPE_LABELS[t] }));
const cell = 'rounded border border-slate-300 px-1.5 py-1 text-xs w-full';

export function ManualReconciliationPanel({ stmt, lines, carriers, onViewOriginal, originalOpen }: {
  stmt: ManualStatementInfo;
  lines: ExtractedLine[];
  carriers: { id: string; name: string; status?: string }[];
  onViewOriginal: () => void;
  originalOpen: boolean;
}) {
  const blocker = manualEditBlocker(stmt);
  const [open, setOpen] = useState(false);
  const [head, setHead] = useState<Head | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [csv, setCsv] = useState<{ lines: ManualLine[]; errors: string[]; name: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const built = useMemo(() => (head ? toDraft(head, rows) : null), [head, rows]);
  const check = useMemo(() => {
    if (!built) return null;
    const v = validateManualDraft(built.draft, 'apply');
    if (!v.ok) return { ok: false as const, errors: [...built.typing, ...v.errors] };
    const rec = reconcileStatement(manualDraftToStatement(v.draft, ''));
    return { ok: true as const, rec, typing: built.typing };
  }, [built]);

  const saved = stmt.manualDraft;
  const savedText = saved?.savedAt?.toDate ? `${saved.savedAt.toDate().toLocaleString()}${saved.savedBy ? ` by ${saved.savedBy}` : ''}` : '';

  function start(d: ManualDraft) {
    setHead(toHead(d)); setRows(d.lines.length ? d.lines.map(toRow) : [blankRow()]);
    setOpen(true); setError(null); setServerErrors([]); setNotice(null); setCsv(null);
    if (!originalOpen) onViewOriginal();
  }
  const fromBlank = () => start({ ...emptyManualDraft(stmt.payerId ?? ''), statementMonth: stmt.statementMonth ?? null, statementDate: stmt.statementDate ?? null, agencyCode: stmt.agencyCode ?? '' });
  const fromExtracted = () => start(draftFromExtracted(stmt, lines));
  const resume = () => saved && start({ ...emptyManualDraft(), ...saved });

  async function send(action: 'save_draft' | 'apply') {
    if (!built) return;
    setBusy(true); setError(null); setServerErrors([]); setNotice(null);
    try {
      if (built.typing.length) throw new Error(built.typing.join(' '));
      const res = await api.manualStatement(stmt.id, action, built.draft);
      if (action === 'apply') { setOpen(false); setConfirming(false); setNotice(`Applied: ${res.lines ?? 0} lines, ${res.reconciled ? 'reconciled exactly' : 'not reconciled yet — see the reconciliation above'}. Run matching next.`); }
      else setNotice('Saved. You can close this and resume later.');
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Saving failed';
      setError(m);
    } finally { setBusy(false); }
  }

  async function readCsv(f: File) {
    const text = await f.text();
    const r = parseManualCsv(text);
    setCsv({ ...r, name: f.name });
    if (fileRef.current) fileRef.current.value = '';
  }
  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([`${MANUAL_CSV_TEMPLATE}\n`], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = 'manual-statement-template.csv'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const setRow = (i: number, p: Partial<Row>) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...p } : r)));
  const setH = (p: Partial<Head>) => setHead((h) => (h ? { ...h, ...p } : h));
  const activeCarriers = carriers.filter((c) => c.status !== 'inactive' || c.id === head?.payerId);

  const banner = stmt.method === 'manual' && stmt.manualReconciliation ? (
    <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <b>Reconciled manually</b>{stmt.manualReconciliation.by ? ` by ${stmt.manualReconciliation.by}` : ''}{stmt.manualReconciliation.at?.toDate ? ` on ${stmt.manualReconciliation.at.toDate().toLocaleString()}` : ''}
      {stmt.manualReconciliation.reason ? <> — {stmt.manualReconciliation.reason}</> : null}. The lines and printed totals were typed from the original; check them against it before approving.
    </p>
  ) : null;

  if (blocker) return banner;
  if (!open) {
    return (
      <>
        {banner}
        <Card title="Manual reconciliation">
          <p className="mb-3 text-sm text-slate-600">
            If automatic reading failed or read this statement wrongly, enter or correct the lines and the printed totals yourself, with the original open beside them.
            The statement then reconciles, matches, and is approved and posted exactly like any other — nothing is balanced for you.
          </p>
          <div className="flex flex-wrap gap-2">
            {saved && <Button disabled={busy} onClick={resume}>Resume saved work ({saved.lines.length} line{saved.lines.length === 1 ? '' : 's'}{savedText ? `, saved ${savedText}` : ''})</Button>}
            <Button variant={saved ? 'secondary' : 'primary'} disabled={busy} onClick={fromBlank}>Enter from the original</Button>
            {lines.length > 0 && <Button variant="secondary" disabled={busy} onClick={fromExtracted}>Correct the extracted lines ({lines.length})</Button>}
          </div>
          {notice && <p className="mt-2 text-sm text-emerald-700">{notice}</p>}
        </Card>
      </>
    );
  }

  return (
    <>
      {banner}
      <Card title={<span className="flex items-center gap-2">Manual reconciliation {head?.basedOn === 'extracted' ? <Badge tone="amber">Correcting extracted lines</Badge> : <Badge>Entered from the original</Badge>}</span>}
        actions={<>
          {!originalOpen && <Button size="sm" variant="secondary" onClick={onViewOriginal}>View original</Button>}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Close (unsaved changes are lost)</Button>
        </>}>
        {head && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Field label="Carrier / wholesaler (existing)">
                <Select value={head.payerId} onChange={(e) => setH({ payerId: e.target.value })} placeholder="Choose…" options={activeCarriers.map((c) => ({ value: c.id, label: c.name }))} />
              </Field>
              <Field label="Statement month" hint={head.statementMonth ? formatMonth(head.statementMonth) : 'YYYY-MM'}>
                <TextInput type="month" value={head.statementMonth} onChange={(e) => setH({ statementMonth: e.target.value })} />
              </Field>
              <Field label="Statement date (optional)"><TextInput type="date" value={head.statementDate} onChange={(e) => setH({ statementDate: e.target.value })} /></Field>
              <Field label="Agency code (optional)"><TextInput value={head.agencyCode} onChange={(e) => setH({ agencyCode: e.target.value })} /></Field>
              <Field label="Printed commission total" hint="Exactly as printed (sum of the commission column)"><TextInput inputMode="decimal" value={head.commissionTotal} onChange={(e) => setH({ commissionTotal: e.target.value })} /></Field>
              <Field label="Printed month payable" hint="After adjustments, if printed"><TextInput inputMode="decimal" value={head.monthPayable} onChange={(e) => setH({ monthPayable: e.target.value })} /></Field>
              <Field label="Printed year-to-date (reference only)" hint="Never used as the statement total"><TextInput inputMode="decimal" value={head.ytd} onChange={(e) => setH({ ytd: e.target.value })} /></Field>
            </div>

            <div>
              <div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase text-slate-500">Statement adjustments (agency only, e.g. MVR charges)
                <Button size="sm" variant="ghost" onClick={() => setH({ adjustments: [...head.adjustments, { label: '', amount: '' }] })}>+ Add</Button></div>
              {head.adjustments.map((a, i) => (
                <div key={i} className="mb-1 flex gap-2">
                  <input className={cell} placeholder="Label as printed" value={a.label} onChange={(e) => setH({ adjustments: head.adjustments.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)) })} />
                  <input className={`${cell} w-32 text-right`} placeholder="-25.00" value={a.amount} onChange={(e) => setH({ adjustments: head.adjustments.map((x, k) => (k === i ? { ...x, amount: e.target.value } : x)) })} />
                  <Button size="sm" variant="ghost" onClick={() => setH({ adjustments: head.adjustments.filter((_, k) => k !== i) })}>Remove</Button>
                </div>
              ))}
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead><tr className="text-left uppercase text-slate-500">
                  <th className="px-1">#</th><th className="px-1">Insured</th><th className="px-1">Policy # (as printed)</th><th className="px-1">Eff. date</th><th className="px-1">Type</th><th className="px-1">Kind</th>
                  <th className="px-1 text-right">Premium</th><th className="px-1 text-right">Rate %</th><th className="px-1 text-right">Paid commission</th><th className="px-1 text-right">Payment rec’d</th><th className="px-1">Pg</th><th className="px-1">Note</th><th />
                </tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className="border-t border-slate-100 align-top">
                      <td className="px-1 py-1 text-slate-500">{i + 1}</td>
                      <td className="px-1 py-1 min-w-[9rem]"><input className={cell} value={r.insuredName} onChange={(e) => setRow(i, { insuredName: e.target.value })} /></td>
                      <td className="px-1 py-1 min-w-[8rem]"><input className={`${cell} font-mono`} value={r.policyNumberRaw} onChange={(e) => setRow(i, { policyNumberRaw: e.target.value })} /></td>
                      <td className="px-1 py-1"><input type="date" className={cell} value={r.effectiveDate} onChange={(e) => setRow(i, { effectiveDate: e.target.value })} /></td>
                      <td className="px-1 py-1"><select className={cell} value={r.transactionType} onChange={(e) => setRow(i, { transactionType: e.target.value as TransactionType })}>{TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></td>
                      <td className="px-1 py-1"><select className={cell} value={r.kind} onChange={(e) => setRow(i, { kind: e.target.value as Row['kind'], ...(e.target.value === 'payment_only' ? { commission: '' } : {}) })}><option value="commission">Commission</option><option value="payment_only">Payment only</option></select></td>
                      <td className="px-1 py-1 w-24"><input inputMode="decimal" className={`${cell} text-right`} value={r.premium} onChange={(e) => setRow(i, { premium: e.target.value })} /></td>
                      <td className="px-1 py-1 w-16"><input inputMode="decimal" className={`${cell} text-right`} value={r.rate} onChange={(e) => setRow(i, { rate: e.target.value })} /></td>
                      <td className="px-1 py-1 w-28"><input inputMode="decimal" disabled={r.kind === 'payment_only'} className={`${cell} text-right font-semibold`} value={r.commission} onChange={(e) => setRow(i, { commission: e.target.value })} /></td>
                      <td className="px-1 py-1 w-24"><input inputMode="decimal" className={`${cell} text-right`} value={r.payment} onChange={(e) => setRow(i, { payment: e.target.value })} /></td>
                      <td className="px-1 py-1 w-12"><input inputMode="numeric" className={cell} value={r.page} onChange={(e) => setRow(i, { page: e.target.value })} /></td>
                      <td className="px-1 py-1 min-w-[8rem]"><input className={cell} value={r.note} onChange={(e) => setRow(i, { note: e.target.value })} /></td>
                      <td className="px-1 py-1"><Button size="sm" variant="ghost" onClick={() => setRows((rs) => rs.filter((_, k) => k !== i))}>Remove</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button size="sm" variant="secondary" onClick={() => setRows((rs) => [...rs, blankRow()])}>+ Add line</Button>
                <span className="mx-1 text-slate-300">|</span>
                <label className="cursor-pointer text-xs text-ink underline">Import lines from CSV…
                  <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void readCsv(f); }} />
                </label>
                <button type="button" className="text-xs text-slate-500 underline" onClick={downloadTemplate}>CSV template</button>
              </div>
              {csv && (
                <div className="mt-2 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
                  {csv.errors.length ? (
                    <><b className="text-red-700">“{csv.name}” was not imported:</b><ul className="mt-1 list-disc pl-5 text-red-700">{csv.errors.slice(0, 20).map((e, i) => <li key={i}>{e}</li>)}</ul></>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <span>“{csv.name}”: {csv.lines.length} line{csv.lines.length === 1 ? '' : 's'} read.</span>
                      <Button size="sm" onClick={() => { setRows((rs) => [...rs.filter((r) => r.policyNumberRaw || r.commission), ...csv.lines.map(toRow)]); setCsv(null); }}>Add to the lines</Button>
                      <Button size="sm" variant="secondary" onClick={() => { setRows(csv.lines.map(toRow)); setCsv(null); }}>Replace the lines</Button>
                      <Button size="sm" variant="ghost" onClick={() => setCsv(null)}>Cancel</Button>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="rounded border border-slate-200 px-3 py-2">
              <div className="mb-1 text-xs font-medium uppercase text-slate-500">Check before applying (same rules as the server)</div>
              {check && !check.ok && <ul className="list-disc pl-5 text-sm text-amber-800">{check.errors.slice(0, 15).map((e, i) => <li key={i}>{e}</li>)}</ul>}
              {check && check.ok && (
                <div className="text-sm">
                  <div className="flex flex-wrap gap-4">
                    <span>Lines: <b>{check.rec.totals.lineCount}</b></span>
                    <span>Sum of commission: <Money cents={check.rec.totals.commissionCents} className="font-semibold" /></span>
                    {check.rec.totals.adjustmentsCents !== 0 && <span>Adjustments: <Money cents={check.rec.totals.adjustmentsCents} /></span>}
                    {check.rec.reconciled ? <Badge tone="green">Matches the printed totals to the cent</Badge> : <Badge tone="red">Does not match yet</Badge>}
                  </div>
                  {!check.rec.reconciled && <ul className="mt-1 list-disc pl-5 text-red-700">{check.rec.blockingReasons.map((b, i) => <li key={i}>{b}</li>)}</ul>}
                </div>
              )}
            </div>

            <Field label="Reason for manual reconciliation (required to apply; kept in the audit log)">
              <TextArea value={head.reason} onChange={(e) => setH({ reason: e.target.value })} placeholder="e.g. Scanned statement; AI could not read it. Keyed from page 1, totals from page 2." />
            </Field>

            <ErrorNote message={error} />
            {serverErrors.length > 0 && <ul className="list-disc pl-5 text-sm text-red-700">{serverErrors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
            {notice && <p className="text-sm text-emerald-700">{notice}</p>}
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" disabled={busy} onClick={() => void send('save_draft')}>Save and continue later</Button>
              <Button disabled={busy || !check?.ok} title={check?.ok ? undefined : 'Complete the fields listed above first'} onClick={() => setConfirming(true)}>Apply manual lines…</Button>
            </div>
            <p className="text-xs text-slate-500">
              Applying replaces this statement’s unposted lines with the lines above and reconciles them against the totals you typed. Matching starts again.
              Approval and posting are separate steps, exactly as for any statement. The original file is never changed.
            </p>
          </div>
        )}
      </Card>

      <Modal open={confirming} title="Apply the manual lines?" onClose={() => setConfirming(false)} width="max-w-md">
        <p className="text-sm text-slate-600">
          {lines.length ? `The ${lines.length} current line${lines.length === 1 ? '' : 's'} of this statement will be replaced by the ${rows.length} manual line${rows.length === 1 ? '' : 's'}. ` : ''}
          Every change is recorded in the audit log with your reason.
          {check?.ok && !check.rec.reconciled ? ' The lines do not match the printed totals yet, so the statement will stay in Discrepancy and cannot be approved until they do.' : ''}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirming(false)}>Cancel</Button>
          <Button disabled={busy} onClick={() => void send('apply')}>Apply</Button>
        </div>
      </Modal>
    </>
  );
}
