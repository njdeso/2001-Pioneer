/**
 * RFC 4180 CSV parser. Handles quoted fields, escaped quotes (""), delimiters and
 * line breaks inside quotes, CRLF/LF/CR line endings, a UTF-8 BOM, and
 * comma / semicolon / tab / pipe delimiters (auto-detected).
 */

export type Delimiter = ',' | ';' | '\t' | '|';

export function detectDelimiter(text: string): Delimiter {
  const sample = text.replace(/^﻿/, '').split(/\r\n|\n|\r/).slice(0, 10);
  const candidates: Delimiter[] = [',', '\t', ';', '|'];
  let best: Delimiter = ',';
  let bestScore = -1;
  for (const d of candidates) {
    const counts = sample.filter((l) => l.trim()).map((l) => countOutsideQuotes(l, d));
    if (counts.length === 0 || counts[0] === 0) continue;
    const consistent = counts.filter((c) => c === counts[0]).length;
    const score = consistent * 1000 + counts[0];
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

function countOutsideQuotes(line: string, d: string): number {
  let n = 0;
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === d && !q) n++;
  }
  return n;
}

export class CsvError extends Error {}

export function parseCsv(input: string, delimiter?: Delimiter): string[][] {
  const text = input.replace(/^﻿/, '');
  const d = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  let fieldStarted = false;

  const endField = () => { row.push(field); field = ''; fieldStarted = false; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && !fieldStarted) { inQuotes = true; fieldStarted = true; i++; continue; }
    if (ch === d) { endField(); i++; continue; }
    if (ch === '\r' || ch === '\n') {
      endRow();
      if (ch === '\r' && text[i + 1] === '\n') i++;
      i++;
      continue;
    }
    field += ch; fieldStarted = true; i++;
  }
  if (inQuotes) throw new CsvError('Unclosed quote in CSV file');
  if (field !== '' || row.length > 0) endRow();

  // Drop completely blank rows (e.g. trailing newlines)
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Split parsed rows into header + data, trimming headers and padding short rows. */
export function toTable(rows: string[][]): { headers: string[]; rows: string[][] } {
  if (rows.length === 0) return { headers: [], rows: [] };
  const headers = rows[0].map((h, idx) => h.trim() || `Column ${idx + 1}`);
  const width = headers.length;
  const data = rows.slice(1).map((r) => {
    const out = r.slice(0, width).map((c) => c.trim());
    while (out.length < width) out.push('');
    return out;
  });
  return { headers, rows: data };
}
