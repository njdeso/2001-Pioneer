import { PDFDocument, StandardFonts, rgb, degrees, type PDFFont, type PDFPage } from 'pdf-lib';
import type { BrokerStatementModel, ReconciliationModel } from './statements.js';

/**
 * PDF (pdf-lib) and Excel (exceljs) writers for the buyout documents. Layout only: the content is the
 * model from statements.ts. Imported on demand via '@asm/shared/buyout-reports'.
 */

// ---------------------------------------------------------------- formatting

export function money(cents: number): string {
  const neg = cents < 0;
  const a = Math.abs(Math.trunc(cents));
  const whole = Math.floor(a / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}$${whole}.${String(a % 100).padStart(2, '0')}`;
}
const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`;

const CP1252_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
/** Standard PDF fonts use WinAnsi: replace characters it cannot encode. */
export function pdfSafe(s: string): string {
  return s
    .replace(/→/g, '->').replace(/−/g, '-').replace(/≤/g, '<=').replace(/≥/g, '>=').replace(/Σ/g, 'Sum ').replace(/ | /g, ' ')
    .replace(/[^\n]/g, (c) => { const n = c.charCodeAt(0); return (n >= 0x20 && n <= 0x7e) || (n >= 0xa0 && n <= 0xff) || CP1252_EXTRA.includes(c) ? c : '?'; });
}

// ---------------------------------------------------------------- PDF layout

const W = 792, H = 612, M = 36; // US Letter landscape, 0.5" margins
const INK = rgb(0.1, 0.12, 0.16), MUTED = rgb(0.4, 0.43, 0.48), RULE = rgb(0.82, 0.84, 0.87);

class Pdf {
  page!: PDFPage; y = 0; pageNo = 0;
  private constructor(public doc: PDFDocument, public font: PDFFont, public bold: PDFFont, private header: string, private watermark: string | null) {}
  static async create(header: string, watermark: string | null, title: string) {
    const doc = await PDFDocument.create();
    doc.setTitle(pdfSafe(title)); doc.setProducer('Agency Sale Manager'); doc.setCreator('Agency Sale Manager');
    const p = new Pdf(doc, await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold), header, watermark);
    p.newPage();
    return p;
  }
  newPage() {
    this.page = this.doc.addPage([W, H]);
    this.pageNo += 1;
    if (this.watermark) this.page.drawText(pdfSafe(this.watermark), { x: 150, y: 130, size: 54, font: this.bold, color: rgb(0.85, 0.2, 0.2), opacity: 0.12, rotate: degrees(25) });
    this.page.drawText(pdfSafe(this.header), { x: M, y: H - M + 14, size: 7.5, font: this.font, color: MUTED });
    this.page.drawText(`Page ${this.pageNo}`, { x: W - M - 40, y: M - 20, size: 7.5, font: this.font, color: MUTED });
    this.y = H - M - 4;
  }
  ensure(h: number) { if (this.y - h < M) this.newPage(); }
  fit(s: string, f: PDFFont, size: number, width: number) {
    let t = pdfSafe(s);
    if (f.widthOfTextAtSize(t, size) <= width) return t;
    while (t.length > 1 && f.widthOfTextAtSize(`${t}…`, size) > width) t = t.slice(0, -1);
    return `${t}…`;
  }
  text(s: string, o: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; x?: number; gap?: number } = {}) {
    const size = o.size ?? 9, f = o.bold ? this.bold : this.font;
    for (const ln of this.wrap(s, f, size, W - 2 * M - (o.x ?? 0))) {
      this.ensure(size + 3);
      this.page.drawText(ln, { x: M + (o.x ?? 0), y: this.y - size, size, font: f, color: o.color ?? INK });
      this.y -= size + 3;
    }
    this.y -= o.gap ?? 0;
  }
  wrap(s: string, f: PDFFont, size: number, width: number): string[] {
    const out: string[] = [];
    for (const para of pdfSafe(s).split('\n')) {
      let cur = '';
      for (const w of para.split(/\s+/)) {
        const next = cur ? `${cur} ${w}` : w;
        if (f.widthOfTextAtSize(next, size) > width && cur) { out.push(cur); cur = w; } else cur = next;
      }
      out.push(cur);
    }
    return out;
  }
  heading(s: string) { this.ensure(40); this.y -= 6; this.text(s, { size: 11, bold: true, gap: 2 }); }
  kv(rows: [string, string][], labelWidth = 170) {
    for (const [k, v] of rows) {
      this.ensure(13);
      this.page.drawText(this.fit(k, this.font, 9, labelWidth - 6), { x: M, y: this.y - 9, size: 9, font: this.font, color: MUTED });
      this.page.drawText(this.fit(v, this.bold, 9, W - 2 * M - labelWidth), { x: M + labelWidth, y: this.y - 9, size: 9, font: this.bold, color: INK });
      this.y -= 13;
    }
  }
  table<T>(cols: { title: string; width: number; align?: 'left' | 'right'; get: (r: T) => string }[], rows: T[], o: { size?: number; total?: string[] } = {}) {
    const size = o.size ?? 7.5, rowH = size + 5;
    const total = cols.reduce((s, c) => s + c.width, 0), scale = (W - 2 * M) / total;
    const xs: number[] = []; let x = M;
    for (const c of cols) { xs.push(x); x += c.width * scale; }
    const head = () => {
      this.ensure(rowH * 2);
      cols.forEach((c, i) => this.cell(c.title, xs[i], c.width * scale, c.align, this.bold, size, MUTED));
      this.y -= rowH;
      this.page.drawLine({ start: { x: M, y: this.y + 2 }, end: { x: W - M, y: this.y + 2 }, thickness: 0.5, color: RULE });
    };
    head();
    for (const r of rows) {
      if (this.y - rowH < M) { this.newPage(); head(); }
      cols.forEach((c, i) => this.cell(c.get(r), xs[i], c.width * scale, c.align, this.font, size, INK));
      this.y -= rowH;
    }
    if (o.total) {
      this.ensure(rowH + 2);
      this.page.drawLine({ start: { x: M, y: this.y + 2 }, end: { x: W - M, y: this.y + 2 }, thickness: 0.5, color: INK });
      cols.forEach((c, i) => this.cell(o.total![i] ?? '', xs[i], c.width * scale, c.align, this.bold, size, INK));
      this.y -= rowH;
    }
    this.y -= 6;
  }
  private cell(s: string, x: number, w: number, align: 'left' | 'right' | undefined, f: PDFFont, size: number, color: ReturnType<typeof rgb>) {
    const t = this.fit(s, f, size, w - 4);
    const tx = align === 'right' ? x + w - 2 - f.widthOfTextAtSize(t, size) : x + 1;
    this.page.drawText(t, { x: tx, y: this.y - size, size, font: f, color });
  }
  async bytes() { return this.doc.save({ useObjectStreams: false }); }
}

