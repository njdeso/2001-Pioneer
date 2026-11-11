// READ-ONLY local check of a real Excel commission statement with the PR #9 reader.
//
//   npx tsx scripts/inspect-statement-xlsx.mts DetailedStatement20261110.xlsx [--show-rows 3] [--exceljs-dir DIR]
//   --exceljs-dir: a folder where exceljs was installed on its own (npm install --prefix DIR exceljs@4.4.0),
//   for the independent second-parser comparison when the workspace install cannot load it.
//
// It only reads the one file named on the command line. No Firebase, no network, no credentials,
// nothing written. By default it prints structure, counts and totals — not insured names or policy
// numbers (use --show-rows N to print the first N data rows in your own terminal).
//
// Checks (PASS / FAIL / INFO), exit code 0 only if nothing FAILs:
//   1. the production read path (readXlsxDetailed) opens the workbook; which reader succeeded and why
//      exceljs failed, if it did
//   2. the worksheets the server sends on, including the Detailed sheet
//   3. Detailed: header, data-row count, column count; exceljs and the built-in reader agree cell for cell
//   4. 01/01/0001 placeholder dates: kept verbatim in the text; parsed as "no date" (blank)
//   5. Month End values (e.g. 202511) kept verbatim; their YYYYMM reading
//   6. no silent omission: rows with commission, commission total vs the Summary sheet; row limit
//   7. what is NOT tested here: the AI extraction step
import { readFileSync } from 'node:fs';
import { basename, resolve as resolvePath } from 'node:path';
import { createRequire } from 'node:module';
import { readXlsxDetailed } from '../packages/shared/src/excelRead.ts';
import { readXlsxLite } from '../packages/shared/src/xlsxLite.ts';
import { excelRowsToText } from '../packages/shared/src/excel.ts';
import { parseFlexibleDate } from '../packages/shared/src/importMap.ts';
import { tableToText } from '../packages/shared/src/statements/ai.ts';

const args = process.argv.slice(2);
const file = args.find((a, i) => !a.startsWith('--') && !['--show-rows', '--exceljs-dir'].includes(args[i - 1] ?? ''));
const showRows = args.includes('--show-rows') ? Number(args[args.indexOf('--show-rows') + 1]) || 0 : 0;
const exceljsDir = args.includes('--exceljs-dir') ? args[args.indexOf('--exceljs-dir') + 1] : null;
if (!file) { console.error('Usage: npx tsx scripts/inspect-statement-xlsx.mts <statement.xlsx> [--show-rows N]'); process.exit(2); }

const TABLE_ROW_LIMIT = 3000; // the server refuses spreadsheets with more rows than it sends on
const results: { status: 'PASS' | 'FAIL' | 'INFO'; check: string; detail: string }[] = [];
const report = (status: 'PASS' | 'FAIL' | 'INFO', check: string, detail: string) => { results.push({ status, check, detail }); console.log(`${status.padEnd(4)}  ${check}${detail ? `\n      ${detail.replace(/\n/g, '\n      ')}` : ''}`); };

/** Exact cents from statement text: "1,234.50", "$12", "(15.00)", "-3.1" → integer cents; null if not money. */
function cents(raw: string): number | null {
  let s = raw.trim().replace(/[$,\s]/g, '');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  const m = /^(\d+)(?:\.(\d{1,2})\d*)?$/.exec(s);
  if (!m) return null;
  const v = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return neg ? -v : v;
}
const money = (c: number) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const bytes = new Uint8Array(readFileSync(file));
console.log(`\nRead-only inspection of ${basename(file)} (${bytes.length.toLocaleString()} bytes) — nothing is uploaded or written.\n`);

// ---------------------------------------------------------------- 1. production read path
let prod: Awaited<ReturnType<typeof readXlsxDetailed>>;
try {
  prod = await readXlsxDetailed(bytes);
  report('PASS', '1. Workbook opens with the PR #9 read path', `reader used: ${prod.reader}${prod.exceljsError ? (/Cannot find (package|module) 'exceljs'/.test(prod.exceljsError) ? '\nexceljs is not installed here (run npm install for the full two-parser check)' : `\nexceljs could not read it: ${prod.exceljsError}  ← the kind of error production hid behind "The spreadsheet could not be read."`) : ''}`);
} catch (e) {
  const err = e as { code?: string; message?: string; detail?: string };
  report('FAIL', '1. Workbook opens with the PR #9 read path', `${err.code ?? 'error'}: ${err.message}${err.detail ? `\ndetail: ${err.detail}` : ''}`);
  finish();
}

