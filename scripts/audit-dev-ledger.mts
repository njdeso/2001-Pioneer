#!/usr/bin/env -S npx tsx
// READ-ONLY balance audit of the DEVELOPMENT ledger (pioneer-2001-dev).
//
//   npx tsx scripts/audit-dev-ledger.mts            (dev project; Application Default Credentials)
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npx tsx scripts/audit-dev-ledger.mts demo-asm
//
// It reads the ledger, statements (top-level fields only), brokers, policies and settings, then runs
// the shared auditLedger() — the same code as the app's Ledger report and Dashboard — and checks:
//   - every reversal is the exact negative of its original in gross, broker and agency
//   - every reversed posting nets to zero in all three; no posting is partly reversed
//   - broker + agency = gross on every entry; amounts are whole cents
//   - each statement's status, postedCents, posting and reversal records agree with the ledger
//   - the snapshot-window totals from ledgerTotals() equal the aggregate used by the Dashboard charts
//   - the due-diligence exports (commission summary; clients & policies) pass their reconciliation checks
//     and contain no broker identifier, broker name or email address
//
// It NEVER writes to Firestore, Storage or Auth, never deploys and never seeds. All database access
// goes through the read-only `reader` below (get() calls only); scripts/audit-dev-ledger.test.mjs
// fails CI if a write method appears anywhere in this file. Output goes to local files only:
//   $AUDIT_OUT_DIR (default audit-out/): ledger-audit.json, ledger-transactions-accounting.csv,
//   ledger-postings-accounting.csv; plus a Markdown summary in $GITHUB_STEP_SUMMARY when set.
// Exit code 1 when any error-level finding exists (so the deploy workflow stops before deploying).
//
// It refuses anything but pioneer-2001-dev: by .firebaserc alias and project ID, and by the project
// NUMBER Google reports for the credentials (scripts/lib/dev-guard.mjs).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import {
  auditLedger, buildDiligenceSummary, clientPolicyExport, diligenceSummaryCsv, formatCents, groupPostings, inRange, ledgerCsv, postingsCsv, totalInWindow, windowRange,
  type AuditStatement, type DiligenceCarrier, type DiligenceClient, type DiligencePolicy, type LegacyBrokerFn, type PostingGroup, type ReportEntry,
} from '@asm/shared';
import { assertDevAlias, assertDevProjectNumber, NotDevError } from './lib/dev-guard.mjs';