const policyCols = <T extends BrokerStatementModel['policies'][number]>(extra: { title: string; width: number; get: (r: T) => string }[] = []) => [
  ...extra,
  { title: 'Client', width: 92, get: (r: T) => r.clientName },
  { title: 'Carrier', width: 62, get: (r: T) => r.carrierName },
  { title: 'Policy', width: 62, get: (r: T) => r.policyNumber },
  { title: 'Term', width: 92, get: (r: T) => `${r.termEffectiveDate} - ${r.termExpirationDate}` },
  { title: 'Days', width: 28, align: 'right' as const, get: (r: T) => String(r.termDays) },
  { title: 'Left', width: 28, align: 'right' as const, get: (r: T) => String(r.remainingDays) },
  { title: 'Term comm.', width: 52, align: 'right' as const, get: (r: T) => money(r.basisCents) },
  { title: 'Annualized', width: 52, align: 'right' as const, get: (r: T) => money(r.annualizedAgencyCents) },
  { title: 'Share', width: 32, align: 'right' as const, get: (r: T) => pct(r.brokerShareBps) },
  { title: 'Broker ann.', width: 52, align: 'right' as const, get: (r: T) => money(r.annualizedBrokerCents) },
  { title: 'Gross 1.5x', width: 52, align: 'right' as const, get: (r: T) => money(r.grossBuyoutCents) },
  { title: 'Adv. paid', width: 50, align: 'right' as const, get: (r: T) => money(r.advancePaidCents) },
  { title: 'Unearned', width: 50, align: 'right' as const, get: (r: T) => money(r.outstandingAdvanceCents) },
  { title: 'Net', width: 52, align: 'right' as const, get: (r: T) => money(r.netContributionCents) },
];

