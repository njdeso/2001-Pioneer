import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readDetailedStatement, summaryPairs, type DetailedReadResult } from '../src/statements/detailedStatement.ts';
import { reconcileStatement } from '../src/statements/reconcile.ts';
import { buildPostingPlan, type PostingLine, type PostingStatement } from '../src/statements/posting.ts';
import { autoMatchLine, prepareMatchContext, summarizeMatches, type MatchPolicy } from '../src/statements/match.ts';
import { ledgerTotals } from '../src/reports/ledger.ts';
import { readXlsxDetailed } from '../src/excelRead.ts';
import type { ExtractedStatement } from '../src/statements/types.ts';

// Synthetic data only (fictional insureds and policies). Business rule under test — Option B, confirmed by
// the owner: brokers are paid on GROSS commission; MVR chargebacks are agency-only adjustments.
// @ts-expect-error — plain .mjs fixture module shared with the dev smoke test
import { mvrStatement, detailedStatementWorkbook, MVR_HEAD } from '../../../scripts/lib/synthetic-xlsx.mjs';

type Fixture = { sheets: { name: string; rows: (string | number)[][] }[]; bytes: Uint8Array; grossCents: number; mvrCents: number; netCents: number; rows: unknown[][] };
const asText = (sheets: Fixture['sheets']) => sheets.map((s) => ({ name: s.name, rows: s.rows.map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c)))) }));
function read(f: Fixture): { s: ExtractedStatement; r: Extract<DetailedReadResult, { kind: 'statement' }>['report'] } {
  const res = readDetailedStatement(asText(f.sheets));
  assert.equal(res.kind, 'statement', JSON.stringify(res));
  if (res.kind !== 'statement') throw new Error('unreachable');
  return { s: res.statement, r: res.report };
}
const errors = (s: ExtractedStatement) => [...s.issues, ...s.lines.flatMap((l) => l.issues)].filter((i) => i.level === 'error').map((i) => i.code);

/** The real workbook's verified figures, rebuilt with fictional rows: 94 rows, gross 7,057.02, one MVR −184.80. */
function realFigures(opts: Record<string, unknown> = {}): Fixture {
  return mvrStatement({
    mvr: [{ row: 57, cents: 18480 }],
    ...opts,
    mutate: (data: (string | number)[][]) => {
      // 91 rows at 75.00, two cancellations at −50.00, the last row closes gross to exactly 7,057.02.
      data.forEach((r, i) => { const g = [3, 40].includes(i) ? -5000 : 7500; r[13] = g / 100; r[16] = g / 100; });
      const others = data.slice(0, -1).reduce((t, r) => t + Math.round((r[13] as number) * 100), 0);
      const last = data[data.length - 1]; last[13] = (705702 - others) / 100; last[16] = last[13];
      const m = data[57]; m[16] = Math.round((m[13] as number) * 100 - 18480) / 100;
    },
  });
}

test('the real workbook figures: 94 lines at gross 7,057.02, one agency-only MVR −184.80, net 6,872.22, November 2025', () => {
  const f = realFigures();
  assert.equal(f.grossCents, 705702); assert.equal(f.mvrCents, -18480); assert.equal(f.netCents, 687222);
  const { s, r } = read(f);
  assert.equal(s.lines.length, 94, 'every transaction row is a line (the MVR row keeps its policy commission)');
  assert.equal(s.adjustments.length, 1);
  assert.equal(s.adjustments[0].amountCents, -18480);
  assert.match(s.adjustments[0].label, /^MVR chargeback \(Detailed row 59, policy 004057\)$/);
  assert.deepEqual(s.adjustments[0].source, { sheet: 'Detailed', sheetRow: 59, kind: 'mvr', policyNumberRaw: '004057', lineNo: 58 });
  assert.equal(s.lines.reduce((t, l) => t + l.paidCommissionCents!, 0), 705702, 'lines carry GROSS commission');
  assert.equal(s.lines[57].paidCommissionCents, 7500, 'the affected policy line is NOT reduced by the MVR charge');
  assert.equal(s.statementMonth, '2025-11');
  assert.deepEqual(s.stated.commissionPayableCents, 705702);
  assert.deepEqual(s.stated.monthCommissionPayableCents, 687222);
  assert.deepEqual(s.sourceAccounting, { sheet: 'Detailed', rows: 94, lineRows: 94, adjustmentOnlyRows: 0, totalRows: 0, rowsWithErrors: [], identicalRowGroups: [] });
  assert.ok(r.checks.every((c) => c.ok), JSON.stringify(r.checks.filter((c) => !c.ok)));
  assert.equal(r.mvr.totalCents, -18480); assert.deepEqual(r.mvr.identifiedBy, ['"MVR" text on the row']);
  const rec = reconcileStatement(s);
  assert.equal(rec.reconciled, true, rec.blockingReasons.join('; '));
  assert.deepEqual(rec.checks.map((c) => [c.key, c.statedCents, c.extractedCents, c.ok]), [['commission', 705702, 705702, true], ['monthPayable', 687222, 687222, true]]);
  assert.match(rec.checks[0].label, /Gross Comm.*Commissions - Current/);
  assert.match(rec.checks[1].label, /Net Amount Due Agent/);
});

