import { z } from 'zod';
import { isoDate, UNASSIGNED_BROKER_ID } from '../schemas.js';
import { csvCell } from './ledger.js';

/**
 * Customer & Policy Export (internal use: admin and staff only — never part of a Pioneer / due-diligence
 * package). Built on the server from EVERY client and policy record, so the file never depends on what a
 * screen happens to show.
 *
 * Contains no commission, premium, commission rate, broker share or any other compensation or
 * acquisition-financial figure: the column lists below are the whole contract and a test checks them.
 *
 * Excel: UTF-8 with BOM, CRLF. Identifier columns (policy numbers, customer IDs, box numbers) are written as
 * ="…" text formulas so Excel keeps leading zeros and never shows 6.17738E+08; names and other text get the
 * usual formula-injection guard (a leading ' before = + - @).
 */

export const BOOK_EXPORT_FORMATS = ['customer_summary', 'policy_detail'] as const;
export type BookExportFormat = (typeof BOOK_EXPORT_FORMATS)[number];
export const BOOK_EXPORT_SCOPES = ['all', 'active'] as const;
export type BookExportScope = (typeof BOOK_EXPORT_SCOPES)[number];

export const bookExportInput = z.object({
  format: z.enum(BOOK_EXPORT_FORMATS),
  scope: z.enum(BOOK_EXPORT_SCOPES),
  includeFileTracking: z.boolean().optional().default(false),
});
export type BookExportInput = z.infer<typeof bookExportInput>;

// ---------------------------------------------------------------- physical file tracking

export const FILE_REVIEW_STATUSES = ['not_started', 'in_progress', 'reviewed', 'needs_attention'] as const;
export type FileReviewStatus = (typeof FILE_REVIEW_STATUSES)[number];
export const FILE_REVIEW_STATUS_LABELS: Record<FileReviewStatus, string> = {
  not_started: 'Not started', in_progress: 'In progress', reviewed: 'Reviewed', needs_attention: 'Needs attention',
};

/** Physical (paper) file tracking for one customer: fileTracking/{clientId}. Separate from the client record. */
export const fileTrackingInput = z.object({
  clientId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'Client is required'),
  fileReviewed: z.boolean(),
  reviewStatus: z.enum(FILE_REVIEW_STATUSES),
  boxNumber: z.string().trim().max(40).default(''),
  transferDate: isoDate.nullable().default(null),
});
export type FileTrackingInput = z.infer<typeof fileTrackingInput>;
export type FileTracking = Omit<FileTrackingInput, 'clientId'>;

// ---------------------------------------------------------------- export

export interface ExportClient { id: string; name: string; externalId?: string; classification?: string; brokerId?: string; status?: string }
export interface ExportPolicy {
  id: string; clientId: string; carrierId: string; wholesalerId?: string | null; policyNumber: string; policyType?: string;
  effectiveDate?: string | null; expirationDate?: string | null; status?: string; brokerId?: string;
}
export interface BookExportData {
  clients: ExportClient[];
  policies: ExportPolicy[];
  carriers: { id: string; name: string }[];
  brokers: { id: string; name: string }[];
  fileTracking?: Map<string, FileTracking>;
}
export interface BookExportResult {
  csv: string;
  fileName: string;
  /** Customers in the file (after the scope filter). */
  customers: number;
  /** Policies in the file. */
  policies: number;
  /** Data rows in the file (excluding the header). */
  rows: number;
  /** Policy Detail: customers with no policy, each on one row with blank policy fields. */
  customersWithoutPolicies: number;
  /** Policies whose customer record does not exist (listed at the end, never dropped). */
  orphanPolicies: number;
}

export const CUSTOMER_SUMMARY_HEADERS = [
  'Customer Name', 'Customer ID', 'Customer Record ID', 'Customer Status', 'Line', 'Assigned Broker',
  'Policies', 'Active Policies', 'Policy Numbers', 'Carriers', 'Policy Types', 'Policy Statuses', 'Earliest Effective Date', 'Latest Expiration Date',
] as const;
export const POLICY_DETAIL_HEADERS = [
  'Customer Name', 'Customer ID', 'Customer Record ID', 'Customer Status', 'Line', 'Policy Number', 'Carrier', 'Wholesaler / MGA',
  'Policy Type', 'Effective Date', 'Expiration Date', 'Policy Status', 'Assigned Broker',
] as const;
export const FILE_TRACKING_HEADERS = ['File Reviewed', 'Review Status', 'Box Number', 'Transfer Date'] as const;