export async function brokerStatementPdf(m: BrokerStatementModel): Promise<Uint8Array> {
  const p = await Pdf.create(`${m.agencyName} - Broker buyout settlement statement - ${m.brokerName} - closing ${m.closingDate} - version ${m.version} (${m.stateLabel})`, m.watermark, `Broker buyout statement - ${m.brokerName}`);
  p.text(m.agencyName, { size: 9, color: MUTED });
  p.text('Broker Buyout Settlement Statement', { size: 16, bold: true, gap: 4 });
  p.kv([
    ['Broker', m.brokerName], ['Closing date', m.closingDate], ['Statement generated', m.generatedAt.slice(0, 10)],
    ['Settlement version', `${m.version} (${m.stateLabel})${m.final ? '' : ' - not final'}`], ['Reference', m.snapshotId],
  ]);
  p.heading('Summary');
  p.kv([
    ['Eligible policies', String(m.summary.policies)],
    ['Gross buyout (1.5x annualized broker commission)', money(m.summary.grossBuyoutCents)],
    ['Less outstanding unearned advances', money(-m.summary.outstandingAdvanceCents)],
    ['Net before adjustments', money(m.summary.netBeforeAdjustmentsCents)],
    ...m.summary.adjustments.map((a) => [`Adjustment: ${a.reason}`, money(a.amountCents)] as [string, string]),
    ['Net buyout settlement', money(m.summary.finalNetCents)],
  ], 300);
  if (m.summary.negative) p.text('The net settlement is negative. It is under manual review; no amount is owed by the broker under this statement.', { size: 9, bold: true, color: rgb(0.7, 0.1, 0.1) });
  p.heading('Payment schedule');
  p.table([
    { title: 'Installment', width: 160, get: (r: BrokerStatementModel['schedule'][number]) => r.label },
    { title: 'Due date', width: 100, get: (r) => r.dueDate },
    { title: 'Share', width: 60, align: 'right', get: (r) => r.percent },
    { title: 'Amount', width: 100, align: 'right', get: (r) => money(r.amountCents) },
    { title: '', width: 300, get: () => '' },
  ], m.schedule, { size: 9, total: ['Total', '', '', money(m.schedule.reduce((s, i) => s + i.amountCents, 0)), ''] });
  p.heading('Policy detail');
  p.table(policyCols(), m.policies, { total: ['Total', '', '', '', '', '', '', money(m.policies.reduce((s, r) => s + r.annualizedAgencyCents, 0)), '', money(m.policies.reduce((s, r) => s + r.annualizedBrokerCents, 0)), money(m.summary.grossBuyoutCents), money(m.policies.reduce((s, r) => s + r.advancePaidCents, 0)), money(m.summary.outstandingAdvanceCents), money(m.summary.netBeforeAdjustmentsCents)] });
  const noted = m.policies.filter((r) => r.notes);
  if (noted.length) { p.text('Notes', { bold: true }); for (const r of noted) p.text(`${r.policyNumber} (${r.clientName}): ${r.notes}`, { size: 8 }); }
  if (m.excluded.length) {
    p.heading('Your policies not included');
    p.table([
      { title: 'Client', width: 160, get: (r: BrokerStatementModel['excluded'][number]) => r.clientName },
      { title: 'Carrier', width: 100, get: (r) => r.carrierName },
      { title: 'Policy', width: 100, get: (r) => r.policyNumber },
      { title: 'Reason', width: 360, get: (r) => r.reason },
    ], m.excluded);
  }
  p.heading('Methodology');
  for (const s of m.methodology) p.text(`- ${s}`, { size: 8 });
  p.heading('Acknowledgment');
  p.text(m.acknowledgment, { size: 8.5, gap: 18 });
  p.ensure(70);
  for (const label of ['Broker signature', 'Agency signature']) {
    p.page.drawLine({ start: { x: M, y: p.y - 18 }, end: { x: M + 280, y: p.y - 18 }, thickness: 0.5, color: INK });
    p.page.drawLine({ start: { x: M + 320, y: p.y - 18 }, end: { x: M + 440, y: p.y - 18 }, thickness: 0.5, color: INK });
    p.page.drawText(label, { x: M, y: p.y - 28, size: 7.5, font: p.font, color: MUTED });
    p.page.drawText('Date', { x: M + 320, y: p.y - 28, size: 7.5, font: p.font, color: MUTED });
    p.y -= 36;
  }
  return p.bytes();
}

