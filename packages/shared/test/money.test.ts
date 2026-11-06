import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMoneyToCents, sumCents, applyBasisPoints, multiplyCents, formatCents,
  parsePercentToBps, formatBps, allocateByBps, MoneyError,
} from '../src/money.ts';

test('parses statement-style amounts exactly', () => {
  const cases: [string, number][] = [
    ['1,234.56', 123456], ['$1,234.56', 123456], ['-1,234.56', -123456],
    ['(1,234.56)', -123456], ['$(1,234.56)', -123456], ['1,234.56-', -123456],
    ['1,234.56 CR', -123456], ['12', 1200], ['12.5', 1250], ['.75', 75],
    ['0.00', 0], ['-0.00', 0], ['$ 15,000.00', 1500000], ['+3.10', 310],
    ['12.3400', 1234], ['-$45.10', -4510],
  ];
  for (const [input, expected] of cases) assert.equal(parseMoneyToCents(input), expected, input);
});

test('rejects malformed or over-precise amounts instead of guessing', () => {
  for (const bad of ['', 'abc', '1,23.45', '12.345', '1.2.3', '$', '(']) {
    assert.throws(() => parseMoneyToCents(bad), MoneyError, bad);
  }
});

test('never produces floating-point drift', () => {
  // 0.1 + 0.2 style inputs
  assert.equal(sumCents([parseMoneyToCents('0.10'), parseMoneyToCents('0.20')]), 30);
  const many = Array.from({ length: 1000 }, () => parseMoneyToCents('0.01'));
  assert.equal(sumCents(many), 1000);
  assert.throws(() => sumCents([1.5]), MoneyError);
});

test('statement with negative commissions sums correctly', () => {
  // Synthetic statement: 2 renewals, 1 chargeback, 1 return commission
  const lines = ['450.00', '1,212.35', '(300.00)', '45.10-'].map(parseMoneyToCents);
  assert.equal(sumCents(lines), 131725);
});

test('basis points apply with a single half-even rounding', () => {
  assert.equal(applyBasisPoints(100000, 1500), 15000); // 15% of $1,000
  assert.equal(applyBasisPoints(333, 5000), 166); // 166.5 → 166 (even)
  assert.equal(applyBasisPoints(335, 5000), 168); // 167.5 → 168 (even)
  assert.equal(applyBasisPoints(-335, 5000), -168);
  assert.equal(applyBasisPoints(12345, 750), 926); // 925.875 → 926
});

test('valuation multiples use exact decimal math', () => {
  assert.equal(multiplyCents(10000000, '2.5'), 25000000);
  assert.equal(multiplyCents(123456, '1.75'), 216048);
  assert.throws(() => multiplyCents(100, 'x'), MoneyError);
});

test('formats cents', () => {
  assert.equal(formatCents(123456), '$1,234.56');
  assert.equal(formatCents(-123456), '-$1,234.56');
  assert.equal(formatCents(-5, { accounting: true }), '($0.05)');
  assert.equal(formatCents(100000000), '$1,000,000.00');
});

test('percentages to basis points', () => {
  assert.equal(parsePercentToBps('15'), 1500);
  assert.equal(parsePercentToBps('7.5%'), 750);
  assert.equal(parsePercentToBps('10.25'), 1025);
  assert.equal(formatBps(750), '7.5%');
  assert.equal(formatBps(5000), '50%');
  assert.equal(formatBps(1025), '10.25%');
});

test('allocation always sums to the total', () => {
  const parts = allocateByBps(100, [3333, 3333, 3334]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 100);
  const neg = allocateByBps(-101, [5000, 5000]);
  assert.equal(neg[0] + neg[1], -101);
});
