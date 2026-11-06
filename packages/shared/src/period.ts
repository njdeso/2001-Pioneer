/**
 * Months and dates. Months are "YYYY-MM" strings; dates are "YYYY-MM-DD" strings.
 * No Date objects or time zones are involved in financial grouping.
 */

export type Month = string; // YYYY-MM
export type IsoDate = string; // YYYY-MM-DD

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function isMonth(v: unknown): v is Month {
  return typeof v === 'string' && MONTH_RE.test(v);
}

export function isIsoDate(v: unknown): v is IsoDate {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  return d <= daysInMonth(y, m);
}

export function daysInMonth(year: number, month: number): number {
  return [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function addMonths(month: Month, n: number): Month {
  if (!isMonth(month)) throw new Error(`Invalid month "${month}"`);
  const [y, m] = month.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

export function monthOf(date: IsoDate): Month {
  if (!isIsoDate(date)) throw new Error(`Invalid date "${date}"`);
  return date.slice(0, 7);
}

/** The list of months in a window starting at `start`, `count` months long (default 12). */
export function windowMonths(start: Month, count = 12): Month[] {
  return Array.from({ length: count }, (_, i) => addMonths(start, i));
}

export function inWindow(month: Month, start: Month, count = 12): boolean {
  return isMonth(month) && month >= start && month <= addMonths(start, count - 1);
}

/** The 12 complete months ending the month before `today` (YYYY-MM-DD). */
export function trailingTwelveStart(today: IsoDate): Month {
  return addMonths(monthOf(today), -12);
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatMonth(month: Month): string {
  if (!isMonth(month)) return month;
  const [y, m] = month.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

export function formatWindow(start: Month, count = 12): string {
  return `${formatMonth(start)} – ${formatMonth(addMonths(start, count - 1))}`;
}
