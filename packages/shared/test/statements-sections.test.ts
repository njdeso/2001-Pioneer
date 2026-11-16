import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiStatementSchema, aiToStatement, STATEMENT_SCHEMA } from '../src/statements/ai.ts';
import { reconcileStatement } from '../src/statements/reconcile.ts';

// Regression cases for multi-section statements, built from SYNTHETIC data (no real amounts, names, policy
// numbers or agent codes). Each case reproduces the STRUCTURE of a real layout that was mis-read:
//
//   SYN_MULTI_OK      several writing companies, a "Month Total" each (two NEGATIVE), and one final
//                     "Net Commission" that equals the subtotals (was blocked as "carrier total not found")
//   SYN_MULTI_GAP     the same layout, but the printed final total is higher than all printed company
//                     subtotals together (an amount not itemized anywhere in the document)
//   SYN_PRODUCTS_GAP  product sections ("Total …" per product; one heading without its own subtotal) and a
//                     "Total Compensation" higher than the printed sections
//
// Each answer is shaped as the AI returns it (amounts as strings exactly as printed) and goes through the real
// validation (aiStatementSchema) and normalization (aiToStatement) before reconciliation.

type Row = [code: string, premium: string, rate: string, commission: string];
interface Section { label: string; code: string; page: number; premium: string; commission: string; rows: Row[] }

const SYN_MULTI_OK: Section[] = [
  { label: 'Alpha Mutual Insurance Company', code: 'TST900', page: 1, premium: '-2,625.00', commission: '-425.00', rows: [
    ['16', '-200.00', '15.0', '-30.00'],
    ['14', '-3,125.00', '16.0', '-500.00'],
    ['12', '300.00', '15.0', '45.00'],
    ['14', '-400.00', '15.0', '-60.00'],
    ['12', '800.00', '15.0', '120.00'],
  ] },
  { label: 'Beta Casualty Company', code: 'TST900003', page: 2, premium: '-5,620.00', commission: '-660.00', rows: [
    ['14', '-200.00', '10.0', '-20.00'],
    ['14', '-400.00', '10.0', '-40.00'],
    ['16', '-5,000.00', '12.0', '-600.00'],
    ['37', '-20.00', '0.0', '0.00'],
  ] },
  { label: 'Gamma Protection Insurance Company', code: 'TST900005', page: 4, premium: '9,560.00', commission: '1,110.00', rows: [
    ['12', '1,000.00', '15.0', '150.00'],
    ['37', '10.00', '0.0', '0.00'],
    ['12', '1,500.00', '14.0', '210.00'],
    ['37', '10.00', '0.0', '0.00'],
    ['12', '5,000.00', '10.0', '500.00'],
    ['37', '40.00', '0.0', '0.00'],
    ['14', '-500.00', '10.0', '-50.00'],
    ['12', '2,500.00', '12.0', '300.00'],
  ] },
];

const SYN_MULTI_GAP: Section[] = [
  { label: 'Alpha Mutual Insurance Company', code: 'TST900', page: 1, premium: '5,312.50', commission: '800.00', rows: [
    ['12', '1,250.00', '16.0', '200.00'],
    ['12', '2,187.50', '16.0', '350.00'],
    ['16', '-625.00', '16.0', '-100.00'],
    ['13', '2,500.00', '14.0', '350.00'],
  ] },
  { label: 'Delta Assurance Company', code: 'TST900002', page: 2, premium: '2,887.14', commission: '400.00', rows: [
    ['12', '2,857.14', '14.0', '400.00'],
    ['37', '30.00', '0.0', '0.00'],
  ] },
  { label: 'Gamma Protection Insurance Company', code: 'TST900005', page: 4, premium: '11,010.00', commission: '1,500.00', rows: [
    ['12', '6,000.00', '15.0', '900.00'],
    ['37', '10.00', '0.0', '0.00'],
    ['13', '-500.00', '12.0', '-60.00'],
    ['12', '5,500.00', '12.0', '660.00'],
  ] },
];

const SYN_PRODUCTS_GAP: Section[] = [
  { label: 'Product Line A', code: '', page: 2, premium: '$2,700.00', commission: '$300.00', rows: [
    ['New Bus-A', '$1,500.00', '12.00%', '$180.00'],
    ['Renew', '$1,500.00', '10.00%', '$150.00'],
    ['Cancel-INS', '-$1,200.00', '10.00%', '-$120.00'],
    ['Renew', '$900.00', '10.00%', '$90.00'],
  ] },
  { label: 'Product Line B', code: '', page: 4, premium: '$750.00', commission: '$75.00', rows: [
    ['Endors', '-$150.00', '10.00%', '-$15.00'],
    ['Renew', '$1,200.00', '10.00%', '$120.00'],
    ['Cancel-INS', '-$300.00', '10.00%', '-$30.00'],
  ] },
];

