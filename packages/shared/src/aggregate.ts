import { applyBasisPoints, sumCents, type BasisPoints, type Cents } from './money.js';
import { inWindow, windowMonths, type Month } from './period.js';
import type { LedgerEntry } from './types.js';

/**
 * Revenue aggregation over posted ledger entries. Every figure in the app is produced by
 * these functions from the ledger, so reports always tie to the ledger total.
 * Revenue month = statementPeriod (decided basis).
 */

type Entry = Pick<LedgerEntry, 'amountCents' | 'statementPeriod' | 'postingStatus'> &
  Partial<Pick<LedgerEntry, 'policyId' | 'payerId' | 'carrierId' | 'classification' | 'level'>>;

/**
 * Whether a ledger entry counts in reports: posted entries, and originals later reversed (the
 * reversal is its own posted negative entry, so both stay included and net to zero). Every report,
 * the Dashboard, the Ledger report and the dev audit use this one rule.
 */
export function isReportable(e: Pick<LedgerEntry, 'postingStatus'>): boolean {
  return e.postingStatus === 'posted' || e.postingStatus === 'reversed';
}

function counted<T extends Entry>(entries: Iterable<T>): T[] {
  return [...entries].filter(isReportable);
}

export function totalInWindow(entries: Iterable<Entry>, start: Month, count = 12): Cents {
  return sumCents(
    counted(entries)
      .filter((e) => inWindow(e.statementPeriod, start, count))
      .map((e) => e.amountCents),
  );
}

/** Month → total for each month of the window (months with nothing posted are 0). */
export function monthlyTotals(entries: Iterable<Entry>, start: Month, count = 12): Map<Month, Cents> {
  const out = new Map<Month, Cents>(windowMonths(start, count).map((m) => [m, 0]));
  for (const e of counted(entries)) {
    if (!out.has(e.statementPeriod)) continue;
    out.set(e.statementPeriod, sumCents([out.get(e.statementPeriod)!, e.amountCents]));
  }
  return out;
}

/** Group window totals by any key (payer, carrier, classification…). Null keys collect under `nullKey`. */
export function totalsBy<T extends Entry>(
  entries: Iterable<T>,
  key: (e: T) => string | null | undefined,
  start: Month,
  count = 12,
  nullKey = '__none__',
): Map<string, Cents> {
  const out = new Map<string, Cents>();
  for (const e of counted(entries)) {
    if (!inWindow(e.statementPeriod, start, count)) continue;
    const k = key(e) ?? nullKey;
    out.set(k, sumCents([out.get(k) ?? 0, e.amountCents]));
  }
  return out;
}

export const CARRIER_LEVEL_BUCKET = '__carrier_level__';

/**
 * Totals by each policy's CURRENT broker (decided attribution for the snapshot).
 * Entries without a policy (carrier-level bonuses, suspense) go to CARRIER_LEVEL_BUCKET.
 */
export function totalsByBroker(
  entries: Iterable<Entry>,
  policyBroker: ReadonlyMap<string, string>,
  start: Month,
  count = 12,
  unassignedId = 'UNASSIGNED',
): Map<string, Cents> {
  return totalsBy(
    entries,
    (e) => (e.policyId ? policyBroker.get(e.policyId) ?? unassignedId : CARRIER_LEVEL_BUCKET),
    start,
    count,
  );
}

/** Gross commission split between broker share and agency net. The two parts always sum to gross. */
export function brokerSplit(grossCents: Cents, shareBps: BasisPoints): { broker: Cents; agency: Cents } {
  const broker = applyBasisPoints(grossCents, shareBps);
  return { broker, agency: grossCents - broker };
}
