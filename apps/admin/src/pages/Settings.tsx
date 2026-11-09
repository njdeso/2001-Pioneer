import { useEffect, useState, type FormEvent } from 'react';
import { collection, doc, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { formatBps, formatWindow, parsePercentToBps, settingsInput, fieldErrors, type AuditEvent } from '@asm/shared';
import { db } from '../firebase';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { useData } from '../data';
import { Button, Card, DataTable, ErrorNote, Field, PageHeader, TextInput } from '../ui';

function stampToText(v: unknown): string {
  const t = v as { toDate?: () => Date } | null;
  return t?.toDate ? t.toDate().toLocaleString() : '';
}

export function SettingsPage() {
  const { settings } = useData();
  const { user, role } = useAuth();
  const [f, setF] = useState({ agencyName: '', snapshotStartMonth: '', snapshotMonths: '12', share: '50', aiEnabled: false, aiModel: 'claude-sonnet-5-5', aiLimit: '100' });
  const [usage, setUsage] = useState<{ calls?: number; inputTokens?: number; outputTokens?: number } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<AuditEvent[]>([]);

  useEffect(() => {
    if (!settings) return;
    setF({
      agencyName: settings.agencyName,
      snapshotStartMonth: settings.snapshotStartMonth,
      snapshotMonths: String(settings.snapshotMonths ?? 12),
      share: formatBps(settings.defaultBrokerShareBps ?? 5000).replace('%', ''),
      aiEnabled: settings.aiEnabled ?? false,
      aiModel: settings.aiModel ?? 'claude-sonnet-5-5',
      aiLimit: String(settings.aiMonthlyCallLimit ?? 100),
    });
  }, [settings]);

  useEffect(() => {
    if (role !== 'admin') return;
    return onSnapshot(doc(db, 'aiUsage', new Date().toISOString().slice(0, 7)), (s) => setUsage(s.exists() ? s.data() : null));
  }, [role]);

  useEffect(() => {
    if (role !== 'admin') return;
    return onSnapshot(query(collection(db, 'auditLog'), orderBy('at', 'desc'), limit(200)),
      (s) => setEvents(s.docs.map((d) => ({ id: d.id, ...d.data() }) as AuditEvent)));
  }, [role]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null); setSaved(false);
    let share: number;
    try { share = parsePercentToBps(f.share); } catch { setErrors({ defaultBrokerShareBps: 'Enter a percentage' }); return; }
    const parsed = settingsInput.safeParse({
      agencyName: f.agencyName, snapshotStartMonth: f.snapshotStartMonth,
      snapshotMonths: Number(f.snapshotMonths), revenueBasis: 'statementPeriod', defaultBrokerShareBps: share,
      aiEnabled: f.aiEnabled, aiModel: f.aiModel, aiMonthlyCallLimit: Number(f.aiLimit),
    });
    if (!parsed.success) { setErrors(fieldErrors(parsed.error)); return; }
    setErrors({}); setBusy(true);
    try {
      await api.saveSettings(parsed.data);
      setSaved(true);
    } catch (err) {
      if (err instanceof ApiError) { setErrors(err.fieldErrors); setError(err.message); } else setError('Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Administration & Settings" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card title="Snapshot" className="lg:col-span-2">
          <form onSubmit={(e) => void submit(e)} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Agency name" error={errors.agencyName} className="sm:col-span-2">
              <TextInput value={f.agencyName} onChange={(e) => setF({ ...f, agencyName: e.target.value })} />
            </Field>
            <Field label="First month of the window" error={errors.snapshotStartMonth}
              hint={f.snapshotStartMonth.match(/^\d{4}-\d{2}$/) ? formatWindow(f.snapshotStartMonth, Number(f.snapshotMonths) || 12) : 'YYYY-MM'}>
              <TextInput type="month" value={f.snapshotStartMonth} onChange={(e) => setF({ ...f, snapshotStartMonth: e.target.value })} />
            </Field>
            <Field label="Months in window" error={errors.snapshotMonths}>
              <TextInput type="number" min={1} max={36} value={f.snapshotMonths} onChange={(e) => setF({ ...f, snapshotMonths: e.target.value })} />
            </Field>
            <Field label="Default broker share %" error={errors.defaultBrokerShareBps} hint="Used when adding brokers">
              <TextInput value={f.share} onChange={(e) => setF({ ...f, share: e.target.value })} />
            </Field>
            <Field label="Revenue month" hint="Decided: commissions count in their statement-period month">
              <TextInput value="Statement period" disabled />
            </Field>
            <div className="border-t border-slate-100 pt-4 sm:col-span-2">
              <h3 className="text-sm font-semibold text-ink">AI statement reader (Claude)</h3>
              <p className="mt-1 text-xs text-slate-500">
                Used only for statement layouts without a built-in parser (Travelers is parsed without AI). Runs on the server; the API key is a
                Firebase secret and is never sent to the browser. AI results are never posted automatically.
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={f.aiEnabled} onChange={(e) => setF({ ...f, aiEnabled: e.target.checked })} /> Turn on the AI reader
            </label>
            <Field label="Model" error={errors.aiModel}>
              <TextInput value={f.aiModel} onChange={(e) => setF({ ...f, aiModel: e.target.value })} />
            </Field>
            <Field label="Monthly limit (statements read by AI)" error={errors.aiMonthlyCallLimit}
              hint={usage ? `This month: ${usage.calls ?? 0} statements, ${(usage.inputTokens ?? 0).toLocaleString()} input / ${(usage.outputTokens ?? 0).toLocaleString()} output tokens` : 'No AI use this month'}>
              <TextInput type="number" min={0} max={2000} value={f.aiLimit} onChange={(e) => setF({ ...f, aiLimit: e.target.value })} />
            </Field>
            <div className="sm:col-span-2">
              <ErrorNote message={error} />
              <div className="mt-2 flex items-center gap-3">
                <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</Button>
                {saved && <span className="text-sm text-emerald-700">Saved.</span>}
              </div>
            </div>
          </form>
        </Card>
        <Card title="Your account">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between"><dt className="text-slate-500">Email</dt><dd>{user?.email}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Role</dt><dd className="capitalize">{role}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Session</dt><dd>Ends on tab close or 30 min idle</dd></div>
          </dl>
        </Card>
      </div>

      {role === 'admin' && (
        <Card title="Audit log (latest 200)">
          <DataTable rows={events} pageSize={20} searchText={(e) => `${e.action} ${e.entityType} ${e.summary} ${e.actorEmail}`}
            columns={[
              { key: 'at', header: 'When', render: (e) => stampToText(e.at) },
              { key: 'who', header: 'User', render: (e) => e.actorEmail },
              { key: 'action', header: 'Action', render: (e) => e.action },
              { key: 'entity', header: 'Record', render: (e) => `${e.entityType} ${e.entityId.slice(0, 8)}` },
              { key: 'summary', header: 'Summary', render: (e) => e.summary },
              { key: 'fields', header: 'Fields changed', render: (e) => Object.keys(e.changes ?? {}).slice(0, 4).join(', ') || '—' },
            ]}
            empty="No activity yet." />
        </Card>
      )}
    </div>
  );
}
