/**
 * What kind of file is this really? Many "Excel" downloads are not .xlsx packages at all: old .xls
 * workbooks, web pages (HTML tables), "XML Spreadsheet 2003" files or plain CSV are often given an .xlsx
 * name, and password-protected workbooks are a different container. Spreadsheet programs open them all,
 * so the user needs to be told exactly which one it is and what to do.
 */

export type SpreadsheetKind = 'xlsx_zip' | 'ods' | 'legacy_xls' | 'encrypted' | 'ole_other' | 'html' | 'xml2003' | 'xml_other' | 'text' | 'empty' | 'unknown';

export class SpreadsheetError extends Error {
  constructor(public code: string, message: string, public detail: string = '') {
    super(message);
    this.name = 'SpreadsheetError';
  }
}

const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const startsWith = (b: Uint8Array, sig: number[]) => sig.every((x, i) => b[i] === x);

function containsUtf16(b: Uint8Array, s: string): boolean {
  const pat = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) pat[i * 2] = s.charCodeAt(i);
  outer: for (let i = 0; i + pat.length <= b.length; i++) {
    for (let j = 0; j < pat.length; j++) if (b[i + j] !== pat[j]) continue outer;
    return true;
  }
  return false;
}

export function sniffSpreadsheet(bytes: Uint8Array): { kind: SpreadsheetKind; detail: string } {
  if (bytes.length === 0) return { kind: 'empty', detail: 'the file is empty (0 bytes)' };
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5) && (bytes[3] === 4 || bytes[3] === 6)) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 200)));
    if (head.includes('mimetypeapplication/vnd.oasis.opendocument.spreadsheet')) return { kind: 'ods', detail: 'OpenDocument spreadsheet (.ods)' };
    return { kind: 'xlsx_zip', detail: 'ZIP package' };
  }
  if (startsWith(bytes, OLE)) {
    if (containsUtf16(bytes, 'EncryptedPackage')) return { kind: 'encrypted', detail: 'password-protected (encrypted) Office file' };
    if (containsUtf16(bytes, 'Workbook') || containsUtf16(bytes, 'Book')) return { kind: 'legacy_xls', detail: 'Excel 97–2003 workbook (.xls)' };
    return { kind: 'ole_other', detail: 'older Office (OLE) file that is not an Excel workbook' };
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, Math.min(bytes.length, 4096))).replace(/^﻿/, '').trimStart();
  const low = text.toLowerCase();
  if (low.startsWith('<')) {
    if (low.includes('urn:schemas-microsoft-com:office:spreadsheet')) return { kind: 'xml2003', detail: 'XML Spreadsheet 2003 file' };
    if (/<(html|table|!doctype html|head|body|meta)\b/.test(low)) return { kind: 'html', detail: 'web page (HTML table)' };
    return { kind: 'xml_other', detail: 'XML text file' };
  }
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  let printable = 0;
  for (const c of sample) if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 160) printable++;
  if (printable / sample.length > 0.95) return { kind: 'text', detail: /\t/.test(text) ? 'tab-separated text' : 'comma-separated or plain text' };
  const hex = Array.from(bytes.subarray(0, 4), (c) => c.toString(16).padStart(2, '0')).join(' ');
  return { kind: 'unknown', detail: `unrecognized file (starts with bytes ${hex})` };
}

/** A clear, actionable error for every non-.xlsx kind (null for a real .xlsx package). */
export function sniffError(kind: SpreadsheetKind, detail: string): SpreadsheetError | null {
  switch (kind) {
    case 'xlsx_zip': return null;
    case 'legacy_xls': return new SpreadsheetError('xlsx_legacy_xls', 'This is an old Excel 97–2003 workbook (.xls) saved with an .xlsx name. Open it in Excel, choose File → Save As → Excel Workbook (*.xlsx), and upload the new file.', detail);
    case 'encrypted': return new SpreadsheetError('xlsx_encrypted', 'The workbook is password-protected (encrypted), so it cannot be read. In Excel, open it, choose File → Info → Protect Workbook → Encrypt with Password, clear the password, save, and upload again.', detail);
    case 'html': return new SpreadsheetError('xlsx_html', 'This file is a web page (an HTML table) saved with an .xlsx name — not a real Excel workbook. Open it in Excel and choose File → Save As → Excel Workbook (*.xlsx), or save it as CSV, and upload that file.', detail);
    case 'xml2003': return new SpreadsheetError('xlsx_xml2003', 'This is an "XML Spreadsheet 2003" file saved with an .xlsx name. Open it in Excel and choose File → Save As → Excel Workbook (*.xlsx), then upload the new file.', detail);
    case 'ods': return new SpreadsheetError('xlsx_ods', 'This is an OpenDocument spreadsheet (.ods). Save it as Excel Workbook (*.xlsx) or CSV and upload that file.', detail);
    case 'text': return new SpreadsheetError('xlsx_is_text', `This file contains plain text (${detail}), not an Excel workbook. If it is a CSV export, rename it to .csv and upload it again.`, detail);
    case 'empty': return new SpreadsheetError('xlsx_empty_file', 'The file is empty (0 bytes). Download the statement again and upload the new copy.', detail);
    default: return new SpreadsheetError('xlsx_not_excel', `This file is not an Excel workbook (${detail}). Download the statement again as .xlsx, PDF or CSV.`, detail);
  }
}
