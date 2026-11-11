import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { api, type BookExportResponse } from '../api';
import { useAuth } from '../auth';
import { Button, Card, ErrorNote, Modal, PageHeader } from '../ui';

/**
 * Customer & Policy Export: Customer Folder Checklist and Policy Detail Export, as Excel workbooks built on
 * the server from EVERY customer and policy record (not the rows on screen), for internal users only
 * (admin, staff). No commission, premium, broker compensation or acquisition-financial figures.
 */

/** Internal roles allowed to export. Must match EXPORT_ROLES in functions/src/callables/exports.ts. */
export const canExportBook = (role: string | null) => role === 'admin' || role === 'staff';

function download(name: string, base64: string) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
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

export function BookExportForm() {
  const [format, setFormat] = useState<'folder_checklist' | 'policy_detail'>('folder_checklist');
  const [scope, setScope] = useState<'active' | 'all'>('active');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<BookExportResponse | null>(null);

  const run = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.exportBook({ format, scope });
      download(r.fileName, r.fileBase64);
      setLast(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1 text-xs font-medium text-slate-600">Export</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Choice name="format" value="folder_checklist" checked={format === 'folder_checklist'} onChange={() => setFormat('folder_checklist')} title="Customer Folder Checklist">
            One row per customer, A–Z: name, customer ID, number of active policies, and blank boxes for File Located, File Reviewed, Ready for Pioneer and Box Number. Prints on letter paper with the header on every page.
          </Choice>
          <Choice name="format" value="policy_detail" checked={format === 'policy_detail'} onChange={() => setFormat('policy_detail')} title="Policy Detail Export">
            One row per policy: customer name, policy number, carrier, policy type, effective and expiration dates, policy status and broker.
          </Choice>
        </div>
      </div>
      <div>
        <div className="mb-1 text-xs font-medium text-slate-600">Records</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Choice name="scope" value="active" checked={scope === 'active'} onChange={() => setScope('active')} title="Active only">
            Based on policy status: the checklist lists customers with at least one active policy; the policy export lists active policies only.
          </Choice>
          <Choice name="scope" value="all" checked={scope === 'all'} onChange={() => setScope('all')} title="All records">Every customer, or every policy, whatever its status.</Choice>
        </div>
      </div>
      <p className="text-xs text-slate-500">
        Excel workbook (.xlsx). Every matching record is included, not only the customers shown on screen. Policy numbers and IDs are stored as text, so leading zeros are kept.
        No commission, premium, broker compensation or acquisition financial data. Internal use only; each export is recorded in the audit log.
      </p>
      <ErrorNote message={error} />
      {last && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Downloaded <span className="font-mono">{last.fileName}</span>: {last.subtitle}
          {' '}(from {last.totalClientRecords.toLocaleString()} customer and {last.totalPolicyRecords.toLocaleString()} policy records).
          {last.orphanPolicies > 0 && <span className="block text-amber-800">{last.orphanPolicies} policy record(s) refer to a customer that no longer exists; they are listed at the end as "(customer record missing)".</span>}
        </div>
      )}
      <div className="flex justify-end"><Button disabled={busy} onClick={() => void run()}>{busy ? 'Preparing…' : 'Download Excel file'}</Button></div>
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
