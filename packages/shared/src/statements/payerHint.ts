import { normalizeName } from '../normalize.js';

/**
 * Carrier suggestion from the uploaded file's name, used only when the statement itself does not print a
 * carrier name (e.g. a scanned Security Mutual statement saved as "SMIC Nov 26.pdf") and no agency code
 * identified the carrier.
 *
 * - Only carriers/wholesalers already set up are considered; nothing is created or invented.
 * - A carrier is suggested only when a WHOLE word or phrase of the file name equals its name, code or one
 *   of its aliases, and exactly one carrier matches.
 * - A file name is typed by a person, not printed by the carrier, so a suggestion is never applied on its
 *   own: the statement keeps payerId null until someone confirms the carrier on the review screen.
 */

export interface PayerCandidate {
  id: string;
  name: string;
  code?: string | null;
  aliases?: string[] | null;
  status?: string | null;
}

export interface PayerSuggestion {
  payerId: string;
  payerName: string;
  /** The carrier name, code or alias that matched, as set up. */
  matchedTerm: string;
  matchedOn: 'name' | 'code' | 'alias';
  source: 'file_name';
  fileName: string;
  /** Always true: a file-name match is a suggestion that must be confirmed. */
  needsConfirmation: true;
}

export type PayerHintResult =
  | { kind: 'suggested'; suggestion: PayerSuggestion; note: string }
  | { kind: 'ambiguous'; candidates: { id: string; name: string }[]; note: string }
  | { kind: 'none'; note: string };

/** Words too generic to identify a carrier on their own (they also appear in many file names). */
const GENERIC = new Set([
  'insurance', 'ins', 'co', 'company', 'companies', 'mutual', 'group', 'national', 'american', 'general', 'casualty',
  'property', 'fire', 'life', 'assurance', 'indemnity', 'agency', 'commission', 'commissions', 'statement', 'statements',
  'stmt', 'comm', 'direct', 'bill', 'personal', 'commercial', 'lines', 'pl', 'cl', 'and', 'of', 'the', 'new', 'york', 'ny',
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'scan', 'scanned', 'copy', 'final', 'pdf',
]);

function words(s: string): string[] {
  return normalizeName(s).split(' ').filter(Boolean);
}

/** True when `term` appears as consecutive whole words in `hay`. */
function containsPhrase(hay: string[], term: string[]): boolean {
  if (!term.length || term.length > hay.length) return false;
  for (let i = 0; i + term.length <= hay.length; i++) {
    if (term.every((w, k) => hay[i + k] === w)) return true;
  }
  return false;
}

/** A term identifies a carrier only if it has at least 3 characters and is not entirely generic words. */
function usableTerm(term: string[]): boolean {
  return term.join('').length >= 3 && term.some((w) => !GENERIC.has(w) && !/^\d+$/.test(w));
}

export function suggestPayerFromFileName(fileName: string, carriers: PayerCandidate[]): PayerHintResult {
  const base = String(fileName ?? '').replace(/\.[a-z0-9]{1,5}$/i, '');
  const hay = words(base.replace(/[_]+/g, ' '));
  if (!hay.length) return { kind: 'none', note: 'The statement does not print a carrier name; choose the carrier on the review screen' };

  const hits = new Map<string, { c: PayerCandidate; term: string; on: PayerSuggestion['matchedOn'] }>();
  for (const c of carriers) {
    if (c.status === 'inactive') continue;
    const terms: { raw: string; on: PayerSuggestion['matchedOn'] }[] = [
      { raw: c.code ?? '', on: 'code' },
      ...(c.aliases ?? []).map((a) => ({ raw: a, on: 'alias' as const })),
      { raw: c.name, on: 'name' },
    ];
    for (const t of terms) {
      const tw = words(t.raw);
      if (!usableTerm(tw) || !containsPhrase(hay, tw)) continue;
      if (!hits.has(c.id)) hits.set(c.id, { c, term: t.raw.trim(), on: t.on });
      break;
    }
  }

  if (hits.size === 1) {
    const [{ c, term, on }] = [...hits.values()];
    const suggestion: PayerSuggestion = { payerId: c.id, payerName: c.name, matchedTerm: term, matchedOn: on, source: 'file_name', fileName, needsConfirmation: true };
    return {
      kind: 'suggested',
      suggestion,
      note: `The statement does not print a carrier name. Suggested from the file name "${fileName}": ${c.name} (matches ${on} "${term}"). Confirm the carrier before matching.`,
    };
  }
  if (hits.size > 1) {
    const candidates = [...hits.values()].map(({ c }) => ({ id: c.id, name: c.name }));
    return { kind: 'ambiguous', candidates, note: `The statement does not print a carrier name, and the file name matches more than one carrier (${candidates.map((x) => x.name).join(', ')}); choose the carrier on the review screen` };
  }
  return { kind: 'none', note: 'The statement does not print a carrier name, and the file name does not identify a set-up carrier; choose the carrier on the review screen' };
}
