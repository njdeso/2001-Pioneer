import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { valueBuyout, settleBuyout, type BuyoutPolicy } from '../src/buyout/engine.ts';
import type { BrokerAdvance } from '../src/buyout/advances.ts';
import { buyoutInputsCanonical, canTransition, isImmutable, SNAPSHOT_STATES, type BuyoutSnapshot, type SnapshotPolicyRow } from '../src/buyout/snapshot.ts';
import { brokerStatementModel, reconciliationModel, statementFileStem } from '../src/buyout/statements.ts';
import { brokerStatementPdf, money, pdfSafe, reconciliationPdf, brokerStatementXlsx } from '../src/buyout/render.ts';
import { pdfToTextLines } from '../src/pdfText.ts';

// Synthetic data only.
const brokers = [{ id: 'BA', name: 'Avery Synthetic', shareBps: 5000 }, { id: 'BZ', name: 'Zed Fictional', shareBps: 4000 }];
const P = (id: string, brokerId: string, o: Partial<BuyoutPolicy> = {}): BuyoutPolicy => ({ id, clientId: `C${id}`, carrierId: 'K1', policyNumber: `POL-${id}`, brokerId, status: 'active', effectiveDate: '2026-01-01', expirationDate: '2027-01-01', premiumCents: null, commissionRateBps: null, ...o });
const A = (id: string, policyId: string, brokerId: string, share: number, paid: number, o: Partial<BrokerAdvance> = {}): BrokerAdvance => ({
  id, policyId, clientId: `C${policyId}`, brokerId, termId: '2026-01-01', termEffectiveDate: '2026-01-01', termExpirationDate: '2027-01-01', commissionBasisCents: 100000, brokerShareBps: share,
  amountPaidCents: paid, paymentDate: '2026-01-05', paymentReference: id, paymentType: 'new_business', status: 'active', source: { kind: 'manual' }, note: '', ...o,
});
const policies = [P('1', 'BA'), P('2', 'BA', { status: 'cancelled', effectiveDate: '2025-01-01', expirationDate: '2026-01-01' }), P('3', 'BZ')];
const advances = [A('a1', '1', 'BA', 5000, 50000), A('a3', '3', 'BZ', 4000, 77777)];
const closing = '2026-03-07';

function snapshot(state: BuyoutSnapshot['state'] = 'finalized') {
  const v = valueBuyout({ closingDate: closing, policies, advances, brokers, termsByPolicy: new Map() });
  const rows: SnapshotPolicyRow[] = v.policies.map((p) => ({ ...p, clientName: `Client ${p.policyId}${p.brokerId === 'BZ' ? ' ZEDCLIENT' : ''}`, carrierName: 'Synthetic Mutual', brokerName: brokers.find((b) => b.id === p.brokerId)!.name }));
  const snap: BuyoutSnapshot = {
    id: 'SNAP1', closingDate: closing, version: 3, state, engineVersion: v.engineVersion, rules: v.rules, inputFingerprint: 'f'.repeat(64),
    brokers: v.brokers, totals: v.totals, checks: v.checks, finalizable: v.finalizable, blockers: v.blockers, adjustments: [], brokerDirectory: brokers,
    policyCount: rows.length, note: 'test', agencyName: 'Synthetic Agency', history: [{ at: '2026-11-10T12:00:00Z', by: 'owner@example.test', from: null, to: 'draft', note: 'created' }],
  };
  return { snap, rows, v };
}

test('broker statement contains ONLY that broker’s records — no other broker, client, figures or grand totals', () => {
  const { snap, rows } = snapshot();
  const m = brokerStatementModel(snap, rows, 'BA', '2026-11-10T12:00:00Z');
  const json = JSON.stringify(m);
  for (const leak of ['Zed Fictional', 'BZ', 'ZEDCLIENT', 'POL-3', '77777']) assert.ok(!json.includes(leak), `statement leaks ${leak}`);
  assert.ok(!('totals' in m) && !('brokers' in m), 'no grand totals or broker list');
  assert.equal(m.policies.length, 1);
  assert.equal(m.policies[0].netContributionCents, 33904);
  assert.deepEqual(m.excluded.map((e) => e.policyNumber), ['POL-2'], 'own cancelled policy listed as not included');
  assert.equal(m.summary.finalNetCents, 33904);
  assert.equal(m.schedule.reduce((s, i) => s + i.amountCents, 0), 33904);
  assert.equal(m.final, true);
  assert.equal(m.watermark, null);
  assert.match(m.acknowledgment, /not itself a binding agreement/);
  assert.ok(m.methodology.some((s) => /1\.5/.test(s)) && m.methodology.some((s) => /no(t)? clawed back|not clawed back/i.test(s)));
  assert.throws(() => brokerStatementModel(snap, rows, 'NOPE', ''), /no settlement/);
});

