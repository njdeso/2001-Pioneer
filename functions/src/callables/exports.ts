import { onCall, HttpsError } from 'firebase-functions/v2/https';
import {
  buildBookExport, bookExportInput, fileTrackingInput, FILE_REVIEW_STATUS_LABELS,
  type ExportClient, type ExportPolicy, type FileTracking,
} from '@asm/shared';
import { audit, db, meta, parse, requireRole } from '../lib/core.js';

/**
 * Customer & Policy Export and physical file tracking — INTERNAL users only (admin, staff).
 *
 * The allow-list is explicit: any other role (including any future Pioneer / due-diligence / read-only
 * role) is refused unless it is added here on purpose. The export reads EVERY client and policy record on
 * the server (never what one screen shows), only the fields the file contains (Firestore field masks:
 * no premium, commission, rate or broker-share field is even read), writes nothing but an audit entry,
 * and changes no customer, policy or financial record.
 */
const EXPORT_ROLES = ['admin', 'staff'] as const;
/** Callable responses are limited (~10 MB); stay well below and say so instead of failing obscurely. */
const MAX_CSV_BYTES = 8 * 1024 * 1024;

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export const exportBook = onCall({ memory: '1GiB', timeoutSeconds: 300 }, async (req) => {
  const actor = requireRole(req, [...EXPORT_ROLES]);
  const input = parse(bookExportInput, req.data);
  const [clients, policies, carriers, brokers, tracking] = await Promise.all([
    db.collection('clients').select('name', 'externalId', 'classification', 'brokerId', 'status').get(),
    db.collection('policies').select('clientId', 'carrierId', 'wholesalerId', 'policyNumber', 'policyType', 'effectiveDate', 'expirationDate', 'status', 'brokerId').get(),
    db.collection('carriers').select('name').get(),
    db.collection('brokers').select('name').get(),
    input.includeFileTracking ? db.collection('fileTracking').select('fileReviewed', 'reviewStatus', 'boxNumber', 'transferDate').get() : Promise.resolve(null),
  ]);
  const result = buildBookExport({
    clients: clients.docs.map((d) => ({ id: d.id, ...d.data() }) as ExportClient),
    policies: policies.docs.map((d) => ({ id: d.id, ...d.data() }) as ExportPolicy),
    carriers: carriers.docs.map((d) => ({ id: d.id, name: String(d.get('name') ?? d.id) })),
    brokers: brokers.docs.map((d) => ({ id: d.id, name: String(d.get('name') ?? d.id) })),
    fileTracking: tracking ? new Map(tracking.docs.map((d) => [d.id, d.data() as FileTracking])) : undefined,
  }, input, today());
  const bytes = Buffer.byteLength(result.csv, 'utf8');
  if (bytes > MAX_CSV_BYTES) {
    throw new HttpsError('resource-exhausted', `The export is ${(bytes / 1048576).toFixed(1)} MB, over the ${MAX_CSV_BYTES / 1048576} MB limit for one download. Export active customers only, or without file tracking.`);
  }
  const b = db.batch();
  audit(b, actor, {
    action: 'export_book', entityType: 'export', entityId: input.format,
    summary: `Customer & Policy Export (${input.format === 'customer_summary' ? 'Customer Summary' : 'Policy Detail'}, ${input.scope === 'all' ? 'all customers' : 'active customers only'}${input.includeFileTracking ? ', with file tracking' : ''}): ${result.customers} customers, ${result.policies} policies, ${result.rows} rows`,
  });
  await b.commit();
  return {
    csv: result.csv, fileName: result.fileName, customers: result.customers, policies: result.policies, rows: result.rows,
    customersWithoutPolicies: result.customersWithoutPolicies, orphanPolicies: result.orphanPolicies,
    totalClientRecords: clients.size, totalPolicyRecords: policies.size,
  };
});

/** Save the physical (paper) file tracking for one customer. The client record itself is not changed. */
export const setFileTracking = onCall(async (req) => {
  const actor = requireRole(req, [...EXPORT_ROLES]);
  const input = parse(fileTrackingInput, req.data);
  return db.runTransaction(async (tx) => {
    const clientRef = db.collection('clients').doc(input.clientId);
    const ref = db.collection('fileTracking').doc(input.clientId);
    const [client, cur] = await Promise.all([tx.get(clientRef), tx.get(ref)]);
    if (!client.exists) throw new HttpsError('not-found', 'Client not found.');
    const next = { fileReviewed: input.fileReviewed, reviewStatus: input.reviewStatus, boxNumber: input.boxNumber, transferDate: input.transferDate };
    const before = cur.exists ? { fileReviewed: cur.get('fileReviewed'), reviewStatus: cur.get('reviewStatus'), boxNumber: cur.get('boxNumber'), transferDate: cur.get('transferDate') ?? null } : null;
    const changes = Object.fromEntries(Object.entries(next).filter(([k, v]) => (before as Record<string, unknown> | null)?.[k] !== v).map(([k, v]) => [k, { before: (before as Record<string, unknown> | null)?.[k] ?? null, after: v }]));
    tx.set(ref, { ...next, clientId: input.clientId, ...meta(actor, !cur.exists) }, { merge: true });
    audit(tx, actor, {
      action: 'file_tracking', entityType: 'client', entityId: input.clientId,
      summary: `Physical file: ${input.fileReviewed ? 'reviewed' : 'not reviewed'}, ${FILE_REVIEW_STATUS_LABELS[input.reviewStatus]}${input.boxNumber ? `, box ${input.boxNumber}` : ''}${input.transferDate ? `, transfer ${input.transferDate}` : ''}`,
      changes,
    });
    return { ok: true };
  });
});