// ---------------------------------------------------------------- 2. worksheets
const sheetLines = prod!.allSheets.map((s) => {
  const got = prod!.sheets.find((x) => x.name === s.name);
  return `${s.name.padEnd(24)} ${s.state.padEnd(10)} ${got ? `${got.rows.length} non-blank rows, up to ${Math.max(...got.rows.map((r) => r.length))} columns` : s.state === 'visible' ? 'no data' : 'skipped (not visible)'}`;
});
const detailed = prod!.sheets.find((s) => /detail/i.test(s.name));
const summarySheet = prod!.sheets.find((s) => /summar/i.test(s.name));
report(detailed ? 'PASS' : 'FAIL', '2. Detailed worksheet is read and sent on', `${sheetLines.join('\n')}\nThe server does not pick one sheet: every visible sheet with data is sent to the statement reader, each marked "# Sheet: <name>", so the Summary totals travel with the Detailed rows.`);
if (!detailed) finish();

// ---------------------------------------------------------------- 3. rows and columns, two parsers
const rows = detailed!.rows;
const headerIdx = rows.findIndex((r) => r.filter((c) => c !== '').length >= 5 && r.filter((c) => /[A-Za-z]/.test(c)).length >= 5);
const header = headerIdx >= 0 ? rows[headerIdx] : [];
const data = rows.slice(headerIdx + 1);
const width = header.length;
const wider = data.filter((r) => r.length > width).length;
report(headerIdx >= 0 ? 'PASS' : 'FAIL', '3a. Detailed: header row and data rows', `header at sheet row ${headerIdx + 1} of the non-blank rows, ${width} columns:\n${header.map((h, i) => `${String(i + 1).padStart(2)}. ${h}`).join('\n')}\ndata rows below the header: ${data.length}${headerIdx > 0 ? ` (${headerIdx} title row(s) above the header)` : ''}${wider ? `\n${wider} data row(s) have cells beyond the header width` : ''}`);
report('INFO', '3b. Compare with what you expect', `you described 94 data rows and 20 columns; this file has ${data.length} data rows and ${width} header columns${data.length === 94 && width === 20 ? ' — matches' : ' — CHECK this against the workbook in Excel'}`);
if (showRows) console.log(`\n      First ${showRows} data row(s), as the server sees them (local terminal only):\n${data.slice(0, showRows).map((r) => `      ${r.map((c, i) => `${header[i] ?? `col${i + 1}`}=${c}`).join(' | ')}`).join('\n')}\n`);

let exceljsSheets: { name: string; rows: string[][] }[] | null = null; let exErr = '';
try {
  const mod = (exceljsDir ? createRequire(resolvePath(exceljsDir, 'package.json'))('exceljs') : await import('exceljs')) as unknown as { default?: { Workbook: new () => any }; Workbook?: new () => any };
  const wb = new (mod.default?.Workbook ?? mod.Workbook!)();
  await wb.xlsx.load(bytes);
  exceljsSheets = wb.worksheets.filter((ws: any) => !ws.state || ws.state === 'visible').map((ws: any) => { const rs: unknown[][] = []; ws.eachRow({ includeEmpty: false }, (row: any) => rs.push(Array.isArray(row.values) ? row.values : [])); return { name: ws.name, rows: excelRowsToText(rs) }; });
} catch (e) { exErr = e instanceof Error ? e.message : String(e); }
let lite: { name: string; rows: string[][] }[] | null = null; let liteErr = '';
try { lite = (await readXlsxLite(bytes)).sheets; } catch (e) { liteErr = e instanceof Error ? e.message : String(e); }
const sameAs = (a: { name: string; rows: string[][] }[], b: { name: string; rows: string[][] }[]) => {
  const out: string[] = [];
  for (const s of a) {
    const t = b.find((x) => x.name === s.name);
    if (!t) { out.push(`sheet "${s.name}" missing in the other reader`); continue; }
    if (t.rows.length !== s.rows.length) out.push(`sheet "${s.name}": ${s.rows.length} vs ${t.rows.length} rows`);
    for (let i = 0; i < Math.min(s.rows.length, t.rows.length); i++) {
      const w = Math.max(s.rows[i].length, t.rows[i].length);
      for (let j = 0; j < w; j++) if ((s.rows[i][j] ?? '') !== (t.rows[i][j] ?? '')) { out.push(`sheet "${s.name}" row ${i + 1} column ${j + 1} differs`); if (out.length > 10) return out; }
    }
  }
  return out;
};
if (exceljsSheets && lite) {
  const d = sameAs(exceljsSheets.filter((s) => s.rows.length), lite);
  report(d.length ? 'FAIL' : 'PASS', '3c. Two independent parsers agree cell for cell (exceljs vs built-in)', d.length ? d.join('\n') : `${lite.reduce((n, s) => n + s.rows.length, 0)} rows identical in both`);
} else {
  const loadFailed = /Cannot find (package|module)|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/.test(exErr);
  report(lite ? 'INFO' : 'FAIL', '3c. Two independent parsers agree cell for cell (exceljs vs built-in)', `${exceljsSheets ? '' : loadFailed
    ? `exceljs did not LOAD (${exErr.split('\n')[0]}) — an incomplete installation in this folder, not a problem with the workbook (a fresh install loads it on Node 20 and 22). Common cause in Cloud Shell: the 5 GB home disk filling up (check: df -h ~). For the comparison, install it on its own and rerun:\n  npm install --no-save --no-audit --no-fund --prefix /tmp/exceljs-only exceljs@4.4.0\n  npx tsx scripts/inspect-statement-xlsx.mts <file> --exceljs-dir /tmp/exceljs-only`
    : `exceljs loaded but could not read this workbook (${exErr.split('\n')[0]}) — the kind of failure production hid; the built-in reader read it.`}${lite ? '' : `\nbuilt-in reader failed: ${liteErr}`}`);
}

