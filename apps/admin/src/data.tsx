import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { collection, doc, onSnapshot, query, where, type Query } from 'firebase/firestore';
import {
  addMonths, brokerSplit, monthlyTotals, totalInWindow, totalsBy, totalsByBroker,
  type Broker, type Carrier, type Cents, type Client, type LedgerEntry, type Month, type Policy, type Settings,
  UNASSIGNED_BROKER_ID,
} from '@asm/shared';
import { db } from './firebase';

/**
 * Live data for the whole app. At agency scale (a few thousand clients/policies,
 * ~150 statements) subscribing to the collections keeps every screen consistent
 * and every figure computed from the same ledger.
 */

export interface Revenue {
  start: Month;
  months: number;
  entries: LedgerEntry[];
  total: Cents;
  monthly: Map<Month, Cents>;
  byPayer: Map<string, Cents>;
  byCarrier: Map<string, Cents>;
  byBroker: Map<string, Cents>;
  byPolicy: Map<string, Cents>;
  byLine: Map<string, Cents>;
  brokerShare: Cents;
  agencyNet: Cents;
}

interface DataState {
  ready: boolean;
  error: string | null;
  settings: Settings | null;
  carriers: Carrier[];
  brokers: Broker[];
  clients: Client[];
  policies: Policy[];
  carrierById: Map<string, Carrier>;
  brokerById: Map<string, Broker>;
  clientById: Map<string, Client>;
  policyById: Map<string, Policy>;
  revenue: Revenue | null;
}

const DataContext = createContext<DataState | null>(null);

function useCollection<T>(q: Query | null, deps: unknown[]): { rows: T[]; loaded: boolean; error: string | null } {
  const [state, setState] = useState<{ rows: T[]; loaded: boolean; error: string | null }>({ rows: [], loaded: false, error: null });
  useEffect(() => {
    if (!q) return;
    return onSnapshot(
      q,
      (snap) => setState({ rows: snap.docs.map((d) => ({ id: d.id, ...d.data() }) as T), loaded: true, error: null }),
      (err) => setState((s) => ({ ...s, loaded: true, error: err.message })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

export function DataProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  useEffect(
    () =>
      onSnapshot(doc(db, 'settings/app'), (s) => {
        setSettings(s.exists() ? (s.data() as Settings) : null);
        setSettingsLoaded(true);
      }),
    [],
  );

  const carriers = useCollection<Carrier>(collection(db, 'carriers'), []);
  const brokers = useCollection<Broker>(collection(db, 'brokers'), []);
  const clients = useCollection<Client>(collection(db, 'clients'), []);
  const policies = useCollection<Policy>(collection(db, 'policies'), []);

  const start = settings?.snapshotStartMonth ?? null;
  const months = settings?.snapshotMonths ?? 12;
  const ledgerQuery = start
    ? query(
        collection(db, 'ledger'),
        where('statementPeriod', '>=', start),
        where('statementPeriod', '<=', addMonths(start, months - 1)),
      )
    : null;
  const ledger = useCollection<LedgerEntry>(ledgerQuery, [start, months]);

  const value = useMemo<DataState>(() => {
    const carrierById = new Map(carriers.rows.map((c) => [c.id, c]));
    const brokerById = new Map(brokers.rows.map((b) => [b.id, b]));
    const clientById = new Map(clients.rows.map((c) => [c.id, c]));
    const policyById = new Map(policies.rows.map((p) => [p.id, p]));

    let revenue: Revenue | null = null;
    if (start) {
      const entries = ledger.rows;
      const policyBroker = new Map(policies.rows.map((p) => [p.id, p.brokerId || UNASSIGNED_BROKER_ID]));
      const byBroker = totalsByBroker(entries, policyBroker, start, months);
      let brokerShare = 0;
      for (const [brokerId, gross] of byBroker) {
        const b = brokerById.get(brokerId);
        if (b) brokerShare += brokerSplit(gross, b.shareBps).broker;
      }
      const total = totalInWindow(entries, start, months);
      revenue = {
        start,
        months,
        entries,
        total,
        monthly: monthlyTotals(entries, start, months),
        byPayer: totalsBy(entries, (e) => e.payerId, start, months),
        byCarrier: totalsBy(entries, (e) => e.carrierId, start, months),
        byBroker,
        byPolicy: totalsBy(entries, (e) => e.policyId, start, months),
        byLine: totalsBy(entries, (e) => (e.policyId ? policyById.get(e.policyId)?.line : null), start, months, 'carrier_level'),
        brokerShare,
        agencyNet: total - brokerShare,
      };
    }

    const errors = [carriers.error, brokers.error, clients.error, policies.error, ledger.error].filter(Boolean);
    return {
      ready: settingsLoaded && carriers.loaded && brokers.loaded && clients.loaded && policies.loaded,
      error: errors[0] ?? null,
      settings,
      carriers: carriers.rows,
      brokers: brokers.rows,
      clients: clients.rows,
      policies: policies.rows,
      carrierById,
      brokerById,
      clientById,
      policyById,
      revenue,
    };
  }, [settings, settingsLoaded, carriers, brokers, clients, policies, ledger, start, months]);

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): DataState {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData outside DataProvider');
  return ctx;
}
