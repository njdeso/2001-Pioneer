import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readXlsxDetailed, SpreadsheetError } from '../src/excelRead.ts';
import { isDateFormat, readXlsxLite } from '../src/xlsxLite.ts';
import { sniffSpreadsheet } from '../src/spreadsheetSniff.ts';

// Fixtures shared with the dev smoke test (synthetic data only).
import { zip, HEAD, detailedStatementWorkbook, oleFile } from '../../../scripts/lib/synthetic-xlsx.mjs';
const workbook = (o: Parameters<typeof detailedStatementWorkbook>[0] = {}) => detailedStatementWorkbook(o).bytes;

function checkStatementSheets(sheets: { name: string; rows: string[][] }[]) {
  assert.deepEqual(sheets.map((s) => s.name), ['Detailed', 'Summary']);
  const d = sheets[0].rows;
  assert.equal(d.length, 95, '94 data rows + header');
  assert.equal(d[0].length, 20);
  assert.deepEqual(d[0], HEAD);
  assert.equal(d[1][0], '202511', 'Month End stays 202511 (a number, not a date)');
  assert.equal(d[1][9], '01/01/0001', 'a text date is kept exactly as stored');
  assert.equal(d[1][6], '01/01/2025');
  assert.equal(d[1][2], 'Synthetic Insured 1 & Co');
  assert.equal(d[1][10], '1000');
  assert.equal(d[2][10], '1010.5');
  assert.equal(d[1][11], '0.12');
  assert.equal(d[1][19], undefined, 'trailing blank cell trimmed');
  const { premium, commission } = detailedStatementWorkbook();
  assert.deepEqual(sheets[1].rows, [['Total Written Premium', String(premium)], ['Total Commission', String(commission)], ['Statement Date', '2025-11-01']]);
}

test('built-in reader: an Excel-style DetailedStatement workbook (Detailed + Summary, text dates, Month End 202511)', async () => {
  const r = await readXlsxLite(workbook());
  checkStatementSheets(r.sheets);
});

test('built-in reader: the same workbook as written by .NET exporters (x: prefixes, no cell refs, inline strings) reads identically', async () => {
  const a = await readXlsxLite(workbook());
  const b = await readXlsxLite(workbook({ prefix: 'x', refs: false, inline: true }));
  assert.deepEqual(b.sheets, a.sheets);
});

test('readXlsxDetailed: reads both variants whichever reader succeeds (exceljs where installed, else built-in)', async (t) => {
  for (const [label, bytes] of [['Excel-style', workbook()], ['.NET-style', workbook({ prefix: 'x', refs: false, inline: true })]] as const) {
    const r = await readXlsxDetailed(bytes);
    t.diagnostic(`${label}: read by ${r.reader}${r.exceljsError ? ` (exceljs: ${r.exceljsError})` : ''}`);
    checkStatementSheets(r.sheets);
  }
});

const code = async (bytes: Uint8Array) => { try { await readXlsxDetailed(bytes); return 'ok'; } catch (e) { assert.ok(e instanceof SpreadsheetError, String(e)); return `${(e as SpreadsheetError).code}: ${(e as Error).message}`; } };
const ole = (marker: string) => oleFile(marker);

test('every non-.xlsx file gets its own specific, actionable error (never "could not be read")', async () => {
  assert.match(await code(ole('Workbook')), /^xlsx_legacy_xls: .*Excel 97–2003.*Save As/);
  assert.match(await code(ole('EncryptedPackage')), /^xlsx_encrypted: .*password-protected/);
  assert.match(await code(new TextEncoder().encode('<html><body><table><tr><td>Policy</td></tr></table></body></html>')), /^xlsx_html: .*web page/);
  assert.match(await code(new TextEncoder().encode('<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"></Workbook>')), /^xlsx_xml2003: /);
  assert.match(await code(new TextEncoder().encode('Policy,Insured,Commission\nSYN1,Synthetic,12.00\n')), /^xlsx_is_text: .*rename it to \.csv/);
  assert.match(await code(new Uint8Array(0)), /^xlsx_empty_file: /);
  assert.match(await code(new Uint8Array([1, 2, 3, 4, 250, 251, 252, 0, 0, 7])), /^xlsx_not_excel: .*starts with bytes 01 02 03 04/);
  const full = workbook();
  assert.match(await code(full.subarray(0, Math.floor(full.length / 2))), /^xlsx_(corrupt|parse_failed): .*(damaged|incomplete|parsed)/i);
  assert.match(await code(zip({ 'readme.txt': 'hello' })), /^xlsx_(no_workbook|parse_failed): /);
  assert.match(await code(workbook({ hiddenDetailed: true })), /^xlsx_no_data: .*"Detailed" \(hidden\).*"Summary" \(hidden\)/);
});

test('file sniffing', () => {
  assert.equal(sniffSpreadsheet(workbook()).kind, 'xlsx_zip');
  assert.equal(sniffSpreadsheet(ole('Workbook')).kind, 'legacy_xls');
  assert.equal(sniffSpreadsheet(new TextEncoder().encode('﻿  <!DOCTYPE html><html>')).kind, 'html');
});

test('date formats: only real date formats turn numbers into dates', () => {
  for (const f of ['mm/dd/yyyy', 'd-mmm-yy', 'yyyy-mm-dd hh:mm', '[$-409]mmmm d, yyyy', 'm/d/yy;@']) assert.equal(isDateFormat(f), true, f);
  for (const f of ['General', '0.00', '#,##0', '"$"#,##0.00', '0%', '[Red]#,##0', '"Month "0']) assert.equal(isDateFormat(f), false, f);
});
