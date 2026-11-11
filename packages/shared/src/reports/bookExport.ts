import { z } from 'zod';
import { UNASSIGNED_BROKER_ID } from '../schemas.js';
import { displayName } from '../displayName.js';

/**
 * Customer & Policy Export — internal use only (admin, staff), for organizing the physical customer
 * folders for transfer to Pioneer. Built on the server from EVERY client and policy record, never from
 * what one screen shows. Delivered as a native Excel workbook (see excelWrite.ts).
 *
 *   Customer Folder Checklist — one row per customer, alphabetical: name, customer ID, number of active
 *     policies, and blank boxes to mark by hand (File Located, File Reviewed, Ready for Pioneer, Box Number).
 *   Policy Detail Export — one row per policy: customer, policy number, carrier, type, dates, status, broker.
 *
 * "Active only" is decided by POLICY status, not customer status:
 *   checklist → customers with at least one active policy; policy detail → active policies only.
 *
 * Customer names are shown in proper case (displayName, display only — "SMITH TRUCKING LLC" → "Smith Trucking
 * LLC"; mixed-case names as typed). Sorting still uses the stored name, case-insensitively, so the order is the
 * same as before; stored records are never changed.
 *
 * Contains no commission, premium, rate, broker share or other compensation / acquisition-financial data:
 * the column lists below are the whole contract and tests check them.
 */

export const BOOK_EXPORT_FORMATS = ['folder_checklist', 'policy_detail'] as const;
export type BookExportFormat = (typeof BOOK_EXPORT_FORMATS)[number];
export const BOOK_EXPORT_SCOPES = ['active', 'all'] as const;
export type BookExportScope = (typeof BOOK_EXPORT_SCOPES)[number];

export const bookExportInput = z.object({ format: z.enum(BOOK_EXPORT_FORMATS), scope: z.enum(BOOK_EXPORT_SCOPES) }).strict();
export type BookExportInput = z.infer<typeof bookExportInput>;

export interface ExportClient { id: string; name: string; externalId?: string }
export interface ExportPolicy {
  id: string; clientId: string; carrierId: string; policyNumber: string; policyType?: string;
  effectiveDate?: string | null; expirationDate?: string | null; status?: string; brokerId?: string;
}
export interface BookExportData {
  clients: ExportClient[];
  policies: ExportPolicy[];
  carriers: { id: string; name: string }[];
  brokers: { id: string; name: string }[];
}

/** text: stored as Excel text (never a number); int: a whole number; date: an Excel date; mark: blank box to fill in by hand. */
export type ExportColumnKind = 'text' | 'int' | 'date' | 'mark';
export interface ExportColumn { header: string; kind: ExportColumnKind; width: number }
export type ExportCell = string | number | null;

export interface BookExportReport {
  format: BookExportFormat;
  scope: BookExportScope;
  title: string;
  /** One line under the title, e.g. "Active customers (at least one active policy) · 1,612 customers". */
  subtitle: string;
  sheetName: string;
  orientation: 'portrait' | 'landscape';
  columns: ExportColumn[];
  rows: ExportCell[][];
  fileName: string;
  counts: {
    customers: number; policies: number; rows: number;
    /** Policies in the file whose customer record does not exist (listed, never dropped). */
    orphanPolicies: number;
  };
}

