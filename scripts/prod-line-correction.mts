// ONE-TIME Personal/Commercial correction for the Agency Sale Manager (2001-Pioneer).
//
// Source of truth: each policy's line of business (the "Policy type" field). See
// packages/shared/src/lineOfBusiness.ts for the rules, and docs/LINE-CLASSIFICATION-CORRECTION.md for the
// full procedure (backup, preview, approval, apply, verification, rollback).
//
// Run in a NEW, empty folder (e.g. ~/pioneer-release/line-correction-2026-11), signed in with gcloud:
//
//   node ~/2001-pioneer/scripts/prod-line-correction.mts preview  [--project pioneer-285cf] [--overrides lob-overrides.json]
//                                                                  [--evidence statement|none|KIND,KIND…]
//   node ~/2001-pioneer/scripts/prod-line-correction.mts apply    PREVIEW_FOLDER
//   node ~/2001-pioneer/scripts/prod-line-correction.mts verify   PREVIEW_FOLDER
//   node ~/2001-pioneer/scripts/prod-line-correction.mts rollback PREVIEW_FOLDER
//
// (Node 22.18+ runs .mts directly; on older Node 22 add --experimental-strip-types after `node`.)
//
// What each mode may do:
//   preview   READ-ONLY. Reads every client and policy (all statuses), the statements and their matched lines
//             (evidence for ambiguous lines of business such as "Auto"), writes a full backup of both collections,
//             the plan (plan.json, sealed with a SHA-256 hash) and the preview reports to a new local folder.
//   apply     Asks you to type the confirmation shown. Re-reads every affected record and saves it again
//             (apply-backup.json) BEFORE writing. Creates maintenance/line-correction-2026-11 with "must not
//             exist", so it can run only once. Changes ONLY policies.line and clients.classification (plus
//             updatedAt/updatedBy), each with a precondition that the record is unchanged since the preview;
//             anything edited in between is skipped and reported. One audit-log entry per changed record,
//             in the same commit as the change. Then verifies.
//   verify    READ-ONLY. Every applied record holds its new value; every other field of every affected
//             record is identical to the backup; record counts are unchanged.
//   rollback  Asks for confirmation. Restores the previous value only on records that still hold the corrected
//             value and have not been written since; writes an audit entry per restore.
//
// Output never includes broker names, IDs or shares in the preview/report files. The backup files are full
// records (they include broker fields): keep them in Cloud Shell, never send them to Pioneer or reviewers.
// Application logs print counts and IDs only.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import {
  CORRECTION_FIELDS, DEFAULT_EVIDENCE, EVIDENCE_KINDS, EVIDENCE_LABELS, classifyLineOfBusiness, normalizeLob, planLineCorrection, planLineRollback,
  type AppliedChange, type CorrectionPlan, type EvidenceKind, type EvidenceSignal, type Line, type LobOverrides,
} from '../packages/shared/src/lineOfBusiness.ts';

export const RUN_ID = 'line-correction-2026-11';
export const MARKER_PATH = `maintenance/${RUN_ID}`;
export const MAINT_ACTOR = `maintenance:${RUN_ID}`;
/** PR #25's marker: reported if present (that script must not also have run). */
const OTHER_MARKERS = ['maintenance/client-classification-2026-11'];
const PROJECTS: Record<string, string> = { 'pioneer-285cf': '933119340508', 'pioneer-2001-dev': '994437988131' };
const CHUNK = 200; // changes per commit (each change = 2 writes: the record + its audit entry; limit 500)

// ------------------------------------------------------------------------------------------------ plumbing

type FsValue = Record<string, unknown>;
export interface FsDoc { name: string; fields?: Record<string, FsValue>; createTime?: string; updateTime?: string }

export interface Deps {
  fetch: typeof fetch;
  token: () => string;
  account: () => string;
  ask: (question: string) => Promise<string>;
  log: (line: string) => void;
  cwd: string;
  now: () => Date;
  emulatorHost?: string;
  /** Changes per commit (tests use a small value). */
  chunk?: number;
}

class Refusal extends Error {}

function defaultDeps(): Deps {
  const gcloud = (args: string[]) => {
    const win = process.platform === 'win32';
    return execFileSync(win ? 'gcloud.cmd' : 'gcloud', args, { encoding: 'utf8', shell: win }).trim();
  };
  let tok: string | null = null;
  return {
    fetch: globalThis.fetch,
    token: () => (tok ??= process.env.FIRESTORE_EMULATOR_HOST ? 'owner' : gcloud(['auth', 'print-access-token'])),
    account: () => (process.env.FIRESTORE_EMULATOR_HOST ? 'emulator@example.test' : gcloud(['config', 'get-value', 'account'])),
    ask: async (q) => { const rl = createInterface({ input: process.stdin, output: process.stdout }); try { return await rl.question(q); } finally { rl.close(); } },
    log: (l) => console.log(l),
    cwd: process.cwd(),
    now: () => new Date(),
    emulatorHost: process.env.FIRESTORE_EMULATOR_HOST,
  };
}

const sv = (v: unknown): string | null => {
  const x = v as FsValue | undefined;
  if (!x || 'nullValue' in x) return null;
  if ('stringValue' in x) return String(x.stringValue);
  if ('integerValue' in x) return String(x.integerValue);
  if ('booleanValue' in x) return String(x.booleanValue);
  return JSON.stringify(x);
};
const str = (s: string | null): FsValue => (s === null ? { nullValue: null } : { stringValue: s });
const toFields = (o: Record<string, unknown>): Record<string, FsValue> => {
  const enc = (v: unknown): FsValue => {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === 'string') return { stringValue: v };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
    return { mapValue: { fields: toFields(v as Record<string, unknown>) } };
  };
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, enc(v)]));
};
const docId = (name: string) => name.slice(name.lastIndexOf('/') + 1);

