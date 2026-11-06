import { useState, type FormEvent, type ReactNode } from 'react';
import {
  brokerInput, carrierInput, clientInput, fieldErrors, formatBps, formatCents, parseMoneyToCents, parsePercentToBps, policyInput,
  UNASSIGNED_BROKER_ID, type Broker, type Carrier, type Client, type Policy,
} from '@asm/shared';
import type { ZodType, z } from 'zod';
import { api, ApiError } from './api';
import { useData } from './data';
import { Button, ErrorNote, Field, Modal, Select, TextArea, TextInput } from './ui';

/** Shared submit flow: validate locally with the same schema the server uses, then call the API. */
function useSubmit() {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run<S extends ZodType>(schema: S, raw: unknown, send: (data: z.output<S>) => Promise<unknown>, done: () => void) {
    setFormError(null);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) { setErrors(fieldErrors(parsed.error)); return; }
    setErrors({}); setBusy(true);
    try {
      await send(parsed.data);
      done();
    } catch (err) {
      if (err instanceof ApiError) { setErrors(err.fieldErrors); setFormError(err.message); }
      else setFormError('Something went wrong.');
    } finally {
      setBusy(false);
    }
  }
  return { errors, setErrors, formError, setFormError, busy, run };
}

function Actions({ busy, onCancel, label = 'Save' }: { busy: boolean; onCancel: () => void; label?: string }) {
  return (
    <div className="mt-5 flex justify-end gap-2 border-t border-slate-100 pt-4">
      <Button variant="secondary" onClick={onCancel}>Cancel</Button>
      <Button type="submit" disabled={busy}>{busy ? 'Saving…' : label}</Button>
    </div>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div>;
}

const STATUS_OPTIONS = [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }];

// ---------------- Carrier / wholesaler ----------------

export function CarrierForm({ open, onClose, carrier, defaultKind = 'carrier', initialName = '' }: {
  open: boolean; onClose: () => void; carrier?: Carrier; defaultKind?: 'carrier' | 'wholesaler'; initialName?: string;
}) {
  const [f, setF] = useState(() => ({
    name: carrier?.name ?? initialName,
    code: carrier?.code ?? '',
    kind: carrier?.kind ?? defaultKind,
    commissionMethod: carrier?.commissionMethod ?? 'statement',
    rate: carrier?.defaultRateBps != null ? formatBps(carrier.defaultRateBps).replace('%', '') : '',
    aliases: (carrier?.aliases ?? []).join(', '),
    status: carrier?.status ?? 'active',
    contactName: carrier?.contact?.name ?? '',
    phone: carrier?.contact?.phone ?? '',
    email: carrier?.contact?.email ?? '',
    address: carrier?.contact?.address ?? '',
    notes: carrier?.contact?.notes ?? '',
  }));
  const s = useSubmit();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  function submit(e: FormEvent) {
    e.preventDefault();
    let rate: number | null = null;
    if (f.rate.trim()) {
      try { rate = parsePercentToBps(f.rate); } catch { s.setErrors({ defaultRateBps: 'Enter a percentage like 15 or 7.5' }); return; }
    }
    void s.run(carrierInput, {
      name: f.name, code: f.code, kind: f.kind, commissionMethod: f.commissionMethod, defaultRateBps: rate,
      aliases: f.aliases.split(',').map((a) => a.trim()).filter(Boolean), status: f.status,
      contact: { name: f.contactName, phone: f.phone, email: f.email, address: f.address, notes: f.notes },
    }, (data) => api.saveCarrier(data, carrier?.id), onClose);
  }

  return (
    <Modal open={open} onClose={onClose} title={carrier ? `Edit ${carrier.name}` : 'Add carrier or wholesaler'}>
      <form onSubmit={submit}>
        <Grid>
          <Field label="Name" error={s.errors.name}><TextInput value={f.name} onChange={set('name')} autoFocus /></Field>
          <Field label="Code" error={s.errors.code} hint="Short unique code, e.g. LANCER, JJ, CRC"><TextInput value={f.code} onChange={set('code')} /></Field>
          <Field label="Type" error={s.errors.kind}>
            <Select value={f.kind} onChange={set('kind')} options={[{ value: 'carrier', label: 'Insurance carrier' }, { value: 'wholesaler', label: 'Wholesaler / MGA' }]} />
          </Field>
          <Field label="How commission is received" error={s.errors.commissionMethod}>
            <Select value={f.commissionMethod} onChange={set('commissionMethod')} options={[
              { value: 'statement', label: 'Paid by commission statement' },
              { value: 'retained', label: 'Retained from premium (e.g. Lancer)' },
            ]} />
          </Field>
          <Field label="Standard commission %" error={s.errors.defaultRateBps} hint="Optional. Used for checks, never to create revenue.">
            <TextInput value={f.rate} onChange={set('rate')} inputMode="decimal" placeholder="e.g. 10" />
          </Field>
          <Field label="Status"><Select value={f.status} onChange={set('status')} options={STATUS_OPTIONS} /></Field>
          <Field label="Other names on statements" hint="Comma-separated aliases" className="sm:col-span-2" error={s.errors.aliases}>
            <TextInput value={f.aliases} onChange={set('aliases')} />
          </Field>
        </Grid>
        <h3 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-slate-500">Contact</h3>
        <Grid>
          <Field label="Contact name" error={s.errors['contact.name']}><TextInput value={f.contactName} onChange={set('contactName')} /></Field>
          <Field label="Phone" error={s.errors['contact.phone']}><TextInput value={f.phone} onChange={set('phone')} /></Field>
          <Field label="Email" error={s.errors['contact.email']}><TextInput value={f.email} onChange={set('email')} /></Field>
          <Field label="Address" error={s.errors['contact.address']}><TextInput value={f.address} onChange={set('address')} /></Field>
          <Field label="Notes" className="sm:col-span-2"><TextArea value={f.notes} onChange={set('notes')} /></Field>
        </Grid>
        <div className="mt-3"><ErrorNote message={s.formError} /></div>
        <Actions busy={s.busy} onCancel={onClose} />
      </form>
    </Modal>
  );
}