export const FOLDER_CHECKLIST_COLUMNS: ExportColumn[] = [
  { header: 'No.', kind: 'int', width: 6 },
  { header: 'Customer Name', kind: 'text', width: 38 },
  { header: 'Customer ID', kind: 'text', width: 16 },
  { header: 'Active Policies', kind: 'int', width: 9 },
  { header: 'File Located', kind: 'mark', width: 9 },
  { header: 'File Reviewed', kind: 'mark', width: 9 },
  { header: 'Ready for Pioneer', kind: 'mark', width: 10 },
  { header: 'Box Number', kind: 'mark', width: 11 },
];
export const POLICY_DETAIL_COLUMNS: ExportColumn[] = [
  { header: 'Customer Name', kind: 'text', width: 34 },
  { header: 'Policy Number', kind: 'text', width: 20 },
  { header: 'Carrier', kind: 'text', width: 26 },
  { header: 'Policy Type', kind: 'text', width: 20 },
  { header: 'Effective Date', kind: 'date', width: 12 },
  { header: 'Expiration Date', kind: 'date', width: 12 },
  { header: 'Policy Status', kind: 'text', width: 12 },
  { header: 'Broker', kind: 'text', width: 22 },
];

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
const cap = (s: string | undefined | null) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
const isActive = (p: ExportPolicy) => (p.status ?? 'active') === 'active';
const n = (x: number) => x.toLocaleString('en-US');
const byName = (a: ExportClient, b: ExportClient) => collator.compare(a.name ?? '', b.name ?? '') || collator.compare(a.externalId ?? '', b.externalId ?? '') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function buildBookExport(data: BookExportData, opts: BookExportInput, today: string): BookExportReport {
  const carrier = new Map(data.carriers.map((c) => [c.id, c.name]));
  const broker = new Map(data.brokers.map((b) => [b.id, b.name]));
  const brokerName = (id: string | undefined) => (!id || id === UNASSIGNED_BROKER_ID ? 'Unassigned' : broker.get(id) ?? id);
  const byClient = new Map<string, ExportPolicy[]>();
  for (const p of data.policies) byClient.set(p.clientId, [...(byClient.get(p.clientId) ?? []), p]);
  const clients = [...data.clients].sort(byName);
  const stamp = `${opts.scope === 'active' ? 'active' : 'all'}-${today}.xlsx`;

  if (opts.format === 'folder_checklist') {
    const listed = clients
      .map((c) => ({ c, active: (byClient.get(c.id) ?? []).filter(isActive).length }))
      .filter((x) => opts.scope === 'all' || x.active > 0);
    const rows: ExportCell[][] = listed.map((x, i) => [i + 1, displayName(x.c.name), x.c.externalId || x.c.id, x.active, null, null, null, null]);
    return {
      format: opts.format, scope: opts.scope,
      title: 'Customer Folder Checklist',
      subtitle: `${opts.scope === 'active' ? 'Customers with at least one active policy' : 'All customers'} · ${n(listed.length)} customers · ${today}`,
      sheetName: 'Folder Checklist', orientation: 'portrait',
      columns: FOLDER_CHECKLIST_COLUMNS, rows,
      fileName: `customer-folder-checklist-${stamp}`,
      counts: { customers: listed.length, policies: listed.reduce((t, x) => t + x.active, 0), rows: rows.length, orphanPolicies: 0 },
    };
  }

  const known = new Map(data.clients.map((c) => [c.id, c]));
  const wanted = data.policies.filter((p) => opts.scope === 'all' || isActive(p));
  const name = (p: ExportPolicy) => (known.has(p.clientId) ? displayName(known.get(p.clientId)!.name) : '(customer record missing)');
  const sorted = [...wanted].sort((a, b) => {
    const ca = known.get(a.clientId), cb = known.get(b.clientId);
    // Missing customers last; otherwise by customer, then policy number, then effective date.
    if (!ca !== !cb) return ca ? -1 : 1;
    return (ca && cb ? byName(ca, cb) : collator.compare(a.clientId, b.clientId))
      || collator.compare(a.policyNumber, b.policyNumber) || collator.compare(a.effectiveDate ?? '', b.effectiveDate ?? '') || (a.id < b.id ? -1 : 1);
  });
  const rows: ExportCell[][] = sorted.map((p) => [
    name(p), p.policyNumber, carrier.get(p.carrierId) ?? p.carrierId, p.policyType ?? '',
    p.effectiveDate ?? null, p.expirationDate ?? null, cap(p.status ?? 'active'), brokerName(p.brokerId),
  ]);
  const customers = new Set(sorted.map((p) => p.clientId)).size;
  return {
    format: opts.format, scope: opts.scope,
    title: 'Policy Detail Export',
    subtitle: `${opts.scope === 'active' ? 'Active policies' : 'All policies'} · ${n(rows.length)} policies · ${n(customers)} customers · ${today}`,
    sheetName: 'Policy Detail', orientation: 'landscape',
    columns: POLICY_DETAIL_COLUMNS, rows,
    fileName: `policy-detail-${stamp}`,
    counts: { customers, policies: rows.length, rows: rows.length, orphanPolicies: sorted.filter((p) => !known.has(p.clientId)).length },
  };
}
