import { numberToText, type ExcelSheet } from './excel.js';
import { SpreadsheetError } from './spreadsheetSniff.js';

/**
 * A small, tolerant .xlsx reader used when exceljs cannot parse a workbook. It reads the ZIP package
 * directly (DecompressionStream, available in Node 18+ and browsers — no extra dependency) and the
 * worksheet XML with namespace-agnostic patterns, so files written by .NET / Open XML SDK exporters
 * (<x:worksheet>, <x:c>, …), with inline strings, shared strings, rich text or no cell references read
 * the same as Excel-written ones. Values are produced as the text a CSV export would give: numbers
 * without float artifacts, date-formatted numbers as YYYY-MM-DD, text exactly as stored (so a text date
 * such as 01/01/0001 stays 01/01/0001).
 */

const MAX_TOTAL_BYTES = 200 * 1024 * 1024; // uncompressed, guards against ZIP bombs
const MAX_ENTRY_BYTES = 100 * 1024 * 1024;

interface ZipEntry { name: string; method: number; flags: number; compSize: number; size: number; localOffset: number }

function readZipDirectory(b: Uint8Array): Map<string, ZipEntry> {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new SpreadsheetError('xlsx_corrupt', 'The .xlsx file is damaged or incomplete (its ZIP directory is missing — the download may have been cut off). Download the statement again and upload the new copy.', 'no end-of-central-directory record');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  if (p === 0xffffffff || count === 0xffff) throw new SpreadsheetError('xlsx_corrupt', 'The .xlsx file uses a ZIP64 layout this reader does not support. Open it in Excel, save it again as .xlsx, and upload that file.', 'zip64');
  const entries = new Map<string, ZipEntry>();
  for (let n = 0; n < count; n++) {
    if (p + 46 > b.length || dv.getUint32(p, true) !== 0x02014b50) throw new SpreadsheetError('xlsx_corrupt', 'The .xlsx file is damaged (its ZIP directory is unreadable). Download the statement again and upload the new copy.', `bad central directory entry ${n}`);
    const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true), size = dv.getUint32(p + 24, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = new TextDecoder(flags & 0x800 ? 'utf-8' : 'latin1').decode(b.subarray(p + 46, p + 46 + nl)).replace(/\\/g, '/').replace(/^\//, '');
    entries.set(name.toLowerCase(), { name, method, flags, compSize, size, localOffset });
    p += 46 + nl + xl + cl;
  }
  return entries;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

class Zip {
  private total = 0;
  constructor(private b: Uint8Array, private entries: Map<string, ZipEntry>) {}
  has(path: string) { return this.entries.has(path.toLowerCase()); }
  async text(path: string): Promise<string | null> {
    const e = this.entries.get(path.toLowerCase());
    if (!e) return null;
    if (e.flags & 1) throw new SpreadsheetError('xlsx_encrypted', 'The workbook is password-protected (encrypted), so it cannot be read. Remove the password in Excel, save, and upload again.', `encrypted entry ${e.name}`);
    if (e.size > MAX_ENTRY_BYTES) throw new SpreadsheetError('xlsx_too_large', `The workbook is too large to read (${e.name} is ${Math.round(e.size / 1048576)} MB uncompressed).`, e.name);
    const dv = new DataView(this.b.buffer, this.b.byteOffset, this.b.byteLength);
    if (dv.getUint32(e.localOffset, true) !== 0x04034b50) throw new SpreadsheetError('xlsx_corrupt', 'The .xlsx file is damaged (a part of the package is missing). Download the statement again and upload the new copy.', `bad local header for ${e.name}`);
    const start = e.localOffset + 30 + dv.getUint16(e.localOffset + 26, true) + dv.getUint16(e.localOffset + 28, true);
    const raw = this.b.subarray(start, start + e.compSize);
    let out: Uint8Array;
    if (e.method === 0) out = raw;
    else if (e.method === 8) {
      try { out = await inflate(raw); } catch (err) { throw new SpreadsheetError('xlsx_corrupt', 'The .xlsx file is damaged (a part of the package cannot be decompressed). Download the statement again and upload the new copy.', `${e.name}: ${err instanceof Error ? err.message : String(err)}`); }
    } else throw new SpreadsheetError('xlsx_corrupt', 'The .xlsx file uses a compression method this reader does not support. Open it in Excel, save it again as .xlsx, and upload that file.', `${e.name}: method ${e.method}`);
    this.total += out.length;
    if (out.length > MAX_ENTRY_BYTES || this.total > MAX_TOTAL_BYTES) throw new SpreadsheetError('xlsx_too_large', 'The workbook is too large to read.', e.name);
    return new TextDecoder('utf-8').decode(out);
  }
}

// ---------------------------------------------------------------- XML helpers (namespace-agnostic)

const P = '(?:[A-Za-z_][\\w.-]*:)?'; // optional namespace prefix
function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    const v = decode(m[3] ?? m[4] ?? '');
    out[m[1]] = v;
    const local = m[1].includes(':') ? m[1].split(':')[1] : m[1];
    if (!(local in out)) out[local] = v;
    if (m[1].includes(':')) out[`:${local}`] = v; // prefixed form, e.g. r:id → ':id'
  }
  return out;
}
function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16))); // OOXML escapes such as _x000D_
}
const tag = (name: string, flags = 'g') => new RegExp(`<${P}${name}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${P}${name}>)`, flags);
/** Concatenated text of <t> runs, without phonetic (<rPh>) runs. */
function runsText(xml: string): string {
  const noPh = xml.replace(new RegExp(`<${P}rPh\\b[\\s\\S]*?<\\/${P}rPh>`, 'g'), '');
  let s = '';
  for (const m of noPh.matchAll(tag('t'))) s += decode(m[2] ?? '');
  return s;
}
function resolve(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = (base ? base.split('/') : []);
  for (const seg of target.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg); }
  return parts.join('/');
}