// ---------------- Broker ----------------

export function BrokerForm({ open, onClose, broker }: { open: boolean; onClose: () => void; broker?: Broker }) {
  const { settings } = useData();
  const [f, setF] = useState(() => ({
    name: broker?.name ?? '',
    code: broker?.code ?? '',
    share: formatBps(broker?.shareBps ?? settings?.defaultBrokerShareBps ?? 5000).replace('%', ''),
    status: broker?.status ?? 'active',
  }));
  const s = useSubmit();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const isUnassigned = broker?.id === UNASSIGNED_BROKER_ID;

  function submit(e: FormEvent) {
    e.preventDefault();
    let share: number;
    try { share = parsePercentToBps(f.share); } catch { s.setErrors({ shareBps: 'Enter a percentage like 50' }); return; }
    void s.run(brokerInput, { name: f.name, code: f.code, shareBps: share, status: f.status },
      (data) => api.saveBroker(data, broker?.id), onClose);
  }

  return (
    <Modal open={open} onClose={onClose} title={broker ? `Edit ${broker.name}` : 'Add broker'} width="max-w-lg">
      <form onSubmit={submit}>
        <Grid>
          <Field label="Name" error={s.errors.name}><TextInput value={f.name} onChange={set('name')} autoFocus /></Field>
          <Field label="Broker ID / code" error={s.errors.code}><TextInput value={f.code} onChange={set('code')} disabled={isUnassigned} /></Field>
          <Field label="Broker share of commission %" error={s.errors.shareBps} hint="Internal only. Never included in the buyer package.">
            <TextInput value={f.share} onChange={set('share')} inputMode="decimal" disabled={isUnassigned} />
          </Field>
          <Field label="Status"><Select value={f.status} onChange={set('status')} options={STATUS_OPTIONS} disabled={isUnassigned} /></Field>
        </Grid>
        <div className="mt-3"><ErrorNote message={s.formError} /></div>
        <Actions busy={s.busy} onCancel={onClose} />
      </form>
    </Modal>
  );
}

// ---------------- Client ----------------

