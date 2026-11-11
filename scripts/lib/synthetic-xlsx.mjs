// Synthetic spreadsheet fixtures (fictional insureds and policies), built byte by byte so no Excel
// library is needed: a "DetailedStatement"-style workbook (Detailed + Summary sheets, text dates
// including the 01/01/0001 placeholder, Month End 202511), as Excel writes it or as .NET / Open XML SDK
// exporters write it (x: prefixes, no cell references, inline strings), plus disguised non-.xlsx files.
// Used by packages/shared/test/xlsx-read.test.ts and the dev smoke test.
import { deflateRawSync } from 'node:zlib';

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** A minimal ZIP (deflate) from { path: text }. */
export function zip(files) {
  const parts = []; const central = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8'); const comp = deflateRawSync(raw); const nm = Buffer.from(name, 'utf8'); const crc = crc32(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, nm, comp); central.push(ch, nm); off += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, end]));
}

/** Variant with three commission columns, as in some carrier "Detailed" exports: Comm (= gross), Gross Comm,
 *  and Net Due Agent = Gross Comm − a 5 % fee; the Summary carries the gross and the net-due totals. */
export const HEAD3 = ['Month End', 'Agency', 'Insured Name', 'Policy Number', 'Line', 'Trans Type', 'Eff Date', 'Exp Date', 'Trans Date', 'Cancel Date',
  'Written Premium', 'Comm Rate', 'Comm', 'Gross Comm', 'State', 'Company', 'Net Due Agent', 'Term', 'Status', 'Notes'];
export const HEAD = ['Month End', 'Agency', 'Insured Name', 'Policy Number', 'Line', 'Trans Type', 'Eff Date', 'Exp Date', 'Trans Date', 'Cancel Date',
  'Written Premium', 'Comm Rate', 'Comm Amount', 'Producer', 'State', 'Company', 'Bill Type', 'Term', 'Status', 'Notes'];
export const detailRows = (n = 94, nonce = '') => Array.from({ length: n }, (_, i) => [202511, 'SYN-001', `Synthetic Insured ${i + 1} & Co`, `SYN${String(100000 + i)}`, i % 2 ? 'Personal Auto' : 'Homeowners', 'RN',
  `0${(i % 9) + 1}/01/2025`, `0${(i % 9) + 1}/01/2026`, '11/03/2025', '01/01/0001', 1000 + i * 10.5, 0.12, Math.round((1000 + i * 10.5) * 12) / 100, 'P01', 'NY', 'Synthetic Mutual', 'DB', 12, 'Active', i === 0 ? nonce : '']);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const colName = (i) => String.fromCharCode(65 + i);

