import { useMemo, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { formatWindow, normalizeName, normalizePolicyNumber } from '@asm/shared';
import { useAuth } from './auth';
import { useData } from './data';
import { buildRef, isProduction, projectId, usingEmulators } from './firebase';
import { cx } from './ui';

export const NAV = [
  { to: '/', label: 'Dashboard', icon: '▦' },
  { to: '/carriers', label: 'Insurance Carriers', icon: '◈' },
  { to: '/brokers', label: 'Brokers', icon: '◉' },
  { to: '/clients', label: 'Clients & Policies', icon: '☰' },
  { to: '/import', label: 'Import Clients', icon: '⇪' },
  { to: '/statements', label: 'Upload Commission Statements', icon: '⇧' },
  { to: '/queue', label: 'AI Processing Queue', icon: '⟳' },
  { to: '/ledger', label: 'Ledger', icon: '≡' },
  { to: '/reconciliation', label: 'Reconciliation', icon: '⚖', phase: 4 },
  { to: '/reports', label: 'Reports & Analytics', icon: '▤', phase: 5 },
  { to: '/valuation', label: 'Book Valuation', icon: '$', phase: 5 },
  { to: '/package', label: 'Due Diligence Package', icon: '⎙' },
  { to: '/settings', label: 'Administration & Settings', icon: '⚙' },
] as const;

export function Footer() {
  return (
    <footer className="border-t border-slate-200 px-6 py-3 text-xs text-slate-500">
      Agency Sale Manager · Developed by <span className="font-semibold text-ink">Vudu Tech</span>
    </footer>
  );
}

function GlobalSearch() {
  const { clients, policies, carriers, clientById } = useData();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const results = useMemo(() => {
    const name = normalizeName(q);
    const num = normalizePolicyNumber(q);
    if (name.length < 2 && num.length < 2) return [];
    const out: { key: string; label: string; sub: string; to: string }[] = [];
    for (const c of clients) {
      if (name.length >= 2 && c.normalizedName?.includes(name)) out.push({ key: 'c' + c.id, label: c.name, sub: 'Client', to: `/clients/${c.id}` });
      if (out.length > 8) break;
    }
    for (const p of policies) {
      if (num.length >= 2 && (p.normalizedPolicyNumber?.includes(num))) {
        out.push({ key: 'p' + p.id, label: p.policyNumber, sub: `Policy · ${clientById.get(p.clientId)?.name ?? ''}`, to: `/clients/${p.clientId}?policy=${p.id}` });
      }
      if (out.length > 14) break;
    }
    for (const c of carriers) {
      if (name.length >= 2 && normalizeName(c.name).includes(name)) out.push({ key: 'k' + c.id, label: c.name, sub: c.kind === 'wholesaler' ? 'Wholesaler' : 'Carrier', to: `/carriers/${c.id}` });
    }
    return out.slice(0, 15);
  }, [q, clients, policies, carriers, clientById]);

  return (
    <div className="relative w-full max-w-md">
      <input
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        placeholder="Search clients, policy numbers, carriers…"
        className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm focus:border-ink focus:outline-none"
        aria-label="Global search"
      />
      {open && results.length > 0 && (
        <ul className="absolute z-40 mt-1 max-h-96 w-full overflow-auto rounded-md border border-slate-200 bg-white py-1 shadow-lg">
          {results.map((r) => (
            <li key={r.key}>
              <button type="button" className="flex w-full justify-between px-3 py-2 text-left text-sm hover:bg-slate-50"
                onMouseDown={() => { navigate(r.to); setQ(''); setOpen(false); }}>
                <span className="truncate">{r.label}</span>
                <span className="ml-2 shrink-0 text-xs text-slate-400">{r.sub}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AppLayout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const { settings, error } = useData();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="flex min-h-full">
      <aside className={cx(
        'fixed inset-y-0 left-0 z-30 w-64 transform bg-ink text-slate-200 transition-transform lg:static lg:translate-x-0',
        menuOpen ? 'translate-x-0' : '-translate-x-full',
      )}>
        <div className="border-b border-white/10 px-5 py-4">
          <div className="text-sm font-semibold tracking-wide text-white">Agency Sale Manager</div>
          <div className="text-xs text-gold">{settings?.agencyName ?? ''}</div>
        </div>
        <nav className="space-y-0.5 px-2 py-3">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} onClick={() => setMenuOpen(false)}
              className={({ isActive }) => cx(
                'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm',
                isActive ? 'bg-white/10 font-medium text-white' : 'text-slate-300 hover:bg-white/5 hover:text-white',
              )}>
              <span className="w-4 text-center text-xs opacity-70">{n.icon}</span>
              <span className="flex-1">{n.label}</span>
              {'phase' in n && <span className="text-[10px] text-slate-400">P{n.phase}</span>}
            </NavLink>
          ))}
        </nav>
      </aside>
      {menuOpen && <div className="fixed inset-0 z-20 bg-black/30 lg:hidden" onClick={() => setMenuOpen(false)} />}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-slate-200 bg-white/95 px-4 py-2.5 backdrop-blur">
          <button type="button" className="rounded p-1.5 text-slate-600 hover:bg-slate-100 lg:hidden" onClick={() => setMenuOpen(true)} aria-label="Open menu">☰</button>
          <GlobalSearch />
          <div className="ml-auto flex items-center gap-3 text-sm">
            {settings && (
              <span className="hidden rounded bg-gold-soft px-2 py-1 text-xs font-medium text-ink md:inline">
                Snapshot: {formatWindow(settings.snapshotStartMonth, settings.snapshotMonths)}
              </span>
            )}
            <span className="hidden text-slate-500 sm:inline">{user?.email}</span>
            <button type="button" onClick={() => void logout()} className="rounded px-2 py-1 text-slate-600 hover:bg-slate-100">Sign out</button>
          </div>
        </header>
        {!isProduction && (
          <div className="bg-amber-400 px-6 py-1.5 text-center text-xs font-semibold tracking-wide text-amber-950">
            DEVELOPMENT ENVIRONMENT · {usingEmulators ? 'local emulators' : `project ${projectId}`} · not production data{buildRef ? ` · build ${buildRef}` : ''}
          </div>
        )}
        {error && <div className="bg-red-50 px-6 py-2 text-sm text-red-700">Data error: {error}</div>}
        <main className="flex-1 px-4 py-6 sm:px-6">{children}</main>
        <Footer />
      </div>
    </div>
  );
}
