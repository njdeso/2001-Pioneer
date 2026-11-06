/**
 * Excel (.xlsx) reading via exceljs (npm registry). Cells are converted to the same
 * plain-text form a CSV export would give, so the import pipeline treats both alike.
 *
 * exceljs cell values can be: null, string, number, boolean, Date, or objects —
 * { richText: [{ text }] }, { text, hyperlink }, { formula | sharedFormula, result },
 * { error }. All are handled by excelCellToText.
 */

export interface ExcelSheet {
  name: string;
  rows: string[][];
}

/** Numbers to text without binary floating-point artifacts (0.1 + 0.2 style). */
function numberToText(n: number): string {
  if (!Number.isFinite(n)) return '';
  if (Number.isInteger(n)) return Number.isSafeInteger(n) ? String(n) : n.toFixed(0);
  return String(Number(n.toPrecision(15)));
}

function dateToText(d: Date): string {
  if (Number.isNaN(d.getTime())) return '';
  // exceljs represents Excel dates as UTC instants; the calendar date is the UTC date.
  return d.toISOString().slice(0, 10);
}

export function excelCellToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return numberToText(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return dateToText(value);
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v.richText)) return v.richText.map((p) => String((p as { text?: unknown }).text ?? '')).join('');
    if ('error' in v) return '';
    if ('result' in v) return excelCellToText(v.result);
    if ('formula' in v || 'sharedFormula' in v) return '';
    if ('text' in v) return excelCellToText(v.text);
  }
  return String(value);
}

/**
 * Convert exceljs `row.values` arrays (1-based and sparse) to dense string rows,
 * dropping rows that are entirely blank (matching the CSV parser).
 */
export function excelRowsToText(rows: unknown[][]): string[][] {
  const out: string[][] = [];
  for (const values of rows) {
    const cells: string[] = [];
    const arr = Array.isArray(values) ? values : [];
    for (let c = 1; c < arr.length; c++) cells.push(excelCellToText(arr[c]).trim());
    while (cells.length && cells[cells.length - 1] === '') cells.pop();
    if (cells.some((c) => c !== '')) out.push(cells);
  }
  return out;
}