export function ClientForm({ open, onClose, client, onSaved }: {
  open: boolean; onClose: () => void; client?: Client; onSaved?: (id: string) => void;
}) {
  const { brokers } = useData();
  const [f, setF] = useState(() => ({
    name: client?.name ?? '',
    externalId: client?.externalId ?? '',
    classification: client?.classification ?? 'commercial',
    brokerId: client?.brokerId ?? UNASSIGNED_BROKER_ID,
    status: client?.status ?? 'active',
    contactName: client?.contact?.name ?? '',
    phone: client?.contact?.phone ?? '',
    email: client?.contact?.email ?? '',
    address: client?.contact?.address ?? '',
    notes: client?.contact?.notes ?? '',
  }));
  const [applyToPolicies, setApply] = useState(true);
  const s = useSubmit();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const brokerChanged = client && client.brokerId !== f.brokerId;

  function submit(e: FormEvent) {
    e.preventDefault();
    void s.run(clientInput, {
      name: f.name, externalId: f.externalId, classification: f.classification, brokerId: f.brokerId, status: f.status,
      contact: { name: f.contactName, phone: f.phone, email: f.email, address: f.address, notes: f.notes },
    }, async (data) => {
      const res = await api.saveClient(data, client?.id, !!brokerChanged && applyToPolicies);
      onSaved?.(res.id);
    }, onClose);
  }

  return (
    <Modal open={open} onClose={onClose} title={client ? `Edit ${client.name}` : 'Add client'}>
      <form onSubmit={submit}>
        <Grid>
          <Field label="Client name" error={s.errors.name} className="sm:col-span-2"><TextInput value={f.name} onChange={set('name')} autoFocus /></Field>
          <Field label="Client ID in your system" error={s.errors.externalId} hint="Optional; used to match future imports">
            <TextInput value={f.externalId} onChange={set('externalId')} />
          </Field>
          <Field label="Classification" error={s.errors.classification}>
            <Select value={f.classification} onChange={set('classification')} options={[{ value: 'commercial', label: 'Commercial' }, { value: 'personal', label: 'Personal' }]} />
          </Field>
          <Field label="Assigned broker" error={s.errors.brokerId}>
            <Select value={f.brokerId} onChange={set('brokerId')} options={brokers.map((b) => ({ value: b.id, label: b.name }))} />
          </Field>
          <Field label="Status"><Select value={f.status} onChange={set('status')} options={STATUS_OPTIONS} /></Field>
          {brokerChanged && (
            <label className="flex items-center gap-2 self-end text-sm text-slate-600">
              <input type="checkbox" checked={applyToPolicies} onChange={(e) => setApply(e.target.checked)} />
              Also move this client's policies to the new broker
            </label>
          )}
        </Grid>
        <h3 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-slate-500">Contact (optional)</h3>
        <Grid>
          <Field label="Contact name"><TextInput value={f.contactName} onChange={set('contactName')} /></Field>
          <Field label="Phone"><TextInput value={f.phone} onChange={set('phone')} /></Field>
          <Field label="Email" error={s.errors['contact.email']}><TextInput value={f.email} onChange={set('email')} /></Field>
          <Field label="Address"><TextInput value={f.address} onChange={set('address')} /></Field>
          <Field label="Notes" className="sm:col-span-2"><TextArea value={f.notes} onChange={set('notes')} /></Field>
        </Grid>
        <div className="mt-3"><ErrorNote message={s.formError} /></div>
        <Actions busy={s.busy} onCancel={onClose} />
      </form>
    </Modal>
  );
}

// ---------------- Policy ----------------