const TYPE: Record<string, string> = { '11': 'new_business', '12': 'continuation', '13': 'endorsement', '14': 'cancellation', '15': 'cancellation', '16': 'cancellation', '37': 'other', 'New Bus-A': 'new_business', Renew: 'continuation', 'Cancel-INS': 'cancellation', Endors: 'endorsement' };

function answer(carrierName: string, month: string, sections: Section[], totals: { commissionPayable: string; monthCommissionPayable: string }, opts: { withSections?: boolean } = {}) {
  let n = 0;
  return {
    carrierName, agencyCode: 'TEST01', statementMonth: month, statementDate: '',
    totals: { ...totals, paymentReceived: '', premiumForCommission: '', transactionPremium: '', ytdCommissionPayable: '' },
    adjustments: [],
    sections: opts.withSections === false ? [] : sections.map((x) => ({ label: x.label, code: x.code, commissionTotal: x.commission, premiumTotal: x.premium, page: x.page })),
    lines: sections.flatMap((x) => x.rows.map(([code, premium, rate, comm]) => {
      n++;
      return {
        page: x.page, insuredName: `Test Insured ${n}`, policyNumber: `TS${String(n).padStart(5, '0')}`,
        paymentReceived: '', paidCommission: comm, commissionRate: rate, policyTermCommission: '', premiumForCommission: '', transactionPremium: premium,
        effectiveDate: '', transactionCode: code, transactionType: TYPE[code] ?? 'other', section: opts.withSections === false ? '' : x.label,
      };
    })),
  };
}
const read = (a: unknown) => aiToStatement(aiStatementSchema.parse(a), 4);
const multiGap = () => answer('Synthetic Mutual Group', '2025-11', SYN_MULTI_GAP, { commissionPayable: '', monthCommissionPayable: '3,900.00' });
const multiOk = () => answer('Synthetic Mutual Group', '2026-02', SYN_MULTI_OK, { commissionPayable: '', monthCommissionPayable: '25.00' });
const products = () => answer('Synthetic Casualty Insurance', '2026-06', SYN_PRODUCTS_GAP, { commissionPayable: '$950.00', monthCommissionPayable: '$950.00' });
const sectionChecks = (r: ReturnType<typeof reconcileStatement>) => r.checks.filter((c) => c.key === 'section').map((c) => [c.section, c.statedCents, c.extractedCents, c.ok]);

