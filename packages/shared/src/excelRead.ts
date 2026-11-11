import { excelRowsToText, type ExcelSheet } from './excel.js';
import { SpreadsheetError, sniffError, sniffSpreadsheet } from './spreadsheetSniff.js';
import { readXlsxLite } from './xlsxLite.js';

/**
 * .xlsx reader. Kept out of the shared index so the Cloud Functions bundle never pulls in exceljs; the app
 * imports it as "@asm/shared/excel".
 *
 *   1. Identify the file: an .xlsx name does not make it an .xlsx package (old .xls, encrypted workbook,
 *      HTML/XML export, CSV, .ods each get their own actionable error).
 *   2. Read it with exceljs.
 *   3. If exceljs fails — or finds no data — read it with the tolerant built-in reader (xlsxLite.ts),
 *      which handles namespace-prefixed XML written by .NET / Open XML SDK exporters, inline strings, etc.
 *   4. No visible worksheet with data → a specific error naming the sheets found.
 * Every failure is a SpreadsheetError with a code, a user-facing message and a technical detail.
 */

export { SpreadsheetError } from './spreadsheetSniff.js';

interface ExcelJsWorkbook {
  xlsx: { load(data: ArrayBuffer | Uint8Array): Promise<unknown> };
  worksheets: {
    name: string;
    state?: string;
    eachRow(opts: { includeEmpty: boolean }, cb: (row: { values: unknown }, rowNumber: number) => void): void;
  }[];
}

export interface XlsxReadResult {
  sheets: ExcelSheet[];
  allSheets: { name: string; state: string }[];
  reader: 'exceljs' | 'builtin';
  /** Why exceljs was not used (when the built-in reader read the file). */
  exceljsError: string | null;
}

async function readWithExceljs(bytes: Uint8Array): Promise<Omit<XlsxReadResult, 'reader' | 'exceljsError'>> {
  const mod = (await import('exceljs')) as unknown as { default?: { Workbook: new () => ExcelJsWorkbook }; Workbook?: new () => ExcelJsWorkbook };
  const Workbook = mod.default?.Workbook ?? mod.Workbook;
  if (!Workbook) throw new Error('the exceljs library did not load');
  const wb = new Workbook();
  await wb.xlsx.load(bytes);
  const sheets: ExcelSheet[] = [];
  const allSheets = wb.worksheets.map((ws) => ({ name: ws.name, state: ws.state || 'visible' }));
  for (const ws of wb.worksheets) {
    if (ws.state && ws.state !== 'visible') continue;
    const rows: unknown[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => rows.push(Array.isArray(row.values) ? (row.values as unknown[]) : []));
    const text = excelRowsToText(rows);
    if (text.length) sheets.push({ name: ws.name, rows: text });
  }
  return { sheets, allSheets };
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export async function readXlsxDetailed(data: ArrayBuffer | Uint8Array): Promise<XlsxReadResult> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const sniff = sniffSpreadsheet(bytes);
  const notXlsx = sniffError(sniff.kind, sniff.detail);
  if (notXlsx) throw notXlsx;

  let exceljsError: string | null = null;
  try {
    const r = await readWithExceljs(bytes);
    if (r.sheets.length) return { ...r, reader: 'exceljs', exceljsError: null };
    exceljsError = 'exceljs found no rows in any visible worksheet';
  } catch (e) {
    exceljsError = msg(e);
  }

  let lite: Awaited<ReturnType<typeof readXlsxLite>>;
  try {
    lite = await readXlsxLite(bytes);
  } catch (e) {
    if (e instanceof SpreadsheetError) throw new SpreadsheetError(e.code, e.message, `${e.detail}; exceljs: ${exceljsError}`);
    throw new SpreadsheetError('xlsx_parse_failed', `The workbook could not be parsed (${exceljsError}). Open it in Excel, save it again as Excel Workbook (*.xlsx), and upload the new file; or upload the PDF version of the statement.`, `exceljs: ${exceljsError}; built-in reader: ${msg(e)}`);
  }
  if (!lite.sheets.length) {
    const list = lite.allSheets.map((s) => (s.state === 'visible' ? `"${s.name}" (empty)` : `"${s.name}" (${s.state})`)).join(', ');
    throw new SpreadsheetError('xlsx_no_data', `The workbook has no visible worksheet with data. Worksheets found: ${list || 'none'}. Unhide the statement sheet (or check it is the right file) and upload again.`, `exceljs: ${exceljsError}`);
  }
  return { sheets: lite.sheets, allSheets: lite.allSheets, reader: 'builtin', exceljsError };
}

/** Every visible worksheet with data, as text rows. Throws SpreadsheetError with a specific message. */
export async function readXlsx(data: ArrayBuffer | Uint8Array): Promise<ExcelSheet[]> {
  return (await readXlsxDetailed(data)).sheets;
}
