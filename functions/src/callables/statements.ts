import { createHash } from 'node:crypto';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { originalFileAccess, originalFileDisposition } from '@asm/shared';
import { defineSecret } from 'firebase-functions/params';
import { getStorage } from 'firebase-admin/storage';
import type { DocumentData, DocumentReference } from 'firebase-admin/firestore';
import { z } from 'zod';
import {
  DEFAULT_AI_MODEL, AI_PROMPT_VERSION, DETAILED_STATEMENT_READER, TRAVELERS_PL_PARSER, applyUticaDirectBillRules, extractWithClaude, isUticaDirectBill, readDetailedStatement, isTravelersPlStatement, normalizeName, sniffError, sniffSpreadsheet,
  parseCsv, parseTravelersPl, reconcileStatement, tableToText,
  type ExtractedStatement, type ExtractionMethod,
  type DupLine,
} from '@asm/shared';
import { audit, db, FieldValue, idParam, meta, parse, requireRole, type Actor } from '../lib/core.js';
import { duplicateFindings } from '../lib/duplicates.js';

/**
 * Stage 3A — statement upload, extraction and reconciliation.
 * Nothing here posts commission or touches the ledger, clients or policies.
 *
 *   registerStatementUpload → browser uploads to incoming/{uid}/{statementId}/… →
 *   processStatement (verify file, preserve original, extract, validate, reconcile, store lines)
 */

export const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
/** processStatement runs for at most 540 s; a run older than this is treated as abandoned. */
const STALE_PROCESSING_MS = 12 * 60 * 1000;
const MAX_BYTES = 20 * 1024 * 1024;
/** Rows (incl. sheet markers) the statement reader receives from one spreadsheet; more is refused, never truncated. */
const TABLE_MAX_ROWS = 3000;
const FILE_TYPES = { pdf: 'pdf', xlsx: 'xlsx', xlsm: 'xlsx', csv: 'csv' } as const;
type FileType = 'pdf' | 'xlsx' | 'csv';

const registerInput = z.object({
  fileName: z.string().trim().min(1).max(200),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().min(1).max(MAX_BYTES),
});

function fileTypeOf(name: string): FileType | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return (FILE_TYPES as Record<string, FileType>)[ext] ?? null;
}

function safeName(name: string): string {
  return name.replace(/[^\w.\- ()&]/g, '_').slice(0, 120);
}

/** Step 1: reserve the file fingerprint and hand back a one-time upload path. */
export const registerStatementUpload = onCall(async (req) => {
  const actor = requireRole(req);
  const input = parse(registerInput, req.data);
  const type = fileTypeOf(input.fileName);
  if (!type) throw new HttpsError('invalid-argument', 'Upload a PDF, Excel (.xlsx) or CSV statement.');

  const result = await db.runTransaction(async (tx) => {
    const keyRef = db.collection('statementKeys').doc(input.sha256);
    const key = await tx.get(keyRef);
    if (key.exists) {
      const existingId = key.get('statementId') as string;
      const existingRef = db.collection('statements').doc(existingId);
      const existing = await tx.get(existingRef);
      // An earlier upload of this exact file was registered but the file never reached
      // Storage (e.g. the upload was interrupted or blocked by Storage permissions).
      // Let the same file be uploaded into that same statement record instead of
      // reporting a duplicate. Nothing else in the record is changed.
      const neverStored = existing.exists && !existing.get('originalPath')
        && (existing.get('status') === 'awaiting_upload'
          || (existing.get('status') === 'extraction_failed' && ['not_uploaded', 'file_mismatch', 'wrong_type'].includes(String(existing.get('failure.code') ?? ''))));
      if (neverStored) {
        const uploadPath = `incoming/${actor.uid}/${existingId}/upload.${type}`;
        tx.update(existingRef, { status: 'awaiting_upload', uploadPath, fileName: safeName(input.fileName), fileType: type, size: input.size, failure: null, ...meta(actor, false) });
        audit(tx, actor, { action: 'resume_upload', entityType: 'statement', entityId: existingId, summary: 'Resumed an upload that never reached storage' });
        return { duplicate: false as const, resumed: true as const, statementId: existingId, uploadPath };
      }
      return { duplicate: true as const, statementId: existingId };
    }
    const ref = db.collection('statements').doc();
    const uploadPath = `incoming/${actor.uid}/${ref.id}/upload.${type}`;
    tx.set(keyRef, { statementId: ref.id, at: FieldValue.serverTimestamp() });
    tx.set(ref, {
      status: 'awaiting_upload',
      fileName: safeName(input.fileName),
      fileType: type,
      size: input.size,
      sha256: input.sha256,
      uploadPath,
      originalPath: null,
      postedCents: 0,
      ...meta(actor, true),
    });
    audit(tx, actor, { action: 'register_upload', entityType: 'statement', entityId: ref.id, summary: `Registered statement upload (${type})` });
    return { duplicate: false as const, statementId: ref.id, uploadPath };
  });
  // A resumed upload goes to a create-only Storage path; clear any partial object left there
  // by the interrupted attempt so the browser's upload is not refused as an overwrite.
  if ('resumed' in result && result.resumed) {
    await getStorage().bucket().file(result.uploadPath).delete({ ignoreNotFound: true });
  }
  return result;
});

