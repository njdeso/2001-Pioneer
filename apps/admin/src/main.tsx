import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import './index.css';
import { AuthProvider, useAuth } from './auth';
import { DataProvider } from './data';
import { AppLayout } from './layout';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { CarriersPage, CarrierDetailPage } from './pages/Carriers';
import { BrokersPage, BrokerDetailPage } from './pages/Brokers';
import { ClientsPage, ClientDetailPage } from './pages/Clients';
import { SettingsPage } from './pages/Settings';
import { ImportPage } from './pages/Import';
import { StatementUploadPage, StatementQueuePage, StatementReviewPage } from './pages/Statements';
import { ComingSoonPage } from './pages/ComingSoon';
import { LedgerPage } from './pages/Ledger';
import { ReportsPage } from './pages/BookExport';
import { DueDiligencePage } from './pages/DueDiligence';
import { BrokerBuyoutPage } from './pages/BrokerBuyout';
import { configMissing, previewTargetsWrongProject } from './firebase';

function Gate() {
  const { loading, user, role } = useAuth();
  if (previewTargetsWrongProject) {
    return (
      <div className="mx-auto max-w-lg p-10 text-sm">
        <h1 className="text-lg font-semibold text-red-700">Preview refused</h1>
        <p className="mt-2 text-slate-600">This preview build is not pointed at the development project (pioneer-2001-dev), so it will not connect to anything. Previews never use production.</p>
      </div>
    );
  }
  if (configMissing) {
    return (
      <div className="mx-auto max-w-lg p-10 text-sm">
        <h1 className="text-lg font-semibold text-ink">Firebase is not configured</h1>
        <p className="mt-2 text-slate-600">Copy <code>.env.example</code> to <code>apps/admin/.env.local</code> and fill in your Firebase web app settings, then restart <code>npm run dev</code>.</p>
      </div>
    );
  }
  if (loading) return <div className="p-10 text-sm text-slate-500">Loading…</div>;
  if (!user || !role) return <LoginPage />;
  return (
    <DataProvider>
      <AppLayout>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/carriers" element={<CarriersPage />} />
          <Route path="/carriers/:id" element={<CarrierDetailPage />} />
          <Route path="/brokers" element={<BrokersPage />} />
          <Route path="/brokers/:id" element={<BrokerDetailPage />} />
          <Route path="/clients" element={<ClientsPage />} />
          <Route path="/clients/:id" element={<ClientDetailPage />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/statements" element={<StatementUploadPage />} />
          <Route path="/queue" element={<StatementQueuePage />} />
          <Route path="/statements/:id" element={<StatementReviewPage />} />
          <Route path="/ledger" element={<LedgerPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/package" element={<DueDiligencePage />} />
          <Route path="/buyout" element={<BrokerBuyoutPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<ComingSoonPage />} />
        </Routes>
      </AppLayout>
    </DataProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <Gate />
      </BrowserRouter>
    </AuthProvider>
  </StrictMode>,
);
