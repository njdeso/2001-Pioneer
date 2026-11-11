import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { api, type BookExportResponse } from '../api';
import { useAuth } from '../auth';
import { Button, Card, ErrorNote, Modal, PageHeader } from '../ui';

/**
 * Customer & Policy Export. The file is built on the server from EVERY customer and policy record (not the
 * rows on screen) and only for internal users (admin, staff). It contains no commission, premium, broker
 * compensation or acquisition-financial figures. Not part of the Due Diligence Package.
 */

/** Internal roles allowed to export. Must match EXPORT_ROLES in functions/src/callables/exports.ts. */
export const canExportBook = (role: string | null) => role === 'admin' || role === 'staff';

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const Choice = ({ name, value, checked, onChange, title, children }: { name: string; value: string; checked: boolean; onChange: () => void; title: string; children: ReactNode }) => (
  <label className={`flex cursor-pointer gap-2 rounded-md border px-3 py-2 text-sm ${checked ? 'border-ink bg-slate-50' : 'border-slate-200'}`}>
    <input type="radio" name={name} value={value} checked={checked} onChange={onChange} className="mt-0.5" />
    <span><span className="font-medium text-slate-800">{title}</span><span className="block text-xs text-slate-500">{children}</span></span>
  </label>
);

export function BookExportForm({ onDone }: { onDone?: () => void }) {
  const [format, setFormat] = useState<'customer_summary' | 'policy_detail'>('customer_summary');
  const [scope, setScope] = useState<'all' | 'active'>('active');
  const [includeFileTracking, setTracking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<BookExportResponse | null>(null);

  const run = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.exportBook({ format, scope, includeFileTracking });
      download(r.fileName, r.csv);
      setLast(r);
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1 text-xs font-medium text-slate-600">Customers</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Choice name="scope" value="active" checked={scope === 'active'} onChange={() => setScope('active')} title="Active customers only">Customers whose status is Active, with all their policies.</Choice>
          <Choice name="scope" value="all" checked={scope === 'all'} onChange={() => setScope('all')} title="All customers">Active and inactive customers.</Choice>
        </div>
      </div>
      <div>
        <div className="mb-1 text-xs font-medium text-slate-600">Format</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Choice name="format" value="customer_summary" checked={format === 'customer_summary'} onChange={() => setFormat('customer_summary')} title="Customer Summary">One row per customer: ID, status, broker, policy count, policy numbers, carriers, types, earliest effective and latest expiration.</Choice>
          <Choice name="format" value="policy_detail" checked={format === 'policy_detail'} onChange={() => setFormat('policy_detail')} title="Policy Detail">One row per policy: customer, policy number, carrier, type, effective and expiration dates, status, broker. Customers without policies get one row.</Choice>
        </div>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={includeFileTracking} onChange={(e) => setTracking(e.target.checked)} className="mt-0.5" />
        <span><span className="font-medium text-slate-800">Include physical file tracking</span>
          <span className="block text-xs text-slate-500">Adds File Reviewed, Review Status, Box Number and Transfer Date (entered on each customer's page).</span></span>
      </label>
      <p className="text-xs text-slate-500">
        Every matching record is exported, not only the customers shown on screen. Sorted alphabetically by customer. CSV for Microsoft Excel; policy numbers and IDs are kept as text (leading zeros, no scientific notation).
        No commission, premium, broker compensation or acquisition financial data is included. Internal use only — not for the Due Diligence Package. Each export is recorded in the audit log.
      </p>
      <ErrorNote message={error} />
      {last && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Downloaded <span className="font-mono">{last.fileName}</span>: {last.customers.toLocaleString()} customers, {last.policies.toLocaleString()} policies, {last.rows.toLocaleString()} rows
          {' '}(of {last.totalClientRecords.toLocaleString()} customer and {last.totalPolicyRecords.toLocaleString()} policy records).
          {last.orphanPolicies > 0 && <span className="block text-amber-800">{last.orphanPolicies} policy record(s) refer to a customer that no longer exists; they are listed at the end of the Policy Detail file.</span>}
        </div>
      )}
      <div className="flex justify-end"><Button disabled={busy} onClick={() => void run()}>{busy ? 'Preparing…' : 'Export CSV'}</Button></div>
    </div>
  );
}

/** Export button + dialog for the Clients & Policies page. Hidden for anyone who may not export. */
export function BookExportButton() {
  const { role } = useAuth();
  const [open, setOpen] = useState(false);
  if (!canExportBook(role)) return null;
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>Export</Button>
      <Modal open={open} title="Customer & Policy Export" onClose={() => setOpen(false)}>
        <BookExportForm />
      </Modal>
    </>
  );
}

export function ReportsPage() {
  const { role } = useAuth();
  return (
    <div className="space-y-4">
      <PageHeader title="Reports & Analytics" subtitle="Internal reports and exports" />
      {canExportBook(role) ? (
        <Card title="Customer & Policy Export"><BookExportForm /></Card>
      ) : (
        <Card title="Customer & Policy Export"><p className="text-sm text-slate-600">You do not have permission to export customer and policy records.</p></Card>
      )}
      <Card title="Other reports">
        <p className="text-sm text-slate-600">
          Commission reporting from the posted ledger is on the <Link className="font-medium text-ink underline" to="/">Dashboard</Link> and the <Link className="font-medium text-ink underline" to="/ledger">Ledger</Link> (with CSV export).
          Buyer-ready files are on the <Link className="font-medium text-ink underline" to="/package">Due Diligence Package</Link> page. Formatted financial reports (by carrier, line and month, year-over-year) are planned for Phase 5.
        </p>
      </Card>
    </div>
  );
}
