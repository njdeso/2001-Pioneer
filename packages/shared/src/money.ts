/**
 * Money: every amount in Agency Sale Manager is a signed integer number of cents.
 * Floating-point arithmetic is never used for financial values.
 *
 * Rates are integer basis points (1% = 100 bps, 15% = 1500 bps).
 */

export type Cents = number;
export type BasisPoints = number;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export function assertCents(value: unknown, label = 'amount'): asserts value is Cents {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} must be a safe integer number of cents`);
  }
}

/**
 * Parse a money string exactly as printed on a statement into integer cents.
 * Accepts: "1,234.56", "$1,234.56", "-1,234.56", "(1,234.56)", "1,234.56-",
 * "1,234.56 CR", "$ (12.00)", "12", "12.5", ".75".
 * "CR" (credit) and parentheses / trailing minus are treated as negative.
 * More than two decimal places is rejected rather than silently rounded.
 */
export function parseMoneyToCents(input: string | number): Cents {
  if (typeof input === 'number') {
    if (Number.isSafeInteger(input)) return input * 100;
    // Convert via the shortest round-trip string so 0.1 stays "0.1", then parse exactly.
    return parseMoneyToCents(String(input));
  }
  let s = String(input).trim();
  if (s === '') throw new MoneyError('Empty amount');

  let negative = false;
  // Credit marker
  if (/\bCR$/i.test(s)) {
    negative = !negative;
    s = s.replace(/\s*CR$/i, '').trim();
  } else if (/\bDR$/i.test(s)) {
    s = s.replace(/\s*DR$/i, '').trim();
  }
  // Parentheses
  if (/^\(.*\)$/.test(s.replace(/^\$\s*/, ''))) {
    negative = !negative;
    s = s.replace(/^\$\s*/, '').slice(1, -1).trim();
  }
  // Trailing minus
  if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1).trim();
  }
  // Leading sign (may come before or after $)
  s = s.replace(/^\$\s*/, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1).trim();
  } else if (s.startsWith('+')) {
    s = s.slice(1).trim();
  }
  s = s.replace(/^\$\s*/, '');
  if (/^\(.*\)$/.test(s)) {
    negative = !negative;
    s = s.slice(1, -1).trim();
  }

  // Thousands separators must be well formed if present
  if (s.includes(',')) {
    if (!/^\d{1,3}(,\d{3})*(\.\d*)?$/.test(s)) {
      throw new MoneyError(`Malformed thousands separators in "${input}"`);
    }
    s = s.replace(/,/g, '');
  }
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === '' && (m[2] === undefined || m[2] === ''))) {
    throw new MoneyError(`Not a valid amount: "${input}"`);
  }
  const whole = m[1] === '' ? '0' : m[1];
  const frac = m[2] ?? '';
  if (frac.length > 2) {
    if (/^\d{2}0+$/.test(frac)) {
      // trailing zeros beyond cents are harmless: 12.3400
    } else {
      throw new MoneyError(`More than two decimal places in "${input}"`);
    }
  }
  const cents = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
  const result = Number(negative ? -cents : cents);
  if (!Number.isSafeInteger(result)) throw new MoneyError(`Amount out of range: "${input}"`);
  return result === 0 ? 0 : result; // normalise -0
}

/** Sum integer cents, verifying every input and the running total stay safe integers. */
export function sumCents(values: Iterable<Cents>): Cents {
  let total = 0;
  for (const v of values) {
    assertCents(v);
    total += v;
    if (!Number.isSafeInteger(total)) throw new MoneyError('Total out of safe integer range');
  }
  return total;
}

/**
 * Divide a BigInt numerator by a positive BigInt denominator, rounding half to even.
 */
function divRoundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new MoneyError('Denominator must be positive');
  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;
  let q = n / denominator;
  const r = n % denominator;
  const twice = r * 2n;
  if (twice > denominator || (twice === denominator && q % 2n === 1n)) q += 1n;
  return negative ? -q : q;
}

/**
 * cents × numerator / denominator, computed exactly in integers and rounded once, half-even.
 * Used for exact calendar-day ratios (e.g. advance × remaining days / term days).
 */
export function mulDivHalfEven(cents: Cents, numerator: number, denominator: number): Cents {
  assertCents(cents);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) throw new MoneyError('Ratio terms must be integers');
  return Number(divRoundHalfEven(BigInt(cents) * BigInt(numerator), BigInt(denominator)));
}

/** cents × bps / 10,000, rounded once, half-even. */
export function applyBasisPoints(cents: Cents, bps: BasisPoints): Cents {
  assertCents(cents);
  if (!Number.isSafeInteger(bps)) throw new MoneyError('Basis points must be an integer');
  return Number(divRoundHalfEven(BigInt(cents) * BigInt(bps), 10000n));
}

/** Multiply cents by a decimal multiple given as a string, e.g. "2.5" or "1.75". Rounded once, half-even. */
export function multiplyCents(cents: Cents, multiple: string): Cents {
  assertCents(cents);
  const m = /^(\d+)(?:\.(\d{1,4}))?$/.exec(multiple.trim());
  if (!m) throw new MoneyError(`Invalid multiple "${multiple}"`);
  const frac = (m[2] ?? '').padEnd(4, '0');
  const scaled = BigInt(m[1]) * 10000n + BigInt(frac);
  return Number(divRoundHalfEven(BigInt(cents) * scaled, 10000n));
}

/** Parse a percentage string ("15", "15%", "7.5") into integer basis points. */
export function parsePercentToBps(input: string | number): BasisPoints {
  const s = String(input).trim().replace(/%$/, '').trim();
  const m = /^(-?)(\d*)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m || (m[2] === '' && !m[3])) throw new MoneyError(`Not a valid percentage: "${input}"`);
  const bps = Number(m[2] || '0') * 100 + Number(((m[3] ?? '') + '00').slice(0, 2));
  return m[1] === '-' ? -bps : bps;
}

export function formatBps(bps: BasisPoints): string {
  const sign = bps < 0 ? '-' : '';
  const abs = Math.abs(bps);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${sign}${whole}${frac ? '.' + String(frac).padStart(2, '0').replace(/0$/, '') : ''}%`;
}

/** Format cents as US dollars, e.g. -123456 → "-$1,234.56" (or "($1,234.56)" with accounting style). */
export function formatCents(cents: Cents, opts: { accounting?: boolean; symbol?: boolean } = {}): string {
  assertCents(cents);
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = `${opts.symbol === false ? '' : '$'}${dollars}.${String(abs % 100).padStart(2, '0')}`;
  if (!negative) return body;
  return opts.accounting ? `(${body})` : `-${body}`;
}

/** Split a total across shares in basis points (must total 10,000) so the parts always sum exactly. */
export function allocateByBps(total: Cents, shares: BasisPoints[]): Cents[] {
  assertCents(total);
  const sum = shares.reduce((a, b) => a + b, 0);
  if (sum !== 10000) throw new MoneyError('Shares must total 10,000 bps');
  const parts = shares.map((s) => Number((BigInt(total) * BigInt(s)) / 10000n));
  let remainder = total - parts.reduce((a, b) => a + b, 0);
  // Distribute leftover cents to the largest shares first, deterministically.
  const order = shares.map((s, i) => [s, i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const step = remainder >= 0 ? 1 : -1;
  for (let k = 0; remainder !== 0; k = (k + 1) % order.length) {
    parts[order[k][1]] += step;
    remainder -= step;
  }
  return parts;
}