test('schema: sections and the line section are required properties (structured output) and described for multi-company statements', () => {
  const top = STATEMENT_SCHEMA as unknown as { required: string[]; properties: Record<string, any> };
  assert.ok(top.required.includes('sections'));
  assert.deepEqual(top.properties.sections.items.required, ['label', 'code', 'commissionTotal', 'premiumTotal', 'page']);
  assert.equal(top.properties.sections.items.additionalProperties, false);
  assert.ok(top.properties.lines.items.required.includes('section'));
  assert.match(top.properties.totals.properties.monthCommissionPayable.description, /"Net Commission", "Final Net Commission", "Total Compensation"/);
  assert.match(top.properties.totals.properties.commissionPayable.description, /Never copy a single section's subtotal here/);
});

test('BEFORE (as reported): a statement that prints only a final "Net Commission" was blocked as "carrier total not found"', () => {
  // The old rule required a printed grand total of the commission column; these statements print none.
  const s = read(multiOk());
  assert.equal(s.stated.commissionPayableCents, null);
  assert.equal(s.stated.monthCommissionPayableCents, 2500);
  assert.ok(!s.issues.some((i) => i.code === 'no_total'), 'the printed final total is a statement total');
  assert.ok(!reconcileStatement(s).blockingReasons.some((b) => /not found/.test(b)));
});

test('several companies, final Net Commission only: recognized as the statement total; negative company subtotals; reconciles exactly', () => {
  const s = read(multiOk());
  assert.equal(s.lines.length, 17);
  assert.equal(s.sections!.length, 3);
  const r = reconcileStatement(s);
  assert.equal(r.reconciled, true, r.blockingReasons.join('; '));
  assert.deepEqual(r.checks.map((c) => c.key), ['monthPayable', 'section', 'section', 'section'], 'no separate column total is printed, so none is required');
  assert.deepEqual([r.checks[0].statedCents, r.checks[0].extractedCents], [2500, 2500]);
  assert.deepEqual(sectionChecks(r), [
    ['Alpha Mutual Insurance Company', -42500, -42500, true],
    ['Beta Casualty Company', -66000, -66000, true],
    ['Gamma Protection Insurance Company', 111000, 111000, true],
  ]);
  assert.equal(r.totals.negativeLineCount, 7, '3 Alpha + 3 Beta + 1 Gamma');
  assert.deepEqual(r.findings, []);
});

test('the same statement without section tags still reconciles to the printed final total', () => {
  const r = reconcileStatement(read(answer('Synthetic Mutual Group', '2026-02', SYN_MULTI_OK, { commissionPayable: '', monthCommissionPayable: '25.00' }, { withSections: false })));
  assert.equal(r.reconciled, true, r.blockingReasons.join('; '));
});

test('final Net Commission above all company subtotals: every subtotal matches its lines; the difference not in any printed section is reported as a carrier-side difference, not balanced', () => {
  const s = read(multiGap());
  assert.equal(s.lines.length, 10);
  assert.ok(!s.issues.some((i) => i.code === 'no_total'));
  const r = reconcileStatement(s);
  assert.equal(r.reconciled, false);
  assert.deepEqual(sectionChecks(r), [
    ['Alpha Mutual Insurance Company', 80000, 80000, true],
    ['Delta Assurance Company', 40000, 40000, true],
    ['Gamma Protection Insurance Company', 150000, 150000, true],
  ]);
  const final = r.checks.find((c) => c.key === 'monthPayable')!;
  assert.deepEqual([final.statedCents, final.extractedCents, final.differenceCents], [390000, 270000, -120000], 'carrier total kept as printed');
  assert.equal(r.findings!.length, 1);
  assert.match(r.findings![0], /^Every printed section subtotal matches its lines \(3 sections, together \$2,700\.00\), but the carrier's statement total is \$3,900\.00: \$1,200\.00 more than all printed sections together\. This difference is not in any printed section of this document, so it is not a reading error/);
  assert.ok(r.blockingReasons.includes(r.findings![0]));
  assert.equal(s.lines.length, 10, 'nothing added');
});

test('product sections: both subtotals match their lines; the difference to the printed Total Compensation is not in any printed section', () => {
  const s = read(products());
  const r = reconcileStatement(s);
  assert.equal(r.reconciled, false);
  assert.equal(r.totals.commissionCents, 37500, 'every printed row extracted');
  assert.deepEqual(sectionChecks(r), [['Product Line A', 30000, 30000, true], ['Product Line B', 7500, 7500, true]]);
  assert.deepEqual(r.checks.filter((c) => c.key !== 'section').map((c) => [c.key, c.statedCents, c.extractedCents]), [['commission', 95000, 37500], ['monthPayable', 95000, 37500]]);
  assert.match(r.findings![0], /together \$375\.00\), but the carrier's statement total is \$950\.00: \$575\.00 more than all printed sections together/);
});

test('a reading error inside a section is pinpointed by that section\'s subtotal, and is not reported as a carrier difference', () => {
  const a = multiOk();
  a.lines.find((l) => l.paidCommission === '-50.00')!.paidCommission = '50.00'; // sign dropped
  const r = reconcileStatement(read(a));
  assert.equal(r.reconciled, false);
  assert.deepEqual(sectionChecks(r).map(([label, , , ok]) => [label, ok]), [
    ['Alpha Mutual Insurance Company', true], ['Beta Casualty Company', true], ['Gamma Protection Insurance Company', false],
  ]);
  assert.equal(r.checks.find((c) => c.key === 'section' && !c.ok)!.differenceCents, 10000);
  assert.deepEqual(r.findings, [], 'not called a carrier-side difference');
});

test('a commission row tagged with no printed section is a line error', () => {
  const a = multiOk();
  a.lines[0].section = '';
  const s = read(a);
  const r = reconcileStatement(s);
  assert.equal(r.reconciled, false);
  assert.ok(s.lines[0].issues.some((i) => i.code === 'chk_section' && i.level === 'error'));
});

test('duplicate section labels: lines are not attributed by guesswork; the final total still decides', () => {
  const a = multiOk();
  a.sections[1].label = a.sections[0].label;
  const r = reconcileStatement(read(a));
  assert.equal(r.checks.filter((c) => c.key === 'section').length, 0);
  assert.match(r.findings![0], /section labels are not unique/);
  assert.equal(r.reconciled, true, 'lines + adjustments = printed final total exactly');
});

test('a statement with no printed total at all is still blocked (no total is ever made up)', () => {
  const a = multiOk();
  a.totals.monthCommissionPayable = '';
  const s = read(a);
  assert.ok(s.issues.some((i) => i.code === 'no_total' && i.level === 'error'));
  const r = reconcileStatement(s);
  assert.equal(r.reconciled, false);
  assert.ok(r.blockingReasons.some((b) => /the carrier total was not found/.test(b)));
});

test('deterministic readers are unaffected: without the AI\'s finalTotalOnly flag a missing column total still blocks', () => {
  const s = read(multiOk());
  assert.equal(s.finalTotalOnly, true, 'set by the AI reader');
  delete s.finalTotalOnly; // e.g. a deterministic reader whose commission total row was not found
  const r = reconcileStatement(s);
  assert.equal(r.reconciled, false);
  assert.ok(r.blockingReasons.some((b) => /the carrier total was not found/.test(b)));
});