test('the ambiguous "Comm" column is never the paid commission; policy numbers keep leading zeros; negatives and cancellations kept', () => {
  const { s, r } = read(realFigures());
  const comm = MVR_HEAD.indexOf('Comm');
  assert.equal(r.columns.comm.index, comm);
  assert.equal(r.columns.gross.header, 'Gross Comm');
  assert.equal(r.columns.net.header, 'Net Due Agent');
  assert.notEqual(r.ignoredCommTotalCents, r.grossTotalCents);
  assert.ok(s.lines.every((l) => /^00\d{4}$/.test(l.policyNumberRaw)), 'policy numbers are text with leading zeros');
  assert.equal(s.lines[0].policyNumberNormalized, '004000');
  const cancels = s.lines.filter((l) => l.transactionType === 'cancellation');
  assert.equal(cancels.length, 2);
  assert.ok(cancels.every((l) => l.paidCommissionCents === -5000));
  assert.equal(s.lines[6].transactionType, 'continuation');
  assert.equal(s.lines[0].transactionType, 'new_business');
});

test('01/01/0001 is a missing date; a malformed date is a warning, not a guess; blank is null', () => {
  const f = realFigures({ mutate: undefined });
  const rows = f.sheets[0].rows;
  rows[1][6] = '01/01/0001'; rows[2][6] = '13/45/2025'; rows[3][6] = '';
  const { s } = read(f);
  assert.equal(s.lines[0].effectiveDate, null);
  assert.equal(s.lines[1].effectiveDate, null);
  assert.ok(s.lines[1].issues.some((i) => i.code === 'bad_date' && i.level === 'warning'));
  assert.equal(s.lines[2].effectiveDate, null);
  assert.equal(s.lines[4].effectiveDate, '2025-05-01');
  assert.equal(reconcileStatement(s).reconciled, true);
});

test('several MVR charges, including an MVR-only row with no commission: each recorded once, none as a policy commission', () => {
  const f = mvrStatement({ mvr: [{ row: 10, cents: 1500 }, { row: 20, cents: 2500 }, { row: 30, cents: 1225, only: true }] });
  const { s, r } = read(f);
  assert.equal(f.rows.length, 95);
  assert.equal(s.lines.length, 94, 'the MVR-only row is not a line');
  assert.equal(s.adjustments.length, 3);
  assert.deepEqual(s.adjustments.map((a) => a.amountCents).sort((a, b) => a - b), [-2500, -1500, -1225]);
  assert.equal(s.adjustments.find((a) => a.amountCents === -1225)!.source!.lineNo, null);
  assert.ok(s.lines.every((l) => (l.paidCommissionCents ?? 0) !== -1225));
  assert.equal(s.sourceAccounting!.adjustmentOnlyRows, 1);
  assert.equal(s.sourceAccounting!.lineRows + s.sourceAccounting!.adjustmentOnlyRows, 95);
  assert.equal(r.mvr.totalCents, f.mvrCents);
  assert.equal(reconcileStatement(s).reconciled, true);
});

test('a zero-dollar MVR row is kept as a zero adjustment (accounted for, nothing posted)', () => {
  const f = mvrStatement({ mvr: [{ row: 5, cents: 0, only: true }] });
  const { s } = read(f);
  assert.equal(s.adjustments.length, 1); assert.equal(s.adjustments[0].amountCents, 0);
  assert.equal(s.sourceAccounting!.adjustmentOnlyRows, 1);
  assert.equal(reconcileStatement(s).reconciled, true);
});

