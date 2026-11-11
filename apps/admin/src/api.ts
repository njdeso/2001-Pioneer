import type { AiDiagnosis, DuplicateFinding, LineMatch, MatchSummary, PostingPlan, StatementClassification } from '@asm/shared';
import { httpsCallable } from 'firebase/functions';
import { classifyProbe, describeCallableError, PROBE_SAFE_FUNCTIONS, type ProbeResult, type BrokerAdvanceInput, type ParsedAdvanceRow } from '@asm/shared';

export type AdvanceForm = BrokerAdvanceInput;
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
import { functions, buildRef, functionsRegion, projectId } from './firebase';

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
    const e = err as { code?: string; message?: string; details?: { fieldErrors?: Record<string, string> } };
    // Server refusals keep their own message; "the request never reached a function" (e.g. a bare
    // "not-found [404]") becomes a message naming the function, its URL and this build.
    throw new ApiError(describeCallableError(e, { name, projectId, region: functionsRegion, build: buildRef }), e.details?.fieldErrors ?? {});
  }
}

/**
 * Check from this browser that each statement function is deployed and reachable. Each one is called
 * with deliberately invalid input ({ probe: true }); every probed function checks the sign-in and then
 * rejects the input before reading or writing anything, so nothing changes.
 */
export async function probeStatementFunctions(): Promise<{ name: string; result: ProbeResult; detail: string; url: string }[]> {
  return Promise.all(PROBE_SAFE_FUNCTIONS.map(async (name) => {
    const url = `https://${functionsRegion}-${projectId}.cloudfunctions.net/${name}`;
    try {
      await httpsCallable(functions, name, { timeout: 30_000 })({ probe: true });
      return { name, result: 'reachable' as ProbeResult, detail: 'answered', url };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return { name, result: classifyProbe(e), detail: `${e.code ?? ''} ${e.message ?? ''}`.trim(), url };
    }
  }));
}

