import { normalizePolicyNumber } from './normalize.js';

/**
 * Clients & Policies search: a customer matches by name (or broker name), or by any of its policies'
 * numbers — current or alternate — ignoring case, spaces, dashes and other punctuation, so
 * "6x-123 456" finds "6X123456". Policy-number matches need at least 3 characters.
 */
export interface SearchClient { id: string; name: string }
export interface SearchPolicy { id: string; clientId: string; policyNumber: string; alternateNumbers?: string[] }

export function policyNumberMatches(p: SearchPolicy, query: string): boolean {
  const q = normalizePolicyNumber(query);
  if (q.length < 3) return false;
  return [p.policyNumber, ...(p.alternateNumbers ?? [])].some((n) => normalizePolicyNumber(n).includes(q));
}

export function searchBook<C extends SearchClient, P extends SearchPolicy>(clients: C[], policies: P[], query: string, extraText: (c: C) => string = () => '') {
  const q = query.trim().toLowerCase();
  const byClient = new Map<string, P[]>();
  if (q) for (const p of policies) if (policyNumberMatches(p, q)) byClient.set(p.clientId, [...(byClient.get(p.clientId) ?? []), p]);
  const matchesClient = (c: C) => !q || `${c.name} ${extraText(c)}`.toLowerCase().includes(q) || byClient.has(c.id);
  return { matchesClient, policiesFor: (clientId: string) => byClient.get(clientId) ?? [] };
}
