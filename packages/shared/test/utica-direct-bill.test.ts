import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyUticaDirectBillRules, isUticaDirectBill } from '../src/statements/uticaDirectBill.ts';
import { reconcileStatement } from '../src/statements/reconcile.ts';
import { parseMoneyToCents } from '../src/money.ts';
import { normalizePolicyNumber } from '../src/normalize.ts';
import type { ExtractedLine, ExtractedStatement, TransactionType } from '../src/statements/types.ts';
import { buildPostingPlan, type PostingLine, type PostingStatement } from '../src/statements/posting.ts';
import { commissionSplit } from '../src/statements/match.ts';
import { ledgerTotals } from '../src/reports/ledger.ts';

// Regression cases from the five real Utica National direct-bill statements (Feb, Mar, May, Jul, Aug 2026).
// Every amount, entry code and rate is as printed on the statement; the insured names and policy numbers
// are FICTIONAL (no customer data in the repository). '' = a group-printed row (Utica leaves the
// policyholder and policy number blank on a policy's further rows). Rows are shaped exactly as the AI
// copies them: amounts as printed, trailing minus included.
type Row = [entry: string, gross: string, rate: string, commission: string, named: boolean];
const STATEMENTS: Record<string, { month: string; rows: Row[]; totals: { gross: string; commission: string; due: string }; agency: number }> = {
  Feb: {
    month: '2026-02', agency: 257626,
    totals: { gross: '15709.00', commission: '2576.26-', due: '2576.26-' },
    rows: [
      ['SUCH', '10.00', '0.0', '.00', true], ['REN', '2098.00', '15.0', '314.70-', false], ['END', '143.00-', '15.0', '21.45', false],
      ['END', '195.00', '15.0', '29.25-', false], ['END', '195.00-', '15.0', '29.25', false], ['REN', '297.00', '8.0', '23.76-', true],
      ['SUCH', '10.00', '0.0', '.00', true], ['REN', '2017.00', '15.0', '302.55-', false], ['REN', '858.00', '20.0', '171.60-', true],
      ['REN', '1989.00', '20.0', '397.80-', true], ['NEW', '899.00', '15.0', '134.85-', true], ['SUCH', '10.00', '0.0', '.00', true],
      ['END', '138.00-', '15.0', '20.70', false], ['REN', '373.00', '15.0', '55.95-', true], ['END', '90.00', '15.0', '13.50-', false],
      ['SUCH', '30.00', '0.0', '.00', true], ['SUCH', '10.00', '0.0', '.00', false], ['REN', '2896.00', '15.0', '434.40-', false],
      ['END', '1263.00', '15.0', '189.45-', false], ['REN', '1131.00', '20.0', '226.20-', true], ['REN', '1728.00', '15.0', '259.20-', true],
      ['END', '864.00', '15.0', '129.60-', true], ['END', '276.00', '15.0', '41.40-', false], ['END', '276.00-', '15.0', '41.40', true],
      ['END', '99.00', '15.0', '14.85-', true], ['REN', '1046.00', '20.0', '209.20-', false],
    ],
  },
  Mar: {
    month: '2026-03', agency: 227445,
    totals: { gross: '12654.00', commission: '2274.45-', due: '2274.45-' },
    rows: [
      ['SUCH', '30.00', '0.0', '.00', true], ['REN', '2865.00', '15.0', '429.75-', false], ['CANC', '1630.00-', '8.0', '130.40', true],
      ['REN', '1748.00', '20.0', '349.60-', true], ['CANC', '566.00-', '20.0', '113.20', true], ['NEW', '1353.00', '20.0', '270.60-', true],
      ['END', '581.00-', '15.0', '87.15', true], ['SUCH', '20.00', '0.0', '.00', true], ['REN', '2010.00', '15.0', '301.50-', false],
      ['NEW', '1439.00', '15.0', '215.85-', true], ['REN', '1299.00', '20.0', '259.80-', true], ['NEW', '1530.00', '20.0', '306.00-', true],
      ['END', '61.00', '20.0', '12.20-', true], ['NEW', '791.00', '15.0', '118.65-', true], ['SUCH', '10.00', '0.0', '.00', true],
      ['NEW', '836.00', '15.0', '125.40-', false], ['NEW', '1439.00', '15.0', '215.85-', true],
    ],
  },
  May: {
    month: '2026-05', agency: 91042,
    totals: { gross: '5736.00', commission: '910.42-', due: '910.42-' },
    rows: [
      ['SUCH', '10.00', '0.0', '.00', true], ['END', '534.00', '15.0', '80.10-', false], ['END', '540.00-', '15.0', '81.00', false],
      ['SUCH', '20.00', '0.0', '.00', true], ['END', '622.00', '15.0', '93.30-', false], ['SUCH', '10.00', '0.0', '.00', true],
      ['END', '298.00', '15.0', '44.70-', false], ['END', '715.00-', '8.0', '57.20', true], ['SUCH', '10.00', '0.0', '.00', true],
      ['REN', '1572.00', '15.0', '235.80-', false], ['SUCH', '10.00', '0.0', '.00', true], ['REN', '1607.00', '12.0', '192.84-', false],
      ['END', '139.00', '15.0', '20.85-', true], ['REN', '1121.00', '20.0', '224.20-', true], ['REN', '803.00', '20.0', '160.60-', true],
      ['REN', '170.00', '20.0', '34.00-', true], ['SUCH', '10.00', '0.0', '.00', true], ['END', '55.00', '15.0', '8.25-', false],
      // "commission chargebacks on unpaid direct bill premiums sent to collection and/or MVR/CLUE expense"
      ['COMM', '.00', '0.0', '26.88', true], ['EXP', '.00', '0.0', '19.14', true],
    ],
  },
  Jul: {
    month: '2026-07', agency: 128467,
    totals: { gross: '8804.00', commission: '1284.67-', due: '1284.67-' },
    rows: [
      ['REN', '3186.00', '15.0', '477.90-', true], ['END', '1681.00', '8.0', '134.48-', true], ['CANC', '1681.00-', '8.0', '134.48', false],
      ['NEW', '1465.00', '15.0', '219.75-', true], ['SUCH', '20.00', '0.0', '.00', true], ['REN', '2915.00', '12.0', '349.80-', false],
      ['NEW', '1218.00', '20.0', '243.60-', true], ['EXP', '.00', '0.0', '6.38', true],
    ],
  },
  Aug: {
    month: '2026-08', agency: 317556,
    totals: { gross: '20759.00', commission: '3175.56-', due: '3175.56-' },
    rows: [
      ['NEW', '1331.00', '15.0', '199.65-', true], ['REN', '1796.00', '15.0', '269.40-', true], ['REN', '339.00', '15.0', '50.85-', true],
      ['SUCH', '30.00', '0.0', '.00', true], ['REN', '3799.00', '15.0', '569.85-', false], ['SUCH', '20.00', '0.0', '.00', true],
      ['NEW', '2692.00', '15.0', '403.80-', false], ['NEW', '1376.00', '15.0', '206.40-', true], ['END', '290.00', '12.0', '34.80-', true],
      ['CANC', '607.00-', '15.0', '91.05', true], ['REN', '1197.00', '15.0', '179.55-', true], ['NEW', '1343.00', '20.0', '268.60-', true],
      ['REN', '1714.00', '15.0', '257.10-', true], ['REN', '1326.00', '20.0', '265.20-', true], ['SUCH', '10.00', '0.0', '.00', true],
      ['END', '259.00', '15.0', '38.85-', false], ['NEW', '1578.00', '15.0', '236.70-', true], ['REN', '432.00', '15.0', '64.80-', true],
      ['SUCH', '20.00', '0.0', '.00', true], ['REN', '1814.00', '15.0', '272.10-', false], ['EXP', '.00', '0.0', '51.04', true],
    ],
  },
};

