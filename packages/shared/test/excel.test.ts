import { test } from 'node:test';
import assert from 'node:assert/strict';
import { excelCellToText, excelRowsToText } from '../src/excel.ts';
import { readXlsx } from '../src/excelRead.ts';
import { detectColumns, importRecordInput, normalizeRecord, parseFlexibleDate } from '../src/importMap.ts';
import { toTable } from '../src/csv.ts';

// ---- Cell conversion (runs everywhere; no Excel library needed) ----

test('excel cell values convert to CSV-equivalent text', () => {
  assert.equal(excelCellToText(null), '');
  assert.equal(excelCellToText(undefined), '');
  assert.equal(excelCellToText('Smith, John'), 'Smith, John');
  assert.equal(excelCellToText(12500), '12500');
  assert.equal(excelCellToText(1850.5), '1850.5');
  assert.equal(excelCellToText(0.1 + 0.2), '0.3');
  assert.equal(excelCellToText(true), 'TRUE');
  assert.equal(excelCellToText(new Date(Date.UTC(2025, 10, 1))), '2025-11-01');
  assert.equal(excelCellToText({ richText: [{ text: 'Quick ' }, { text: 'Cab' }] }), 'Quick Cab');
  assert.equal(excelCellToText({ text: 'Portal', hyperlink: 'https://example.test' }), 'Portal');
  assert.equal(excelCellToText({ formula: 'B2*2', result: 3700 }), '3700');
  assert.equal(excelCellToText({ sharedFormula: 'C2', result: 'x' }), 'x');
  assert.equal(excelCellToText({ formula: 'NOW()' }), '');
  assert.equal(excelCellToText({ error: '#N/A' }), '');
});

test('sparse 1-based exceljs rows become dense text rows; blank rows dropped', () => {
  // eslint-disable-next-line no-sparse-arrays
  const rows = [[, 'Client', 'Policy #', , 'Premium'], [], [, 'Synthetic Co', 'P-1', , 100], [, '', '  ']];
  assert.deepEqual(excelRowsToText(rows as unknown[][]), [
    ['Client', 'Policy #', '', 'Premium'],
    ['Synthetic Co', 'P-1', '', '100'],
  ]);
});

test('excel-converted values flow through the import parsers', () => {
  const table = toTable(excelRowsToText([
    [undefined, 'Insured Name', 'Policy #', 'Company', 'Eff Date', 'Annual Premium'],
    [undefined, 'Synthetic Cab LLC', 'CA-1001', 'Synthetic Mutual', new Date(Date.UTC(2025, 10, 1)), 12500],
  ]));
  const m = detectColumns(table.headers);
  const r = table.rows[0];
  const rec = normalizeRecord(importRecordInput.parse({
    rowNumber: 2, clientName: r[m.clientName!], policyNumber: r[m.policyNumber!], carrierRaw: r[m.carrier!], carrierId: 'K-SM',
    effectiveDate: r[m.effectiveDate!], premium: r[m.premium!],
  }));
  assert.equal(rec.policy?.effectiveDate, '2025-11-01');
  assert.equal(rec.policy?.premiumCents, 1250000);
  assert.equal(parseFlexibleDate(excelCellToText(new Date(Date.UTC(2026, 0, 15)))), '2026-01-15');
});

// ---- Real .xlsx round trip through exceljs (runs once `npm install` has run) ----

async function loadExcelJs(): Promise<any | null> {
  try {
    const mod: any = await import('exceljs');
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

test('reads a real .xlsx workbook: title row, dates, currency, formulas, rich text, hidden sheet', async (t) => {
  const ExcelJS = await loadExcelJs();
  if (!ExcelJS) { t.skip('exceljs is not installed in this environment'); return; }

  // Build a synthetic workbook the way a user's export might look.
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Clients');
  ws.addRow(['SYNTHETIC TEST DATA - NOT REAL CLIENTS']);
  ws.addRow(['Insured Name', 'Policy #', 'Company', 'Eff Date', 'Annual Premium', 'Pers/Comm', 'Notes']);
  ws.addRow(['Synthetic Cab, LLC', 'CA-1001', 'Synthetic Mutual', new Date(Date.UTC(2025, 10, 1)), 12500, 'CL', null]);
  ws.addRow([{ richText: [{ text: 'Pat ' }, { text: 'Example' }] }, 'HO-77', 'Synthetic Mutual', new Date(Date.UTC(2026, 2, 1)), { formula: '600*2', result: 1200 }, 'PL', 'renewal']);
  ws.addRow([]);
  ws.addRow(['Synthetic Towing Inc', 4455012, 'J&J', '6/1/2026', 4400.5, 'CL', { text: 'link', hyperlink: 'https://example.test' }]);
  ws.getColumn(4).numFmt = 'mm/dd/yyyy';
  ws.getColumn(5).numFmt = '"$"#,##0.00';
  const hidden = wb.addWorksheet('Lookups', { state: 'hidden' });
  hidden.addRow(['secret']);
  const second = wb.addWorksheet('Second');
  second.addRow(['A', 'B']);
  second.addRow([1, 2]);
  const buf: ArrayBuffer = await wb.xlsx.writeBuffer();

  const sheets = await readXlsx(new Uint8Array(buf));
  assert.deepEqual(sheets.map((s) => s.name), ['Clients', 'Second']);
  const rows = sheets[0].rows;
  assert.deepEqual(rows[0], ['SYNTHETIC TEST DATA - NOT REAL CLIENTS']);
  assert.deepEqual(rows[2], ['Synthetic Cab, LLC', 'CA-1001', 'Synthetic Mutual', '2025-11-01', '12500', 'CL']);
  assert.deepEqual(rows[3], ['Pat Example', 'HO-77', 'Synthetic Mutual', '2026-03-01', '1200', 'PL', 'renewal']);
  assert.deepEqual(rows[4], ['Synthetic Towing Inc', '4455012', 'J&J', '6/1/2026', '4400.5', 'CL', 'link']);
  assert.equal(rows.length, 5); // blank row dropped

  // And the header row is found after the title row.
  const table = toTable(rows.slice(1));
  const m = detectColumns(table.headers);
  assert.equal(table.headers[m.policyNumber!], 'Policy #');
  assert.equal(table.headers[m.line!], 'Pers/Comm');
});

test('a non-xlsx file gives a clear error', async (t) => {
  const ExcelJS = await loadExcelJs();
  if (!ExcelJS) { t.skip('exceljs is not installed in this environment'); return; }
  await assert.rejects(() => readXlsx(new TextEncoder().encode('not a workbook')), /could not be read as an \.xlsx/);
});