function stamp(d: Date) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); }
function sha256(s: string) { return createHash('sha256').update(s).digest('hex'); }
function csv(rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => {
    let s = v === null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // never let a spreadsheet run a value as a formula
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

class Firestore {
  readonly base: string;
  readonly root: string;
  readonly project: string;
  private d: Deps;
  // No TypeScript parameter properties here: plain `node` (type stripping) must be able to run this file.
  constructor(project: string, d: Deps) {
    this.project = project;
    this.d = d;
    this.root = `projects/${project}/databases/(default)/documents`;
    const host = d.emulatorHost ? `http://${d.emulatorHost}` : 'https://firestore.googleapis.com';
    this.base = `${host}/v1/${this.root}`;
  }
  async http(method: string, url: string, body?: unknown): Promise<{ ok: boolean; status: number; json: any }> {
    const r = await this.d.fetch(url, {
      method, headers: { authorization: `Bearer ${this.d.token()}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, json };
  }
  async must(method: string, url: string, body?: unknown) {
    const r = await this.http(method, url, body);
    if (!r.ok) throw new Error(`Firestore HTTP ${r.status} on ${method} ${url.split('/documents')[1] ?? url}: ${r.json?.error?.message ?? ''}`);
    return r.json;
  }
  /** Every document of a top-level collection, full fields, paged by document name (no index needed). */
  async readAll(collection: string, opts: { parent?: string; fields?: string[] } = {}): Promise<FsDoc[]> {
    const out: FsDoc[] = [];
    let last: string | null = null;
    const url = opts.parent ? `${this.base}/${opts.parent}:runQuery` : `${this.base}:runQuery`;
    for (;;) {
      const q: Record<string, unknown> = { from: [{ collectionId: collection }], orderBy: [{ field: { fieldPath: '__name__' } }], limit: 500 };
      if (opts.fields) q.select = { fields: opts.fields.map((fieldPath) => ({ fieldPath })) };
      if (last) q.startAt = { values: [{ referenceValue: last }], before: false };
      const res = (await this.must('POST', url, { structuredQuery: q })) as { document?: FsDoc }[];
      const page = res.filter((x) => x.document).map((x) => x.document!);
      out.push(...page);
      if (page.length < 500) return out;
      last = page[page.length - 1].name;
    }
  }
  async getMany(paths: string[]): Promise<Map<string, FsDoc | null>> {
    const out = new Map<string, FsDoc | null>();
    for (let i = 0; i < paths.length; i += 300) {
      const part = paths.slice(i, i + 300);
      const res = (await this.must('POST', `${this.base}:batchGet`, { documents: part.map((p) => `${this.root}/${p}`) })) as { found?: FsDoc; missing?: string }[];
      for (const r of res) {
        if (r.found) out.set(r.found.name.slice(this.root.length + 1), r.found);
        else if (r.missing) out.set(r.missing.slice(this.root.length + 1), null);
      }
    }
    return out;
  }
  async get(path: string): Promise<FsDoc | null> {
    const r = await this.http('GET', `${this.base}/${path}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Firestore HTTP ${r.status} reading ${path}`);
    return r.json as FsDoc;
  }
  commit(writes: unknown[]) { return this.http('POST', `${this.base}:commit`, { writes }); }
}

/** Refuse anything but the two real projects (checked by ID and by the project NUMBER Google reports) or an emulator. */
async function guardProject(project: string, d: Deps): Promise<void> {
  if (d.emulatorHost) {
    if (!/^demo-/.test(project)) throw new Refusal(`With FIRESTORE_EMULATOR_HOST set, only demo- projects are allowed (got ${project}).`);
    return;
  }
  const expected = PROJECTS[project];
  if (!expected) throw new Refusal(`Unknown project "${project}". Allowed: ${Object.keys(PROJECTS).join(', ')}.`);
  const r = await d.fetch(`https://firebase.googleapis.com/v1beta1/projects/${encodeURIComponent(project)}`, { headers: { authorization: `Bearer ${d.token()}` } });
  const j = (await r.json().catch(() => ({}))) as { projectId?: string; projectNumber?: string; error?: { message?: string } };
  if (!r.ok) throw new Refusal(`Could not confirm project ${project} (HTTP ${r.status} ${j.error?.message ?? ''}). Are you signed in with gcloud?`);
  if (j.projectId !== project || String(j.projectNumber) !== expected) {
    throw new Refusal(`Target is ${j.projectId} (number ${j.projectNumber}), expected ${project} (number ${expected}).`);
  }
}

// ------------------------------------------------------------------------------------------------ plan file

export interface PlanChange { collection: 'clients' | 'policies'; id: string; field: 'classification' | 'line'; before: string | null; after: Line; updateTime: string; reason: string }
export interface PlanFile {
  runId: string; project: string; createdAt: string; account: string;
  overrides: LobOverrides; overridesHash: string;
  /** Evidence kinds accepted for ambiguous lines of business (sealed into the hash). */
  evidenceAccepted: EvidenceKind[];
  counts: CorrectionPlan['counts'];
  changes: PlanChange[];
  planHash: string;
}

export function planHashOf(p: Pick<PlanFile, 'runId' | 'project' | 'overridesHash' | 'evidenceAccepted' | 'changes'>): string {
  const canon = p.changes.map((c) => [c.collection, c.id, c.field, c.before, c.after, c.updateTime]);
  return sha256(JSON.stringify([p.runId, p.project, p.overridesHash, [...(p.evidenceAccepted ?? [])].sort(), canon]));
}

function changesOf(plan: CorrectionPlan): PlanChange[] {
  const out: PlanChange[] = [];
  for (const p of plan.policies) if (p.action === 'change') out.push({ collection: 'policies', id: p.id, field: 'line', before: p.current, after: p.target!, updateTime: p.updateTime, reason: p.reason });
  for (const c of plan.clients) if (c.action === 'change') out.push({ collection: 'clients', id: c.id, field: 'classification', before: c.current, after: c.target!, updateTime: c.updateTime, reason: c.reason });
  return out;
}

function readPlan(dir: string): PlanFile {
  const f = join(dir, 'plan.json');
  if (!existsSync(f)) throw new Refusal(`${f} not found. Pass the folder that preview created.`);
  const plan = JSON.parse(readFileSync(f, 'utf8')) as PlanFile;
  if (plan.runId !== RUN_ID) throw new Refusal(`plan.json is for "${plan.runId}", not ${RUN_ID}.`);
  if (sha256(JSON.stringify(plan.overrides)) !== plan.overridesHash) throw new Refusal('plan.json overrides were edited after the preview. Run preview again.');
  if (planHashOf(plan) !== plan.planHash) throw new Refusal('plan.json was edited after the preview (hash mismatch). Run preview again.');
  for (const c of plan.changes) {
    if (CORRECTION_FIELDS[c.collection] !== c.field) throw new Refusal(`plan.json tries to change ${c.collection}.${c.field}; only policies.line and clients.classification may change.`);
    if (c.after !== 'personal' && c.after !== 'commercial') throw new Refusal(`plan.json has an invalid new value "${c.after}".`);
  }
  return plan;
}

// ------------------------------------------------------------------------------------------------ preview

export function readOverrides(file: string | undefined, cwd: string): LobOverrides {
  if (!file) return {};
  const raw = JSON.parse(readFileSync(resolve(cwd, file), 'utf8')) as Record<string, unknown>;
  const out: Record<string, 'personal' | 'commercial' | 'review'> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue; // "_comment" keys
    if (v !== 'personal' && v !== 'commercial' && v !== 'review') throw new Refusal(`Overrides: "${k}" must be "personal", "commercial" or "review" (got ${JSON.stringify(v)}).`);
    out[normalizeLob(k)] = v;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** `--evidence`: "statement" (default: the three statement kinds), "none", "all", or a comma list of kinds. */
export function parseEvidence(arg: string | undefined): EvidenceKind[] {
  if (arg === undefined || arg === 'statement') return [...DEFAULT_EVIDENCE];
  if (arg === 'none') return [];
  if (arg === 'all') return [...EVIDENCE_KINDS];
  const out = new Set<EvidenceKind>();
  for (const raw of arg.split(',').map((x) => x.trim()).filter(Boolean)) {
    if (raw === 'statement') { DEFAULT_EVIDENCE.forEach((k) => out.add(k)); continue; }
    if (!(EVIDENCE_KINDS as readonly string[]).includes(raw)) throw new Refusal(`--evidence: unknown kind "${raw}". Use statement, none, all, or: ${EVIDENCE_KINDS.join(', ')}.`);
    out.add(raw as EvidenceKind);
  }
  return EVIDENCE_KINDS.filter((k) => out.has(k));
}


/**
 * READ-ONLY: statement evidence per policy, from lines matched to it (match.status "matched"), on statements that
 * are not discarded: the statement's classification (set by you), the carrier's section label, the carrier's title.
 */
async function collectStatementEvidence(fs: Firestore): Promise<{ evidence: Map<string, EvidenceSignal[]>; statements: number; matchedLines: number }> {
  const stmts = (await fs.readAll('statements', { fields: ['classification', 'title', 'status'] })).filter((x) => sv(x.fields?.status) !== 'discarded');
  type Acc = Map<string, { line: Line; lines: number; statements: Set<string>; label: string }>;
  const acc = new Map<string, { cls: Acc; sec: Acc; title: Acc }>();
  let matchedLines = 0;
  const add = (a: Acc, key: string, line: Line, label: string, sid: string) => {
    const e = a.get(key) ?? { line, lines: 0, statements: new Set<string>(), label };
    e.lines++; e.statements.add(sid); a.set(key, e);
  };
  for (const st of stmts) {
    const sid = docId(st.name);
    const cls = sv(st.fields?.classification);
    const title = sv(st.fields?.title) ?? '';
    const t = title ? classifyLineOfBusiness(title) : null;
    const lines = await fs.readAll('lines', { parent: `statements/${sid}`, fields: ['match.status', 'match.policyId', 'section'] });
    for (const ln of lines) {
      const m = (ln.fields?.match as { mapValue?: { fields?: Record<string, FsValue> } } | undefined)?.mapValue?.fields;
      if (sv(m?.status) !== 'matched') continue;
      const pid = sv(m?.policyId);
      if (!pid) continue;
      matchedLines++;
      const a = acc.get(pid) ?? { cls: new Map(), sec: new Map(), title: new Map() };
      acc.set(pid, a);
      if (cls === 'personal' || cls === 'commercial') add(a.cls, cls, cls, cls === 'personal' ? 'Personal Lines' : 'Commercial Lines', sid);
      const section = sv(ln.fields?.section);
      const sr = section ? classifyLineOfBusiness(section) : null;
      if (sr?.line && sr.basis === 'rule') add(a.sec, `${sr.line}|${normalizeLob(section)}`, sr.line, section!.trim(), sid);
      if (t?.line && t.basis === 'rule') add(a.title, `${t.line}|${normalizeLob(title)}`, t.line, title.trim(), sid);
    }
  }
  const evidence = new Map<string, EvidenceSignal[]>();
  const n = (x: number, w: string) => `${x} ${w}${x === 1 ? '' : 's'}`;
  for (const [pid, a] of acc) {
    const out: EvidenceSignal[] = [];
    for (const e of a.cls.values()) out.push({ kind: 'statement_classification', line: e.line, detail: `${n(e.lines, 'matched line')} on ${n(e.statements.size, 'statement')} you classified ${e.label}` });
    for (const e of a.sec.values()) out.push({ kind: 'statement_section', line: e.line, detail: `${n(e.lines, 'matched line')} in carrier section "${e.label}"` });
    for (const e of a.title.values()) out.push({ kind: 'statement_title', line: e.line, detail: `${n(e.lines, 'matched line')} on statement titled "${e.label}"` });
    if (out.length) evidence.set(pid, out);
  }
  return { evidence, statements: stmts.length, matchedLines };
}

async function preview(project: string, overridesFile: string | undefined, evidenceArg: string | undefined, d: Deps): Promise<string> {
  const evidenceAccepted = parseEvidence(evidenceArg);
  await guardProject(project, d);
  const fs = new Firestore(project, d);
  const overrides = readOverrides(overridesFile, d.cwd);
  const [clientDocs, policyDocs] = [await fs.readAll('clients'), await fs.readAll('policies')];
  const carrierDocs = await fs.readAll('carriers', { fields: ['name'] });
  const carrierName = new Map(carrierDocs.map((c) => [docId(c.name), sv(c.fields?.name) ?? '']));
  const se = await collectStatementEvidence(fs);
  const markers = (await fs.getMany([MARKER_PATH, ...OTHER_MARKERS]));

  const plan = planLineCorrection({
    clients: clientDocs.map((c) => ({ id: docId(c.name), name: sv(c.fields?.name) ?? '', classification: sv(c.fields?.classification), updateTime: c.updateTime! })),
    policies: policyDocs.map((p) => ({
      id: docId(p.name), clientId: sv(p.fields?.clientId), policyNumber: sv(p.fields?.policyNumber) ?? '', policyType: sv(p.fields?.policyType),
      line: sv(p.fields?.line), status: sv(p.fields?.status), updateTime: p.updateTime!,
      namedInsured: sv(p.fields?.namedInsured), carrierId: sv(p.fields?.carrierId), wholesalerId: sv(p.fields?.wholesalerId),
    })),
    overrides,
    statementEvidence: se.evidence,
    acceptEvidence: evidenceAccepted,
  });
  const policyCarrier = new Map(policyDocs.map((p) => [docId(p.name), { carrier: carrierName.get(sv(p.fields?.carrierId) ?? '') ?? '', wholesaler: carrierName.get(sv(p.fields?.wholesalerId) ?? '') ?? '', namedInsured: sv(p.fields?.namedInsured) ?? '' }]));
  const changes = changesOf(plan);
  const overridesHash = sha256(JSON.stringify(overrides));
  const file: PlanFile = { runId: RUN_ID, project, createdAt: d.now().toISOString(), account: d.account(), overrides, overridesHash, evidenceAccepted, counts: plan.counts, changes, planHash: '' };
  file.planHash = planHashOf(file);

  const dir = join(d.cwd, `line-correction-preview-${stamp(d.now())}`);
  if (existsSync(dir)) throw new Refusal(`${dir} already exists.`);
  mkdirSync(dir);
  // 1. Full backup of BOTH collections, exactly as Firestore returned them (owner-only file).
  writeFileSync(join(dir, 'backup-clients-policies.json'), JSON.stringify({ project, takenAt: d.now().toISOString(), note: 'Full records. Contains broker fields: owner only, never share.', clients: clientDocs, policies: policyDocs }));
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(file, null, 1));

  const clientName = new Map(plan.clients.map((c) => [c.id, c.name]));
  const L = (v: string | null) => (v === 'personal' ? 'Personal' : v === 'commercial' ? 'Commercial' : v ?? '');
  writeFileSync(join(dir, 'preview-policies.csv'), csv([
    ['policy_id', 'client_id', 'client', 'policy_number', 'status', 'line_of_business', 'current', 'new', 'action', 'reason'],
    ...plan.policies.map((p) => [p.id, p.clientId, clientName.get(p.clientId) ?? '', p.policyNumber, p.status, p.lob, L(p.current), L(p.target), p.action, p.reason]),
  ]));
  writeFileSync(join(dir, 'preview-clients.csv'), csv([
    ['client_id', 'client', 'current', 'new', 'action', 'policies', 'personal', 'commercial', 'needs_review', 'reason'],
    ...plan.clients.map((c) => [c.id, c.name, L(c.current), L(c.target), c.action, c.policies.total, c.policies.personal, c.policies.commercial, c.policies.review, c.reason]),
  ]));
  writeFileSync(join(dir, 'exceptions.csv'), csv([
    ['code', 'record', 'id', 'client_id', 'client', 'detail'],
    ...plan.exceptions.map((e) => [e.code, e.entityType, e.id, e.clientId, e.clientId ? clientName.get(e.clientId) ?? '' : '', e.detail]),
  ]));
  writeFileSync(join(dir, 'line-of-business.csv'), csv([
    ['line_of_business', 'examples', 'policies', 'decision', 'basis', 'changes', 'spelling', 'evidence_personal', 'evidence_commercial', 'evidence_conflict', 'no_evidence', 'reason'],
    ...plan.lobSummary.map((r) => [r.lobNormalized, r.examples.join(' | '), r.policies, r.decision, r.basis, r.changes, r.corrections.join('; '),
      r.evidence?.personal ?? '', r.evidence?.commercial ?? '', r.evidence?.conflict ?? '', r.evidence?.none ?? '', r.reason]),
  ]));
  writeFileSync(join(dir, 'evidence-review.csv'), csv([
    ['policy_id', 'client_id', 'client', 'named_insured', 'policy_number', 'carrier', 'wholesaler', 'status', 'line_of_business', 'current', 'new', 'action',
      'evidence_personal', 'evidence_commercial', 'other_policies_personal', 'other_policies_commercial', 'reason'],
    ...plan.policies.filter((p) => p.evidence).map((p) => {
      const pc = policyCarrier.get(p.id)!;
      const sig = (line: Line) => p.evidence!.filter((x) => x.line === line).map((x) => `${EVIDENCE_LABELS[x.kind]}${evidenceAccepted.includes(x.kind) ? '' : ' (not accepted)'}: ${x.detail}`).join(' | ');
      return [p.id, p.clientId, clientName.get(p.clientId) ?? '', pc.namedInsured, p.policyNumber, pc.carrier, pc.wholesaler, p.status, p.lob, L(p.current), L(p.target), p.action,
        sig('personal'), sig('commercial'), p.siblings?.personal ?? 0, p.siblings?.commercial ?? 0, p.reason];
    }),
  ]));
  writeFileSync(join(dir, 'crosscheck-lob-vs-statements.csv'), csv([
    ['policy_id', 'client', 'policy_number', 'line_of_business', 'new', 'note'],
    ...plan.policies.filter((p) => p.crossCheck).map((p) => [p.id, clientName.get(p.clientId) ?? '', p.policyNumber, p.lob, L(p.target), p.crossCheck!]),
  ]));
  // Template for settling review values: fill in "personal" or "commercial", then run preview again with --overrides.
  const template: Record<string, string> = { _comment: 'Replace "review" with "personal" or "commercial" for values you have checked; leave "review" to keep them for manual review.' };
  for (const r of plan.lobSummary) if (r.decision === 'review' && r.lobNormalized !== '(blank)') template[r.lobNormalized] = overrides[r.lobNormalized] ?? 'review';
  writeFileSync(join(dir, 'lob-overrides.template.json'), JSON.stringify(template, null, 2) + '\n');

  const c = plan.counts;
  const md: string[] = [
    `# Personal/Commercial correction — PREVIEW (nothing has been changed)`, '',
    `- Project: **${project}**   Run: ${RUN_ID}   Taken: ${file.createdAt} by ${file.account}`,
    `- Plan hash: \`${file.planHash}\``,
    `- Overrides: ${Object.keys(overrides).length ? Object.entries(overrides).map(([k, v]) => `${k} → ${v}`).join('; ') : 'none'}`,
    `- Evidence accepted for ambiguous lines of business: ${evidenceAccepted.length ? evidenceAccepted.map((k) => EVIDENCE_LABELS[k]).join(', ') : 'none (line of business only)'}`,
    `- Statements read for evidence: ${se.statements} (not discarded), ${se.matchedLines} matched lines`,
    `- Single-run marker ${MARKER_PATH}: ${markers.get(MARKER_PATH) ? '**EXISTS — apply will be refused**' : 'not present'}`,
    ...OTHER_MARKERS.map((m) => `- Earlier correction marker ${m}: ${markers.get(m) ? '**EXISTS (PR #25 script was run)**' : 'not present'}`),
    '', '## Summary', '',
    '| | Total | Will change | → Personal | → Commercial | Unchanged | Manual review |', '|---|---:|---:|---:|---:|---:|---:|',
    `| Policies | ${c.policiesTotal} | **${c.policiesChange}** | ${c.policiesToPersonal} | ${c.policiesToCommercial} | ${c.policiesUnchanged} | ${c.policiesReview} |`,
    `| Clients | ${c.clientsTotal} | **${c.clientsChange}** | ${c.clientsToPersonal} | ${c.clientsToCommercial} | ${c.clientsUnchanged} | ${c.clientsReview} |`,
    '', '## Policies by status', '', '| Status | Policies | Will change | Manual review |', '|---|---:|---:|---:|',
    ...Object.entries(c.policiesByStatus).sort().map(([s, v]) => `| ${s} | ${v.total} | ${v.change} | ${v.review} |`),
    '', '## Exceptions (never changed; listed in exceptions.csv)', '', '| Code | Count | Meaning |', '|---|---:|---|',
    ...([
      ['policy_lob_blank', 'Policy has no line of business'],
      ['policy_lob_review', 'Line of business is ambiguous or not recognized, and no accepted evidence decides it'],
      ['policy_evidence_conflict', 'Ambiguous line of business with contradicting evidence'],
      ['policy_client_missing', 'Policy points to a client that does not exist'],
      ['client_no_policies', 'Client has no policies'],
      ['client_has_review_policies', 'Client has at least one policy needing review'],
      ['client_mixed', 'Client has both Personal and Commercial policies (current value kept)'],
    ] as const).map(([k, m]) => `| ${k} | ${c.exceptionsByCode[k] ?? 0} | ${m} |`),
    '', '## Ambiguous lines of business — evidence', '',
    `${c.evidence.ambiguousPolicies} policies have a line of business that does not say Personal or Commercial. Evidence accepted: ${evidenceAccepted.length ? evidenceAccepted.map((k) => EVIDENCE_LABELS[k]).join(', ') : 'none'}.`, '',
    '| | Policies |', '|---|---:|',
    `| Decided Personal by evidence | ${c.evidence.resolvedPersonal} |`, `| Decided Commercial by evidence | ${c.evidence.resolvedCommercial} |`,
    `| Evidence conflicts (kept, review) | ${c.evidence.conflicting} |`, `| No accepted evidence (kept, review) | ${c.evidence.noAcceptedEvidence} |`, '',
    '| Line of business | Policies | → Personal | → Commercial | Conflict | No evidence |', '|---|---:|---:|---:|---:|---:|',
    ...plan.lobSummary.filter((r) => r.evidence).map((r) => `| ${r.lobNormalized} | ${r.policies} | ${r.evidence!.personal} | ${r.evidence!.commercial} | ${r.evidence!.conflict} | ${r.evidence!.none} |`),
    '', 'Evidence found but NOT accepted (would decide these if accepted with --evidence; still subject to the no-conflict rule):', '',
    '| Evidence kind | → Personal | → Commercial |', '|---|---:|---:|',
    ...EVIDENCE_KINDS.filter((k) => c.evidence.availableNotAccepted[k]).map((k) => `| ${EVIDENCE_LABELS[k]} | ${c.evidence.availableNotAccepted[k]!.personal} | ${c.evidence.availableNotAccepted[k]!.commercial} |`),
    '', `Cross-check: ${c.evidence.lobStatementDisagreements} policies with a clear line of business sit on statement evidence of the other type (the line of business still decides; listed in crosscheck-lob-vs-statements.csv).`,
    '', '## Spelling and abbreviation corrections', '',
    `${c.evidence.spellingCorrected} policies were read with a correction. Check each; mark any wrong one "review" in --overrides.`, '',
    '| As typed | Read as | Policies | Decision |', '|---|---|---:|---|',
    ...plan.lobSummary.filter((r) => r.corrections.length).map((r) => `| ${r.examples[0] ?? r.lobNormalized} | ${r.corrections.join('; ')} | ${r.policies} | ${r.decision} |`),
    '', '## Lines of business (top 40; all in line-of-business.csv)', '', '| Line of business | Policies | Decision | Changes | Reason |', '|---|---:|---|---:|---|',
    ...plan.lobSummary.slice(0, 40).map((r) => `| ${r.lobNormalized} | ${r.policies} | ${r.decision} | ${r.changes} | ${r.reason.replace(/\|/g, '/')} |`),
    '', '## Files', '',
    '- preview-policies.csv, preview-clients.csv — every record, current and new value, reason (no broker data)',
    '- exceptions.csv — records left for manual review', '- line-of-business.csv — every distinct line of business, its decision, spelling corrections and evidence counts',
    '- evidence-review.csv — every ambiguous policy: carrier, wholesaler, named insured, all evidence found, the client\'s other policies, decision',
    '- crosscheck-lob-vs-statements.csv — clear lines of business that statement evidence contradicts (not changed by evidence)',
    '- lob-overrides.template.json — settle review values, then run preview again with `--overrides`',
    '- backup-clients-policies.json — FULL backup of both collections (contains broker fields: owner only)',
    '- plan.json — the sealed plan that `apply` will execute', '',
    `Nothing changes until you run: \`apply ${dir.split(/[\\/]/).pop()}\` and type the confirmation.`,
  ];
  writeFileSync(join(dir, 'preview.md'), md.join('\n') + '\n');

  d.log(`PREVIEW (read-only) — ${project}`);
  d.log(`  policies: ${c.policiesTotal} total, ${c.policiesChange} will change (→ Personal ${c.policiesToPersonal}, → Commercial ${c.policiesToCommercial}), ${c.policiesReview} for review`);
  d.log(`  clients:  ${c.clientsTotal} total, ${c.clientsChange} will change (→ Personal ${c.clientsToPersonal}, → Commercial ${c.clientsToCommercial}), ${c.clientsReview} for review`);
  d.log(`  ambiguous: ${c.evidence.ambiguousPolicies} — by evidence → Personal ${c.evidence.resolvedPersonal}, → Commercial ${c.evidence.resolvedCommercial}; conflicts ${c.evidence.conflicting}; no evidence ${c.evidence.noAcceptedEvidence}`);
  d.log(`  exceptions: ${plan.exceptions.length}   plan hash: ${file.planHash.slice(0, 12)}`);
  if (markers.get(MARKER_PATH)) d.log(`  NOTE: ${MARKER_PATH} already exists — apply will be refused.`);
  d.log(`  Files: ${dir}`);
  return dir;
}

// ------------------------------------------------------------------------------------------------ apply

function updateWrite(fs: Firestore, ch: { collection: string; id: string; field: string; value: string | null }, precondition: string): unknown {
  return {
    update: { name: `${fs.root}/${ch.collection}/${ch.id}`, fields: { [ch.field]: str(ch.value), updatedBy: str(MAINT_ACTOR) } },
    updateMask: { fieldPaths: [ch.field, 'updatedBy'] },
    updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }],
    currentDocument: { updateTime: precondition },
  };
}

function auditWrite(fs: Firestore, account: string, a: { action: string; entityType: string; entityId: string; summary: string; field: string; before: string | null; after: string | null; detail: Record<string, unknown> }): unknown {
  const id = randomBytes(10).toString('hex'); // 20 hex chars, like an auto-ID
  return {
    update: {
      name: `${fs.root}/auditLog/${id}`,
      fields: toFields({
        actor: MAINT_ACTOR, actorEmail: account, action: a.action, entityType: a.entityType, entityId: a.entityId, summary: a.summary,
        changes: { [a.field]: { before: a.before, after: a.after } }, detail: a.detail,
      }),
    },
    updateTransforms: [{ fieldPath: 'at', setToServerValue: 'REQUEST_TIME' }],
    currentDocument: { exists: false },
  };
}

const LBL = (v: string | null) => (v === 'personal' ? 'Personal' : v === 'commercial' ? 'Commercial' : v ?? '(blank)');

/** Commit change+audit pairs in chunks; a chunk refused for a precondition is retried one change at a time. */
async function commitPairs<T>(fs: Firestore, size: number, items: T[], writesOf: (x: T) => [unknown, unknown], onDone: (x: T, writeTime: string) => void, onSkip: (x: T, why: string) => void) {
  const one = async (x: T) => {
    const r = await fs.commit(writesOf(x));
    if (r.ok) onDone(x, r.json.writeResults[0].updateTime);
    else if (r.status === 400 || r.status === 409 || r.status === 404) onSkip(x, `refused by Firestore (${r.json?.error?.status ?? r.status}): record changed since it was read`);
    else throw new Error(`Firestore HTTP ${r.status}: ${r.json?.error?.message ?? ''}`);
  };
  for (let i = 0; i < items.length; i += size) {
    const part = items.slice(i, i + size);
    const r = await fs.commit(part.flatMap(writesOf));
    if (r.ok) part.forEach((x, k) => onDone(x, r.json.writeResults[2 * k].updateTime));
    else if (r.status === 400 || r.status === 409 || r.status === 404) for (const x of part) await one(x);
    else throw new Error(`Firestore HTTP ${r.status}: ${r.json?.error?.message ?? ''}`);
  }
}

export interface ApplyResult { runId: string; project: string; planHash: string; appliedAt: string; applied: AppliedChange[]; skipped: { change: PlanChange; reason: string }[] }

async function apply(dirArg: string, d: Deps): Promise<void> {
  const dir = resolve(d.cwd, dirArg);
  const plan = readPlan(dir);
  if (existsSync(join(dir, 'apply-result.json'))) throw new Refusal(`${dir} already has apply-result.json: this plan was applied.`);
  await guardProject(plan.project, d);
  const fs = new Firestore(plan.project, d);
  if (await fs.get(MARKER_PATH)) throw new Refusal(`${MARKER_PATH} exists: the correction already ran. Use verify or rollback.`);
  if (!plan.changes.length) { d.log('Nothing to change.'); return; }

  const nPol = plan.changes.filter((c) => c.collection === 'policies').length;
  const nCli = plan.changes.length - nPol;
  const phrase = `APPLY ${plan.changes.length} ${plan.project}`;
  d.log(`About to change ${nPol} policies (line) and ${nCli} clients (classification) in ${plan.project}. Plan ${plan.planHash.slice(0, 12)}.`);
  d.log('Nothing else on any record changes: policy numbers, carriers, premiums, commissions, dates and status are never written.');
  const typed = (await d.ask(`Type "${phrase}" to continue: `)).trim();
  if (typed !== phrase) throw new Refusal('Confirmation did not match. Nothing was changed.');

  // Fresh backup of every affected record, saved before any write.
  const paths = plan.changes.map((c) => `${c.collection}/${c.id}`);
  const before = await fs.getMany(paths);
  writeFileSync(join(dir, 'apply-backup.json'), JSON.stringify({ project: plan.project, takenAt: d.now().toISOString(), note: 'Affected records just before the correction. Owner only.', records: Object.fromEntries(before) }));

  const ready: PlanChange[] = [];
  const skipped: ApplyResult['skipped'] = [];
  for (const c of plan.changes) {
    const doc = before.get(`${c.collection}/${c.id}`);
    if (!doc) skipped.push({ change: c, reason: 'record no longer exists' });
    else if (doc.updateTime !== c.updateTime) skipped.push({ change: c, reason: 'record was edited after the preview' });
    else if (sv(doc.fields?.[c.field]) !== c.before) skipped.push({ change: c, reason: `value is now "${sv(doc.fields?.[c.field])}"` });
    else ready.push(c);
  }

  const startedAt = d.now().toISOString();
  const marker = await fs.commit([{
    update: { name: `${fs.root}/${MARKER_PATH}`, fields: toFields({ runId: RUN_ID, planHash: plan.planHash, status: 'in_progress', startedAt, actorEmail: d.account(), planned: plan.changes.length, policiesPlanned: nPol, clientsPlanned: nCli }) },
    currentDocument: { exists: false },
  }]);
  if (!marker.ok) throw new Refusal(`Could not create ${MARKER_PATH} (HTTP ${marker.status}): the correction may already have run. Nothing was changed.`);

  const applied: AppliedChange[] = [];
  const account = d.account();
  const saveResult = (incomplete: boolean) => {
    const result: ApplyResult & { incomplete?: boolean } = { runId: RUN_ID, project: plan.project, planHash: plan.planHash, appliedAt: startedAt, applied, skipped, ...(incomplete ? { incomplete } : {}) };
    writeFileSync(join(dir, 'apply-result.json'), JSON.stringify(result, null, 1));
    writeFileSync(join(dir, 'apply-result.csv'), csv([
      ['record', 'id', 'field', 'before', 'after', 'result'],
      ...applied.map((a) => [a.collection, a.id, a.field, a.before, a.after, 'changed']),
      ...skipped.map((s) => [s.change.collection, s.change.id, s.change.field, s.change.before, s.change.after, `skipped: ${s.reason}`]),
    ]));
  };
  try {
  await commitPairs(fs, d.chunk ?? CHUNK, ready, (c) => [
    updateWrite(fs, { collection: c.collection, id: c.id, field: c.field, value: c.after }, c.updateTime),
    auditWrite(fs, account, {
      action: 'line_correction', entityType: c.collection === 'clients' ? 'client' : 'policy', entityId: c.id,
      summary: `Personal/Commercial correction: ${LBL(c.before)} → ${LBL(c.after)} (${c.reason})`,
      field: c.field, before: c.before, after: c.after, detail: { runId: RUN_ID, planHash: plan.planHash, reason: c.reason },
    }),
  ], (c, writeTime) => applied.push({ collection: c.collection, id: c.id, field: c.field, before: c.before, after: c.after, writeTime }),
  (c, why) => skipped.push({ change: c, reason: why }));
  } catch (e) {
    // Stopped part-way (network, permissions…): keep an exact record of what WAS changed, so verify and
    // rollback work from it. The marker stays "in_progress", which blocks a second apply.
    saveResult(true);
    d.log(`STOPPED after ${applied.length} change(s): ${e instanceof Error ? e.message : e}. apply-result.json lists what changed; run rollback to undo it, or send the output to Claude.`);
    throw e;
  }
  saveResult(false);
  const fin = await fs.commit([{
    update: { name: `${fs.root}/${MARKER_PATH}`, fields: toFields({ status: 'applied', applied: applied.length, skipped: skipped.length, policiesChanged: applied.filter((a) => a.collection === 'policies').length, clientsChanged: applied.filter((a) => a.collection === 'clients').length }) },
    updateMask: { fieldPaths: ['status', 'applied', 'skipped', 'policiesChanged', 'clientsChanged'] },
    updateTransforms: [{ fieldPath: 'finishedAt', setToServerValue: 'REQUEST_TIME' }],
  }]);
  if (!fin.ok) d.log(`WARNING: the changes are in place but ${MARKER_PATH} could not be marked "applied" (HTTP ${fin.status}). It stays "in_progress", which still blocks a second run.`);
  d.log(`APPLIED: ${applied.length} changed, ${skipped.length} skipped (see apply-result.csv).`);
  await verify(dirArg, d);
}

// ------------------------------------------------------------------------------------------------ verify

const IGNORED_ON_COMPARE = new Set(['updatedAt', 'updatedBy']);

async function verify(dirArg: string, d: Deps): Promise<boolean> {
  const dir = resolve(d.cwd, dirArg);
  const plan = readPlan(dir);
  const resultFile = join(dir, 'apply-result.json');
  if (!existsSync(resultFile)) throw new Refusal('apply-result.json not found: nothing was applied from this folder.');
  const result = JSON.parse(readFileSync(resultFile, 'utf8')) as ApplyResult;
  await guardProject(plan.project, d);
  const fs = new Firestore(plan.project, d);
  const backup = JSON.parse(readFileSync(join(dir, 'apply-backup.json'), 'utf8')) as { records: Record<string, FsDoc | null> };
  const full = JSON.parse(readFileSync(join(dir, 'backup-clients-policies.json'), 'utf8')) as { clients: FsDoc[]; policies: FsDoc[] };
  const problems: string[] = [];

  const now = await fs.getMany(result.applied.map((a) => `${a.collection}/${a.id}`));
  for (const a of result.applied) {
    const key = `${a.collection}/${a.id}`;
    const cur = now.get(key);
    const old = backup.records[key];
    if (!cur) { problems.push(`${key}: missing`); continue; }
    if (sv(cur.fields?.[a.field]) !== a.after && cur.updateTime === a.writeTime) problems.push(`${key}: ${a.field} is not ${a.after}`);
    if (cur.updateTime !== a.writeTime) continue; // edited since by someone else: not ours to judge
    // Every other field must be byte-for-byte what it was before.
    const keys = new Set([...Object.keys(old?.fields ?? {}), ...Object.keys(cur.fields ?? {})]);
    for (const k of keys) {
      if (k === a.field || IGNORED_ON_COMPARE.has(k)) continue;
      if (JSON.stringify(old?.fields?.[k] ?? null) !== JSON.stringify(cur.fields?.[k] ?? null)) problems.push(`${key}: field ${k} differs from the backup`);
    }
  }
  const [clients, policies] = [await fs.readAll('clients'), await fs.readAll('policies')];
  if (clients.length !== full.clients.length) problems.push(`client count ${clients.length} ≠ ${full.clients.length} at preview (check for edits by others)`);
  if (policies.length !== full.policies.length) problems.push(`policy count ${policies.length} ≠ ${full.policies.length} at preview (check for edits by others)`);
  const marker = await fs.get(MARKER_PATH);
  if (!marker) problems.push(`${MARKER_PATH} missing`);

  const lines = [
    `# Verification — ${plan.project} — ${d.now().toISOString()}`, '',
    `- Applied: ${result.applied.length} (policies ${result.applied.filter((a) => a.collection === 'policies').length}, clients ${result.applied.filter((a) => a.collection === 'clients').length}); skipped: ${result.skipped.length}`,
    `- Records now: clients ${clients.length}, policies ${policies.length} (preview: ${full.clients.length}, ${full.policies.length})`,
    `- Marker: ${sv(marker?.fields?.status) ?? 'missing'}`, '',
    problems.length ? `## PROBLEMS (${problems.length})\n\n${problems.map((p) => `- ${p}`).join('\n')}` : '## VERIFIED — every change is in place and no other field changed.',
  ];
  writeFileSync(join(dir, `verify-${stamp(d.now())}.md`), lines.join('\n') + '\n');
  d.log(problems.length ? `VERIFY: ${problems.length} problem(s) — see the verify file. Send it to Claude.` : 'VERIFY: OK — every change is in place and no other field changed.');
  return problems.length === 0;
}

// ------------------------------------------------------------------------------------------------ rollback

async function rollback(dirArg: string, d: Deps): Promise<void> {
  const dir = resolve(d.cwd, dirArg);
  const plan = readPlan(dir);
  const resultFile = join(dir, 'apply-result.json');
  if (!existsSync(resultFile)) throw new Refusal('apply-result.json not found: nothing to roll back from this folder.');
  if (readdirSync(dir).includes('rollback-result.json')) throw new Refusal('This correction was already rolled back (rollback-result.json exists).');
  const result = JSON.parse(readFileSync(resultFile, 'utf8')) as ApplyResult;
  await guardProject(plan.project, d);
  const fs = new Firestore(plan.project, d);

  const now = await fs.getMany(result.applied.map((a) => `${a.collection}/${a.id}`));
  const current = new Map([...now].map(([k, doc]) => [k, {
    exists: !!doc, value: doc ? sv(doc.fields?.[k.startsWith('clients/') ? 'classification' : 'line']) : null,
    updateTime: doc?.updateTime ?? null,
  }]));
  const decision = planLineRollback(result.applied, current);
  const phrase = `ROLLBACK ${decision.restore.length} ${plan.project}`;
  d.log(`Rollback will restore ${decision.restore.length} record(s); ${decision.skipped.length} will be skipped (edited since the correction).`);
  if (!decision.restore.length) { d.log('Nothing to restore.'); return; }
  const typed = (await d.ask(`Type "${phrase}" to continue: `)).trim();
  if (typed !== phrase) throw new Refusal('Confirmation did not match. Nothing was changed.');

  const restored: AppliedChange[] = [];
  const skipped = decision.skipped.map((s) => ({ ...s.change, reason: s.reason }));
  const account = d.account();
  const saveRollback = (incomplete: boolean) => {
    writeFileSync(join(dir, incomplete ? 'rollback-partial.json' : 'rollback-result.json'), JSON.stringify({ runId: RUN_ID, project: plan.project, at: d.now().toISOString(), incomplete, restored, skipped }, null, 1));
    writeFileSync(join(dir, incomplete ? 'rollback-partial.csv' : 'rollback-result.csv'), csv([
      ['record', 'id', 'field', 'restored_to', 'result'],
      ...restored.map((r) => [r.collection, r.id, r.field, r.before, 'restored']),
      ...skipped.map((x) => [x.collection, x.id, x.field, x.before, `skipped: ${x.reason}`]),
    ]));
  };
  try {
  await commitPairs(fs, d.chunk ?? CHUNK, decision.restore, (c) => [
    updateWrite(fs, { collection: c.collection, id: c.id, field: c.field, value: c.before }, c.writeTime),
    auditWrite(fs, account, {
      action: 'line_correction_rollback', entityType: c.collection === 'clients' ? 'client' : 'policy', entityId: c.id,
      summary: `Personal/Commercial correction rolled back: ${LBL(c.after)} → ${LBL(c.before)}`,
      field: c.field, before: c.after, after: c.before, detail: { runId: RUN_ID, planHash: plan.planHash },
    }),
  ], (c) => restored.push(c), (c, why) => skipped.push({ ...c, reason: why }));
  } catch (e) {
    // Stopped part-way: rollback can simply be run again; it re-checks every record and skips restored ones.
    saveRollback(true);
    d.log(`STOPPED after ${restored.length} restore(s): ${e instanceof Error ? e.message : e}. Run rollback again to finish.`);
    throw e;
  }
  saveRollback(false);
  const fin = await fs.commit([{
    update: { name: `${fs.root}/${MARKER_PATH}`, fields: toFields({ status: 'rolled_back', restored: restored.length, rollbackSkipped: skipped.length }) },
    updateMask: { fieldPaths: ['status', 'restored', 'rollbackSkipped'] },
    updateTransforms: [{ fieldPath: 'rolledBackAt', setToServerValue: 'REQUEST_TIME' }],
  }]);
  if (!fin.ok) d.log(`WARNING: restores are done but ${MARKER_PATH} could not be marked "rolled_back" (HTTP ${fin.status}).`);
  d.log(`ROLLED BACK: ${restored.length} restored, ${skipped.length} skipped (see rollback-result.csv).`);
}

// ------------------------------------------------------------------------------------------------ main

export async function main(argv: string[], deps: Partial<Deps> = {}): Promise<number> {
  const d = { ...defaultDeps(), ...deps };
  const [mode, ...rest] = argv;
  const flag = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));
  try {
    if (mode === 'preview') await preview(flag('--project') ?? 'pioneer-285cf', flag('--overrides'), flag('--evidence'), d);
    else if (mode === 'apply' && positional[0]) await apply(positional[0], d);
    else if (mode === 'verify' && positional[0]) return (await verify(positional[0], d)) ? 0 : 1;
    else if (mode === 'rollback' && positional[0]) await rollback(positional[0], d);
    else { d.log('Usage: preview [--project ID] [--overrides FILE] [--evidence statement|none|all|KIND,…] | apply DIR | verify DIR | rollback DIR'); return 2; }
    return 0;
  } catch (e) {
    if (e instanceof Refusal) { d.log(`REFUSED: ${e.message}`); return 1; }
    throw e;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(`FAILED: ${e instanceof Error ? e.message : e}`); process.exit(1); });
}