const TYPE: Record<string, TransactionType> = { NEW: 'new_business', REN: 'continuation', END: 'endorsement', CANC: 'cancellation', SUCH: 'other', COMM: 'other', EXP: 'other' };

/** The statement as the AI reader returns it today: every amount exactly as printed. */
function asExtracted(key: string, carrierName = 'UTICA MUTUAL INS CO. - ERO'): ExtractedStatement {
  const st = STATEMENTS[key];
  let n = 0;
  const lines: ExtractedLine[] = st.rows.map(([entry, gross, rate, comm, named], i) => {
    if (named) n++;
    const pol = named ? (entry === 'EXP' ? 'MVRCLU' : `T${key.toUpperCase()}${String(n).padStart(4, '0')}`) : '';
    return {
      lineNo: i + 1, page: 1, insuredName: named ? `Test Insured ${key} ${n}` : '',
      policyNumberRaw: pol, policyNumberNormalized: normalizePolicyNumber(pol),
      paymentReceivedCents: null, paidCommissionCents: parseMoneyToCents(comm), rateBps: Math.round(Number(rate) * 100),
      termCommissionCents: null, premiumForCommissionCents: null, transactionPremiumCents: parseMoneyToCents(gross), feeCents: null,
      effectiveDate: `${st.month}-15`, transactionCodeRaw: entry, transactionType: TYPE[entry], paymentMethod: '', kind: 'commission', rawText: '', issues: [],
    };
  });
  return {
    carrierName, agencyCode: 'TEST01', officeCode: null, statementMonth: st.month, statementDate: null, title: 'DIRECT BILL STATEMENT', pageCount: 2,
    stated: {
      commissionPayableCents: parseMoneyToCents(st.totals.commission), monthCommissionPayableCents: parseMoneyToCents(st.totals.due),
      paymentReceivedCents: null, premiumForCommissionCents: null, transactionPremiumCents: parseMoneyToCents(st.totals.gross), feeCents: null, ytdCommissionPayableCents: null,
    },
    adjustments: [], lines, issues: [],
  };
}
const sum = (s: ExtractedStatement) => s.lines.reduce((t, l) => t + (l.paidCommissionCents ?? 0), 0);
const errors = (s: ExtractedStatement) => [...s.issues, ...s.lines.flatMap((l) => l.issues)].filter((i) => i.level === 'error').map((i) => i.code);