function magicOk(type: FileType, buf: Buffer): boolean {
  if (type === 'pdf') return buf.subarray(0, 5).toString('latin1') === '%PDF-';
  if (type === 'xlsx') return buf[0] === 0x50 && buf[1] === 0x4b; // zip container
  // CSV: must be text (no NUL bytes in the first 4 KB)
  return !buf.subarray(0, 4096).includes(0);
}

interface RunOutcome {
  statement: ExtractedStatement | null;
  method: ExtractionMethod | null;
  model: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  attempts: number;
  failure: FailureInfo | null;
}

/** Stored on the statement and the extraction run so the real cause is visible later. */
interface FailureInfo {
  code: string;
  message: string;
  /** Technical detail (parser message, sheet list …) shown under the message for support. */
  detail?: string;
  httpStatus?: number;
  errorType?: string | null;
  apiMessage?: string | null;
  requestId?: string | null;
}

async function reserveAiCall(limit: number): Promise<void> {
  const month = new Date().toISOString().slice(0, 7);
  await db.runTransaction(async (tx) => {
    const ref = db.collection('aiUsage').doc(month);
    const snap = await tx.get(ref);
    const calls = (snap.get('calls') as number | undefined) ?? 0;
    if (calls >= limit) {
      throw new HttpsError('resource-exhausted', `The monthly AI limit (${limit} statements) has been reached. Raise it in Settings to continue.`);
    }
    tx.set(ref, { calls: calls + 1, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  });
}

async function recordAiUsage(usage: { inputTokens: number; outputTokens: number } | null): Promise<void> {
  if (!usage) return;
  const month = new Date().toISOString().slice(0, 7);
  await db.collection('aiUsage').doc(month).set({
    inputTokens: FieldValue.increment(usage.inputTokens),
    outputTokens: FieldValue.increment(usage.outputTokens),
  }, { merge: true });
}

async function extract(buf: Buffer, type: FileType, fileName: string, force: 'auto' | 'ai'): Promise<RunOutcome> {
  const settings = (await db.collection('settings').doc('app').get()).data() ?? {};
  const aiEnabled = settings.aiEnabled === true;
  const model = typeof settings.aiModel === 'string' && settings.aiModel ? settings.aiModel : DEFAULT_AI_MODEL;
  const limit = typeof settings.aiMonthlyCallLimit === 'number' ? settings.aiMonthlyCallLimit : 100;
  const none: RunOutcome = { statement: null, method: null, model: null, usage: null, attempts: 0, failure: null };

  let aiInput: Parameters<typeof extractWithClaude>[0]['input'];
  if (type === 'pdf') {
    const { pdfToTextLines } = await import('@asm/shared/pdf');
    let text: Awaited<ReturnType<typeof pdfToTextLines>>;
    try {
      text = await pdfToTextLines(new Uint8Array(buf));
    } catch {
      return { ...none, failure: { code: 'pdf_unreadable', message: 'The PDF could not be opened (damaged, encrypted, or over the page limit).' } };
    }
    if (force === 'auto' && text.hasText && isTravelersPlStatement(text.pages)) {
      return { ...none, statement: parseTravelersPl(text.pages), method: TRAVELERS_PL_PARSER };
    }
    aiInput = { kind: 'pdf', base64: buf.toString('base64'), pageCount: text.pageCount };
  } else {
    let rows: string[][];
    let sheets: { name: string; rows: string[][] }[] = [];
    try {
      if (type === 'csv') rows = parseCsv(new TextDecoder('utf-8').decode(buf));
      else {
        const { readXlsxDetailed } = await import('@asm/shared/excel');
        const r = await readXlsxDetailed(new Uint8Array(buf));
        // Which reader succeeded, and why exceljs did not (if it did not): no document content is logged.
        logger.info('Spreadsheet read', { fileName, reader: r.reader, exceljsError: r.exceljsError, sheets: r.allSheets, rows: r.sheets.map((s) => ({ name: s.name, rows: s.rows.length })) });
        sheets = r.sheets;
        rows = r.sheets.flatMap((s) => [[`# Sheet: ${s.name}`], ...s.rows]);
      }
    } catch (err) {
      // A specific, actionable reason (old .xls, encrypted, HTML export, damaged, no visible data, …).
      const e = err as { name?: string; code?: string; message?: string; detail?: string };
      const specific = e?.name === 'SpreadsheetError' && typeof e.code === 'string';
      logger.warn('Spreadsheet unreadable', { fileName, type, code: specific ? e.code : 'unexpected', detail: specific ? e.detail : String(e?.message ?? err).slice(0, 300) });
      return {
        ...none,
        failure: specific
          ? { code: e.code!, message: e.message!, detail: e.detail ?? '' }
          : { code: 'table_unreadable', message: `The ${type === 'csv' ? 'CSV file' : 'spreadsheet'} could not be read: ${String(e?.message ?? err).slice(0, 200)}`, detail: '' },
      };
    }
    if (!rows.length) return { ...none, failure: { code: 'table_empty', message: `The ${type === 'csv' ? 'CSV file' : 'spreadsheet'} has no rows of data.` } };
    // Never cut a statement short: the statement reader receives at most TABLE_MAX_ROWS rows.
    if (rows.length > TABLE_MAX_ROWS) return { ...none, failure: { code: 'table_too_large', message: `The ${type === 'csv' ? 'CSV file' : 'spreadsheet'} has ${rows.length} rows; at most ${TABLE_MAX_ROWS} can be read in one statement. Split it (for example by month or line of business) and upload each part.`, detail: `${rows.length} rows` } };
    // Carrier DetailedStatement workbooks (Detailed + Summary sheets, Gross Comm / Net Due Agent): read
    // deterministically — brokers on gross, MVR charges as agency-only adjustments — and NEVER by the AI,
    // even on "read again with AI": an ambiguous file is refused or held as a discrepancy, not guessed.
    if (type === 'xlsx') {
      const det = readDetailedStatement(sheets);
      if (det.kind === 'incomplete') return { ...none, method: DETAILED_STATEMENT_READER, failure: { code: det.code, message: det.message, detail: det.detail } };
      if (det.kind === 'statement') {
        logger.info('DetailedStatement read', { fileName, rows: det.statement.sourceAccounting, columns: Object.fromEntries(Object.entries(det.report.columns).map(([k, v]) => [k, v.header])), checks: det.report.checks.map((c) => ({ key: c.key, ok: c.ok })) });
        return { ...none, statement: det.statement, method: DETAILED_STATEMENT_READER };
      }
    }
    aiInput = { kind: 'table', text: tableToText(rows, TABLE_MAX_ROWS), fileName };
  }

  if (!aiEnabled) {
    return { ...none, failure: { code: 'ai_disabled', message: 'No built-in parser recognizes this layout, and the AI reader is turned off in Settings.' } };
  }
  await reserveAiCall(limit);
  const res = await extractWithClaude({ apiKey: ANTHROPIC_API_KEY.value(), model, input: aiInput, deadlineMs: 450_000 });
  await recordAiUsage(res.ok ? res.usage : res.usage ?? null);
  if (!res.ok) {
    const h = res.http;
    // Logged for Cloud Logging: status and Anthropic's reason only — never the key or document.
    logger.warn('Claude extraction failed', { code: res.code, model, attempts: res.attempts, httpStatus: h?.status ?? null, kind: h?.kind ?? null, errorType: h?.errorType ?? null, apiMessage: h?.apiMessage ?? null, requestId: h?.requestId ?? null });
    const failure: FailureInfo = {
      code: h ? `ai_${h.kind}` : `ai_${res.code}`,
      message: res.message,
      ...(h ? { httpStatus: h.status, errorType: h.errorType, apiMessage: h.apiMessage, requestId: h.requestId } : {}),
    };
    return { ...none, method: type === 'pdf' ? 'ai' : 'table-ai', model, attempts: res.attempts, usage: res.usage ?? null, failure };
  }
  // Carrier-specific reading rules for what the AI copied exactly as printed (Utica direct bill only).
  let statement = res.statement;
  if (statement && isUticaDirectBill(statement)) {
    const u = applyUticaDirectBillRules(statement);
    statement = u.statement;
    logger.info('Utica direct-bill rules', { fileName, applied: u.report.applied, evidenceRows: u.report.evidenceRows, contradicting: u.report.contradictingRows, filled: u.report.filledRows.length, outsideTotals: u.report.rowsOutsideTotals });
  }
  return { statement, method: type === 'pdf' ? 'ai' : 'table-ai', model, usage: res.usage, attempts: res.attempts, failure: null };
}

/** Match the statement's carrier name / agency code to a set-up carrier or wholesaler. */
async function resolvePayer(s: ExtractedStatement): Promise<{ payerId: string | null; note: string }> {
  const carriers = (await db.collection('carriers').get()).docs.map((d) => ({ id: d.id, ...(d.data() as { name: string; code: string; aliases?: string[]; agencyCodes?: string[]; status?: string }) }));
  const code = (s.agencyCode ?? '').toUpperCase();
  const byCode = code ? carriers.filter((c) => (c.agencyCodes ?? []).includes(code)) : [];
  if (byCode.length === 1) return { payerId: byCode[0].id, note: `Matched by agency code ${code}` };
  const n = normalizeName(s.carrierName);
  const byName = carriers.filter((c) => normalizeName(c.name) === n || normalizeName(c.code) === n || (c.aliases ?? []).some((a) => normalizeName(a) === n));
  if (byName.length === 1) return { payerId: byName[0].id, note: `Matched by name "${s.carrierName}"` };
  // Utica National prints its statements as "Utica Mutual Ins Co. - ERO" / "Utica Mutual Insurance Co. - ERO".
  // When no name or alias matches exactly, a Utica statement goes to the ONE set-up carrier whose name or
  // alias contains "Utica" (e.g. Utica National Insurance Group). Never creates a carrier; if there are
  // several, the carrier is chosen on the review screen as before.
  if (!byName.length && !byCode.length && isUticaDirectBill(s)) {
    const utica = carriers.filter((c) => c.status !== 'inactive' && [c.name, ...(c.aliases ?? [])].some((n) => /\butica\b/i.test(n ?? '')));
    if (utica.length === 1) return { payerId: utica[0].id, note: `Matched Utica statement "${s.carrierName}" to ${utica[0].name}` };
  }
  if (byCode.length > 1 || byName.length > 1) return { payerId: null, note: 'More than one carrier matches; choose the carrier on the review screen' };
  return { payerId: null, note: `No carrier set up for "${s.carrierName}"${code ? ` / agency code ${code}` : ''}; add it or choose one on the review screen` };
}

async function claimForProcessing(id: string, actor: Actor): Promise<DocumentData> {
  return db.runTransaction(async (tx) => {
    const ref = db.collection('statements').doc(id);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Statement not found.');
    const status = snap.get('status');
    const updatedMs = (snap.get('updatedAt') as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
    const abandoned = status === 'processing' && Date.now() - updatedMs > STALE_PROCESSING_MS;
    if (!abandoned && !['awaiting_upload', 'extraction_failed', 'needs_review', 'discrepancy'].includes(status)) {
      throw new HttpsError('failed-precondition', `This statement is ${status}.`);
    }
    if ((snap.get('postedCents') ?? 0) !== 0) throw new HttpsError('failed-precondition', 'Lines from this statement have been posted.');
    // A statement that was ever posted (even if since reversed) keeps its extracted lines: they are the
    // source of ledger entries in the audit trail, and re-reading would delete and rewrite them.
    if ((snap.get('postingSeq') ?? 0) > 0 || ((snap.get('reversals') as unknown[] | undefined) ?? []).length > 0) {
      throw new HttpsError('failed-precondition', 'This statement has posting history, so its extracted lines are kept as the source of those ledger entries. To read the file again, discard this statement and upload the file as a new statement.');
    }
    tx.update(ref, { status: 'processing', ...meta(actor, false) });
    return snap.data()!;
  });
}

async function replaceLines(stmtRef: DocumentReference, s: ExtractedStatement, payerId: string | null): Promise<void> {
  const existing = await stmtRef.collection('lines').listDocuments();
  for (let i = 0; i < existing.length; i += 450) {
    const b = db.batch();
    existing.slice(i, i + 450).forEach((d) => b.delete(d));
    await b.commit();
  }
  for (let i = 0; i < s.lines.length; i += 450) {
    const b = db.batch();
    for (const l of s.lines.slice(i, i + 450)) {
      b.set(stmtRef.collection('lines').doc(String(l.lineNo).padStart(5, '0')), {
        ...l,
        statementId: stmtRef.id,
        payerId,
        status: l.kind === 'commission' ? 'pending' : 'info',
        match: { status: 'not_started' },
      });
    }
    await b.commit();
  }
}

const processInput = z.object({ statementId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), method: z.enum(['auto', 'ai']).default('auto') });

/** Step 2: verify the uploaded file, preserve it, extract, validate and reconcile. */
export const processStatement = onCall(
  { secrets: [ANTHROPIC_API_KEY], memory: '1GiB', timeoutSeconds: 540 },
  async (req) => {
    const actor = requireRole(req);
    const { statementId, method: force } = parse(processInput, req.data);
    const doc = await claimForProcessing(statementId, actor);
    const ref = db.collection('statements').doc(statementId);
    const started = Date.now();
    const bucket = getStorage().bucket();
    const fail = async (code: string, message: string, extra: Record<string, unknown> = {}, details: Partial<FailureInfo> = {}) => {
      const failure: FailureInfo = { ...details, code, message };
      const b = db.batch();
      b.update(ref, { status: 'extraction_failed', failure, ...meta(actor, false) });
      b.set(db.collection('extractionRuns').doc(), { statementId, ok: false, errorCode: code, failure, durationMs: Date.now() - started, at: FieldValue.serverTimestamp(), by: actor.uid, ...extra });
      audit(b, actor, { action: 'extract_failed', entityType: 'statement', entityId: statementId, summary: `Extraction failed: ${code}` });
      await b.commit();
      return { status: 'extraction_failed', failure };
    };

    try {
      // ---- File: verify and preserve the original exactly as uploaded ----
      const type = doc.fileType as FileType;
      let buf: Buffer;
      let originalPath = doc.originalPath as string | null;
      if (!originalPath) {
        const incoming = bucket.file(String(doc.uploadPath));
        const [exists] = await incoming.exists();
        if (!exists) return await fail('not_uploaded', 'The file has not finished uploading.');
        [buf] = await incoming.download();
        const sha = createHash('sha256').update(buf).digest('hex');
        if (buf.length > MAX_BYTES || buf.length !== doc.size || sha !== doc.sha256) {
          await incoming.delete({ ignoreNotFound: true });
          return await fail('file_mismatch', 'The uploaded file does not match the registered fingerprint.');
        }
        if (!magicOk(type, buf)) {
          await incoming.delete({ ignoreNotFound: true });
          // Name what the file really is (old .xls, encrypted workbook, HTML/XML export, CSV …). The code stays
          // 'wrong_type' so the corrected file can be uploaded into the same record.
          const sniff = type === 'xlsx' ? sniffSpreadsheet(new Uint8Array(buf)) : null;
          const specific = sniff ? sniffError(sniff.kind, sniff.detail) : null;
          return await fail('wrong_type', specific?.message ?? `The file is not a valid ${type.toUpperCase()}.`, {}, specific ? { detail: `${specific.code}: ${specific.detail}` } : {});
        }
        originalPath = `statements/${statementId}/original.${type}`;
        await incoming.copy(bucket.file(originalPath), { preconditionOpts: { ifGenerationMatch: 0 } });
        await incoming.delete({ ignoreNotFound: true });
        await ref.update({ originalPath, originalStoredAt: FieldValue.serverTimestamp() });
      } else {
        [buf] = await bucket.file(originalPath).download();
      }

      // ---- Extract ----
      const out = await extract(buf, type, String(doc.fileName), force);
      const runBase = { statementId, method: out.method, model: out.model, promptVersion: out.method === TRAVELERS_PL_PARSER || out.method === DETAILED_STATEMENT_READER ? null : AI_PROMPT_VERSION, attempts: out.attempts, usage: out.usage };
      if (out.failure || !out.statement) return await fail(out.failure?.code ?? 'unknown', out.failure?.message ?? 'Extraction failed.', runBase, out.failure ?? {});
      const s = out.statement;

      // ---- Validate and reconcile (exact to the cent) ----
      const rec = reconcileStatement(s);
      const payer = await resolvePayer(s);

      // ---- Other statements from this payer for this month (compared by content) ----
      // Several statements a month are normal (e.g. Personal and Commercial Lines). This is informational;
      // approval and posting always re-check (functions/src/lib/duplicates.ts). The old carrier+agency+month
      // identity records (statementIdentity) are left as they are and no longer used.
      const dupCheck = await duplicateFindings(statementId, {
        status: rec.reconciled ? 'needs_review' : 'discrepancy', fileName: doc.fileName, payerId: payer.payerId, statementMonth: s.statementMonth,
        classification: doc.classification ?? null, agencyCode: s.agencyCode, officeCode: s.officeCode, statementDate: s.statementDate, title: s.title,
        statementTotalCents: s.stated.monthCommissionPayableCents ?? s.stated.commissionPayableCents, postedCents: 0, separateConfirmations: doc.separateConfirmations ?? {},
      }, s.lines as unknown as DupLine[]);
      const possibleDuplicateOf: string | null = dupCheck.findings.find((f) => !f.confirmed)?.otherId ?? null;

      await replaceLines(ref, s, payer.payerId);
      const runRef = db.collection('extractionRuns').doc();
      const b = db.batch();
      b.set(runRef, { ...runBase, ok: true, reconciled: rec.reconciled, lineCount: s.lines.length, durationMs: Date.now() - started, at: FieldValue.serverTimestamp(), by: actor.uid });
      b.update(ref, {
        status: rec.reconciled ? 'needs_review' : 'discrepancy',
        failure: null,
        method: out.method,
        carrierName: s.carrierName,
        agencyCode: s.agencyCode,
        officeCode: s.officeCode,
        statementMonth: s.statementMonth,
        statementDate: s.statementDate,
        pageCount: s.pageCount,
        stated: s.stated,
        adjustments: s.adjustments,
        statementIssues: s.issues,
        sourceAccounting: s.sourceAccounting ?? null,
        reconciliation: rec,
        reconciled: rec.reconciled,
        payerId: payer.payerId,
        payerNote: payer.note,
        possibleDuplicateOf,
        title: s.title,
        contentDigest: dupCheck.current.digest,
        duplicateCheck: { at: new Date().toISOString(), others: dupCheck.findings.length, sameStatement: dupCheck.findings.filter((f) => f.hard).length, unconfirmed: dupCheck.findings.filter((f) => !f.hard && !f.confirmed).length },
        statementTotalCents: s.stated.monthCommissionPayableCents ?? s.stated.commissionPayableCents,
        extractedCommissionCents: rec.totals.commissionCents,
        postedCents: 0,
        pendingCents: rec.totals.commissionCents,
        lastRunId: runRef.id,
        matching: null, // lines were replaced; matching starts again
        extractedAt: FieldValue.serverTimestamp(),
        ...meta(actor, false),
      });
      audit(b, actor, {
        action: 'extract', entityType: 'statement', entityId: statementId,
        summary: `Extracted ${s.lines.length} lines by ${out.method}; ${rec.reconciled ? 'reconciled exactly' : `not reconciled (${rec.blockingReasons.length} issue${rec.blockingReasons.length === 1 ? '' : 's'})`}`,
      });
      await b.commit();
      return { status: rec.reconciled ? 'needs_review' : 'discrepancy', reconciled: rec.reconciled, lines: s.lines.length, possibleDuplicateOf };
    } catch (err) {
      if (err instanceof HttpsError) {
        await fail(err.code, err.message);
        throw err;
      }
      logger.error('processStatement stopped unexpectedly', { statementId, name: (err as Error)?.name, message: String((err as Error)?.message ?? err).slice(0, 300) });
      return await fail('internal', 'Processing stopped unexpectedly. Try again.');
    }
  },
);

/** Choose the carrier/wholesaler a statement belongs to when it could not be matched automatically. */
export const setStatementPayer = onCall(async (req) => {
  const actor = requireRole(req);
  const body = (req.data ?? {}) as { statementId?: unknown; payerId?: unknown };
  const statementId = idParam(body.statementId, 'statement');
  const payerId = idParam(body.payerId, 'carrier');
  if (!statementId || !payerId) throw new HttpsError('invalid-argument', 'Statement and carrier are required.');
  return db.runTransaction(async (tx) => {
    const ref = db.collection('statements').doc(statementId);
    const [snap, carrier] = await Promise.all([tx.get(ref), tx.get(db.collection('carriers').doc(payerId))]);
    if (!snap.exists) throw new HttpsError('not-found', 'Statement not found.');
    if (!carrier.exists) throw new HttpsError('not-found', 'Carrier not found.');
    if (!['needs_review', 'discrepancy'].includes(snap.get('status'))) throw new HttpsError('failed-precondition', 'The statement must be extracted first.');
    const lines = await tx.get(ref.collection('lines'));
    // Matches were scoped to the previous payer: keep them, but flag the summary for a re-run.
    tx.update(ref, { payerId, payerNote: `Chosen by ${actor.email}`, ...(snap.get('matching') ? { 'matching.stale': true } : {}), ...meta(actor, false) });
    lines.docs.forEach((d) => tx.update(d.ref, { payerId }));
    audit(tx, actor, { action: 'set_payer', entityType: 'statement', entityId: statementId, summary: `Statement carrier set to ${carrier.get('name')}`, changes: { payerId: { before: snap.get('payerId') ?? null, after: payerId } } });
    return { ok: true };
  });
});

/** Set a statement aside. The original file and extracted lines are kept; the same file may be uploaded again. */
export const discardStatement = onCall(async (req) => {
  const actor = requireRole(req);
  const body = (req.data ?? {}) as { statementId?: unknown; reason?: unknown };
  const statementId = idParam(body.statementId, 'statement');
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
  if (!statementId) throw new HttpsError('invalid-argument', 'Statement is required.');
  if (!reason) throw new HttpsError('invalid-argument', 'A reason is required.', { fieldErrors: { reason: 'Required' } });
  return db.runTransaction(async (tx) => {
    const ref = db.collection('statements').doc(statementId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Statement not found.');
    if ((snap.get('postedCents') ?? 0) !== 0) throw new HttpsError('failed-precondition', 'A statement with posted lines cannot be discarded.');
    if (snap.get('status') === 'processing') throw new HttpsError('failed-precondition', 'The statement is being processed.');
    if (['approved', 'posted'].includes(snap.get('status'))) throw new HttpsError('failed-precondition', 'An approved or posted statement cannot be discarded. Return it to review (or reverse it) first.');
    tx.update(ref, { status: 'discarded', discardReason: reason, discardedAt: FieldValue.serverTimestamp(), ...meta(actor, false) });
    tx.delete(db.collection('statementKeys').doc(String(snap.get('sha256'))));
    audit(tx, actor, { action: 'discard', entityType: 'statement', entityId: statementId, summary: `Statement discarded: ${reason}` });
    return { ok: true };
  });
});

/** Short-lived link to view the preserved original. */
export const getStatementFileUrl = onCall(async (req) => {
  // Every status, including approved and posted: the original is evidence and viewing it changes nothing.
  const actor = requireRole(req, ['admin', 'staff']);
  const data = req.data as { statementId?: unknown; download?: unknown } | undefined;
  const statementId = idParam(data?.statementId, 'statement');
  if (!statementId) throw new HttpsError('invalid-argument', 'Statement is required.');
  const download = data?.download === true;
  const snap = await db.collection('statements').doc(statementId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'The statement was not found.');
  const access = originalFileAccess({ status: String(snap.get('status') ?? ''), originalPath: snap.get('originalPath') as string | null | undefined });
  if (!access.available) throw new HttpsError('not-found', access.reason);
  const path = snap.get('originalPath') as string;
  const file = getStorage().bucket().file(path);
  const [exists] = await file.exists();
  if (!exists) throw new HttpsError('not-found', 'The original file is recorded for this statement but is missing from storage. Upload the statement again if you need the file.');
  const [url] = await file.getSignedUrl({
    version: 'v4', action: 'read', expires: Date.now() + 5 * 60 * 1000,
    responseDisposition: originalFileDisposition(snap.get('fileName'), download),
  });
  const b = db.batch();
  audit(b, actor, download
    ? { action: 'download_original', entityType: 'statement', entityId: statementId, summary: 'Downloaded original statement file' }
    : { action: 'view_original', entityType: 'statement', entityId: statementId, summary: 'Viewed original statement file' });
  await b.commit();
  return { url, expiresInSeconds: 300 };
});
