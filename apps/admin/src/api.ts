import { httpsCallable } from 'firebase/functions';
import type { BrokerInput, CarrierInput, ClientInput, PolicyInput, SettingsInput } from '@asm/shared';
import { functions } from './firebase';

/** Error carrying per-field messages from the server for forms. */
export class ApiError extends Error {
  fieldErrors: Record<string, string>;
  constructor(message: string, fieldErrors: Record<string, string> = {}) {
    super(message);
    this.fieldErrors = fieldErrors;
  }
}

async function call<Req, Res>(name: string, data: Req): Promise<Res> {
  try {
    const res = await httpsCallable<Req, Res>(functions, name)(data);
    return res.data;
  } catch (err: unknown) {
    const e = err as { message?: string; details?: { fieldErrors?: Record<string, string> } };
    throw new ApiError(e.message?.replace(/^.*?:\s*/, '') || 'Request failed', e.details?.fieldErrors ?? {});
  }
}

export const api = {
  claimOwner: () => call<Record<string, never>, { role: string }>('claimOwner', {}),
  saveSettings: (data: SettingsInput) => call<SettingsInput, { ok: true }>('saveSettings', data),
  saveCarrier: (data: CarrierInput, id?: string) =>
    call<{ id?: string; data: CarrierInput }, { id: string }>('saveCarrier', { id, data }),
  saveBroker: (data: BrokerInput, id?: string) =>
    call<{ id?: string; data: BrokerInput }, { id: string }>('saveBroker', { id, data }),
  saveClient: (data: ClientInput, id?: string, applyBrokerToPolicies = false) =>
    call<{ id?: string; data: ClientInput; applyBrokerToPolicies: boolean }, { id: string; policiesMoved: number }>(
      'saveClient', { id, data, applyBrokerToPolicies }),
  savePolicy: (data: PolicyInput, id?: string) =>
    call<{ id?: string; data: PolicyInput }, { id: string }>('savePolicy', { id, data }),
  reassignPolicies: (policyIds: string[], brokerId: string) =>
    call<{ policyIds: string[]; brokerId: string }, { moved: number }>('reassignPolicies', { policyIds, brokerId }),
};