test('BEFORE the fix (as reported): the rows read exactly as printed give negative totals', () => {
  assert.deepEqual(Object.keys(STATEMENTS).map((k) => sum(asExtracted(k))), [-283546, -227445, -91042, -128467, -317556]);
});

for (const key of ['Mar', 'May', 'Jul', 'Aug']) {
  test(`${key} 2026: positive agency commission, genuine negatives kept, group rows filled, reconciles exactly`, () => {
    const st = STATEMENTS[key];
    const { statement: s, report } = applyUticaDirectBillRules(asExtracted(key));
    assert.equal(report.applied, true);
    assert.deepEqual(report.contradictingRows, []);
    // MVR/CLUE expense rows (EXP) are agency-only adjustments, not policy lines; every other row is a line.
    const exp = st.rows.map((r, i) => (r[0] === 'EXP' ? i + 1 : 0)).filter(Boolean);
    assert.equal(s.lines.length, st.rows.length - exp.length, 'every row is a line except MVR/CLUE expenses');
    assert.deepEqual(report.mvrClueRows, exp);
    assert.deepEqual(s.adjustments.map((a) => [a.amountCents, a.source?.kind, a.source?.policyNumberRaw, a.source?.sheetRow]),
      exp.map((n) => [-parseMoneyToCents(st.rows[n - 1][3])!, 'mvr', 'MVRCLU', n]), 'MVR/CLUE kept once, negative, with its row for the audit trail');
    const mvrTotal = s.adjustments.reduce((t, a) => t + a.amountCents, 0);
    assert.equal(sum(s) + mvrTotal, st.agency, 'policy commissions + MVR/CLUE = agency total');
    assert.equal(s.stated.commissionPayableCents, st.agency - mvrTotal, 'policy commission check: Producers Total less MVR/CLUE');
    assert.equal(s.stated.monthCommissionPayableCents, st.agency, 'amount due producer (printed) unchanged');
    // Each line: agency commission = printed with the sign reversed (row by row, not a blanket flip).
    for (const l of s.lines) { const printed = parseMoneyToCents(st.rows[l.lineNo - 1][3])!; assert.equal(l.paidCommissionCents, printed === 0 ? 0 : -printed); }
    // Cancellations and chargebacks (COMM) stay negative policy lines.
    for (const l of s.lines.filter((x) => ['CANC', 'COMM'].includes(x.transactionCodeRaw))) assert.ok(l.paidCommissionCents! < 0, `${l.transactionCodeRaw} line ${l.lineNo}`);
    assert.ok(!s.lines.some((l) => l.transactionCodeRaw === 'EXP'));
    // New business and renewals are positive.
    for (const l of s.lines.filter((x) => ['NEW', 'REN'].includes(x.transactionCodeRaw))) assert.ok(l.paidCommissionCents! > 0);
    // Group-printed rows take the policy and insured of the row above (matching reads the policy number),
    // with a note saying it was not printed on that row; rows with a printed number are unchanged.
    const blanks = st.rows.map((r, i) => (!r[4] ? i : -1)).filter((i) => i >= 0);
    assert.equal(report.filledRows.length, blanks.length);
    const original = asExtracted(key);
    for (const l of s.lines) {
      const i = l.lineNo - 1;
      if (blanks.includes(i)) {
        const above = s.lines.filter((x) => x.lineNo < l.lineNo && !blanks.includes(x.lineNo - 1)).at(-1)!;
        assert.equal(l.policyNumberRaw, above.policyNumberRaw, `line ${i + 1}`);
        assert.equal(l.insuredName, above.insuredName);
        assert.match(l.issues.find((x) => x.code === 'utica_group_row')!.text, new RegExp(`taken from line ${above.lineNo} above`));
      } else {
        assert.equal(l.policyNumberRaw, original.lines[i].policyNumberRaw, 'printed policy numbers never change');
      }
    }
    const rec = reconcileStatement(s);
    assert.equal(rec.reconciled, true, rec.blockingReasons.join('; '));
    assert.deepEqual(rec.checks.map((c) => [c.key, c.statedCents, c.extractedCents]),
      [['commission', st.agency - mvrTotal, st.agency - mvrTotal], ['monthPayable', st.agency, st.agency], ['transactionPremium', parseMoneyToCents(st.totals.gross), parseMoneyToCents(st.totals.gross)]]);
    assert.ok(rec.checks.every((c) => c.ok), 'commission, amount due and gross premium all match the printed totals');
    assert.ok(!s.lines.some((l) => l.issues.some((x) => x.code === 'chk_sign_premium')), 'commission and premium now agree in sign');
  });
}