// ---------------------------------------------------------------- dates

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
export function isDateFormat(code: string): boolean {
  const c = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[(?!h\]|m\]|mm\]|s\]|ss\])[^\]]*\]/gi, '').replace(/_.|\*./g, '');
  if (/general/i.test(c)) return false;
  return /[dmyhs]/i.test(c) && !/^[#0.,%\s?E+\-/]*$/.test(c);
}
function serialToIso(serial: number, date1904: boolean): string {
  const ms = Math.round((serial + (date1904 ? 1462 : 0) - 25569) * 86400000); // 25569 = days 1899-12-30 → 1970-01-01; 1904 system starts 1462 days later
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? numberToText(serial) : d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- workbook

const colIndex = (ref: string) => { let n = 0; for (const ch of ref.replace(/[^A-Za-z]/g, '').toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

export interface LiteSheetInfo { name: string; state: string }

/** All visible worksheets with data (like readXlsx), plus every sheet's name and state. */
export async function readXlsxLite(data: ArrayBuffer | Uint8Array): Promise<{ sheets: ExcelSheet[]; allSheets: LiteSheetInfo[] }> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const zip = new Zip(bytes, readZipDirectory(bytes));

  // The workbook part (normally xl/workbook.xml), via the package relationships.
  let wbPath = 'xl/workbook.xml';
  const rootRels = await zip.text('_rels/.rels');
  if (rootRels) for (const m of rootRels.matchAll(tag('Relationship'))) { const a = attrs(m[1]); if (/officeDocument$/.test(a.Type ?? '') && a.Target) wbPath = resolve('', a.Target); }
  const wbXml = await zip.text(wbPath);
  if (!wbXml) throw new SpreadsheetError('xlsx_no_workbook', 'This ZIP file is not an Excel workbook (it has no workbook part). Download the statement again as .xlsx, PDF or CSV.', `missing ${wbPath}`);
  const wbDir = wbPath.includes('/') ? wbPath.slice(0, wbPath.lastIndexOf('/')) : '';
  const date1904 = new RegExp(`<${P}workbookPr\\b[^>]*date1904\\s*=\\s*["'](1|true)["']`, 'i').test(wbXml);

  const rels = new Map<string, string>();
  const relsXml = await zip.text(`${wbDir ? `${wbDir}/` : ''}_rels/${wbPath.slice(wbDir ? wbDir.length + 1 : 0)}.rels`);
  if (relsXml) for (const m of relsXml.matchAll(tag('Relationship'))) { const a = attrs(m[1]); if (a.Id && a.Target) rels.set(a.Id, a.Target); }

  // Shared strings and number formats.
  const shared: string[] = [];
  const ssPath = [...rels.values()].find((t) => /sharedStrings\.xml$/i.test(t));
  const ssXml = await zip.text(ssPath ? resolve(wbDir, ssPath) : `${wbDir}/sharedStrings.xml`);
  if (ssXml) for (const m of ssXml.matchAll(tag('si'))) shared.push(runsText(m[2] ?? ''));
  const dateStyles = new Set<number>();
  const stPath = [...rels.values()].find((t) => /styles\.xml$/i.test(t));
  const stXml = await zip.text(stPath ? resolve(wbDir, stPath) : `${wbDir}/styles.xml`);
  if (stXml) {
    const custom = new Map<number, string>();
    for (const m of stXml.matchAll(tag('numFmt'))) { const a = attrs(m[1]); custom.set(Number(a.numFmtId), a.formatCode ?? ''); }
    const xfs = new RegExp(`<${P}cellXfs\\b[^>]*>([\\s\\S]*?)<\\/${P}cellXfs>`).exec(stXml)?.[1] ?? '';
    let i = 0;
    for (const m of xfs.matchAll(tag('xf'))) {
      const id = Number(attrs(m[1]).numFmtId ?? 0);
      if (BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDateFormat(custom.get(id)!))) dateStyles.add(i);
      i++;
    }
  }

  const sheets: ExcelSheet[] = [];
  const allSheets: LiteSheetInfo[] = [];
  for (const m of wbXml.matchAll(tag('sheet'))) {
    const a = attrs(m[1]);
    const name = a.name ?? `Sheet${allSheets.length + 1}`;
    const state = a.state ?? 'visible';
    allSheets.push({ name, state });
    if (state !== 'visible') continue;
    const target = rels.get(a[':id'] ?? a.id ?? '');
    const xml = target ? await zip.text(resolve(wbDir, target)) : null;
    if (!xml) continue;
    const rows: string[][] = [];
    for (const r of xml.matchAll(tag('row'))) {
      const cells: string[] = [];
      let next = 0;
      for (const c of (r[2] ?? '').matchAll(tag('c'))) {
        const ca = attrs(c[1]);
        const col = ca.r ? colIndex(ca.r) : next;
        next = col + 1;
        const inner = c[2] ?? '';
        const v = new RegExp(`<${P}v\\b[^>]*>([\\s\\S]*?)<\\/${P}v>`).exec(inner)?.[1];
        let text = '';
        switch (ca.t) {
          case 's': text = shared[Number(v)] ?? ''; break;
          case 'inlineStr': text = runsText(new RegExp(`<${P}is\\b[^>]*>([\\s\\S]*?)<\\/${P}is>`).exec(inner)?.[1] ?? ''); break;
          case 'str': text = decode(v ?? ''); break;
          case 'b': text = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : ''; break;
          case 'e': text = ''; break;
          case 'd': text = (v ?? '').slice(0, 10); break;
          default: {
            if (v === undefined || v.trim() === '') break;
            const n = Number(v);
            text = Number.isNaN(n) ? decode(v) : dateStyles.has(Number(ca.s ?? 0)) ? serialToIso(n, date1904) : numberToText(n);
          }
        }
        while (cells.length < col) cells.push('');
        cells[col] = text.trim();
      }
      while (cells.length && cells[cells.length - 1] === '') cells.pop();
      if (cells.some((x) => x !== '')) rows.push(cells);
    }
    if (rows.length) sheets.push({ name, rows });
  }
  if (!allSheets.length) throw new SpreadsheetError('xlsx_no_sheets', 'The workbook lists no worksheets. Open it in Excel, save it again as .xlsx, and upload that file.', 'no <sheet> entries');
  return { sheets, allSheets };
}