// ---------------------------------------------------------------- 4. placeholder dates
const placeholders = new Map<number, number>();
let placeholderParsed = true;
for (const r of data) r.forEach((c, j) => {
  if (/^\s*0?1[/-]0?1[/-]0{3}1\s*$|^\s*0001-01-01/.test(c)) {
    placeholders.set(j, (placeholders.get(j) ?? 0) + 1);
    if (parseFlexibleDate(c) !== null) placeholderParsed = false;
  }
});
const realDates = data.flatMap((r) => r).filter((c) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(c) && !/0001$/.test(c)).slice(0, 3);
report(placeholderParsed ? 'PASS' : 'FAIL', '4. 01/01/0001 placeholder dates',
  placeholders.size
    ? `${[...placeholders].map(([j, n]) => `"${header[j] ?? `column ${j + 1}`}": ${n} cell(s)`).join(', ')}\nkept verbatim as "01/01/0001" in the text the statement reader receives; parseFlexibleDate("01/01/0001") → ${JSON.stringify(parseFlexibleDate('01/01/0001'))} (blank, no date) — before PR #9 it became "2001-01-01"\nreal dates are unaffected, e.g. ${realDates.map((d) => `${d} → ${parseFlexibleDate(d)}`).join(', ') || '(none found)'}`
    : 'no 01/01/0001 cells found in the Detailed data rows');

// ---------------------------------------------------------------- 5. Month End
const meCol = header.findIndex((h) => /month\s*end|period/i.test(h));
if (meCol < 0) report('INFO', '5. Month End', 'no "Month End" column found in the header');
else {
  const counts = new Map<string, number>();
  for (const r of data) counts.set(r[meCol] ?? '', (counts.get(r[meCol] ?? '') ?? 0) + 1);
  const vals = [...counts].map(([v, n]) => { const m = /^(\d{4})(\d{2})$/.exec(v); return `${v || '(blank)'} × ${n}${m ? ` → ${m[1]}-${m[2]}` : ' (not YYYYMM)'}`; });
  const fileDate = /(\d{4})(\d{2})\d{2}/.exec(basename(file));
  const single = counts.size === 1 ? [...counts.keys()][0] : null;
  const mismatch = single && fileDate && /^\d{6}$/.test(single) && single !== `${fileDate[1]}${fileDate[2]}`;
  // Every date column's range (placeholders excluded), and any period / date labels on the Summary sheet.
  const ranges: string[] = [];
  header.forEach((h, j) => {
    const vals = data.map((r) => r[j] ?? '').filter((v) => v !== '');
    const parsed = vals.map((v) => parseFlexibleDate(v));
    const dates = parsed.filter((d): d is string => typeof d === 'string').sort();
    const placeholderN = vals.filter((v, i) => parsed[i] === null).length;
    if (vals.length && (dates.length + placeholderN) / vals.length >= 0.9 && dates.length) {
      const inMonth = single && /^\d{6}$/.test(single) ? dates.filter((d) => d.slice(0, 7) === `${single.slice(0, 4)}-${single.slice(4)}`).length : 0;
      ranges.push(`"${h}": ${dates[0]} … ${dates[dates.length - 1]} (${dates.length} dates${placeholderN ? `, ${placeholderN} placeholder/blank` : ''}${single ? `; ${inMonth} in ${single.slice(0, 4)}-${single.slice(4)}` : ''})`);
    } else if (vals.length && placeholderN === vals.length) ranges.push(`"${h}": all ${placeholderN} values are the 01/01/0001 placeholder (no date)`);
  });
  const periodLabels = (summarySheet?.rows ?? []).filter((r) => r.some((c) => /period|month|statement date|as of|through|ending|date/i.test(c))).map((r) => r.filter((c) => c !== '').join(' | '));
  report(counts.size === 1 && /^\d{6}$/.test(single!) ? 'PASS' : 'INFO', '5b. Which month: date columns and Summary period', `${ranges.join('\n') || 'no date columns found'}\n${periodLabels.length ? `Summary sheet period/date entries:\n  ${periodLabels.join('\n  ')}` : 'the Summary sheet has no period or date label'}\n${fileDate ? `File name date ${fileDate[1]}-${fileDate[2]}-${/(\d{4})(\d{2})(\d{2})/.exec(basename(file))![3]}: carrier downloads are usually named with the date they were generated, not the statement period.` : ''}`);
  report(counts.size === 1 && /^\d{6}$/.test(single!) ? 'PASS' : 'INFO', '5. Month End', `"${header[meCol]}": ${vals.join(', ')}\nkept verbatim (a number, not turned into a date by the reader).${mismatch ? `\nNOTE: the file name suggests ${fileDate![1]}-${fileDate![2]}, but Month End says ${single!.slice(0, 4)}-${single!.slice(4)}. Confirm which month this statement is for.` : ''}\nThe statement month itself is decided in the AI extraction step (see 7).`);
}