export interface BookExportResponse {
  csv: string; fileName: string; customers: number; policies: number; rows: number;
  customersWithoutPolicies: number; orphanPolicies: number; totalClientRecords: number; totalPolicyRecords: number;
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
  exportBook: (input: { format: 'customer_summary' | 'policy_detail'; scope: 'all' | 'active'; includeFileTracking: boolean }) =>
    call<typeof input, BookExportResponse>('exportBook', input, 300_000),
  setFileTracking: (input: { clientId: string; fileReviewed: boolean; reviewStatus: string; boxNumber: string; transferDate: string | null }) =>
    call<typeof input, { ok: true }>('setFileTracking', input),
  recordBrokerAdvance: (input: { advance: AdvanceForm; note: string }) => call<typeof input, { id: string }>('recordBrokerAdvance', input),
  correctBrokerAdvance: (input: { advanceId: string; advance: AdvanceForm; note: string }) => call<typeof input, { id: string; voided: string }>('correctBrokerAdvance', input),
  voidBrokerAdvance: (input: { advanceId: string; note: string }) => call<typeof input, { voided: string }>('voidBrokerAdvance', input),
  stageAdvanceImport: (input: { fileName: string; fileHash: string; headers: string[]; rows: string[][] }) =>
    call<typeof input, { importId: string; counts: { rows: number; ok: number; errors: number; warnings: number }; totalOkCents: number; rows: ParsedAdvanceRow[] }>('stageAdvanceImport', input),
  commitAdvanceImport: (input: { importId: string; note: string }) => call<typeof input, { created: number; already: boolean }>('commitAdvanceImport', input),
  discardAdvanceImport: (input: { importId: string }) => call<typeof input, { discarded: string }>('discardAdvanceImport', input),
  saveBuyoutConfig: (input: { plannedClosingDate: string | null; closingDateConfirmed: boolean; note: string }) => call<typeof input, { ok: true }>('saveBuyoutConfig', input),
  createBuyoutSnapshot: (input: { closingDate: string; note: string }) => call<typeof input, { id: string; version: number; finalizable: boolean; blockers: string[] }>('createBuyoutSnapshot', input, 300_000),
  addBuyoutAdjustment: (input: { snapshotId: string; brokerId: string; amountCents: number; reason: string }) => call<typeof input, { finalizable: boolean; blockers: string[] }>('addBuyoutAdjustment', input),
  removeBuyoutAdjustment: (input: { snapshotId: string; adjustmentId: string; reason: string }) => call<typeof input, { finalizable: boolean; blockers: string[] }>('removeBuyoutAdjustment', input),
  setBuyoutSnapshotState: (input: { snapshotId: string; to: 'draft' | 'reviewed' | 'finalized' | 'discarded'; note: string }) => call<typeof input, { state: string }>('setBuyoutSnapshotState', input, 120_000),
  savePolicyTerm: (input: { policyId: string; originalTermId: string | null; term: { effectiveDate: string; scheduledExpirationDate: string; cancellationDate: string | null; status: string; note: string }; note: string }) =>
    call<typeof input, { termId: string; warnings: { message: string }[] }>('savePolicyTerm', input),
  removePolicyTerm: (input: { policyId: string; termId: string; note: string }) => call<typeof input, { removed: string }>('removePolicyTerm', input),
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
  runStatementMatching: (statementId: string, includeManual = false) =>
    call<{ statementId: string; includeManual: boolean }, MatchSummary & { changed: number; keptManual: number }>('runStatementMatching', { statementId, includeManual }, 300_000),
  setLineMatch: (input: { action: 'assign'; statementId: string; lineId: string; policyId: string; note?: string } | { action: 'unmatch' | 'auto'; statementId: string; lineId: string; note?: string }
    | { action: 'historical'; statementId: string; lineId: string; clientId: string | null; insuredName: string; policyNumber: string; carrierId: string | null; policyStatus: 'cancelled' | 'expired' | 'unknown'; attributedBrokerId: string | null; note: string }) =>
    call<typeof input, { match: LineMatch; summary: MatchSummary }>('setLineMatch', input),
  approveStatement: (statementId: string, note = '') =>
    call<{ statementId: string; note: string }, { status: string; totals: PostingPlan['totals'] }>('approveStatement', { statementId, note }),
  checkStatementDuplicates: (statementId: string) =>
    call<{ statementId: string }, { statementId: string; classification: StatementClassification | null; lineCount: number; findings: DuplicateFinding[] }>('checkStatementDuplicates', { statementId }),
  setStatementClassification: (statementId: string, classification: StatementClassification) =>
    call<{ statementId: string; classification: StatementClassification }, { classification: StatementClassification }>('setStatementClassification', { statementId, classification }),
  confirmSeparateStatement: (statementId: string, otherStatementId: string, reason: string) =>
    call<{ statementId: string; otherStatementId: string; reason: string }, { confirmed: true }>('confirmSeparateStatement', { statementId, otherStatementId, reason }),
  unapproveStatement: (statementId: string, reason: string) => call<{ statementId: string; reason: string }, { status: string }>('unapproveStatement', { statementId, reason }),
  postStatement: (statementId: string) => call<{ statementId: string }, { status: string; postingId: string; totals: PostingPlan['totals'] }>('postStatement', { statementId }, 120_000),
  reverseStatementPosting: (statementId: string, reason: string) =>
    call<{ statementId: string; reason: string }, { status: string; reversedEntries: number; reversedCents: number }>('reverseStatementPosting', { statementId, reason }, 120_000),
  recordRetainedCommission: (input: { requestId: string; policyId: string; statementPeriod: string; amountCents: number; transactionDate: string | null; classification: string; note: string }) =>
    call<typeof input, { entryId: string; duplicate: boolean }>('recordRetainedCommission', input),
  reverseLedgerEntry: (entryId: string, reason: string) => call<{ entryId: string; reason: string }, { reversalId: string }>('reverseLedgerEntry', { entryId, reason }),
  getStatementFileUrl: (statementId: string) =>
    call<{ statementId: string }, { url: string; expiresInSeconds: number }>('getStatementFileUrl', { statementId }),
  reassignPolicies: (policyIds: string[], brokerId: string) =>
    call<{ policyIds: string[]; brokerId: string }, { moved: number }>('reassignPolicies', { policyIds, brokerId }),
};

export interface StatementFailure { code: string; message: string; httpStatus?: number; errorType?: string | null; apiMessage?: string | null; requestId?: string | null }
