import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { pdfToTextLines } from '../src/pdfText.ts';
import { isTravelersPlStatement, parseTravelersPl, splitEffCode } from '../src/statements/travelers.ts';
import { reconcileStatement } from '../src/statements/reconcile.ts';
import { fixtureToPages, fixtureToPdf, loadFixture } from './helpers/travelersPdf.ts';

// Known totals of the December 2025 Travelers statement (reproduced by the anonymized fixture)
const KNOWN = {
  commission: 363114, // $3,631.14 — monthly commission payable
  paymentReceived: 2757343, // $27,573.43 — NOT revenue
  premiumForCommission: 2433800, // $24,338.00
  transactionPremium: 2459200, // $24,592.00
  ytd: 5255364, // $52,553.64
};

async function parseFixturePdf(mutate?: (pages: string[][]) => void) {
  const pages = fixtureToPages(loadFixture());
  mutate?.(pages);
  const pdf = await fixtureToPdf(pages);
  const text = await pdfToTextLines(pdf);
  return { text, statement: parseTravelersPl(text.pages) };
}

test('Travelers fixture: PDF → text → parser reconciles exactly to the known totals', async () => {
  const { text, statement: s } = await parseFixturePdf();
  assert.ok(text.hasText);
  assert.ok(isTravelersPlStatement(text.pages));
  assert.equal(s.carrierName, 'Travelers');
  assert.equal(s.agencyCode, '0SYN01');
  assert.equal(s.officeCode, '662');
  assert.equal(s.statementMonth, '2025-12');
  assert.equal(s.statementDate, '2025-12-29');
  assert.equal(s.stated.commissionPayableCents, KNOWN.commission);
  assert.equal(s.stated.monthCommissionPayableCents, KNOWN.commission);
  assert.equal(s.stated.ytdCommissionPayableCents, KNOWN.ytd);

  const r = reconcileStatement(s);
  assert.equal(r.reconciled, true, r.blockingReasons.join('; '));
  assert.equal(r.errorCount, 0);
  assert.equal(r.warningCount, 0);
  assert.equal(r.totals.commissionCents, KNOWN.commission);
  assert.equal(r.totals.paymentReceivedCents, KNOWN.paymentReceived);
  assert.equal(r.totals.premiumForCommissionCents, KNOWN.premiumForCommission);
  assert.equal(r.totals.transactionPremiumCents, KNOWN.transactionPremium);
  for (const c of r.checks) assert.equal(c.ok, true, c.key);
});

test('payment received is never counted as commission', async () => {
  const { statement: s } = await parseFixturePdf();
  const r = reconcileStatement(s);
  assert.notEqual(r.totals.commissionCents, r.totals.paymentReceivedCents);
  const paymentOnly = s.lines.filter((l) => l.kind === 'payment_only');
  assert.equal(paymentOnly.length, 74);
  for (const l of paymentOnly) {
    assert.equal(l.paidCommissionCents, null);
    assert.equal(l.transactionType, 'installment_payment');
    assert.ok(l.paymentReceivedCents !== null);
    assert.ok(l.termCommissionCents !== null); // term commission is reference only
  }
});

test('line structure: counts, transaction types, negatives', async () => {
  const { statement: s } = await parseFixturePdf();
  assert.equal(s.lines.length, 102);
  const by = (t: string) => s.lines.filter((l) => l.transactionType === t).length;
  assert.equal(by('continuation'), 19);
  assert.equal(by('endorsement'), 6);
  assert.equal(by('cancellation'), 2);
  assert.equal(by('reversal'), 1);
  assert.equal(s.lines.filter((l) => l.kind === 'commission').length, 28);
  const negatives = s.lines.filter((l) => (l.paidCommissionCents ?? 0) < 0);
  assert.equal(negatives.length, 6);
  const r = reconcileStatement(s);
  assert.equal(r.totals.positiveCommissionCents + r.totals.negativeCommissionCents, KNOWN.commission);
});

test('multiple transactions for one policy, and identical installment rows are all kept', async () => {
  const { statement: s } = await parseFixturePdf();
  const byPolicy = new Map<string, number>();
  for (const l of s.lines) byPolicy.set(l.policyNumberNormalized, (byPolicy.get(l.policyNumberNormalized) ?? 0) + 1);
  assert.equal(byPolicy.size, 85);
  assert.equal([...byPolicy.values()].filter((n) => n > 1).length, 15);
  const four = [...byPolicy.entries()].find(([, n]) => n === 4)!;
  const rows = s.lines.filter((l) => l.policyNumberNormalized === four[0]);
  // continuation, two endorsements (one with a negative payment), one installment
  assert.deepEqual(rows.map((l) => l.transactionType).sort(), ['continuation', 'endorsement', 'endorsement', 'installment_payment']);
  const sig = (l: (typeof s.lines)[number]) => JSON.stringify({ ...l, lineNo: 0, issues: [] });
  const seen = new Map<string, number>();
  for (const l of s.lines) seen.set(sig(l), (seen.get(sig(l)) ?? 0) + 1);
  assert.equal([...seen.values()].filter((n) => n > 1).length, 4); // identical pairs are legitimate
});