// ---------------------------------------------------------------- 6. no silent omission
// Money columns: ≥ 90 % of non-empty cells are amounts; rates, counts, codes and dates are excluded.
const notMoney = /rate|%|pct|percent|term|month|year|zip|code|number|no\.?$|#|id$|count|days/i;
const moneyCols = header.map((h, j) => {
  const vals = data.map((r) => (r[j] ?? '').trim()).filter((v) => v !== '');
  const amounts = vals.map(cents);
  const ok = amounts.filter((c) => c !== null) as number[];
  const looksDate = vals.some((v) => /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(v));
  return { j, h, vals: vals.length, ok: ok.length, unreadable: vals.length - ok.length, total: ok.reduce((a, b) => a + b, 0), nonZero: ok.filter((c) => c !== 0).length };
}).filter((c) => c.vals > 0 && c.ok / c.vals >= 0.9 && !notMoney.test(c.h) && !data.some((r) => /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(r[c.j] ?? '')));

// Summary totals: "Label | value" pairs on one row, and label rows followed by value rows.
const pairs: { label: string; cents: number }[] = [];
const srows = summarySheet?.rows ?? [];
srows.forEach((r, i) => {
  for (let j = 0; j < r.length; j++) if (/[A-Za-z]/.test(r[j] ?? '') && cents(r[j]) === null) for (let k = j + 1; k < r.length; k++) { const c = cents(r[k] ?? ''); if (c !== null) { pairs.push({ label: r[j], cents: c }); break; } if (/[A-Za-z]/.test(r[k] ?? '')) break; }
  const next = srows[i + 1];
  if (next && r.every((c) => c === '' || (/[A-Za-z]/.test(c) && cents(c) === null)) && next.some((c) => cents(c) !== null)) r.forEach((lab, j) => { const c = cents(next[j] ?? ''); if (lab && c !== null && !pairs.some((p) => p.label === lab && p.cents === c)) pairs.push({ label: lab, cents: c }); });
});

