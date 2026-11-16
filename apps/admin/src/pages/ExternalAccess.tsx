import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { collection, onSnapshot } from 'firebase/firestore';
import { EXTERNAL_ROLE_LABELS, EXTERNAL_ROLES, type ExternalRole } from '@asm/shared';
import { db } from '../firebase';
import { api, type InviteResult } from '../api';
import { Badge, Button, Card, DataTable, ErrorNote, Field, PageHeader, Select, TextInput } from '../ui';

/**
 * Owner only: grant, review and revoke read-only due-diligence access for Pioneer Bank (buyer) and the
 * independent due-diligence company (reviewer). Each organization has its own accounts; every grant has
 * an end date. Revocation takes effect at the reviewer's next request. All changes are in the audit log.
 */

interface AccessRow { id: string; email: string; role: ExternalRole; organization: string; status: 'active' | 'revoked'; expiresOn: string; invitedAtIso?: string; lastAccessAtIso?: string; revokedAtIso?: string | null; revokeReason?: string | null }

const today = () => new Date().toISOString().slice(0, 10);
const inDays = (d: number) => new Date(Date.now() + d * 86400_000).toISOString().slice(0, 10);

export function ExternalAccessPage() {
  const [rows, setRows] = useState<AccessRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<ExternalRole>('buyer');
  const [expiresOn, setExpiresOn] = useState(inDays(60));
  const [busy, setBusy] = useState(false);
  const [invited, setInvited] = useState<InviteResult & { email: string } | null>(null);

  useEffect(() => onSnapshot(collection(db, 'externalAccess'),
    (s) => setRows(s.docs.map((d) => ({ id: d.id, ...d.data() }) as AccessRow)),
    (e) => setError(e.message)), []);

  const invite = async () => {
    setBusy(true); setError(null); setInvited(null);
    try { const r = await api.inviteExternalUser({ email, role, expiresOn }); setInvited({ ...r, email }); setEmail(''); } catch (e) { setError(e instanceof Error ? e.message : 'Could not grant access'); } finally { setBusy(false); }
  };
  const revoke = async (r: AccessRow) => {
    const reason = window.prompt(`Revoke access for ${r.email}? Give a short reason (recorded in the audit log):`, 'Due-diligence access ended');
    if (!reason || reason.trim().length < 3) return;
    setBusy(true); setError(null);
    try { await api.revokeExternalUser(r.id, reason.trim()); } catch (e) { setError(e instanceof Error ? e.message : 'Could not revoke'); } finally { setBusy(false); }
  };

  const state = (r: AccessRow) => (r.status === 'revoked' ? <Badge tone="slate">Revoked</Badge> : r.expiresOn < today() ? <Badge tone="amber">Expired</Badge> : <Badge tone="green">Active</Badge>);
  return (
    <div className="space-y-4">
      <PageHeader title="External Reviewer Access" subtitle="Read-only acquisition access for Pioneer Bank and the independent due-diligence company. No broker information is ever shown to them." actions={<Link to="/reviewer-preview"><Button size="sm" variant="secondary">Preview what reviewers see</Button></Link>} />
      <ErrorNote message={error} />
      <Card title="Grant access">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Email" className="min-w-[16rem] flex-1"><TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="reviewer@example.com" /></Field>
          <Field label="Organization"><Select value={role} onChange={(e) => setRole(e.target.value as ExternalRole)} options={EXTERNAL_ROLES.map((r) => ({ value: r, label: EXTERNAL_ROLE_LABELS[r] }))} /></Field>
          <Field label="Access ends (inclusive)"><TextInput type="date" value={expiresOn} min={today()} max={inDays(366)} onChange={(e) => setExpiresOn(e.target.value)} /></Field>
          <Button disabled={busy || !email.trim()} onClick={() => void invite()}>{busy ? 'Working…' : 'Grant read-only access'}</Button>
        </div>
        {invited && (
          <div className="mt-3 rounded border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
            Access granted to <b>{invited.email}</b> as {invited.organization} until {invited.expiresOn}. Send them this one-time link to set their password, then they sign in at this site:
            <div className="mt-1 break-all rounded bg-white p-2 font-mono text-xs">{invited.setupLink}</div>
            <div className="mt-1 text-xs">The link is shown only now. If it expires, grant access again to get a new link (or they can use "Forgot password" on the sign-in page).</div>
          </div>
        )}
      </Card>
      <Card title={`Accounts (${rows.length})`}>
        <DataTable rows={rows} pageSize={25} searchText={(r) => `${r.email} ${r.organization}`}
          columns={[
            { key: 'email', header: 'Email', render: (r) => r.email, sort: (r) => r.email },
            { key: 'org', header: 'Organization', render: (r) => r.organization, sort: (r) => r.organization },
            { key: 'state', header: 'Status', render: state },
            { key: 'exp', header: 'Access ends', render: (r) => r.expiresOn, sort: (r) => r.expiresOn },
            { key: 'last', header: 'Last access', render: (r) => (r.lastAccessAtIso ? new Date(r.lastAccessAtIso).toLocaleString() : 'Never') },
            { key: 'act', header: '', align: 'right', render: (r) => (r.status === 'active' ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void revoke(r)}>Revoke</Button> : <span className="text-xs text-slate-500">{r.revokeReason ?? ''}</span>) },
          ]} />
      </Card>
    </div>
  );
}