export async function reconciliationPdf(m: ReconciliationModel): Promise<Uint8Array> {
  const p = await Pdf.create(`INTERNAL - OWNER ONLY - not for Pioneer or any broker - ${m.agencyName} - buyout reconciliation - closing ${m.closingDate} - v${m.version} (${m.stateLabel})`, m.watermark, 'Broker buyout reconciliation (internal)');
  p.text('INTERNAL - OWNER ONLY', { size: 9, bold: true, color: rgb(0.7, 0.1, 0.1) });
  p.text('Broker Buyout Reconciliation', { size: 16, bold: true, gap: 4 });
  p.kv([
    ['Closing date', m.closingDate], ['Version', `${m.version} (${m.stateLabel})`], ['Generated', m.generatedAt.slice(0, 19).replace('T', ' ') + ' UTC'],
    ['Engine', m.engineVersion], ['Input fingerprint', m.inputFingerprint.slice(0, 16)], ['Reference', m.snapshotId],
    ['Can be finalized', m.finalizable ? 'Yes' : 'No'],
  ]);
  if (m.blockers.length) { p.text('Blockers', { bold: true }); for (const b of m.blockers) p.text(`- ${b}`, { size: 8.5, color: rgb(0.7, 0.1, 0.1) }); }
  p.heading('Totals');
  const t = m.totals;
  p.kv([
    ['Eligible / excluded policies', `${t.eligiblePolicies} / ${t.excludedPolicies}`], ['Annualized agency commission', money(t.annualizedAgencyCents)], ['Annualized broker commission', money(t.annualizedBrokerCents)],
    ['Gross buyout', money(t.grossBuyoutCents)], ['Outstanding unearned advances', money(t.outstandingAdvanceCents)], ['Net before adjustments', money(t.netBeforeAdjustmentsCents)],
    ['Adjustments', money(t.adjustmentsCents)], ['Net settlements', money(t.finalNetCents)],
    ['Installments (closing / 1st / 2nd)', t.installmentsCents.map(money).join(' / ')], ['Policies requiring review / missing advances', `${t.policiesRequiringReview} / ${t.missingAdvances}`],
  ], 260);
  p.heading('Checks');
  p.table([{ title: 'Check', width: 520, get: (c: ReconciliationModel['checks'][number]) => c.name }, { title: 'Result', width: 60, get: (c) => (c.pass ? 'PASS' : 'FAIL') }, { title: 'Detail', width: 200, get: (c) => c.detail }], m.checks, { size: 8 });
  p.heading('Brokers');
  p.table([
    { title: 'Broker', width: 140, get: (b: ReconciliationModel['brokers'][number]) => b.brokerName },
    { title: 'Policies', width: 45, align: 'right', get: (b) => String(b.policies) },
    { title: 'Gross', width: 70, align: 'right', get: (b) => money(b.grossBuyoutCents) },
    { title: 'Unearned', width: 70, align: 'right', get: (b) => money(b.outstandingAdvanceCents) },
    { title: 'Adjust.', width: 60, align: 'right', get: (b) => money(b.adjustmentsCents) },
    { title: 'Net', width: 70, align: 'right', get: (b) => money(b.finalNetCents) },
    { title: 'Closing', width: 65, align: 'right', get: (b) => money(b.installments[0]) },
    { title: '1st ann.', width: 65, align: 'right', get: (b) => money(b.installments[1]) },
    { title: '2nd ann.', width: 65, align: 'right', get: (b) => money(b.installments[2]) },
    { title: 'Flags', width: 110, get: (b) => b.flags },
  ], m.brokers, { total: ['Total', String(t.eligiblePolicies), money(t.grossBuyoutCents), money(t.outstandingAdvanceCents), money(t.adjustmentsCents), money(t.finalNetCents), ...t.installmentsCents.map(money), ''] });
  if (m.adjustments.length) { p.heading('Adjustments'); p.table([{ title: 'Broker', width: 160, get: (a: ReconciliationModel['adjustments'][number]) => a.brokerName }, { title: 'Amount', width: 80, align: 'right', get: (a) => money(a.amountCents) }, { title: 'Reason', width: 480, get: (a) => a.reason }], m.adjustments); }
  if (m.exceptions.length) { p.heading('Exceptions and flags'); p.table([{ title: 'Broker', width: 110, get: (e: ReconciliationModel['exceptions'][number]) => e.brokerName }, { title: 'Client', width: 120, get: (e) => e.clientName }, { title: 'Policy', width: 80, get: (e) => e.policyNumber }, { title: 'Blocks?', width: 40, get: (e) => (e.material ? 'Yes' : '') }, { title: 'Flags', width: 430, get: (e) => e.flags }], m.exceptions); }
  p.heading('Included policies');
  p.table(policyCols<ReconciliationModel['policies'][number]>([{ title: 'Broker', width: 70, get: (r) => r.brokerName }]), m.policies, { size: 7 });
  p.heading('Excluded policies');
  p.table([{ title: 'Broker', width: 110, get: (e: ReconciliationModel['excluded'][number]) => e.brokerName }, { title: 'Client', width: 140, get: (e) => e.clientName }, { title: 'Carrier', width: 90, get: (e) => e.carrierName }, { title: 'Policy', width: 90, get: (e) => e.policyNumber }, { title: 'Reason', width: 350, get: (e) => e.reason }], m.excluded, { size: 7 });
  if (m.history.length) { p.heading('Version history'); p.table([{ title: 'When', width: 130, get: (h: ReconciliationModel['history'][number]) => h.at.slice(0, 19).replace('T', ' ') }, { title: 'By', width: 160, get: (h) => h.by }, { title: 'From', width: 70, get: (h) => h.from }, { title: 'To', width: 70, get: (h) => h.to }, { title: 'Note', width: 350, get: (h) => h.note }], m.history); }
  return p.bytes();
}