export function PolicyForm({ open, onClose, client, policy }: {
  open: boolean; onClose: () => void; client: Client; policy?: Policy;
}) {
  const { carriers, brokers } = useData();
  const insurers = carriers.filter((c) => c.kind === 'carrier');
  const wholesalers = carriers.filter((c) => c.kind === 'wholesaler');
  const [f, setF] = useState(() => ({
    carrierId: policy?.carrierId ?? '',
    wholesalerId: policy?.wholesalerId ?? '',
    policyNumber: policy?.policyNumber ?? '',
    alternateNumbers: (policy?.alternateNumbers ?? []).join(', '),
    policyType: policy?.policyType ?? '',
    line: policy?.line ?? client.classification,
    namedInsured: policy?.namedInsured ?? client.name,
    brokerId: policy?.brokerId ?? client.brokerId ?? UNASSIGNED_BROKER_ID,
    effectiveDate: policy?.effectiveDate ?? '',
    expirationDate: policy?.expirationDate ?? '',
    premium: policy?.premiumCents != null ? formatCents(policy.premiumCents, { symbol: false }) : '',
    rate: policy?.commissionRateBps != null ? formatBps(policy.commissionRateBps).replace('%', '') : '',
    status: policy?.status ?? 'active',
  }));
  const s = useSubmit();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  function submit(e: FormEvent) {
    e.preventDefault();
    let premiumCents: number | null = null;
    let rate: number | null = null;
    try { if (f.premium.trim()) premiumCents = parseMoneyToCents(f.premium); } catch { s.setErrors({ premiumCents: 'Enter an amount like 2,450.00' }); return; }
    try { if (f.rate.trim()) rate = parsePercentToBps(f.rate); } catch { s.setErrors({ commissionRateBps: 'Enter a percentage like 10' }); return; }
    void s.run(policyInput, {
      clientId: client.id, carrierId: f.carrierId, wholesalerId: f.wholesalerId || null,
      policyNumber: f.policyNumber, alternateNumbers: f.alternateNumbers.split(',').map((a) => a.trim()).filter(Boolean),
      policyType: f.policyType, line: f.line, namedInsured: f.namedInsured, brokerId: f.brokerId,
      effectiveDate: f.effectiveDate || null, expirationDate: f.expirationDate || null,
      premiumCents, commissionRateBps: rate, status: f.status,
    }, (data) => api.savePolicy(data, policy?.id), onClose);
  }

  return (
    <Modal open={open} onClose={onClose} title={policy ? `Edit policy ${policy.policyNumber}` : `Add policy for ${client.name}`}>
      <form onSubmit={submit}>
        <Grid>
          <Field label="Policy number" error={s.errors.policyNumber}><TextInput value={f.policyNumber} onChange={set('policyNumber')} autoFocus /></Field>
          <Field label="Insurance carrier" error={s.errors.carrierId}>
            <Select value={f.carrierId} onChange={set('carrierId')} placeholder="Select carrier…" options={[
              ...insurers.map((c) => ({ value: c.id, label: c.name })),
              ...(f.wholesalerId ? [{ value: f.wholesalerId, label: 'Unknown — placed via the wholesaler' }] : []),
            ]} />
          </Field>
          <Field label="Placed through wholesaler" error={s.errors.wholesalerId} hint="Leave blank if placed direct">
            <Select value={f.wholesalerId} onChange={set('wholesalerId')} placeholder="Direct with carrier" options={wholesalers.map((c) => ({ value: c.id, label: c.name }))} />
          </Field>
          <Field label="Policy type" error={s.errors.policyType} hint="e.g. Commercial Auto, BOP, Homeowners"><TextInput value={f.policyType} onChange={set('policyType')} /></Field>
          <Field label="Line" error={s.errors.line}>
            <Select value={f.line} onChange={set('line')} options={[{ value: 'commercial', label: 'Commercial' }, { value: 'personal', label: 'Personal' }]} />
          </Field>
          <Field label="Assigned broker" error={s.errors.brokerId}>
            <Select value={f.brokerId} onChange={set('brokerId')} options={brokers.map((b) => ({ value: b.id, label: b.name }))} />
          </Field>
          <Field label="Named insured" error={s.errors.namedInsured} className="sm:col-span-2"><TextInput value={f.namedInsured} onChange={set('namedInsured')} /></Field>
          <Field label="Effective date" error={s.errors.effectiveDate}><TextInput type="date" value={f.effectiveDate} onChange={set('effectiveDate')} /></Field>
          <Field label="Expiration date" error={s.errors.expirationDate}><TextInput type="date" value={f.expirationDate} onChange={set('expirationDate')} /></Field>
          <Field label="Premium" error={s.errors.premiumCents} hint="Optional"><TextInput value={f.premium} onChange={set('premium')} inputMode="decimal" placeholder="0.00" /></Field>
          <Field label="Commission %" error={s.errors.commissionRateBps} hint="Optional; overrides the carrier's standard rate"><TextInput value={f.rate} onChange={set('rate')} inputMode="decimal" /></Field>
          <Field label="Status">
            <Select value={f.status} onChange={set('status')} options={[
              { value: 'active', label: 'Active' }, { value: 'pending', label: 'Pending' },
              { value: 'cancelled', label: 'Cancelled' }, { value: 'expired', label: 'Expired' },
            ]} />
          </Field>
          <Field label="Alternate policy numbers" hint="Comma-separated, as they appear on statements" error={s.errors.alternateNumbers}>
            <TextInput value={f.alternateNumbers} onChange={set('alternateNumbers')} />
          </Field>
        </Grid>
        <div className="mt-3"><ErrorNote message={s.formError} /></div>
        <Actions busy={s.busy} onCancel={onClose} />
      </form>
    </Modal>
  );
}
