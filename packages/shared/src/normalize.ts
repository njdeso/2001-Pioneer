/**
 * Normalization used for duplicate detection, matching and search.
 * Raw values are always stored alongside normalized ones.
 */

/** Uppercase and strip everything except letters and digits. "ab-123 456/01" → "AB12345601". */
export function normalizePolicyNumber(raw: string): string {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** Key that enforces "one policy per carrier + policy number". Same number at two carriers = two keys. */
export function policyKey(carrierId: string, policyNumber: string): string {
  const norm = normalizePolicyNumber(policyNumber);
  if (!carrierId || !norm) throw new Error('policyKey requires a carrier and a policy number');
  return `${carrierId}__${norm}`;
}

const LEGAL_SUFFIXES = new Set([
  'llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited',
  'lp', 'llp', 'pllc', 'pc', 'pa', 'the',
]);

/** Lowercase, strip punctuation and legal suffixes, collapse whitespace. "The Smith Trucking, L.L.C." → "smith trucking" */
export function normalizeName(raw: string): string {
  const cleaned = String(raw ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b([a-z])\.(?=[a-z]\.)/g, '$1') // L.L.C. → LLC
    .replace(/\./g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  while (cleaned.length > 1 && LEGAL_SUFFIXES.has(cleaned[cleaned.length - 1])) cleaned.pop();
  while (cleaned.length > 1 && cleaned[0] === 'the') cleaned.shift();
  return cleaned.join(' ');
}

/** Split "ABC Holdings DBA Quick Cab" into its legal and trade names, each normalized. */
export function nameVariants(raw: string): string[] {
  const parts = String(raw ?? '').split(/\b(?:d\/?b\/?a|aka|t\/a)\b\.?/i);
  const out = new Set<string>();
  for (const p of parts) {
    const n = normalizeName(p);
    if (n) out.add(n);
  }
  const whole = normalizeName(raw);
  if (whole) out.add(whole);
  return [...out];
}

/** Prefix tokens for Firestore array-contains search. Lowercase, 2–12 chars, capped. */
export function searchTokens(...values: (string | undefined | null)[]): string[] {
  const tokens = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    const words = [
      ...normalizeName(v).split(' '),
      normalizePolicyNumber(v).toLowerCase(),
    ].filter((w) => w.length >= 2);
    for (const w of words) {
      for (let i = 2; i <= Math.min(w.length, 12); i++) tokens.add(w.slice(0, i));
    }
  }
  return [...tokens].slice(0, 200);
}

/** Normalize a free-text query the same way, for matching against searchTokens. */
export function searchQueryToken(query: string): string {
  const n = normalizeName(query).split(' ')[0] ?? '';
  return n.slice(0, 12);
}