// ---------------------------------------------------------------- Excel

const MONEY_FMT = '#,##0.00;[Red]-#,##0.00';
const dollars = (c: number) => Math.round(c) / 100;

async function workbook(): Promise<{ wb: any; add: (name: string, header: string[], rows: unknown[][], moneyCols?: number[], widths?: number[]) => unknown }> {
  const mod: any = await import('exceljs');
  const ExcelJS = mod.default ?? mod;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Agency Sale Manager';
  const add = (name: string, header: string[], rows: unknown[][], moneyCols: number[] = [], widths: number[] = []) => {
    const ws = wb.addWorksheet(name);
    ws.addRow(header).font = { bold: true };
    for (const r of rows) ws.addRow(r);
    header.forEach((_, i) => { const c = ws.getColumn(i + 1); c.width = widths[i] ?? Math.min(Math.max(header[i].length + 2, 12), 60); if (moneyCols.includes(i + 1)) c.numFmt = MONEY_FMT; });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    return ws;
  };
  return { wb, add };
}

const POLICY_HEAD = ['Client', 'Carrier', 'Policy', 'Term effective', 'Term expiration', 'Term days', 'Days remaining', 'Term commission', 'Basis source', 'Annualized commission', 'Broker share %', 'Annualized broker commission', 'Gross buyout (1.5x)', 'Advance paid', 'Outstanding unearned advance', 'Net contribution', 'Notes'];
const POLICY_MONEY = [8, 10, 12, 13, 14, 15, 16];
const policyRow = (r: BrokerStatementModel['policies'][number]) => [r.clientName, r.carrierName, r.policyNumber, r.termEffectiveDate, r.termExpirationDate, r.termDays, r.remainingDays, dollars(r.basisCents), r.basisSource, dollars(r.annualizedAgencyCents), r.brokerShareBps / 100, dollars(r.annualizedBrokerCents), dollars(r.grossBuyoutCents), dollars(r.advancePaidCents), dollars(r.outstandingAdvanceCents), dollars(r.netContributionCents), r.notes];