const alias = process.argv[2] ?? 'dev';
const OUT = process.env.AUDIT_OUT_DIR || 'audit-out';
const FOCUS = (process.env.AUDIT_FOCUS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const LABEL = process.env.AUDIT_LABEL || 'Ledger audit (read-only)';

let projectId: string;
try {
  projectId = assertDevAlias(alias);
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credPath && existsSync(credPath) && JSON.parse(readFileSync(credPath, 'utf8')).type === 'service_account') {
    throw new NotDevError('Refusing: a downloaded service-account key was supplied; the audit runs only with keyless credentials.');
  }
  const credential = process.env.FIRESTORE_EMULATOR_HOST ? null : applicationDefault();
  await assertDevProjectNumber(projectId, async () => (await credential!.getAccessToken()).access_token);
  initializeApp(credential ? { credential, projectId } : { projectId });
} catch (e) {
  console.error(e instanceof NotDevError ? e.message : `Refusing to audit: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}

/** The ONLY database access in this script: whole-collection and single-document reads. */
function reader(db: Firestore) {
  return {
    async all<T>(name: string): Promise<(T & { id: string })[]> {
      const snap = await db.collection(name).get();
      return snap.docs.map((d) => ({ ...(d.data() as T), id: d.id }));
    },
    async one<T>(path: string): Promise<T | null> {
      const snap = await db.doc(path).get();
      return snap.exists ? (snap.data() as T) : null;
    },
  };
}
const read = reader(getFirestore());

type Ts = { toDate?: () => Date } | null | undefined;
const iso = (t: Ts) => (t && typeof t.toDate === 'function' ? t.toDate().toISOString() : null);

const [rawLedger, rawStatements, brokers, policies, settings, clients, carriers] = await Promise.all([
  read.all<Record<string, unknown> & { postedAt?: Ts }>('ledger'),
  read.all<Record<string, unknown>>('statements'),
  read.all<{ shareBps: number; name?: string; code?: string }>('brokers'),
  read.all<{ brokerId?: string } & Record<string, unknown>>('policies'),
  read.one<{ snapshotStartMonth?: string; snapshotMonths?: number; agencyName?: string }>('settings/app'),
  read.all<Record<string, unknown>>('clients'),
  read.all<Record<string, unknown>>('carriers'),
]);

const entries: ReportEntry[] = rawLedger.map((e) => ({ ...(e as unknown as ReportEntry), postedAtIso: iso(e.postedAt) }));
const statements: AuditStatement[] = rawStatements.map((s) => ({
  id: s.id, status: String(s.status ?? ''), postedCents: (s.postedCents as number | undefined) ?? 0,
  posting: (s.posting as AuditStatement['posting']) ?? null, reversals: (s.reversals as AuditStatement['reversals']) ?? [],
}));
const brokerById = new Map(brokers.map((b) => [b.id, b]));
const policyBroker = new Map(policies.map((p) => [p.id, p.brokerId || 'UNASSIGNED']));
const legacyBroker: LegacyBrokerFn = (e) => {
  const b = e.policyId ? brokerById.get(policyBroker.get(e.policyId) ?? 'UNASSIGNED') : undefined;
  return b ? { brokerId: b.id, shareBps: b.shareBps } : null;
};
const window = settings?.snapshotStartMonth ? windowRange(settings.snapshotStartMonth, settings.snapshotMonths ?? 12) : null;

const result = auditLedger({ entries, statements, window, legacyBroker });
// Cross-check: the window total from ledgerTotals (Dashboard cards, Ledger report) must equal the
// aggregate used by the Dashboard's charts.
if (window && settings?.snapshotStartMonth) {
  const agg = totalInWindow(entries.filter((e) => inRange(e, window)), settings.snapshotStartMonth, settings.snapshotMonths ?? 12);
  if (agg !== result.window!.totals.grossCents) {
    result.findings.push({ severity: 'error', code: 'window_total_mismatch', message: `Window total ${result.window!.totals.grossCents} (ledgerTotals) ≠ ${agg} (totalInWindow).`, ids: [] });
    result.errors++; result.ok = false;
  }
}

// Due-diligence exports, built from the same data with the same code as the app's Due Diligence page.
// Their checks must pass, and neither file may contain any broker identifier, broker name or email.
const dd = buildDiligenceSummary({
  entries, start: settings?.snapshotStartMonth, months: settings?.snapshotMonths ?? 12,
  carriers: carriers as unknown as DiligenceCarrier[], policies: policies as unknown as DiligencePolicy[],
  statements: rawStatements.map((x) => ({ id: x.id, status: String(x.status ?? ''), statementMonth: (x.statementMonth as string) ?? null, payerId: (x.payerId as string) ?? null })),
});
const ddCp = clientPolicyExport({
  clients: clients as unknown as DiligenceClient[], policies: policies as unknown as DiligencePolicy[], carriers: carriers as unknown as DiligenceCarrier[],
  entries, start: settings?.snapshotStartMonth, months: settings?.snapshotMonths ?? 12, policyAttributedCents: dd.policyAttributedCents,
});
const ddSummaryCsv = diligenceSummaryCsv(dd, { agencyName: settings?.agencyName ?? 'Agency', preparedAtIso: new Date().toISOString() });
const brokerMarkers = brokers.flatMap((b) => [b.id, b.name, b.code]).filter((x): x is string => !!x && x !== 'UNASSIGNED' && x !== 'Unassigned' && x.length >= 3);
for (const [label, csv] of [['commission summary', ddSummaryCsv], ['clients & policies', ddCp.csv]] as const) {
  // Whole-cell match, so a broker named "Jim" does not match the wholesaler "Jimcor".
  const cells = new Set(csv.replace(/^\uFEFF/, '').split(/\r\n/).flatMap((l) => l.split(',')).map((c) => c.replace(/^"|"$/g, '').trim()));
  const leaks = [...brokerMarkers.filter((m) => cells.has(m)), ...(csv.includes('@') ? ['an email address'] : [])];
  if (leaks.length) { result.findings.push({ severity: 'error', code: 'diligence_export_leak', message: `The ${label} export contains broker or staff information: ${leaks.slice(0, 5).join(', ')}.`, ids: [] }); result.errors++; result.ok = false; }
}
for (const c of [...(dd.status === 'NO_PERIOD' ? [] : dd.checks), ...ddCp.checks]) {
  if (!c.pass) { result.findings.push({ severity: 'error', code: 'diligence_check_failed', message: `Due-diligence check failed: ${c.name} (${c.detail}).`, ids: [] }); result.errors++; result.ok = false; }
}

// Optional read-only period override (AUDIT_DD_START=YYYY-MM): the same summary for another 12 months,
// computed without changing Settings.
const ddStart = process.env.AUDIT_DD_START?.trim() || '';
const ddOverride = /^\d{4}-(0[1-9]|1[0-2])$/.test(ddStart)
  ? buildDiligenceSummary({
    entries, start: ddStart, months: 12,
    carriers: carriers as unknown as DiligenceCarrier[], policies: policies as unknown as DiligencePolicy[],
    statements: rawStatements.map((x) => ({ id: x.id, status: String(x.status ?? ''), statementMonth: (x.statementMonth as string) ?? null, payerId: (x.payerId as string) ?? null })),
  })
  : null;
if (ddOverride) for (const c of ddOverride.checks) {
  if (!c.pass) { result.findings.push({ severity: 'error', code: 'diligence_check_failed', message: `Due-diligence check failed for ${ddStart}: ${c.name} (${c.detail}).`, ids: [] }); result.errors++; result.ok = false; }
}

// ---------------------------------------------------------------- output (local files only)
const $ = (c: number) => formatCents(c);
const lines: string[] = [];
const md = (s = '') => lines.push(s);
md(`### ${LABEL} — ${projectId}`);
md();
md(`Read-only: no writes, no deploy, no seeding. ${new Date().toISOString()}`);
md();
md(`**${result.ok ? '✅ Balanced' : '❌ Problems found'}** — ${result.errors} error(s), ${result.warnings} warning(s).`);
md();
md('| | Count |');
md('|---|---|');
md(`| Ledger entries | ${result.counts.entries} (${result.counts.originals} original, ${result.counts.reversals} reversal) |`);
md(`| Postings | ${result.counts.postings} (${result.counts.activePostings} active, ${result.counts.reversedPostings} reversed) |`);
md(`| Statements checked | ${result.counts.statements} |`);
md();
md(`All entries: gross ${$(result.totals.grossCents)}, broker ${$(result.totals.brokerCents)}, agency ${$(result.totals.agencyCents)}.`);
if (result.window) md(`Snapshot window ${result.window.from} – ${result.window.to} (what the Dashboard shows): gross ${$(result.window.totals.grossCents)}, broker ${$(result.window.totals.brokerCents)}, agency ${$(result.window.totals.agencyCents)}.`);
else md('No snapshot window is set in Settings.');
md();

const focus = (g: PostingGroup) => FOCUS.length === 0 || FOCUS.some((f) => (g.postingId ?? g.key).startsWith(f) || (g.statementId ?? '').startsWith(f));
const shown = result.postings.filter(focus);
md(`#### Postings${FOCUS.length ? ` matching ${FOCUS.join(', ')}` : ''}`);
md();
md('| Posting | State | Original gross / broker / agency | Reversal gross / broker / agency | Net gross / broker / agency |');
md('|---|---|---|---|---|');
for (const g of shown) {
  const t = (x: PostingGroup['net']) => `${$(x.grossCents)} / ${$(x.brokerCents)} / ${$(x.agencyCents)}`;
  const zero = g.net.grossCents === 0 && g.net.brokerCents === 0 && g.net.agencyCents === 0;
  md(`| \`${g.postingId ?? g.key}\` | ${g.state}${g.state === 'reversed' ? (zero ? ' ✅' : ' ❌') : ''} | ${t(g.original)} | ${g.reversal.entries ? t(g.reversal) : '—'} | ${t(g.net)} |`);
}
if (!shown.length) md('| (none) | | | | |');
md();
md('#### Due-diligence exports (same code as the app)');
md();
md(`Commission summary: **${dd.statusLabel}**. ${dd.statusText}`);
md();
md(`Period ${dd.from} – ${dd.to}: total ${$(dd.total.total)} (matched ${$(dd.total.commission)}, unmatched ${$(dd.total.unmatched)}, adjustments ${$(dd.total.adjustment)}, retained ${$(dd.total.retained)}, manual ${$(dd.total.manual)}); months with posted statements ${dd.byMonth.filter((m) => m.hasPostedStatement).length} of ${dd.months.length}.`);
md();
md(`Clients & policies: ${ddCp.policyRows} policies, ${ddCp.clientsWithoutPolicies} clients without policies, ${ddCp.rows} rows.`);
md();
md('| Check | Result |');
md('|---|---|');
for (const c of [...dd.checks, ...ddCp.checks]) md(`| ${c.name} | ${c.pass ? '✅' : '❌'} ${c.detail.replace(/\|/g, '/')} |`);
md(`| No broker identifiers, broker names or email addresses in either export | ${result.findings.some((f) => f.code === 'diligence_export_leak') ? '❌' : '✅'} |`);
md();
if (ddOverride) {
  md(`#### Due-diligence summary for ${ddOverride.from} – ${ddOverride.to} (read-only period override; Settings unchanged)`);
  md();
  md(`**${ddOverride.statusLabel}**. Total ${$(ddOverride.total.total)} (matched ${$(ddOverride.total.commission)}, unmatched ${$(ddOverride.total.unmatched)}, adjustments ${$(ddOverride.total.adjustment)}, retained ${$(ddOverride.total.retained)}); months with posted statements ${ddOverride.byMonth.filter((m) => m.hasPostedStatement).length} of ${ddOverride.months.length}.`);
  md();
  md('| Month | Total | Posted statements |');
  md('|---|---|---|');
  for (const m of ddOverride.byMonth) if (m.totals.total !== 0 || m.hasPostedStatement) md(`| ${m.month} | ${$(m.totals.total)} | ${m.statementPostings} |`);
  md();
  md(`Checks: ${ddOverride.checks.filter((c) => c.pass).length} of ${ddOverride.checks.length} pass${ddOverride.checks.some((c) => !c.pass) ? ` — FAILED: ${ddOverride.checks.filter((c) => !c.pass).map((c) => c.name).join('; ')}` : ''}.`);
  md();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `due-diligence-commission-summary-${ddOverride.from}.csv`), diligenceSummaryCsv(ddOverride, { agencyName: settings?.agencyName ?? 'Agency', preparedAtIso: new Date().toISOString() }));
}
if (result.findings.length) {
  md('#### Findings');
  md();
  for (const f of result.findings) md(`- ${f.severity === 'error' ? '❌' : '⚠️'} \`${f.code}\` ${f.message}`);
  md();
}

// Files may be uploaded as workflow artifacts of a public repository: no email addresses in them.
const noEmail = entries.map(({ postedByEmail: _e, ...rest }) => rest as ReportEntry);
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'ledger-audit.json'), JSON.stringify({
  projectId, at: new Date().toISOString(), ok: result.ok, errors: result.errors, warnings: result.warnings, counts: result.counts,
  totals: result.totals, window: result.window, findings: result.findings,
  postings: result.postings.map(({ originals: _o, reversals: _r, postedByEmail: _p, reversedByEmail: _q, ...g }) => g),
}, null, 2));
writeFileSync(join(OUT, 'ledger-transactions-accounting.csv'), ledgerCsv(noEmail, 'accounting', {}, legacyBroker));
writeFileSync(join(OUT, 'ledger-postings-accounting.csv'), postingsCsv(groupPostings(noEmail, legacyBroker), 'accounting'));
writeFileSync(join(OUT, 'due-diligence-commission-summary.csv'), ddSummaryCsv);
writeFileSync(join(OUT, 'due-diligence-clients-and-policies.csv'), ddCp.csv);

const text = lines.join('\n');
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
process.exit(result.ok ? 0 : 1);