test('a different number of rows (12 and 400) reconciles the same way', () => {
  for (const n of [12, 400]) {
    const { s } = read(mvrStatement({ rows: n, mvr: [{ row: 2, cents: 990 }], negatives: [1] }));
    assert.equal(s.lines.length, n);
    assert.equal(reconcileStatement(s).reconciled, true);
  }
});

test('identical rows are all kept and flagged; legitimate repeated transactions still reconcile', () => {
  const f = mvrStatement({ mvr: [], summary: {}, mutate: (d: unknown[][]) => { d.splice(8, 0, [...d[7]]); } });
  const { s } = read(f);
  assert.equal(s.lines.length, 95);
  assert.deepEqual(s.sourceAccounting!.identicalRowGroups, [[9, 10]]);
  assert.ok(s.issues.some((i) => i.code === 'identical_rows' && i.level === 'warning'));
  assert.equal(reconcileStatement(s).reconciled, true, 'a repeat is not removed and does not block by itself');
});

// ---- rejection: inconsistent or ambiguous data blocks approval and posting ----

test('incorrect Summary totals block, with a specific message', () => {
  const off = (summary: Record<string, number | null>) => { const { s } = read(mvrStatement({ summary })); return { s, rec: reconcileStatement(s) }; };
  const base = mvrStatement();
  let { s, rec } = off({ commissions: base.grossCents + 1 });
  assert.equal(rec.reconciled, false);
  assert.ok(rec.blockingReasons.some((b) => /Gross policy commission.*extracted .* vs carrier/.test(b)), rec.blockingReasons.join('|'));
  assert.ok(errors(s).includes('chk_gross_vs_summary'));
  ({ s, rec } = off({ net: base.netCents - 1 }));
  assert.equal(rec.reconciled, false);
  assert.ok(rec.blockingReasons.some((b) => /Net agency payment/.test(b)));
  ({ s, rec } = off({ net: null }));
  assert.equal(rec.reconciled, false);
  assert.ok(errors(s).includes('summary_missing'));
  ({ s, rec } = off({ mvr: base.mvrCents * 2 }));
  assert.equal(rec.reconciled, false);
  assert.ok(errors(s).includes('chk_mvr_vs_summary'));
});

test('a double-counted MVR charge cannot reconcile', () => {
  // A Summary claiming the charge was deducted twice (net = gross − 2 × MVR) disagrees with the rows.
  const base = mvrStatement();
  const { s } = read(mvrStatement({ summary: { net: base.grossCents + 2 * base.mvrCents } }));
  const rec = reconcileStatement(s);
  assert.equal(rec.reconciled, false);
  assert.ok(errors(s).includes('chk_net_column'));
  // And deducting it twice in the statement itself (adjustment repeated) is caught by reconciliation.
  const twice = read(base).s; twice.adjustments.push({ ...twice.adjustments[0] });
  assert.equal(reconcileStatement(twice).reconciled, false);
});

test('an unexplained Net/Gross difference, a positive MVR, or an MVR inside Gross Comm is rejected, never guessed', () => {
  // Deduction with no MVR identification
  let f = mvrStatement({ mvr: [], mutate: (d: (string | number)[][]) => { d[4][16] = Math.round((d[4][13] as number) * 100 - 700) / 100; } });
  let s = read(f).s;
  assert.ok(s.lines[4].issues.some((i) => i.code === 'net_differs' && i.level === 'error'));
  assert.equal(reconcileStatement(s).reconciled, false);
  assert.deepEqual(s.sourceAccounting!.rowsWithErrors, [6]);
  // MVR that increases the payment
  f = mvrStatement({ mvr: [{ row: 4, cents: -700 }] });
  s = read(f).s;
  assert.ok(errors(s).includes('mvr_positive'));
  assert.equal(reconcileStatement(s).reconciled, false);
  // "MVR" on a row whose net equals gross: the charge would be inside the policy commission
  f = mvrStatement({ mvr: [], mutate: (d: (string | number)[][]) => { d[4][19] = 'MVR chargeback'; } });
  s = read(f).s;
  assert.ok(errors(s).includes('mvr_in_gross'));
  assert.equal(reconcileStatement(s).reconciled, false);
});