test('non-final versions are watermarked; file names say DRAFT', () => {
  for (const [state, mark] of [['draft', /DRAFT/], ['reviewed', /DRAFT/], ['superseded', /SUPERSEDED/], ['discarded', /DISCARDED/]] as const) {
    const { snap, rows } = snapshot(state);
    const m = brokerStatementModel(snap, rows, 'BA', '2026-11-10T00:00:00Z');
    assert.match(m.watermark ?? '', mark);
    assert.equal(m.final, false);
  }
  assert.equal(statementFileStem({ brokerName: 'Avery Synthetic', closingDate: closing, version: 3, final: false }), 'Avery-Synthetic-buyout-2026-03-07-v3-DRAFT');
  assert.equal(statementFileStem({ kind: 'reconciliation', closingDate: closing, version: 3, final: true }), 'INTERNAL-reconciliation-buyout-2026-03-07-v3');
});

test('reconciliation model covers every policy, broker, exclusion and check', () => {
  const { snap, rows } = snapshot();
  const r = reconciliationModel(snap, rows, '2026-11-10T00:00:00Z');
  assert.equal(r.internal, true);
  assert.equal(r.policies.length + r.excluded.length, rows.length);
  assert.deepEqual(r.brokers.map((b) => b.brokerName), ['Avery Synthetic', 'Zed Fictional']);
  assert.equal(r.brokers.reduce((s, b) => s + b.finalNetCents, 0), r.totals.finalNetCents);
  assert.equal(r.checks.length, snap.checks.length);
  assert.equal(r.history.length, 1);
});

test('PDF statements: valid PDF, broker’s own data present, other broker absent, WinAnsi-safe text', async () => {
  const { snap, rows } = snapshot('draft');
  const bytes = await brokerStatementPdf(brokerStatementModel(snap, rows, 'BA', '2026-11-10T12:00:00Z'));
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), '%PDF-');
  const text = (await pdfToTextLines(bytes)).pages.flat().join('\n');
  for (const want of ['Broker Buyout Settlement Statement', 'Avery Synthetic', '$339.04', '$750.00', '$410.96', '2027-03-07', 'POL-1', 'POL-2', 'DRAFT', 'not itself a binding agreement']) assert.ok(text.includes(want), `missing ${want}`);
  for (const leak of ['Zed Fictional', 'POL-3', 'ZEDCLIENT']) assert.ok(!text.includes(leak), `leaks ${leak}`);
  const rec = await reconciliationPdf(reconciliationModel(snap, rows, '2026-11-10T12:00:00Z'));
  const rtext = (await pdfToTextLines(rec)).pages.flat().join('\n');
  for (const want of ['INTERNAL - OWNER ONLY', 'Zed Fictional', 'Avery Synthetic', 'POL-3', 'PASS']) assert.ok(rtext.includes(want), `reconciliation missing ${want}`);
  assert.equal(pdfSafe('a → b − c ≤ d Σ'), 'a -> b - c <= d Sum ');
  assert.equal(pdfSafe('日本'), '??');
  assert.deepEqual([money(33904), money(-1), money(123456789), money(0)], ['$339.04', '-$0.01', '$1,234,567.89', '$0.00']);
});

