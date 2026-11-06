import { httpsCallable } from 'firebase/functions';
import type {
  BrokerInput, CarrierInput, ClientInput, ImportOptionsInput, ImportPlanSummary, ImportRecordInput, Message, PolicyInput, SettingsInput,
} from '@asm/shared';

export interface StagedRow {
  rowNumber: number;
  clientName: string;
  policyNumber: string;
  carrier: string;
  status: 'ok' | 'warning' | 'error';
  clientAction: 'create' | 'existing' | 'update' | 'none';
  policyAction: 'create' | 'update' | 'unchanged' | 'duplicate' | 'conflict' | 'none';
  policyChanges: Record<string, { before: unknown; after: unknown }>;
  messages: Message[];
}
export interface StageResult { batchId: string; duplicateOf: string | null; summary: ImportPlanSummary; rows: StagedRow[] }
export type CommitResult = ImportPlanSummary & { clientsCreated: number; clientsUpdated: number; policiesCreated: number; policiesUpdated: number };
export interface UndoResult {
  policiesDeleted: number; policiesRestored: number; clientsDeleted: number; clientsRestored: number;
  skipped: { id: string; type: 'policy' | 'client'; reason: string }[];
}
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
  stageImport: (fileName: string, fileHash: string, options: ImportOptionsInput, records: ImportRecordInput[]) =>
    call<{ fileName: string; fileHash: string; options: ImportOptionsInput; records: ImportRecordInput[] }, StageResult>(
      'stageImport', { fileName, fileHash, options, records }),
  commitImport: (batchId: string) => call<{ batchId: string }, CommitResult>('commitImport', { batchId }),
  undoImport: (batchId: string) => call<{ batchId: string }, UndoResult>('undoImport', { batchId }),
  discardImport: (batchId: string) => call<{ batchId: string }, { ok: true }>('discardImport', { batchId }),
  reassignPolicies: (policyIds: string[], brokerId: string) =>
    call<{ policyIds: string[]; brokerId: string }, { moved: number }>('reassignPolicies', { policyIds, brokerId }),
};
