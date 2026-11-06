import { useLocation } from 'react-router';
import { NAV } from '../layout';
import { Card, PageHeader } from '../ui';

const DESCRIPTIONS: Record<string, string> = {
  '/statements': 'Drag and drop the 12 months of carrier and wholesaler statements, plus Lancer bind documents. Duplicate files are rejected by fingerprint.',
  '/queue': 'Track each statement through AI extraction and validation, then review extracted lines beside the original document.',
  '/reconciliation': 'Balance every statement to $0.00, resolve unmatched lines, approve exceptions, and post to the ledger. Includes the carrier × month completeness grid.',
  '/reports': 'All financial reports with filters and PDF / Excel / CSV export, each tied to the posted ledger.',
  '/valuation': 'Book valuation on T12 commission with adjustable multiples and saved scenarios.',
  '/package': 'Lock the snapshot and export the due-diligence package (PDF + Excel + statement copies). Broker information is never included.',
};

export function ComingSoonPage() {
  const { pathname } = useLocation();
  const item = NAV.find((n) => n.to === pathname);
  if (!item || !('phase' in item)) {
    return <PageHeader title="Page not found" />;
  }
  return (
    <div>
      <PageHeader title={item.label} subtitle={`Built in Phase ${item.phase}`} />
      <Card>
        <p className="text-sm text-slate-600">{DESCRIPTIONS[item.to]}</p>
        <p className="mt-3 text-xs text-slate-400">This section is not built yet. It is listed so the navigation matches the approved plan.</p>
      </Card>
    </div>
  );
}