test('February 2026: the rows add up to $2,835.46 but Utica\'s own totals leave out exactly line 21 ($259.20 on $1,728.00) — named, blocked, not removed', () => {
  const { statement: s, report } = applyUticaDirectBillRules(asExtracted('Feb'));
  assert.equal(report.applied, true);
  assert.equal(sum(s), 283546);
  assert.equal(s.stated.commissionPayableCents, 257626);
  assert.deepEqual(report.rowsOutsideTotals, [21]);
  assert.equal(s.lines.length, 26, 'the row is kept');
  const msg = s.issues.find((i) => i.code === 'utica_row_outside_totals')!;
  assert.match(msg.text, /^Line 21 \(policy TFEB0011, commission \$259\.20\) is printed on the statement but is not included in Utica's totals: the commission total and the gross premium total both leave out exactly this row/);
  const rec = reconcileStatement(s);
  assert.equal(rec.reconciled, false, 'cannot be approved until decided');
  // Everything else on the statement is right: without line 21 it reconciles to the printed $2,576.26.
  const without = { ...s, issues: [], lines: s.lines.filter((l) => l.lineNo !== 21).map((l) => ({ ...l, issues: l.issues.filter((i) => i.code !== 'utica_row_outside_totals') })) };
  assert.equal(sum(without), 257626);
  assert.equal(reconcileStatement(without).reconciled, true);
});

test('five statements together: +$10,221.36 printed by Utica (the Feb rows themselves total $10,480.56)', () => {
  const total = Object.keys(STATEMENTS).reduce((t, k) => t + (applyUticaDirectBillRules(asExtracted(k)).statement.stated.monthCommissionPayableCents ?? 0), 0);
  assert.equal(total, 1022136);
});

test('the sign is NOT reversed when any row contradicts the convention; the statement is held for review', () => {
  const s0 = asExtracted('Mar');
  s0.lines[1].paidCommissionCents = 42975; // REN 2865.00 with a commission printed without the minus
  const { statement: s, report } = applyUticaDirectBillRules(s0);
  assert.equal(report.applied, false);
  assert.deepEqual(report.contradictingRows, [2]);
  assert.equal(s.lines[3].paidCommissionCents, -34960, 'amounts left as printed');
  assert.ok(errors(s).includes('utica_sign_unverified'));
  assert.equal(reconcileStatement(s).reconciled, false);
});

test('with no row that has both premium and commission, nothing is reversed', () => {
  const s0 = asExtracted('Jul');
  s0.lines = s0.lines.filter((l) => l.transactionCodeRaw === 'EXP' || l.transactionCodeRaw === 'SUCH');
  const { report, statement } = applyUticaDirectBillRules(s0);
  assert.equal(report.applied, false);
  assert.ok(errors(statement).includes('utica_sign_unverified'));
});

test('only Utica statements: both printed names are recognised; other carriers are untouched', () => {
  assert.ok(isUticaDirectBill({ carrierName: 'UTICA MUTUAL INS CO. - ERO' }));
  assert.ok(isUticaDirectBill({ carrierName: 'Utica Mutual Insurance Co. - ERO' }));
  assert.ok(isUticaDirectBill({ carrierName: 'Utica National Insurance Group' }));
  for (const c of ['Progressive', 'Travelers', 'Mutica Holdings', 'Synthetic Mutual']) assert.equal(isUticaDirectBill({ carrierName: c }), false, c);
});

test('the input statement is not modified (pure function)', () => {
  const s0 = asExtracted('Aug'); const before = JSON.stringify(s0);
  applyUticaDirectBillRules(s0);
  assert.equal(JSON.stringify(s0), before);
});

test('MVR/CLUE at a 50 % broker share: broker $0.00, agency absorbs all of it; policy lines split on their own commission', () => {
  for (const key of ['May', 'Jul', 'Aug']) {
    const { statement: s } = applyUticaDirectBillRules(asExtracted(key));
    const lines: PostingLine[] = s.lines.map((l) => {
      const amt = l.paidCommissionCents ?? 0; const sp = commissionSplit(amt, 5000);
      return { id: String(l.lineNo).padStart(5, '0'), lineNo: l.lineNo, insuredName: l.insuredName, policyNumberRaw: l.policyNumberRaw, paidCommissionCents: l.paidCommissionCents, transactionType: l.transactionType, effectiveDate: l.effectiveDate,
        match: { status: 'matched', method: 'auto', confidence: 'high', policyId: `P-${l.policyNumberRaw}`, clientId: 'C', carrierId: 'UTICA', brokerId: 'B50', brokerShareBps: 5000, brokerShareSource: 'broker', commissionCents: amt, brokerCents: sp.brokerCents, agencyCents: sp.agencyCents, reasons: [], candidates: [], policyNumberKey: null, nameEvidence: 'strong', engineVersion: 'test' } } as unknown as PostingLine;
    });
    const stmt: PostingStatement = { id: `UT-${key}`, status: 'needs_review', payerId: 'UTICA', payerKind: 'carrier', statementMonth: s.statementMonth, statementDate: null, adjustments: s.adjustments, postedCents: 0, postingSeq: 0, matching: { stale: false, balanced: true } };
    const plan = buildPostingPlan(stmt, lines);
    const st = STATEMENTS[key];
    assert.equal(plan.totals.amountCents, st.agency, `${key}: posted total = Amount Due Producer`);
    const mvr = plan.entries.filter((e) => e.level === 'carrier');
    assert.equal(mvr.length, 1, `${key}: MVR/CLUE posted exactly once`);
    assert.equal(mvr[0].brokerCents, 0); assert.equal(mvr[0].brokerShareBps, 0); assert.equal(mvr[0].policyId, null);
    assert.equal(mvr[0].agencyCents, mvr[0].amountCents); assert.ok(mvr[0].amountCents < 0);
    assert.equal(mvr[0].classification, 'other_adjustment');
    const brokerFromPolicies = plan.entries.filter((e) => e.level === 'policy').reduce((t, e) => t + e.brokerCents, 0);
    assert.equal(plan.totals.brokerCents, brokerFromPolicies, 'broker total comes only from policy commissions');
    assert.ok(!plan.entries.some((e) => e.level === 'policy' && /MVRCLU/.test(String(e.policyId))), 'no policy entry for MVR/CLUE');
    assert.equal(ledgerTotals(plan.entries.map((e) => ({ ...e, postingStatus: 'posted', reversalOf: null })) as never).brokerCents, brokerFromPolicies);
  }
});

test('an MVR/CLUE row that pays the agency is held for review, not moved', () => {
  const s0 = asExtracted('Jul');
  s0.lines[7].paidCommissionCents = -638; // printed "6.38-": would be a credit to the agency after the reversal
  s0.stated.commissionPayableCents! -= 1276; s0.stated.monthCommissionPayableCents! -= 1276;
  const { statement: s, report } = applyUticaDirectBillRules(s0);
  assert.deepEqual(report.mvrClueRows, []);
  assert.equal(s.adjustments.length, 0);
  assert.ok(errors(s).includes('utica_mvr_positive'));
  assert.equal(reconcileStatement(s).reconciled, false);
});
