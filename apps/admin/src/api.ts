import type { AiDiagnosis } from '@asm/shared';
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

async function call<Req, Res>(name: string, data: Req, timeoutMs?: number): Promise<Res> {
  try {
    const res = await httpsCallable<Req, Res>(functions, name, timeoutMs ? { timeout: timeoutMs } : undefined)(data);
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
  registerStatementUpload: (fileName: string, sha256: string, size: number) =>
    call<{ fileName: string; sha256: string; size: number }, { duplicate: true; statementId: string } | { duplicate: false; resumed?: boolean; statementId: string; uploadPath: string }>(
      'registerStatementUpload', { fileName, sha256, size }),
  processStatement: (statementId: string, method: 'auto' | 'ai' = 'auto') =>
    call<{ statementId: string; method: string }, { status: string; reconciled?: boolean; lines?: number; possibleDuplicateOf?: string | null; failure?: StatementFailure }>(
      'processStatement', { statementId, method }, 540_000),
  setStatementPayer: (statementId: string, payerId: string) =>
    call<{ statementId: string; payerId: string }, { ok: true }>('setStatementPayer', { statementId, payerId }),
  discardStatement: (statementId: string, reason: string) =>
    call<{ statementId: string; reason: string }, { ok: true }>('discardStatement', { statementId, reason }),
  checkAiConnection: (model?: string, skipRequest = false) =>
    call<{ model?: string; skipRequest: boolean }, AiDiagnosis>('checkAiConnection', { model, skipRequest }, 120_000),
  getStatementFileUrl: (statementId: string) =>
    call<{ statementId: string }, { url: string; expiresInSeconds: number }>('getStatementFileUrl', { statementId }),
  reassignPolicies: (policyIds: string[], brokerId: string) =>
    call<{ policyIds: string[]; brokerId: string }, { moved: number }>('reassignPolicies', { policyIds, brokerId }),
};

export interface StatementFailure { code: string; message: string; httpStatus?: number; errorType?: string | null; apiMessage?: string | null; requestId?: string | null }