test('mixed Month End values or an unreadable amount block', () => {
  let s = read(mvrStatement({ mutate: (d: (string | number)[][]) => { d[3][0] = 202512; } })).s;
  assert.ok(errors(s).includes('month_end'));
  assert.equal(s.statementMonth, null);
  assert.equal(reconcileStatement(s).reconciled, false);
  s = read(mvrStatement({ mutate: (d: (string | number)[][]) => { d[3][13] = '12.3.4'; } })).s;
  assert.ok(errors(s).includes('bad_amount'));
  assert.equal(reconcileStatement(s).reconciled, false);
});

test('a carrier total row is verified and not counted again; a wrong total row blocks', () => {
  const withTotal = (adjust: number) => {
    const f = mvrStatement(); // Summary built from the transaction rows
    f.sheets[0].rows.push([202511, '', 'Total', '', '', '', '', '', '', '', '', '', '', (f.grossCents + adjust) / 100, '', '', f.netCents / 100, '', '', '']);
    return read(f).s;
  };
  const ok = withTotal(0);
  assert.equal(ok.sourceAccounting!.totalRows, 1);
  assert.equal(ok.lines.length, 94);
  assert.equal(reconcileStatement(ok).reconciled, true, reconcileStatement(ok).blockingReasons.join('; '));
  const bad = withTotal(1);
  assert.ok(errors(bad).includes('total_row_mismatch'));
  assert.equal(reconcileStatement(bad).reconciled, false);
});

test('missing or ambiguous required columns, or no Summary sheet: the file is refused (not sent to the AI)', () => {
  const f = mvrStatement();
  const rename = (from: string, to: string) => asText([{ name: 'Detailed', rows: [f.sheets[0].rows[0].map((h) => (h === from ? to : h)), ...f.sheets[0].rows.slice(1)] }, f.sheets[1]]);
  let res = readDetailedStatement(rename('Policy Number', 'Reference'));
  assert.equal(res.kind, 'incomplete'); assert.equal((res as { code: string }).code, 'detailed_columns'); assert.match((res as { message: string }).message, /Policy number/);
  res = readDetailedStatement(rename('Gross Comm', 'Gross'));
  assert.equal(res.kind, 'incomplete'); assert.match((res as { message: string }).message, /Gross Comm/);
  res = readDetailedStatement(rename('Net Due Agent', 'Net'));
  assert.equal(res.kind, 'incomplete'); assert.match((res as { message: string }).message, /Net Due Agent/);
  res = readDetailedStatement(rename('Notes', 'Gross Commission'));
  assert.equal(res.kind, 'incomplete'); assert.match((res as { message: string }).message, /more than one column could be: Gross Comm/);
  res = readDetailedStatement(asText([f.sheets[0]]));
  assert.equal(res.kind, 'incomplete'); assert.equal((res as { code: string }).code, 'detailed_no_summary');
});

test('other layouts are not claimed: they keep using the existing AI path', () => {
  const other = detailedStatementWorkbook(); // "Comm Amount" layout, no Gross Comm / Net Due Agent
  return readXlsxDetailed(other.bytes).then((r) => assert.equal(readDetailedStatement(r.sheets).kind, 'not_this_layout'));
});

test('end to end from workbook bytes, Excel and .NET (x: prefix, inline strings) formats', async () => {
  for (const o of [{}, { prefix: 'x', inline: true }]) {
    const f = mvrStatement({ mvr: [{ row: 57, cents: 18480 }], ...o });
    const wb = await readXlsxDetailed(f.bytes);
    const res = readDetailedStatement(wb.sheets);
    assert.equal(res.kind, 'statement');
    if (res.kind !== 'statement') return;
    assert.equal(res.statement.lines[0].policyNumberRaw, '004000');
    assert.equal(res.statement.statementMonth, '2025-11');
    assert.equal(reconcileStatement(res.statement).reconciled, true);
  }
});

test('Summary reading: current amount, not the year-to-date one beside it', () => {
  const p = summaryPairs([['Commissions - Current', '7057.02', '77627.22'], ['Net Amount Due Agent', '6872.22', '75594.42']]);
  assert.deepEqual(p, [{ label: 'Commissions - Current', cents: 705702 }, { label: 'Net Amount Due Agent', cents: 687222 }]);
});

// ---- posting: brokers on gross, MVR agency-only ----

