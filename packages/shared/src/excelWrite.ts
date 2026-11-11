import type { BookExportReport } from './reports/bookExport.js';

/**
 * Native Excel (.xlsx) writer for the Customer & Policy Export, built on exceljs (already used to read
 * statements). Server-side only; imported as "@asm/shared/excel-write" so nothing else loads exceljs.
 *
 *   - text columns (names, policy numbers, customer IDs) are real text cells with the Text (@) format:
 *     leading zeros stay and long numbers never turn into 6.17738E+11 — no formulas, no CSV workarounds;
 *   - dates are real Excel dates (mm/dd/yyyy); counts are whole numbers;
 *   - print-ready: letter paper, fit to one page wide, header row repeated on every page, title and
 *     "Page x of y" in the page header/footer, gridlines and borders, frozen header, filter buttons;
 *   - the Folder Checklist has tall rows and wide bordered blank boxes for marking by hand.
 */

type Cell = { value: unknown; numFmt: string; alignment: unknown; border: unknown; font: unknown; fill: unknown };
interface Ws {
  columns: { header?: string; key?: string; width?: number }[];
  addRow(values: unknown[]): { height: number; eachCell(opts: { includeEmpty: boolean }, cb: (c: Cell, col: number) => void): void };
  autoFilter: unknown;
  pageSetup: Record<string, unknown>;
  headerFooter: Record<string, unknown>;
  views: unknown[];
}
interface Wb {
  creator: string; created: Date; title: string;
  addWorksheet(name: string, opts?: unknown): Ws;
  xlsx: { writeBuffer(): Promise<ArrayBuffer | Uint8Array> };
}

const thin = { style: 'thin', color: { argb: 'FF9CA3AF' } };
const box = { top: thin, left: thin, bottom: thin, right: thin };
/** Page header/footer text: & starts a code, so a literal & is written &&. */
const hf = (s: string) => s.replace(/&/g, '&&');

function isoToDate(iso: string | null): Date | null {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
}

export async function writeBookExportXlsx(r: BookExportReport): Promise<Uint8Array> {
  const mod = (await import('exceljs')) as unknown as { default?: { Workbook: new () => Wb }; Workbook?: new () => Wb };
  const Workbook = mod.default?.Workbook ?? mod.Workbook;
  if (!Workbook) throw new Error('Excel writer failed to load');
  const wb = new Workbook();
  wb.creator = '2001-Pioneer Sales Manager';
  wb.created = new Date();
  wb.title = r.title;
  const checklist = r.format === 'folder_checklist';
  const ws = wb.addWorksheet(r.sheetName, {
    pageSetup: {
      paperSize: 1, orientation: r.orientation, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      showGridLines: true, horizontalCentered: true,
      margins: { left: 0.4, right: 0.4, top: 0.75, bottom: 0.6, header: 0.3, footer: 0.3 },
    },
    headerFooter: {
      oddHeader: `&L&"-,Bold"&12${hf(r.title)}&R&9${hf(r.subtitle)}`,
      oddFooter: '&L&9Internal use only&C&9Page &P of &N',
    },
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  ws.columns = r.columns.map((c, i) => ({ key: `c${i}`, width: c.width }));
  const header = ws.addRow(r.columns.map((c) => c.header));
  header.height = checklist ? 32 : 20;
  header.eachCell({ includeEmpty: true }, (c) => {
    c.font = { bold: true, size: 10 };
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
    c.border = box;
  });

  for (const values of r.rows) {
    const row = ws.addRow(r.columns.map((col, i) => {
      const v = values[i];
      if (col.kind === 'mark') return null;
      if (col.kind === 'date') return isoToDate(typeof v === 'string' ? v : null);
      if (col.kind === 'int') return typeof v === 'number' ? v : null;
      return v === null || v === undefined ? '' : String(v); // text: always a string, even "00123"
    }));
    if (checklist) row.height = 22;
    row.eachCell({ includeEmpty: true }, (c, colNo) => {
      const col = r.columns[colNo - 1];
      if (!col) return;
      c.border = box;
      c.font = { size: 10 };
      if (col.kind === 'text') { c.numFmt = '@'; c.alignment = { vertical: 'middle' }; }
      else if (col.kind === 'date') { c.numFmt = 'mm/dd/yyyy'; c.alignment = { vertical: 'middle', horizontal: 'center' }; }
      else c.alignment = { vertical: 'middle', horizontal: 'center' };
    });
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: r.columns.length } };
  ws.pageSetup.printTitlesRow = '1:1';
  const out = await wb.xlsx.writeBuffer();
  return out instanceof Uint8Array ? out : new Uint8Array(out);
}
