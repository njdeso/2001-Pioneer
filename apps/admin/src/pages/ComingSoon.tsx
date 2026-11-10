import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { NAV } from '../layout';
import { Card, PageHeader } from '../ui';

const A = ({ to, children }: { to: string; children: ReactNode }) => <Link to={to} className="font-medium text-ink underline">{children}</Link>;

/** What is planned for each later-phase section, and where the working parts already live. */
const SECTIONS: Record<string, { planned: string; availableNow?: ReactNode }> = {
  '/reconciliation': {
    planned: 'A carrier × month completeness grid (which statements are in, missing or late), discrepancy corrections and approved overrides, and resolving suspense entries.',
    availableNow: (
      <>
        Balancing each statement to $0.00, matching lines to policies, approval, posting to the ledger and reversal are already built.
        Open a statement from <A to="/queue">AI Processing Queue</A> to use them. Posted results are in the <A to="/ledger">Ledger</A>.
      </>
    ),
  },
  '/reports': {
    planned: 'Formatted financial reports (by carrier, broker, line of business and month, year-over-year) with PDF and Excel export.',
    availableNow: (
      <>
        Financial reporting from the posted ledger is available now. The <A to="/">Dashboard</A> shows the trailing-12-month commission, broker share, agency net and monthly totals.
        The <A to="/ledger">Ledger</A> lists every posted transaction and reversal, with filters, net totals and CSV export for accounting and due diligence.
      </>
    ),
  },
  '/valuation': { planned: 'Book valuation on T12 commission with adjustable multiples and saved scenarios.' },
  '/package': { planned: 'Lock the snapshot and export the due-diligence package (PDF + Excel + statement copies). Broker information is never included.' },
};

export function ComingSoonPage() {
  const { pathname } = useLocation();
  const item = NAV.find((n) => n.to === pathname);
  if (!item || !('phase' in item)) {
    return <PageHeader title="Page not found" />;
  }
  const s = SECTIONS[item.to];
  return (
    <div className="space-y-4">
      <PageHeader title={item.label} subtitle={`Planned for Phase ${item.phase}`} />
      {s?.availableNow && (
        <Card title="Available now">
          <p className="text-sm text-slate-700">{s.availableNow}</p>
        </Card>
      )}
      <Card title="Still to come">
        <p className="text-sm text-slate-600">{s?.planned}</p>
        <p className="mt-3 text-xs text-slate-400">This page itself is not built yet; it is listed so the navigation matches the approved plan.</p>
      </Card>
    </div>
  );
}