const commish = moneyCols.filter((c) => /comm|due|net|paid|payable|earned|agent/i.test(c.h));
if (!moneyCols.length) report('FAIL', '6. Money columns', `no amount columns recognised in: ${header.join(' | ')}`);
else {
  const lines = moneyCols.map((c) => {
    const m = pairs.filter((p) => p.cents === c.total).map((p) => `"${p.label}"`);
    return `"${c.h}": total ${money(c.total)} over ${c.ok} row(s) (${c.nonZero} non-zero${c.unreadable ? `, ${c.unreadable} UNREADABLE` : ''})${m.length ? `  = Summary ${m.join(', ')}` : '  — no Summary total equals this'}`;
  });
  report('INFO', '6a. Detailed money columns and the Summary totals they equal', `${lines.join('\n')}\nSummary totals found: ${pairs.length ? pairs.map((p) => `"${p.label}" ${money(p.cents)}`).join(', ') : 'none'}`);

  // Row-by-row relationships between the commission columns (e.g. Gross − Net = a fee column).
  const rel: string[] = [];
  for (let a = 0; a < commish.length; a++) for (let b = a + 1; b < commish.length; b++) {
    const A = commish[a], B = commish[b];
    let eq = 0, n = 0; const diffs: number[] = [];
    for (const r of data) { const x = cents(r[A.j] ?? ''), y = cents(r[B.j] ?? ''); if (x === null || y === null) continue; n++; if (x === y) eq++; diffs.push(x - y); }
    const diffTotal = diffs.reduce((s2, d) => s2 + d, 0);
    const explain = moneyCols.filter((c) => c !== A && c !== B && data.every((r, i) => { const v = cents(r[c.j] ?? '') ?? 0; return Math.abs(v) === Math.abs(diffs[i] ?? 0); }));
    rel.push(`"${A.h}" vs "${B.h}": equal on ${eq} of ${n} rows; "${A.h}" − "${B.h}" totals ${money(diffTotal)}${explain.length ? ` = the "${explain.map((e) => e.h).join('"/"')}" column row by row` : ''}`);
  }
  if (rel.length) report('INFO', '6b. How the commission columns relate, row by row', rel.join('\n'));

  const unreadable = commish.filter((c) => c.unreadable);
  report(unreadable.length ? 'FAIL' : 'PASS', '6c. Every commission row is present and readable', `${data.length} data rows; ${commish.map((c) => `"${c.h}": ${c.ok} readable, ${c.nonZero} non-zero`).join('; ') || 'no commission columns'}${unreadable.length ? `\nUNREADABLE cells in ${unreadable.map((c) => `"${c.h}" (${c.unreadable})`).join(', ')}` : ''}`);

  // The amount actually paid to the agency: the commission column whose total equals a Summary total
  // labelled as due / payable / paid / net — decided by the workbook's own totals, not by the header alone.
  const paidLabel = /due|payable|paid|net|remit|agent|agency/i;
  const reconciled = commish.filter((c) => pairs.some((p) => p.cents === c.total));
  // One reconciling column: that is it. Several: the one tied to a due / payable / net / paid total.
  const paid = reconciled.length === 1 ? reconciled : reconciled.filter((c) => pairs.some((p) => p.cents === c.total && (paidLabel.test(p.label) || paidLabel.test(c.h))));
  report(paid.length === 1 ? 'PASS' : reconciled.length ? 'INFO' : 'FAIL', '6d. Column that reconciles as the commission paid to the agency',
    paid.length === 1
      ? `"${paid[0].h}" — its Detailed total ${money(paid[0].total)} equals the Summary total ${pairs.filter((p) => p.cents === paid[0].total).map((p) => `"${p.label}"`).join(', ')}. This is the figure the statement reader must take as each line's paid commission, and the statement total it must reconcile to.`
      : reconciled.length
        ? `${reconciled.length} commission columns equal Summary totals (${reconciled.map((c) => `"${c.h}"`).join(', ')}); which one is paid to the agency is not decided by the totals alone — see 6a/6b and confirm from the carrier's statement definitions.`
        : `no commission column total equals any Summary total — rows may be missing, or the Summary uses another basis. Do not process this statement until this is explained.`);
}
const allRows = prod!.sheets.reduce((n, s) => n + s.rows.length + 1, 0);
report(allRows <= TABLE_ROW_LIMIT ? 'PASS' : 'FAIL', '6e. Within the row limit (no truncation)', `${allRows} row(s) incl. sheet markers; limit ${TABLE_ROW_LIMIT} (larger spreadsheets are refused with an error, never cut short)`);
const text = tableToText(prod!.sheets.flatMap((s) => [[`# Sheet: ${s.name}`], ...s.rows]));
report('INFO', '6f. Text the server would send to the statement reader', `${text.split('\n').length} lines, ${text.length.toLocaleString()} characters`);

// ---------------------------------------------------------------- 7. not tested
report('INFO', '7. NOT TESTED here: the AI extraction step', 'Turning these rows into statement lines (statement month, carrier, each line\'s commission, reconciliation) is done by the AI statement reader in Cloud Functions. It was tested live in dev with a SYNTHETIC workbook of this layout (12 rows, reconciled exactly), NOT with this file. This script makes no AI call and sends nothing anywhere.');
finish();

function finish(): never {
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n${failed ? `RESULT: ${failed} check(s) FAILED` : 'RESULT: all read checks passed'} — read-only; nothing was uploaded or changed.`);
  process.exit(failed ? 1 : 0);
}