test('policy numbers are preserved exactly as printed and normalized only for matching', async () => {
  const { statement: s } = await parseFixturePdf();
  const l = s.lines[0];
  assert.match(l.policyNumberRaw, /^9\d{8} \d{3} \d$/);
  assert.equal(l.policyNumberNormalized, l.policyNumberRaw.replace(/ /g, ''));
});

test('endorsement, cancellation and returned-check details', async () => {
  const { statement: s } = await parseFixturePdf();
  const neg = s.lines.find((l) => l.paidCommissionCents === -5625)!; // 56.25- endorsement
  assert.equal(neg.transactionType, 'endorsement');
  assert.equal(neg.rateBps, 1500);
  assert.equal(neg.premiumForCommissionCents, -37500);
  assert.equal(neg.effectiveDate, '2026-01-10');
  assert.equal(neg.paymentReceivedCents, null);
  const check = s.lines.find((l) => l.transactionType === 'reversal')!;
  assert.equal(check.transactionCodeRaw, 'UNHON-CHECK');
  assert.equal(check.effectiveDate, null);
  assert.equal(check.paidCommissionCents, -3810);
  assert.equal(check.paymentReceivedCents, -24400);
  const canc = s.lines.filter((l) => l.transactionType === 'cancellation');
  assert.ok(canc.every((l) => (l.paidCommissionCents ?? 0) < 0));
  assert.deepEqual(splitEffCode('120325-CONT'), { date: '2025-12-03', code: 'CONT', bad: false });
});

test('a one-cent extraction difference blocks reconciliation', async () => {
  const { statement: s } = await parseFixturePdf((pages) => {
    // change one paid commission from 305.52 to 305.53
    for (const p of pages) for (let i = 0; i < p.length; i++) {
      if (p[i].includes(' 305.52 ') && p[i].includes('CONT')) { p[i] = p[i].replace(' 305.52 ', ' 305.53 '); return; }
    }
  });
  const r = reconcileStatement(s);
  assert.equal(r.reconciled, false);
  const c = r.checks.find((x) => x.key === 'commission')!;
  assert.equal(c.differenceCents, 1);
  assert.ok(r.blockingReasons.some((b) => b.includes('3631.15 vs carrier 3631.14')));
});

test('a missing totals row or month payable blocks reconciliation', async () => {
  const { statement: s } = await parseFixturePdf((pages) => {
    for (const p of pages) for (let i = p.length - 1; i >= 0; i--) {
      if (/^TOTAL (COMMISSION PAYABLE PL|MONTH COMMISSION PAYABLE|COMMISSION PAYABLE - PL)/.test(p[i])) p.splice(i, 1);
    }
  });
  const r = reconcileStatement(s);
  assert.equal(r.reconciled, false);
  assert.ok(s.issues.some((i) => i.code === 'no_total_row'));
  assert.ok(s.issues.some((i) => i.code === 'no_month_payable'));
});

test('an unreadable amount is a line error and blocks reconciliation', () => {
  const pages = fixtureToPages(loadFixture());
  pages[0][5] = pages[0][5].replace('241.73', '24I.73');
  const s = parseTravelersPl(pages);
  const r = reconcileStatement(s);
  assert.equal(r.reconciled, false);
  assert.ok(s.lines[0].issues.some((i) => i.code === 'bad_amount'));
});

test('non-Travelers documents are not mistaken for Travelers', () => {
  assert.equal(isTravelersPlStatement([['ACME MUTUAL COMMISSION STATEMENT', 'Policy, Commission']]), false);
});

// ---- Optional: the real statement, kept OUTSIDE the repository ----
// Run with: TRAVELERS_REAL_PDF=/path/to/2001_Central_Dec_25.pdf npm test
test('real December 2025 Travelers statement reconciles to $3,631.14 (local file only)', async (t) => {
  const path = process.env.TRAVELERS_REAL_PDF;
  if (!path || !existsSync(path)) { t.skip('set TRAVELERS_REAL_PDF to run against the real statement'); return; }
  const text = await pdfToTextLines(new Uint8Array(readFileSync(path)));
  const s = parseTravelersPl(text.pages);
  const r = reconcileStatement(s);
  assert.equal(r.reconciled, true, r.blockingReasons.join('; '));
  assert.equal(r.totals.commissionCents, KNOWN.commission);
  assert.equal(r.totals.paymentReceivedCents, KNOWN.paymentReceived);
  assert.equal(r.totals.premiumForCommissionCents, KNOWN.premiumForCommission);
  assert.equal(r.totals.transactionPremiumCents, KNOWN.transactionPremium);
  assert.equal(s.stated.ytdCommissionPayableCents, KNOWN.ytd);
  assert.equal(s.lines.length, 102);
});
