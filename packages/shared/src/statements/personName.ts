import { normalizeName } from '../normalize.js';

/**
 * Person-name comparison for insured names on carrier statements.
 *
 * Statements print people as "LAST FIRST M", "LAST,F" or "LAST, FIRST"; the book stores them as
 * "First Last" and joint insureds as "William & Joelle Augustine". The word-overlap comparison in
 * nameEvidence() scores those as different people ("BIONDI,D" vs "Dana Biondi" share 1 of 3 words).
 *
 * personEvidence() recognises the same person across those formats: the surname must be identical and
 * the given names compatible (equal, or an initial matching a given name; extra middle initials ignored).
 * It answers 'compatible' or 'conflict' (same surname, different given names), or null when it cannot
 * apply (a business name, or no shared surname). It never returns more than "compatible": callers treat
 * that as PARTIAL name support, so it can only confirm a policy already found by number and carrier.
 */

export interface Person { surname: string; given: string[] }

const BUSINESS_WORDS = new Set([
  'llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'lp', 'llp', 'pllc', 'pc', 'pa',
  'trust', 'estate', 'services', 'service', 'group', 'holdings', 'enterprises', 'enterprise', 'associates', 'partners',
  'transport', 'transportation', 'trucking', 'logistics', 'cab', 'cabs', 'taxi', 'limo', 'limousine', 'livery', 'car', 'cars',
  'auto', 'motors', 'construction', 'contracting', 'church', 'school', 'restaurant', 'deli', 'market', 'realty', 'properties',
  'management', 'mgmt', 'agency', 'insurance', 'bank', 'club', 'association', 'assoc', 'society', 'foundation', 'center',
  'medical', 'dental', 'law', 'plumbing', 'electric', 'heating', 'roofing', 'landscaping', 'cleaning', 'salon', 'shop', 'store',
  'dba', 'of', 'the', 'express',
]);
const CONNECTORS = new Set(['and', 'or']);
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'md', 'esq']);

/** Apostrophes join the name (O'Connor → oconnor) instead of splitting it. */
const norm = (s: string) => normalizeName(String(s ?? '').replace(/['’`]/g, ''));
const words = (s: string) => norm(s).split(' ').filter((w) => w && !SUFFIXES.has(w));
const isBusiness = (raw: string) => /\d/.test(raw) || words(raw).some((w) => BUSINESS_WORDS.has(w)) || words(raw).length > 6;

/**
 * Readings of a name as one or more people. `printed` names (from a statement) may be either
 * "LAST FIRST M" or "FIRST M LAST", so both orders are returned; book names are "First Last".
 * "LAST, F" with a comma is unambiguous. Joint insureds share the last part's surname.
 */
export function parsePersons(raw: string, kind: 'printed' | 'book'): Person[][] | null {
  const s = String(raw ?? '').trim();
  if (!s || isBusiness(s)) return null;
  const comma = s.indexOf(',');
  if (comma > 0) {
    const surname = words(s.slice(0, comma));
    const given = words(s.slice(comma + 1)).filter((w) => !CONNECTORS.has(w));
    if (surname.length !== 1) return null;
    return [[{ surname: surname[0], given }]];
  }
  const parts = norm(s).split(/\b(?:and|or)\b/).map((p) => p.trim().split(' ').filter((w) => w && !SUFFIXES.has(w))).filter((p) => p.length);
  if (!parts.length) return null;
  const readings: Person[][] = [];
  if (parts.length > 1) {
    // "William and Joelle Augustine": every part shares the surname at the end of the last part.
    const last = parts[parts.length - 1];
    if (last.length < 2) return null;
    const surname = last[last.length - 1];
    readings.push(parts.map((p, i) => ({ surname, given: i === parts.length - 1 ? p.slice(0, -1) : p.filter((w) => w !== surname) })));
    if (kind === 'printed') {
      // "AUGUSTINE WILLIAM AND JOELLE": surname first.
      const first = parts[0];
      if (first.length >= 2) readings.push(parts.map((p, i) => ({ surname: first[0], given: i === 0 ? p.slice(1) : p.filter((w) => w !== first[0]) })));
    }
    return readings;
  }
  const w = parts[0];
  if (w.length < 2) return null;
  readings.push([{ surname: w[w.length - 1], given: w.slice(0, -1) }]);               // First M Last
  if (kind === 'printed') readings.push([{ surname: w[0], given: w.slice(1) }]);       // LAST FIRST M
  return readings;
}

/** Given names compatible: an exact shared given name, or an initial matching the first letter of one. */
function givenCompatible(a: string[], b: string[]): boolean | null {
  const fullA = a.filter((x) => x.length > 1), fullB = b.filter((x) => x.length > 1);
  const initA = a.filter((x) => x.length === 1), initB = b.filter((x) => x.length === 1);
  if (!a.length || !b.length) return null; // surname only: no evidence either way
  if (fullA.some((x) => fullB.includes(x))) return true;
  // Primary given name: the first given token on each side.
  const pa = a[0], pb = b[0];
  if (pa.length > 1 && pb.length > 1) return false; // two different full first names
  if (pa[0] === pb[0]) return true;                   // initial ↔ name, or initial ↔ initial
  // An initial on one side matching any full given name on the other ("SMITH J A" vs "Alan James Smith").
  if (initA.some((i) => fullB.some((f) => f[0] === i)) || initB.some((i) => fullA.some((f) => f[0] === i))) return true;
  return false;
}

const GENERATIONS = ['jr', 'sr', 'ii', 'iii', 'iv'];
const generation = (raw: string) => norm(raw).split(' ').find((w) => GENERATIONS.includes(w)) ?? null;

export function personEvidence(printed: string, book: string): 'compatible' | 'conflict' | null {
  const pr = parsePersons(printed, 'printed');
  const bk = parsePersons(book, 'book');
  if (!pr || !bk) return null;
  // Jr vs Sr (or II vs III) are different people even with identical names.
  const ga = generation(printed), gb = generation(book);
  const generationConflict = !!ga && !!gb && ga !== gb;
  let sawConflict = false;
  for (const readingA of pr) for (const readingB of bk) {
    for (const a of readingA) for (const b of readingB) {
      if (a.surname !== b.surname || a.surname.length < 2) continue;
      const g = givenCompatible(a.given, b.given);
      if (g === true && generationConflict) { sawConflict = true; continue; }
      if (g === true) return 'compatible';
      if (g === false) sawConflict = true;
    }
  }
  return sawConflict ? 'conflict' : null;
}
