/**
 * Display-only proper casing for customer names. Never used for storage, matching or import:
 * the stored name is unchanged and every comparison still runs on the raw / normalized value.
 *
 *   "SMITH TRUCKING LLC"     → "Smith Trucking LLC"
 *   "john o'brien"           → "John O'Brien"
 *   "ACME INC. DBA ACE AUTO" → "Acme Inc. DBA Ace Auto"
 *   "McDonald & Sons, Inc."  → unchanged (already mixed case)
 */

/** Tokens that stay all-caps. Keys are the token with dots removed, lowercased. */
const UPPER = new Set([
  'llc', 'llp', 'lp', 'pllc', 'pc', 'pa', 'dba', 'aka', 'fka', 'nka', 'usa', 'us', 'nyc', 'ny',
  'ii', 'iii', 'iv', 'vi', 'vii', 'viii', 'md', 'dds', 'dmd', 'dvm', 'cpa', 'rn', 'np', 'esq',
]);
/** Fixed spellings (kept with any trailing dot from the source). */
const FIXED: Record<string, string> = { inc: 'Inc', corp: 'Corp', co: 'Co', ltd: 'Ltd', jr: 'Jr', sr: 'Sr', mr: 'Mr', mrs: 'Mrs', ms: 'Ms', dr: 'Dr', st: 'St' };
/** Lowercased when not the first word. */
const SMALL = new Set(['and', 'of', 'the', 'for', 'at', 'by', 'on', 'in', 'to', 'c/o']);

/** True when the name already has deliberate capitalization (both upper- and lowercase letters). */
function isMixedCase(s: string): boolean {
  return /[a-z]/.test(s) && /[A-Z]/.test(s);
}

function capWord(w: string): string {
  // Capitalize the first letter of each part split by - / . & and handle O'Brien / McDonald.
  let out = w.toLowerCase().replace(/(^|[-/.&(])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase());
  out = out.replace(/^([a-z])'([a-z])/i, (_, a: string, b: string) => a.toUpperCase() + "'" + b.toUpperCase()); // O'Brien, D'Angelo
  out = out.replace(/^Mc([a-z])/, (_, c: string) => 'Mc' + c.toUpperCase()); // McDonald
  return out;
}

function caseToken(tok: string, first: boolean): string {
  const m = /^([("']*)(.*?)([),;:]*)$/.exec(tok)!;
  const [, lead, core, trail] = m;
  if (!core || !/[a-z]/i.test(core)) return tok; // numbers, "&", punctuation
  const key = core.toLowerCase().replace(/\./g, '');
  const dot = core.endsWith('.') ? '.' : '';
  const fixed = FIXED[core.toLowerCase().replace(/\.$/, '')]; // "J.R." is initials, not "Jr."
  let out: string;
  if (UPPER.has(key) || key === 'd/b/a') out = core.toUpperCase();
  else if (fixed) out = fixed + dot;
  else if (!first && SMALL.has(core.toLowerCase())) out = core.toLowerCase();
  else if (/^\d/.test(core)) out = core.toLowerCase(); // 1st, 2nd, 3rd
  else out = capWord(core);
  return lead + out + trail;
}

/** Proper-case a customer name for display. Mixed-case names are returned as-is. */
export function displayName(raw: string | null | undefined): string {
  const s = String(raw ?? '');
  if (!s.trim() || isMixedCase(s)) return s;
  let first = true;
  return s.split(/(\s+)/).map((part) => {
    if (/^\s*$/.test(part)) return part;
    const out = caseToken(part, first);
    first = false;
    return out;
  }).join('');
}