/** A DetailedStatement-like workbook. Summary totals equal the Detailed sheet's sums (it reconciles). */
export function detailedStatementWorkbook({ prefix = '', refs = true, inline = false, hiddenDetailed = false, rows = 94, nonce = '', threeCommission = false } = {}) {
  const x = prefix ? `${prefix}:` : '';
  const ns = prefix ? `xmlns:${prefix}="http://schemas.openxmlformats.org/spreadsheetml/2006/main"` : 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const strings = []; const sIdx = (s) => { let k = strings.indexOf(s); if (k < 0) { strings.push(s); k = strings.length - 1; } return k; };
  const cell = (v, r, c, style) => {
    const ref = refs ? ` r="${colName(c)}${r}"` : '';
    const s = style !== undefined ? ` s="${style}"` : '';
    if (typeof v === 'number') return `<${x}c${ref}${s}><${x}v>${v}</${x}v></${x}c>`;
    if (v === '') return '';
    if (inline) return `<${x}c${ref} t="inlineStr"><${x}is><${x}t>${esc(v)}</${x}t></${x}is></${x}c>`;
    return `<${x}c${ref} t="s"><${x}v>${sIdx(v)}</${x}v></${x}c>`;
  };
  let data = detailRows(rows, nonce);
  if (threeCommission) data = data.map((r) => { const g = r[12]; const net = Math.round(g * 95) / 100; return [...r.slice(0, 13), g, r[14], r[15], net, ...r.slice(17)]; });
  const premium = Math.round(data.reduce((t, r) => t + r[10] * 100, 0)) / 100;
  const commission = Math.round(data.reduce((t, r) => t + r[12] * 100, 0)) / 100;
  const netDue = threeCommission ? Math.round(data.reduce((t, r) => t + Math.round(r[16] * 100), 0)) / 100 : null;
  const sheetXml = (rs) => `<?xml version="1.0" encoding="UTF-8"?><${x}worksheet ${ns}><${x}sheetData>${rs.map((row, ri) =>
    `<${x}row r="${ri + 1}">${row.map((v, ci) => cell(v, ri + 1, ci)).join('')}</${x}row>`).join('')}</${x}sheetData></${x}worksheet>`;
  // Summary: one date-formatted numeric cell (serial 45962 = 2025-11-01) to exercise date styles.
  const summary = `<?xml version="1.0" encoding="UTF-8"?><${x}worksheet ${ns}><${x}sheetData>`
    + `<${x}row r="1">${cell('Total Written Premium', 1, 0)}${cell(premium, 1, 1)}</${x}row>`
    + (threeCommission
      ? `<${x}row r="2">${cell('Gross Commission', 2, 0)}${cell(commission, 2, 1)}</${x}row><${x}row r="4">${cell('Net Due Agent', 4, 0)}${cell(netDue, 4, 1)}</${x}row>`
      : `<${x}row r="2">${cell('Total Commission', 2, 0)}${cell(commission, 2, 1)}</${x}row>`)
    + `<${x}row r="3">${cell('Statement Date', 3, 0)}${cell(45962, 3, 1, 1)}</${x}row>`
    + `</${x}sheetData></${x}worksheet>`;
  const files = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0"?><${x}workbook ${ns} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><${x}sheets>`
      + `<${x}sheet name="Detailed" sheetId="1" r:id="rId1"${hiddenDetailed ? ' state="hidden"' : ''}/><${x}sheet name="Summary" sheetId="2" r:id="rId2"${hiddenDetailed ? ' state="hidden"' : ''}/></${x}sheets></${x}workbook>`,
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/>'
      + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>'
      + '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheetXml([threeCommission ? HEAD3 : HEAD, ...data]),
    'xl/worksheets/sheet2.xml': summary,
    'xl/styles.xml': `<?xml version="1.0"?><${x}styleSheet ${ns}><${x}numFmts count="1"><${x}numFmt numFmtId="164" formatCode="mm/dd/yyyy"/></${x}numFmts><${x}cellXfs count="2"><${x}xf numFmtId="0"/><${x}xf numFmtId="164" applyNumberFormat="1"/></${x}cellXfs></${x}styleSheet>`,
  };
  files['xl/sharedStrings.xml'] = `<?xml version="1.0"?><${x}sst ${ns} count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<${x}si><${x}t>${esc(s)}</${x}t></${x}si>`).join('')}</${x}sst>`;
  return { bytes: zip(files), premium, commission, netDue };
}

/** An old Excel 97–2003 (.xls / OLE) or encrypted-Office container header, as seen in disguised files. */
export function oleFile(marker = 'Workbook', nonce = '') {
  return new Uint8Array(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(500), Buffer.from(marker, 'utf16le'), Buffer.alloc(100), Buffer.from(nonce)]));
}

/** A web-page export (HTML table) — what many portals produce as "Excel". */
export function htmlExport(nonce = '') {
  return new TextEncoder().encode(`<html><head><meta charset="utf-8"></head><body><!-- ${nonce} --><table><tr><td>Policy Number</td><td>Comm Amount</td></tr><tr><td>SYN100000</td><td>120.00</td></tr></table></body></html>`);
}

/** Any workbook from { name, rows } sheets (numbers stay numeric cells; strings shared or inline). */
export function sheetsWorkbook(sheets, { prefix = '', inline = false } = {}) {
  const x = prefix ? `${prefix}:` : '';
  const ns = prefix ? `xmlns:${prefix}="http://schemas.openxmlformats.org/spreadsheetml/2006/main"` : 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const strings = []; const sIdx = (s) => { let k = strings.indexOf(s); if (k < 0) { strings.push(s); k = strings.length - 1; } return k; };
  const colRef = (i) => (i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(64 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26)));
  const cell = (v, r, c) => {
    const ref = ` r="${colRef(c)}${r}"`;
    if (typeof v === 'number') return `<${x}c${ref}><${x}v>${v}</${x}v></${x}c>`;
    if (v === '' || v === null || v === undefined) return '';
    if (inline) return `<${x}c${ref} t="inlineStr"><${x}is><${x}t>${esc(v)}</${x}t></${x}is></${x}c>`;
    return `<${x}c${ref} t="s"><${x}v>${sIdx(String(v))}</${x}v></${x}c>`;
  };
  const files = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0"?><${x}workbook ${ns} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><${x}sheets>${sheets.map((s, i) => `<${x}sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</${x}sheets></${x}workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
  };
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = `<?xml version="1.0" encoding="UTF-8"?><${x}worksheet ${ns}><${x}sheetData>${s.rows.map((row, ri) => `<${x}row r="${ri + 1}">${row.map((v, ci) => cell(v, ri + 1, ci)).join('')}</${x}row>`).join('')}</${x}sheetData></${x}worksheet>`;
  });
  files['xl/sharedStrings.xml'] = `<?xml version="1.0"?><${x}sst ${ns} count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<${x}si><${x}t>${esc(s)}</${x}t></${x}si>`).join('')}</${x}sst>`;
  return zip(files);
}

/**
 * A DetailedStatement with MVR chargebacks (fictional data): 20 columns incl. an ambiguous "Comm" column
 * (deliberately NOT gross), Gross Comm and Net Due Agent; MVR charges appear as Net Due Agent < Gross Comm
 * on the affected row, with "MVR" in Trans Type (or a separate MVR-only row with no commission).
 *   mvr: [{ row: <0-based data row>, cents: <positive charge>, only?: true (an MVR-only row inserted there) }]
 *   negatives: data-row indexes made cancellations (negative premium and commission)
 *   summary: overrides { commissions, net, mvr } in cents (null = omit the label)
 * Returns { sheets, bytes, grossCents, mvrCents, netCents, rows }.
 */
export const MVR_HEAD = ['Month End', 'Agency', 'Insured Name', 'Policy Number', 'Line', 'Trans Type', 'Eff Date', 'Exp Date', 'Trans Date', 'Cancel Date',
  'Written Premium', 'Comm Rate', 'Comm', 'Gross Comm', 'State', 'Company', 'Net Due Agent', 'Term', 'Status', 'Notes'];
export function mvrStatement({ rows = 94, mvr = [{ row: 10, cents: 18480 }], negatives = [3, 40], summary = {}, monthEnd = 202511, nonce = '', prefix = '', inline = false, mutate } = {}) {
  const data = [];
  for (let i = 0; i < rows; i++) {
    const neg = negatives.includes(i);
    const premC = (100000 + i * 1050) * (neg ? -1 : 1);
    const grossC = Math.round(premC * 0.12);
    data.push([monthEnd, 'SYN-001', `Synthetic Insured ${i + 1}`, `00${String(4000 + i)}`, i % 2 ? 'Personal Auto' : 'Homeowners', neg ? 'CN' : (i % 5 ? 'RN' : 'NB'),
      `0${(i % 9) + 1}/01/2025`, `0${(i % 9) + 1}/01/2026`, '11/03/2025', neg ? '11/15/2025' : '01/01/0001',
      premC / 100, 0.12, Math.round(grossC * 0.9) / 100, grossC / 100, 'NY', 'Synthetic Mutual', grossC / 100, 12, neg ? 'Cancelled' : 'Active', i === 0 ? nonce : '']);
  }
  // MVR charges, highest row first so inserted rows do not shift later ones
  for (const m of [...mvr].sort((a, b) => b.row - a.row)) {
    if (m.only) {
      data.splice(m.row, 0, [monthEnd, 'SYN-001', `Synthetic Insured MVR ${m.row}`, `00${String(9000 + m.row)}`, 'Personal Auto', 'MVR', '', '', '11/05/2025', '01/01/0001', '', '', '', '', 'NY', 'Synthetic Mutual', -m.cents / 100, '', 'Active', 'MVR fee']);
    } else {
      const r = data[m.row];
      r[16] = Math.round(r[13] * 100 - m.cents) / 100;
      r[19] = 'MVR chargeback';
    }
  }
  if (mutate) mutate(data);
  const sum = (j) => data.reduce((t, r) => t + Math.round((typeof r[j] === 'number' ? r[j] : 0) * 100), 0);
  const grossCents = sum(13); const netCents = sum(16); const mvrCents = netCents - grossCents;
  const s = { commissions: grossCents, net: netCents, mvr: mvrCents, ...summary };
  const summaryRows = [['Summary', 'Current', 'Year to Date'], ['Written Premium - Current', sum(10) / 100]];
  // Year-to-date figures sit to the right of the current ones, as on carrier summaries.
  if (s.commissions !== null) summaryRows.push(['Commissions - Current', s.commissions / 100, (s.commissions * 11) / 100]);
  if (s.mvr !== null && s.mvr !== undefined) summaryRows.push(['MVR Charges', s.mvr / 100, (s.mvr * 3) / 100]);
  if (s.net !== null) summaryRows.push(['Net Amount Due Agent', s.net / 100, (s.net * 11) / 100]);
  const sheets = [{ name: 'Detailed', rows: [MVR_HEAD, ...data] }, { name: 'Summary', rows: summaryRows }];
  return { sheets, bytes: sheetsWorkbook(sheets, { prefix, inline }), grossCents, mvrCents, netCents, rows: data };
}