test('Excel statement opens and holds only that broker’s policies', async (t) => {
  let ExcelJS: any; try { const mod: any = await import('exceljs'); ExcelJS = mod.default ?? mod; } catch { t.skip('exceljs is not installed in this environment'); return; }
  const { snap, rows } = snapshot();
  const bytes = await brokerStatementXlsx(brokerStatementModel(snap, rows, 'BA', '2026-11-10T00:00:00Z'));
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(bytes);
  assert.deepEqual(wb.worksheets.map((w: any) => w.name), ['Statement', 'Policies', 'Not included', 'Methodology']);
  const pol = wb.getWorksheet('Policies'); assert.equal(pol.rowCount, 2);
  assert.equal(pol.getRow(2).getCell(16).value, 339.04);
  let all = ''; wb.eachSheet((ws: any) => ws.eachRow((r: any) => { all += JSON.stringify(r.values); }));
  assert.ok(!all.includes('Zed Fictional') && !all.includes('POL-3'));
});

test('snapshot states: only the allowed transitions; finalized/superseded/discarded are immutable', () => {
  const allowed = SNAPSHOT_STATES.flatMap((f) => SNAPSHOT_STATES.filter((t) => canTransition(f, t)).map((t) => `${f}>${t}`));
  assert.deepEqual(allowed.sort(), ['draft>discarded', 'draft>reviewed', 'reviewed>discarded', 'reviewed>draft', 'reviewed>finalized'].sort());
  assert.ok(isImmutable('finalized') && isImmutable('superseded') && isImmutable('discarded') && !isImmutable('draft'));
});

test('input fingerprint changes with any calculation input, not with notes', () => {
  const base = { closingDate: closing, rules: valueBuyout({ closingDate: closing, policies: [], advances: [], brokers, termsByPolicy: new Map() }).rules, policies, termsByPolicy: new Map(), brokers, advances, carrierRates: { K1: null } };
  const c0 = buyoutInputsCanonical(base);
  assert.equal(buyoutInputsCanonical({ ...base, advances: advances.map((a) => ({ ...a, note: 'changed note' })) }), c0);
  assert.equal(buyoutInputsCanonical({ ...base, policies: [...policies].reverse() }), c0, 'order-independent');
  for (const changed of [
    { ...base, advances: [{ ...advances[0], amountPaidCents: 50001 }, advances[1]] },
    { ...base, advances: [{ ...advances[0], status: 'voided' as const }, advances[1]] },
    { ...base, brokers: [{ ...brokers[0], shareBps: 5100 }, brokers[1]] },
    { ...base, policies: [{ ...policies[0], brokerId: 'BZ' }, ...policies.slice(1)] },
    { ...base, termsByPolicy: new Map([['1', [{ id: '2026-01-01', policyId: '1', effectiveDate: '2026-01-01', scheduledExpirationDate: '2027-01-01', cancellationDate: null, status: 'active' as const, note: '' }]]]) },
    { ...base, closingDate: '2026-03-08' },
  ]) assert.notEqual(buyoutInputsCanonical(changed), c0);
});

test('re-settling stored rows with no adjustments reproduces the snapshot exactly', () => {
  const { v } = snapshot();
  const again = settleBuyout({ closingDate: closing, rules: v.rules, policies: v.policies, brokers, adjustments: [], expectedPolicyCount: v.policies.length });
  assert.deepEqual(again.brokers, v.brokers);
  assert.deepEqual(again.totals, v.totals);
  assert.ok(!again.checks.some((c) => !c.pass));
});

test('isolation: Pioneer / due-diligence code never reads broker-buyout or advance data', () => {
  const root = join(import.meta.dirname, '..', '..', '..');
  const files = [
    ...readdirSync(join(root, 'packages/shared/src/reports')).map((f) => join(root, 'packages/shared/src/reports', f)),
    join(root, 'apps/admin/src/pages/DueDiligence.tsx'), join(root, 'apps/admin/src/pages/Ledger.tsx'), join(root, 'apps/admin/src/pages/Dashboard.tsx'),
  ];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!/buyout|brokerAdvance|advanceImport/i.test(src), `${f} references broker-buyout data`);
  }
  // And the buyout engine never reads the ledger.
  const engine = readFileSync(join(root, 'packages/shared/src/buyout/engine.ts'), 'utf8');
  assert.ok(!/from '\.\.\/(aggregate|reports\/)|LedgerEntry/.test(engine));
  const fn = readFileSync(join(root, 'functions/src/callables/buyout.ts'), 'utf8');
  assert.ok(!/collection\('(ledger|statements)'\)/.test(fn), 'buyout callables never touch the ledger or statements');
});
