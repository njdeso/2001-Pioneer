import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import type { AuditEvent } from '@asm/shared';
import { db } from '../firebase';
import { useAuth } from '../auth';
import { Card, DataTable, Money } from '../ui';

const stampToText = (v: unknown) => {
  const t = v as { toDate?: () => Date } | null;
  return t?.toDate ? t.toDate().toLocaleString() : '';
};

/**
 * Permanent history of AI-extracted figures corrected by a carrier reading rule on this statement (admins
 * only — the audit log is admin-read). Read from the audit log, so it survives every re-read.
 */
export function AiCorrectionHistory({ statementId }: { statementId: string }) {
  const { role } = useAuth();
  const [rows, setRows] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (role !== 'admin') return;
    // One equality filter (no composite index); the few audit entries per statement are filtered here.
    return onSnapshot(query(collection(db, 'auditLog'), where('entityId', '==', statementId)),
      (s) => setRows(s.docs.map((d) => ({ id: d.id, ...d.data() }) as AuditEvent)
        .filter((e) => e.action === 'ai_value_corrected' && e.entityType === 'statement')
        .sort((a, b) => ((b.at as { toMillis?: () => number })?.toMillis?.() ?? 0) - ((a.at as { toMillis?: () => number })?.toMillis?.() ?? 0))),
      () => setError('The correction history could not be loaded.'));
  }, [role, statementId]);
  if (role !== 'admin' || (!rows.length && !error)) return null;
  const d = (e: AuditEvent) => (e.detail ?? {}) as { runId?: string; lineNo?: number; policyNumber?: string; originalCents?: number; correctedCents?: number; reason?: string; arithmetic?: string };
  return (
    <Card title={`AI-extracted values corrected (${rows.length}) — permanent history, kept across re-reads`}>
      {error && <p className="text-sm text-red-700">{error}</p>}
      <DataTable rows={rows} pageSize={10}
        columns={[
          { key: 'at', header: 'When', render: (e) => stampToText(e.at) },
          { key: 'run', header: 'Run', render: (e) => <span className="font-mono text-xs">{d(e).runId ?? '—'}</span> },
          { key: 'line', header: 'Line / policy', render: (e) => `${d(e).lineNo ?? '?'} / ${d(e).policyNumber ?? '?'}` },
          { key: 'read', header: 'AI read', render: (e) => d(e).originalCents != null ? <Money cents={d(e).originalCents!} /> : '—' },
          { key: 'used', header: 'Corrected to', render: (e) => d(e).correctedCents != null ? <Money cents={d(e).correctedCents!} /> : '—' },
          { key: 'why', header: 'Reason and arithmetic', className: 'whitespace-normal max-w-md', render: (e) => <span className="text-xs">{d(e).reason ? `${d(e).reason}. ${d(e).arithmetic ?? ''}` : e.summary}</span> },
          { key: 'who', header: 'Re-read by', render: (e) => e.actorEmail },
        ]}
        empty="No corrections." />
    </Card>
  );
}