export async function brokerStatementXlsx(m: BrokerStatementModel): Promise<Uint8Array> {
  const { wb, add } = await workbook();
  add('Statement', ['Item', 'Value'], [
    [m.agencyName, ''], ['Broker Buyout Settlement Statement', ''], ['Broker', m.brokerName], ['Closing date', m.closingDate], ['Generated', m.generatedAt.slice(0, 10)],
    ['Settlement version', `${m.version} (${m.stateLabel})${m.final ? '' : ' — NOT FINAL'}`], ['Reference', m.snapshotId], ['', ''],
    ['Eligible policies', m.summary.policies], ['Gross buyout', dollars(m.summary.grossBuyoutCents)], ['Less outstanding unearned advances', dollars(-m.summary.outstandingAdvanceCents)],
    ['Net before adjustments', dollars(m.summary.netBeforeAdjustmentsCents)], ...m.summary.adjustments.map((a) => [`Adjustment: ${a.reason}`, dollars(a.amountCents)]),
    ['Net buyout settlement', dollars(m.summary.finalNetCents)], ['', ''],
    ...m.schedule.map((s) => [`${s.label} (${s.percent}) — due ${s.dueDate}`, dollars(s.amountCents)]),
    ['', ''], ['Acknowledgment', m.acknowledgment],
  ], [2], [48, 60]);
  add('Policies', POLICY_HEAD, m.policies.map(policyRow), POLICY_MONEY);
  add('Not included', ['Client', 'Carrier', 'Policy', 'Reason'], m.excluded.map((e) => [e.clientName, e.carrierName, e.policyNumber, e.reason]), [], [30, 20, 20, 80]);
  add('Methodology', ['Methodology'], m.methodology.map((s) => [s]), [], [140]);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

export async function reconciliationXlsx(m: ReconciliationModel): Promise<Uint8Array> {
  const { wb, add } = await workbook();
  const t = m.totals;
  add('Summary', ['INTERNAL — OWNER ONLY', ''], [
    ['Agency', m.agencyName], ['Closing date', m.closingDate], ['Version', `${m.version} (${m.stateLabel})`], ['Generated (UTC)', m.generatedAt], ['Engine', m.engineVersion], ['Input fingerprint', m.inputFingerprint], ['Reference', m.snapshotId],
    ['Can be finalized', m.finalizable ? 'Yes' : 'No'], ...m.blockers.map((b) => ['Blocker', b]), ['', ''],
    ['Eligible policies', t.eligiblePolicies], ['Excluded policies', t.excludedPolicies], ['Annualized agency commission', dollars(t.annualizedAgencyCents)], ['Annualized broker commission', dollars(t.annualizedBrokerCents)],
    ['Gross buyout', dollars(t.grossBuyoutCents)], ['Outstanding unearned advances', dollars(t.outstandingAdvanceCents)], ['Net before adjustments', dollars(t.netBeforeAdjustmentsCents)],
    ['Adjustments', dollars(t.adjustmentsCents)], ['Net settlements', dollars(t.finalNetCents)],
    ['Installment at closing', dollars(t.installmentsCents[0])], ['Installment, 1st anniversary', dollars(t.installmentsCents[1])], ['Installment, 2nd anniversary', dollars(t.installmentsCents[2])],
    ['Policies requiring review', t.policiesRequiringReview], ['Missing advances', t.missingAdvances],
  ], [2], [40, 70]);
  add('Checks', ['Check', 'Result', 'Detail'], m.checks.map((c) => [c.name, c.pass ? 'PASS' : 'FAIL', c.detail]), [], [80, 10, 50]);
  add('Brokers', ['Broker', 'Policies', 'Annualized broker commission', 'Gross buyout', 'Outstanding unearned', 'Net before adjustments', 'Adjustments', 'Net settlement', 'At closing', '1st anniversary', '2nd anniversary', 'Flags'],
    m.brokers.map((b) => [b.brokerName, b.policies, dollars(b.annualizedBrokerCents), dollars(b.grossBuyoutCents), dollars(b.outstandingAdvanceCents), dollars(b.netBeforeAdjustmentsCents), dollars(b.adjustmentsCents), dollars(b.finalNetCents), ...b.installments.map(dollars), b.flags]), [3, 4, 5, 6, 7, 8, 9, 10, 11]);
  add('Policies', ['Broker', ...POLICY_HEAD], m.policies.map((r) => [r.brokerName, ...policyRow(r)]), POLICY_MONEY.map((c) => c + 1));
  add('Excluded', ['Broker', 'Client', 'Carrier', 'Policy', 'Reason', 'Blocks finalization'], m.excluded.map((e) => [e.brokerName, e.clientName, e.carrierName, e.policyNumber, e.reason, e.material ? 'Yes' : '']), [], [24, 30, 20, 20, 80, 18]);
  add('Exceptions', ['Broker', 'Client', 'Policy', 'Blocks finalization', 'Flags'], m.exceptions.map((e) => [e.brokerName, e.clientName, e.policyNumber, e.material ? 'Yes' : '', e.flags]), [], [24, 30, 20, 18, 100]);
  add('Adjustments', ['Broker', 'Amount', 'Reason'], m.adjustments.map((a) => [a.brokerName, dollars(a.amountCents), a.reason]), [2], [24, 14, 80]);
  add('History', ['When (UTC)', 'By', 'From', 'To', 'Note'], m.history.map((h) => [h.at, h.by, h.from, h.to, h.note]), [], [24, 30, 12, 12, 80]);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
