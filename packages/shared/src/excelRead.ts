import { excelRowsToText, type ExcelSheet } from './excel.js';

/**
 * .xlsx reader built on exceljs. Kept out of the shared index so the Cloud Functions
 * bundle never pulls in exceljs; the app imports it as "@asm/shared/excel".
 */

interface ExcelJsWorkbook {
  xlsx: { load(data: ArrayBuffer | Uint8Array): Promise<unknown> };
  worksheets: {
    name: string;
    state?: string;
    eachRow(opts: { includeEmpty: boolean }, cb: (row: { values: unknown }, rowNumber: number) => void): void;
  }[];
}

/** Read every visible worksheet of an .xlsx file into text rows. Loads exceljs on demand. */
export async function readXlsx(data: ArrayBuffer | Uint8Array): Promise<ExcelSheet[]> {
  const mod = (await import('exceljs')) as unknown as { default?: { Workbook: new () => ExcelJsWorkbook }; Workbook?: new () => ExcelJsWorkbook };
  const Workbook = mod.default?.Workbook ?? mod.Workbook;
  if (!Workbook) throw new Error('Excel reader failed to load');
  const wb = new Workbook();
  try {
    await wb.xlsx.load(data);
  } catch {
    throw new Error('This file could not be read as an .xlsx workbook. If it is an old .xls file, save it as .xlsx and try again.');
  }
  const sheets: ExcelSheet[] = [];
  for (const ws of wb.worksheets) {
    if (ws.state && ws.state !== 'visible') continue;
    const rows: unknown[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => rows.push(Array.isArray(row.values) ? (row.values as unknown[]) : []));
    const text = excelRowsToText(rows);
    if (text.length) sheets.push({ name: ws.name, rows: text });
  }
  return sheets;
}
