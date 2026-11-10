#!/usr/bin/env -S npx tsx
// READ-ONLY diagnostics of statements in the DEVELOPMENT project (pioneer-2001-dev).
//
//   npx tsx scripts/diagnose-dev.mts dev            (run by the dev workflow in "diagnose" mode)
//
// For every statement paid by DIAG_PAYER (default: the synthetic Mutual carrier) and for DIAG_STATEMENTS
// (comma-separated IDs), it reports what approveStatement would see: the statement fields, whether the
// payer, duplicate-of statement, matched policies, their clients and brokers exist, and the result of
// the same postingReadiness() and buildPostingPlan() calls the function makes.
//
// It NEVER writes, deploys or seeds. All access goes through the get()-only reader below;
// scripts/audit-dev-ledger.test.mjs fails CI if a write call appears in this file. No email addresses
// are printed (the workflow summary of this public repository is visible).
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { buildPostingPlan, postingReadiness, type PostingLine, type PostingStatement } from '@asm/shared';
import { assertDevAlias, assertDevProjectNumber, NotDevError } from './lib/dev-guard.mjs';

const alias = process.argv[2] ?? 'dev';
const PAYER = process.env.DIAG_PAYER || 'SYN3B-MUTUAL';
const EXTRA = (process.env.DIAG_STATEMENTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

let projectId: string;
try {
  projectId = assertDevAlias(alias);
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credPath && existsSync(credPath) && JSON.parse(readFileSync(credPath, 'utf8')).type === 'service_account') {
    throw new NotDevError('Refusing: a downloaded service-account key was supplied; diagnostics run only with keyless credentials.');
  }
  const credential = process.env.FIRESTORE_EMULATOR_HOST ? null : applicationDefault();
  await assertDevProjectNumber(projectId, async () => (await credential!.getAccessToken()).access_token);
  initializeApp(credential ? { credential, projectId } : { projectId });
} catch (e) {
  console.error(e instanceof NotDevError ? e.message : `Refusing to run diagnostics: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}

/** The ONLY database access in this script: reads. */
function reader(db: Firestore) {
  return {
    async all<T>(name: string): Promise<(T & { id: string })[]> {
      const snap = await db.collection(name).get();
      return snap.docs.map((d) => ({ ...(d.data() as T), id: d.id }));
    },
    async sub<T>(path: string, name: string): Promise<(T & { id: string })[]> {
      const snap = await db.doc(path).collection(name).get();
      return snap.docs.map((d) => ({ ...(d.data() as T), id: d.id }));
    },
  };
}
const read = reader(getFirestore());

type Doc = Record<string, unknown> & { id: string };
const [statements, carriers, policies, clients, brokers] = await Promise.all(
  ['statements', 'carriers', 'policies', 'clients', 'brokers'].map((c) => read.all<Record<string, unknown>>(c)),
) as Doc[][];
const has = (rows: Doc[]) => { const s = new Set(rows.map((r) => r.id)); return (id: unknown) => typeof id === 'string' && s.has(id); };
const carrierExists = has(carriers), policyExists = has(policies), clientExists = has(clients), brokerExists = has(brokers), statementExists = has(statements);
const policyById = new Map(policies.map((p) => [p.id, p]));

const out: string[] = [];
const md = (s = '') => out.push(s);
const noEmail = (v: unknown) => JSON.stringify(v ?? null).replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>');
md(`### Statement diagnostics (read-only) — ${projectId}`);
md();
const targets = statements.filter((s) => s.payerId === PAYER || EXTRA.includes(s.id)).sort((a, b) => a.id.localeCompare(b.id));
md(`${targets.length} statement(s) paid by \`${PAYER}\`${EXTRA.length ? ` or listed (${EXTRA.join(', ')})` : ''}. Payer record exists: ${carrierExists(PAYER) ? 'yes' : '**NO**'}.`);
for (const id of EXTRA) if (!statementExists(id)) md(`- **Statement \`${id}\` does not exist.**`);
md();

for (const s of targets) {
  const lines = await read.sub<Record<string, unknown>>(`statements/${s.id}`, 'lines');
  const matched = lines.filter((l) => (l.match as { policyId?: string } | undefined)?.policyId);
  const missingPolicies = matched.filter((l) => !policyExists((l.match as { policyId: string }).policyId));
  const policyProblems: string[] = [];
  for (const l of matched) {
    const p = policyById.get((l.match as { policyId: string }).policyId);
    if (!p) continue;
    if (!clientExists(p.clientId)) policyProblems.push(`policy ${p.id}: client ${String(p.clientId)} missing`);
    if (p.brokerId && p.brokerId !== 'UNASSIGNED' && !brokerExists(p.brokerId)) policyProblems.push(`policy ${p.id}: broker ${String(p.brokerId)} missing`);
  }
  const m = s.matching as Record<string, unknown> | undefined;
  const stmt: PostingStatement = {
    id: s.id, status: String(s.status), payerId: (s.payerId as string) ?? null,
    payerKind: carrierExists(s.payerId) ? ((carriers.find((c) => c.id === s.payerId)!.kind as 'carrier' | 'wholesaler') ?? null) : null,
    statementMonth: (s.statementMonth as string) ?? null, statementDate: (s.statementDate as string) ?? null,
    adjustments: Array.isArray(s.adjustments) ? (s.adjustments as PostingStatement['adjustments']) : [],
    postedCents: (s.postedCents as number) ?? 0, postingSeq: (s.postingSeq as number) ?? 0, possibleDuplicateOf: (s.possibleDuplicateOf as string) ?? null,
    matching: m ? { stale: !!m.stale, balanced: m.balanced !== false } : null,
  };
  const pl: PostingLine[] = lines.map((l) => ({
    id: l.id, lineNo: Number(l.lineNo), insuredName: String(l.insuredName ?? ''), policyNumberRaw: String(l.policyNumberRaw ?? ''),
    paidCommissionCents: typeof l.paidCommissionCents === 'number' ? l.paidCommissionCents : null,
    transactionType: l.transactionType as PostingLine['transactionType'], effectiveDate: (l.effectiveDate as string) ?? null, match: (l.match as PostingLine['match']) ?? null,
  }));
  const others = statements.filter((o) => o.id !== s.id && o.payerId === s.payerId && o.statementMonth === s.statementMonth && o.status === 'posted').map((o) => o.id);
  let readiness = '';
  let plan = '';
  try {
    const r = postingReadiness(stmt, pl, { duplicateAcknowledged: false, otherPostedSameMonth: others });
    readiness = r.ready ? 'ready' : `blocked: ${r.blockers.map((b) => b.code).join(', ')}`;
    if (r.ready) { const p = buildPostingPlan(stmt, pl, { otherPostedSameMonth: others }); plan = `${p.totals.entries} entries, ${p.totals.amountCents} cents, balanced ${p.balanced}`; }
  } catch (e) { readiness = `THREW: ${e instanceof Error ? e.message : String(e)}`; }
  md(`#### \`${s.id}\``);
  md(`- status **${String(s.status)}**, month ${String(s.statementMonth)}, file "${String(s.fileName ?? '')}", synthetic ${String(s.synthetic ?? false)}`);
  md(`- payer \`${String(s.payerId)}\` exists: ${carrierExists(s.payerId) ? 'yes' : '**NO**'}; possibleDuplicateOf ${s.possibleDuplicateOf ? `\`${String(s.possibleDuplicateOf)}\` exists: ${statementExists(s.possibleDuplicateOf) ? 'yes' : '**NO**'}` : 'none'}`);
  md(`- postedCents ${String(s.postedCents ?? 0)}, postingSeq ${String(s.postingSeq ?? 0)}, reversals ${Array.isArray(s.reversals) ? s.reversals.length : 0}, approval ${s.approval ? 'present' : 'none'}, posting ${s.posting ? 'present' : 'none'}`);
  md(`- matching ${noEmail(m ? { stale: m.stale, balanced: m.balanced, counts: m.counts, ranAt: m.ranAt ? 'set' : null } : null)}`);
  md(`- lines ${lines.length}; matched to policies ${matched.length}; matched policies missing: ${missingPolicies.length ? `**${missingPolicies.map((l) => (l.match as { policyId: string }).policyId).join(', ')}**` : 'none'}${policyProblems.length ? `; **${policyProblems.join('; ')}**` : ''}`);
  md(`- approval readiness (same check as approveStatement): **${readiness}**${plan ? `; plan ${plan}` : ''}`);
  md();
}

const text = out.join('\n');
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
