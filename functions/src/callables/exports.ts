import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { buildBookExport, bookExportInput, type ExportClient, type ExportPolicy } from '@asm/shared';
import { audit, db, parse, requireRole } from '../lib/core.js';

/**
 * Customer & Policy Export (Customer Folder Checklist / Policy Detail Export) — INTERNAL users only.
 *
 * The allow-list is explicit: any other role (including any future Pioneer / due-diligence / read-only
 * role) is refused unless it is added here on purpose. Reads EVERY client and policy record on the server
 * (never what one screen shows) and only the fields the file contains (Firestore field masks: no premium,
 * commission, rate or broker-share field is even read). Writes nothing but one audit entry; changes no
 * customer, policy or financial record.
 */
const EXPORT_ROLES = ['admin', 'staff'] as const;
/** Callable responses are limited (~10 MB); the base64 file stays well below and says so otherwise. */
const MAX_FILE_BYTES = 6 * 1024 * 1024;

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export const exportBook = onCall({ memory: '1GiB', timeoutSeconds: 300 }, async (req) => {
  const actor = requireRole(req, [...EXPORT_ROLES]);
  const input = parse(bookExportInput, req.data);
  const [clients, policies, carriers, brokers] = await Promise.all([
    db.collection('clients').select('name', 'externalId').get(),
    db.collection('policies').select('clientId', 'carrierId', 'policyNumber', 'policyType', 'effectiveDate', 'expirationDate', 'status', 'brokerId').get(),
    db.collection('carriers').select('name').get(),
    db.collection('brokers').select('name').get(),
  ]);
  const report = buildBookExport({
    clients: clients.docs.map((d) => ({ id: d.id, ...d.data() }) as ExportClient),
    policies: policies.docs.map((d) => ({ id: d.id, ...d.data() }) as ExportPolicy),
    carriers: carriers.docs.map((d) => ({ id: d.id, name: String(d.get('name') ?? d.id) })),
    brokers: brokers.docs.map((d) => ({ id: d.id, name: String(d.get('name') ?? d.id) })),
  }, input, today());
  const { writeBookExportXlsx } = await import('@asm/shared/excel-write');
  const bytes = await writeBookExportXlsx(report);
  if (bytes.length > MAX_FILE_BYTES) {
    throw new HttpsError('resource-exhausted', `The workbook is ${(bytes.length / 1048576).toFixed(1)} MB, over the ${MAX_FILE_BYTES / 1048576} MB limit for one download. Use "Active only".`);
  }
  const b = db.batch();
  audit(b, actor, {
    action: 'export_book', entityType: 'export', entityId: input.format,
    summary: `${report.title} (${input.scope === 'active' ? 'active only' : 'all records'}): ${report.counts.customers} customers, ${report.counts.policies} ${input.format === 'folder_checklist' ? 'active policies' : 'policies'}, ${report.counts.rows} rows`,
  });
  await b.commit();
  return {
    fileBase64: Buffer.from(bytes).toString('base64'), fileName: report.fileName, title: report.title, subtitle: report.subtitle,
    ...report.counts, totalClientRecords: clients.size, totalPolicyRecords: policies.size,
  };
});