test('posting with a 50 % broker share: the affected policy is split on GROSS; the MVR is one agency-only carrier entry', () => {
  const f = realFigures();
  const { s } = read(f);
  const policies: MatchPolicy[] = s.lines.map((l, i) => ({ id: `P${i}`, clientId: `C${i}`, carrierId: 'MUT', wholesalerId: null, brokerId: 'B50', status: 'active', policyNumber: l.policyNumberRaw }));
  const clients = s.lines.map((l, i) => ({ id: `C${i}`, name: l.insuredName }));
  const ctx = prepareMatchContext({ payerId: 'MUT', policies, clients, brokers: [{ id: 'UNASSIGNED', shareBps: 0 }, { id: 'B50', shareBps: 5000 }] });
  const lines: PostingLine[] = s.lines.map((l) => {
    const pl = { id: String(l.lineNo).padStart(5, '0'), lineNo: l.lineNo, policyNumberRaw: l.policyNumberRaw, insuredName: l.insuredName, paidCommissionCents: l.paidCommissionCents, transactionType: l.transactionType, effectiveDate: l.effectiveDate } as PostingLine;
    return { ...pl, match: autoMatchLine(pl, ctx) };
  });
  assert.ok(lines.every((l) => (l.match as { status: string }).status === 'matched'));
  const summary = summarizeMatches(lines as never, s.adjustments);
  assert.equal(summary.adjustmentsCents, -18480);
  assert.equal(summary.brokerCents + summary.agencyCents, 705702, 'matching splits gross commission only');
  const stmt: PostingStatement = { id: 'SYN', status: 'needs_review', payerId: 'MUT', payerKind: 'carrier', statementMonth: s.statementMonth, statementDate: null, adjustments: s.adjustments, postedCents: 0, postingSeq: 0, matching: { stale: false, balanced: summary.balanced } };
  const plan = buildPostingPlan(stmt, lines);
  assert.equal(plan.balanced, true);
  assert.equal(plan.totals.amountCents, 687222, 'posted total = net agency payment');
  assert.equal(plan.totals.commissionCents, 705702);
  assert.equal(plan.totals.adjustmentsCents, -18480);
  const affected = plan.entries.find((e) => e.lineNo === 58)!;
  assert.deepEqual([affected.level, affected.amountCents, affected.brokerShareBps, affected.brokerCents, affected.agencyCents], ['policy', 7500, 5000, 3750, 3750], 'broker gets 50 % of GROSS on the MVR policy');
  const mvr = plan.entries.filter((e) => e.level === 'carrier');
  assert.equal(mvr.length, 1, 'the MVR charge is posted exactly once');
  assert.deepEqual([mvr[0].amountCents, mvr[0].brokerCents, mvr[0].agencyCents, mvr[0].policyId, mvr[0].brokerShareBps, mvr[0].classification], [-18480, 0, -18480, null, 0, 'other_adjustment']);
  assert.ok(!plan.entries.some((e) => e.level === 'policy' && e.amountCents === -18480), 'no negative policy commission for the MVR');
  const policyEntries = plan.entries.filter((e) => e.level === 'policy');
  const brokerExpected = policyEntries.reduce((t, e) => t + e.brokerCents, 0);
  assert.equal(plan.totals.brokerCents, brokerExpected, 'broker total comes only from policy commissions');
  assert.equal(plan.totals.agencyCents, 687222 - brokerExpected, 'the agency bears the whole MVR charge');
  // The ledger report computes broker share from the stored allocations: MVR adds nothing to brokers.
  const t = ledgerTotals(plan.entries.map((e) => ({ ...e, postingStatus: 'posted', reversalOf: null })) as never);
  assert.equal(t.brokerCents, brokerExpected);
  assert.equal(t.grossCents, 687222);
});

test('broker buyout cannot see agency-only MVR charges: the buyout engine does not read the ledger or statements', () => {
  const dir = new URL('../src/buyout/', import.meta.url).pathname;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    assert.ok(!imports.some((p) => /statements\/|reports\/ledger|posting/.test(p)), `${f} imports ${imports.join(', ')}`);
    assert.ok(!/adjustments\s*:\s*StatementAdjustment|ledgerEntries|collection\('ledger'\)/.test(src), `${f} reads statement adjustments or the ledger`);
  }
  const callable = readFileSync(new URL('../../../functions/src/callables/buyout.ts', import.meta.url), 'utf8');
  assert.ok(!/collection\('(ledger|statements)'\)/.test(callable), 'the buyout callable never reads the ledger or statements');
});