/** Excel text: ="…" keeps 00123 and 617738486000 exactly as typed. Excel caps formula strings at 255 characters. */
export function excelTextCell(value: string | null | undefined): string {
  const v = String(value ?? '');
  if (v === '') return '';
  if (v.length > 250) return csvCell(v);
  return `"=""${v.replace(/"/g, '""""')}"""`;
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
const cap = (s: string | undefined | null) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
const lineLabel = (s: string | undefined) => (s === 'personal' ? 'Personal' : s === 'commercial' ? 'Commercial' : cap(s));

export function buildBookExport(data: BookExportData, opts: BookExportInput, today: string): BookExportResult {
  const carrier = new Map(data.carriers.map((c) => [c.id, c.name]));
  const broker = new Map(data.brokers.map((b) => [b.id, b.name]));
  const brokerName = (id: string | undefined) => (!id || id === UNASSIGNED_BROKER_ID ? 'Unassigned' : broker.get(id) ?? id);
  const tracking = opts.includeFileTracking ? data.fileTracking ?? new Map<string, FileTracking>() : null;

  const clients = data.clients
    .filter((c) => opts.scope === 'all' || (c.status ?? 'active') === 'active')
    .sort((a, b) => collator.compare(a.name ?? '', b.name ?? '') || collator.compare(a.externalId ?? '', b.externalId ?? '') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const known = new Set(data.clients.map((c) => c.id));
  const byClient = new Map<string, ExportPolicy[]>();
  for (const p of data.policies) byClient.set(p.clientId, [...(byClient.get(p.clientId) ?? []), p]);
  const sortPolicies = (ps: ExportPolicy[]) => [...ps].sort((a, b) => collator.compare(a.policyNumber, b.policyNumber) || collator.compare(a.effectiveDate ?? '', b.effectiveDate ?? '') || (a.id < b.id ? -1 : 1));

  const trackingCells = (clientId: string): string[] => {
    if (!tracking) return [];
    const t = tracking.get(clientId);
    if (!t) return ['', '', '', ''];
    return [t.fileReviewed ? 'Yes' : 'No', FILE_REVIEW_STATUS_LABELS[t.reviewStatus] ?? csvCell(t.reviewStatus), excelTextCell(t.boxNumber), t.transferDate ?? ''];
  };
  const customerCells = (c: ExportClient) => [csvCell(c.name), excelTextCell(c.externalId), excelTextCell(c.id), cap(c.status ?? 'active'), lineLabel(c.classification)];

  const lines: string[] = [];
  let policyCount = 0, withoutPolicies = 0;
  if (opts.format === 'customer_summary') {
    lines.push([...CUSTOMER_SUMMARY_HEADERS, ...(tracking ? FILE_TRACKING_HEADERS : [])].map((h) => csvCell(h)).join(','));
    for (const c of clients) {
      const ps = sortPolicies(byClient.get(c.id) ?? []);
      policyCount += ps.length;
      const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort(collator.compare);
      const statuses = new Map<string, number>();
      for (const p of ps) statuses.set(p.status ?? 'active', (statuses.get(p.status ?? 'active') ?? 0) + 1);
      const eff = ps.map((p) => p.effectiveDate).filter((d): d is string => !!d).sort();
      const exp = ps.map((p) => p.expirationDate).filter((d): d is string => !!d).sort();
      const numbers = ps.map((p) => p.policyNumber).join('; ');
      lines.push([
        ...customerCells(c), csvCell(brokerName(c.brokerId)),
        String(ps.length), String(ps.filter((p) => (p.status ?? 'active') === 'active').length),
        ps.length === 1 ? excelTextCell(numbers) : csvCell(numbers),
        csvCell(uniq(ps.map((p) => carrier.get(p.carrierId) ?? p.carrierId)).join('; ')),
        csvCell(uniq(ps.map((p) => p.policyType ?? '')).join('; ')),
        csvCell([...statuses].sort(([a], [b]) => a.localeCompare(b)).map(([s, n]) => `${cap(s)} ${n}`).join('; ')),
        eff[0] ?? '', exp[exp.length - 1] ?? '',
        ...trackingCells(c.id),
      ].join(','));
    }
  } else {
    lines.push([...POLICY_DETAIL_HEADERS, ...(tracking ? FILE_TRACKING_HEADERS : [])].map((h) => csvCell(h)).join(','));
    const policyCells = (p: ExportPolicy) => [
      excelTextCell(p.policyNumber), csvCell(carrier.get(p.carrierId) ?? p.carrierId), csvCell(p.wholesalerId ? carrier.get(p.wholesalerId) ?? p.wholesalerId : ''),
      csvCell(p.policyType ?? ''), p.effectiveDate ?? '', p.expirationDate ?? '', cap(p.status ?? 'active'), csvCell(brokerName(p.brokerId)),
    ];
    for (const c of clients) {
      const ps = sortPolicies(byClient.get(c.id) ?? []);
      if (!ps.length) { withoutPolicies++; lines.push([...customerCells(c), '', '', '', '', '', '', '', '', ...trackingCells(c.id)].join(',')); continue; }
      for (const p of ps) { policyCount++; lines.push([...customerCells(c), ...policyCells(p), ...trackingCells(c.id)].join(',')); }
    }
  }
  // Policies whose customer record is missing are never silently dropped (only possible with "all customers").
  const orphans = opts.scope === 'all' ? sortPolicies(data.policies.filter((p) => !known.has(p.clientId))) : [];
  if (opts.format === 'policy_detail') {
    for (const p of orphans) {
      policyCount++;
      lines.push(['(customer record missing)', '', excelTextCell(p.clientId), '', '', excelTextCell(p.policyNumber), csvCell(carrier.get(p.carrierId) ?? p.carrierId),
        csvCell(p.wholesalerId ? carrier.get(p.wholesalerId) ?? p.wholesalerId : ''), csvCell(p.policyType ?? ''), p.effectiveDate ?? '', p.expirationDate ?? '',
        cap(p.status ?? 'active'), csvCell(brokerName(p.brokerId)), ...(tracking ? ['', '', '', ''] : [])].join(','));
    }
  }
  const fileName = `${opts.format === 'customer_summary' ? 'customer-summary' : 'policy-detail'}-${opts.scope === 'all' ? 'all-customers' : 'active-customers'}${tracking ? '-with-file-tracking' : ''}-${today}.csv`;
  return {
    csv: `﻿${lines.join('\r\n')}\r\n`, fileName,
    customers: clients.length, policies: policyCount, rows: lines.length - 1,
    customersWithoutPolicies: opts.format === 'policy_detail' ? withoutPolicies : clients.filter((c) => !(byClient.get(c.id) ?? []).length).length,
    orphanPolicies: orphans.length,
  };
}
