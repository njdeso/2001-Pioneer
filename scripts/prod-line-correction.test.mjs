// End-to-end test of scripts/prod-line-correction.mts against an in-memory Firestore (REST semantics:
// runQuery paging, batchGet, atomic commit with updateTime / exists preconditions, update masks, REQUEST_TIME).
//   node --test scripts/prod-line-correction.test.mjs        (run from the repository root; CI does this)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, MARKER_PATH, MAINT_ACTOR } from './prod-line-correction.mts';

const PROJECT = 'demo-line-fix';
const ROOT = `projects/${PROJECT}/databases/(default)/documents`;

function fakeFirestore() {
  const docs = new Map(); // path -> { fields, createTime, updateTime }
  let clock = 1;
  const tick = () => `2026-11-19T12:00:${String(clock++).padStart(2, '0')}.000000Z`;
  const pathOf = (name) => name.slice(ROOT.length + 1);
  const asDoc = (path) => ({ name: `${ROOT}/${path}`, ...structuredClone(docs.get(path)) });
  let failNextCommitFor = null; // simulate someone editing a record right before our commit lands

  const put = (path, obj) => {
    const enc = (v) => v === null ? { nullValue: null } : typeof v === 'number' ? { integerValue: String(v) } : typeof v === 'object' ? { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } } : { stringValue: String(v) };
    const t = tick();
    docs.set(path, { fields: Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, enc(v)])), createTime: docs.get(path)?.createTime ?? t, updateTime: t });
  };
  const val = (path, field) => docs.get(path)?.fields?.[field]?.stringValue ?? null;

  async function fetchImpl(url, init = {}) {
    const body = init.body ? JSON.parse(init.body) : undefined;
    const reply = (status, json) => ({ ok: status < 300, status, json: async () => json });
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname).replace(`/v1/${ROOT}`, '');
    const rq = p.match(/^(?:\/(.+))?:runQuery$/);
    if (rq) {
      const q = body.structuredQuery;
      const col = q.from[0].collectionId;
      const prefix = rq[1] ? `${rq[1]}/${col}/` : `${col}/`;
      const depth = prefix.split('/').length;
      let names = [...docs.keys()].filter((k) => k.split('/').length === depth && k.startsWith(prefix)).sort();
      if (q.startAt) names = names.filter((n) => `${ROOT}/${n}` > q.startAt.values[0].referenceValue);
      return reply(200, names.slice(0, q.limit).map((n) => ({ document: asDoc(n) })));
    }
    if (p === ':batchGet') return reply(200, body.documents.map((n) => (docs.has(pathOf(n)) ? { found: asDoc(pathOf(n)) } : { missing: n })));
    if (p === ':commit') {
      if (failNextCommitFor) {
        const target = failNextCommitFor;
        if (body.writes.some((w) => w.update?.name === `${ROOT}/${target}`)) { failNextCommitFor = null; put(target, { ...decodeAll(target), premiumCents: 999 }); }
      }
      for (const w of body.writes) {
        const path = pathOf(w.update.name);
        const cur = docs.get(path);
        const pre = w.currentDocument;
        if (pre?.exists === false && cur) return reply(409, { error: { status: 'ALREADY_EXISTS' } });
        if (pre?.updateTime && !cur) return reply(404, { error: { status: 'NOT_FOUND' } });
        if (pre?.updateTime && cur.updateTime !== pre.updateTime) return reply(400, { error: { status: 'FAILED_PRECONDITION' } });
      }
      const t = tick();
      const results = [];
      for (const w of body.writes) {
        const path = pathOf(w.update.name);
        const cur = docs.get(path);
        let fields = w.updateMask ? { ...(cur?.fields ?? {}) } : {};
        if (w.updateMask) for (const f of w.updateMask.fieldPaths) { if (f in w.update.fields) fields[f] = w.update.fields[f]; else delete fields[f]; }
        else fields = { ...w.update.fields };
        for (const tr of w.updateTransforms ?? []) fields[tr.fieldPath] = { timestampValue: t };
        docs.set(path, { fields, createTime: cur?.createTime ?? t, updateTime: t });
        results.push({ updateTime: t });
      }
      return reply(200, { writeResults: results, commitTime: t });
    }
    if (init.method === 'GET' && p.startsWith('/')) return docs.has(p.slice(1)) ? reply(200, asDoc(p.slice(1))) : reply(404, {});
    return reply(500, { error: { message: `fake: unhandled ${init.method} ${p}` } });
  }
  const decodeAll = (path) => Object.fromEntries(Object.entries(docs.get(path).fields).map(([k, v]) => [k, v.stringValue ?? (v.integerValue ? Number(v.integerValue) : null)]));
  return { docs, put, val, fetchImpl, decodeAll, failOnCommit: (path) => { failNextCommitFor = path; } };
}

function seed(fs) {
  const c = (id, classification) => fs.put(`clients/${id}`, { name: `Client ${id}`, classification, brokerId: 'BRK-SECRET', status: 'active' });
  const p = (id, clientId, policyType, line, status = 'active') => fs.put(`policies/${id}`, {
    clientId, policyNumber: `PN-${id}`, policyType, line, status, carrierId: 'TRAV', brokerId: 'BRK-SECRET', brokerShareBps: 5000,
    premiumCents: 120000, commissionRateBps: 1500, effectiveDate: '2026-01-01', expirationDate: '2027-01-01',
  });
  c('home1', 'commercial'); p('h1', 'home1', 'Homeowners', 'commercial'); p('h2', 'home1', 'Personal Auto', 'commercial', 'expired');
  c('home2', 'commercial'); p('h3', 'home2', 'HO-3', 'commercial', 'cancelled');
  c('biz', 'commercial'); p('b1', 'biz', 'BOP', 'commercial');
  c('mixed', 'commercial'); p('m1', 'mixed', 'Homeowners', 'commercial'); p('m2', 'mixed', 'Workers Comp', 'commercial');
  c('amb', 'commercial'); p('u1', 'amb', 'Umbrella', 'commercial');
  c('none', 'commercial');
  c('race', 'commercial'); p('r1', 'race', 'Renters', 'commercial');
}

function harness() {
  const fs = fakeFirestore();
  seed(fs);
  const cwd = mkdtempSync(join(tmpdir(), 'line-fix-'));
  const logs = [];
  let answer = '';
  let n = 0;
  const deps = {
    fetch: fs.fetchImpl, token: () => 'owner', account: () => 'owner@example.test', ask: async () => answer,
    log: (l) => logs.push(l), cwd, now: () => new Date(Date.UTC(2026, 10, 19, 17, 0, n++)), emulatorHost: '127.0.0.1:1',
  };
  return { fs, cwd, logs, deps, setAnswer: (a) => { answer = a; }, run: (...argv) => main(argv, deps) };
}

const previewDir = (cwd) => readdirSync(cwd).filter((d) => d.startsWith('line-correction-preview-')).sort().at(-1);
const auditDocs = (fs) => [...fs.docs.keys()].filter((k) => k.startsWith('auditLog/')).map((k) => fs.decodeAll(k));

test('preview is read-only and reports counts, exceptions and files with no broker data', async () => {
  const h = harness();
  const before = JSON.stringify([...h.fs.docs]);
  assert.equal(await h.run('preview', '--project', PROJECT), 0);
  assert.equal(JSON.stringify([...h.fs.docs]), before, 'preview must not change anything');
  const dir = join(h.cwd, previewDir(h.cwd));
  const plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'));
  // 8 policies: h1,h2,h3,m1,r1 → personal (5); b1,m2 unchanged; u1 review. clients: home1, home2, race → personal; biz unchanged; mixed/amb/none review.
  assert.equal(plan.counts.policiesChange, 5);
  assert.equal(plan.counts.policiesReview, 1);
  assert.equal(plan.counts.clientsChange, 3);
  assert.equal(plan.counts.clientsReview, 3);
  assert.deepEqual(plan.counts.exceptionsByCode, { policy_lob_review: 1, client_mixed: 1, client_has_review_policies: 1, client_no_policies: 1 });
  for (const f of ['preview.md', 'preview-policies.csv', 'preview-clients.csv', 'exceptions.csv', 'line-of-business.csv', 'lob-overrides.template.json', 'plan.json']) {
    const text = readFileSync(join(dir, f), 'utf8');
    for (const secret of ['BRK-SECRET', 'brokerId', 'brokerShare', 'premium', 'commissionRate']) assert.ok(!text.includes(secret), `${f} must not contain ${secret}`);
  }
  const backup = JSON.parse(readFileSync(join(dir, 'backup-clients-policies.json'), 'utf8'));
  assert.equal(backup.clients.length, 7);
  assert.equal(backup.policies.length, 8);
  assert.match(readFileSync(join(dir, 'preview.md'), 'utf8'), /\| Policies \| 8 \| \*\*5\*\* \| 5 \| 0 \|/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'lob-overrides.template.json'), 'utf8')).umbrella, 'review');
});

test('apply: wrong confirmation changes nothing', async () => {
  const h = harness();
  await h.run('preview', '--project', PROJECT);
  const before = JSON.stringify([...h.fs.docs]);
  h.setAnswer('yes');
  assert.equal(await h.run('apply', previewDir(h.cwd)), 1);
  assert.equal(JSON.stringify([...h.fs.docs]), before);
  assert.ok(h.logs.some((l) => /Confirmation did not match/.test(l)));
});

test('apply changes only line/classification, skips records edited since preview, audits, and runs once', async () => {
  const h = harness();
  await h.run('preview', '--project', PROJECT);
  const dir = previewDir(h.cwd);
  const snapshot = new Map([...h.fs.docs].map(([k, v]) => [k, structuredClone(v)]));
  // Someone edits client "home2" after the preview: it must be skipped, never overwritten.
  h.fs.put('clients/home2', { ...h.fs.decodeAll('clients/home2'), name: 'Client home2 (renamed)' });
  // And "race"'s policy r1 is edited at the very moment the first commit lands (precondition race).
  h.fs.failOnCommit('policies/r1');
  h.setAnswer(`APPLY 8 ${PROJECT}`);
  assert.equal(await h.run('apply', dir), 0, h.logs.join('\n'));

  assert.equal(h.fs.val('policies/h1', 'line'), 'personal');
  assert.equal(h.fs.val('policies/h2', 'line'), 'personal');
  assert.equal(h.fs.val('policies/h3', 'line'), 'personal');
  assert.equal(h.fs.val('policies/m1', 'line'), 'personal');
  assert.equal(h.fs.val('policies/r1', 'line'), 'commercial', 'edited during the commit: skipped');
  assert.equal(h.fs.val('policies/u1', 'line'), 'commercial', 'ambiguous: untouched');
  assert.equal(h.fs.val('clients/home1', 'classification'), 'personal');
  assert.equal(h.fs.val('clients/home2', 'classification'), 'commercial', 'edited after preview: skipped');
  assert.equal(h.fs.val('clients/race', 'classification'), 'personal');
  for (const id of ['mixed', 'amb', 'none', 'biz']) assert.equal(h.fs.val(`clients/${id}`, 'classification'), 'commercial', id);

  // Protected fields are byte-for-byte unchanged on every changed record.
  for (const id of ['h1', 'h2', 'h3', 'm1']) {
    const a = snapshot.get(`policies/${id}`).fields, b = h.fs.docs.get(`policies/${id}`).fields;
    for (const k of Object.keys(a)) if (!['line', 'updatedAt', 'updatedBy'].includes(k)) assert.deepEqual(b[k], a[k], `policies/${id}.${k}`);
    assert.equal(b.updatedBy.stringValue, MAINT_ACTOR);
  }
  // Untouched records are untouched (apart from the deliberate edits above).
  for (const k of ['policies/b1', 'policies/m2', 'policies/u1', 'clients/biz', 'clients/mixed', 'clients/amb', 'clients/none']) {
    assert.deepEqual(h.fs.docs.get(k), snapshot.get(k), k);
  }

  const audits = auditDocs(h.fs).filter((a) => a.action === 'line_correction');
  assert.equal(audits.length, 6, 'one audit entry per changed record (4 policies + 2 clients)');
  for (const a of audits) assert.ok(!JSON.stringify(a).includes('BRK-SECRET'));
  const result = JSON.parse(readFileSync(join(h.cwd, dir, 'apply-result.json'), 'utf8'));
  assert.equal(result.applied.length, 6);
  assert.deepEqual(result.skipped.map((s) => s.change.id).sort(), ['home2', 'r1']);
  assert.ok(existsSync(join(h.cwd, dir, 'apply-backup.json')));
  assert.equal(h.fs.decodeAll(MARKER_PATH).status, 'applied');
  assert.ok(h.logs.some((l) => /^VERIFY: OK/.test(l)), h.logs.join('\n'));

  // A second apply — even from a fresh preview — is refused by the marker.
  await h.run('preview', '--project', PROJECT);
  h.setAnswer('anything');
  assert.equal(await h.run('apply', previewDir(h.cwd)), 1);
  assert.ok(h.logs.some((l) => /already ran/.test(l)));
});

test('a tampered plan or overrides are refused before anything is read for writing', async () => {
  const h = harness();
  await h.run('preview', '--project', PROJECT);
  const dir = previewDir(h.cwd);
  const f = join(h.cwd, dir, 'plan.json');
  const plan = JSON.parse(readFileSync(f, 'utf8'));
  plan.changes[0].after = plan.changes[0].after === 'personal' ? 'commercial' : 'personal';
  writeFileSync(f, JSON.stringify(plan));
  h.setAnswer(`APPLY ${plan.changes.length} ${PROJECT}`);
  assert.equal(await h.run('apply', dir), 1);
  assert.ok(h.logs.some((l) => /hash mismatch/.test(l)));
  plan.changes[0].field = 'premiumCents';
  writeFileSync(f, JSON.stringify(plan));
  assert.equal(await h.run('apply', dir), 1);
  assert.equal(h.fs.docs.has(MARKER_PATH), false);
});

test('reviewed overrides settle ambiguous values and change the plan hash', async () => {
  const h = harness();
  writeFileSync(join(h.cwd, 'lob-overrides.json'), JSON.stringify({ _comment: 'x', Umbrella: 'personal' }));
  await h.run('preview', '--project', PROJECT, '--overrides', 'lob-overrides.json');
  const plan = JSON.parse(readFileSync(join(h.cwd, previewDir(h.cwd), 'plan.json'), 'utf8'));
  assert.deepEqual(plan.overrides, { umbrella: 'personal' });
  assert.equal(plan.counts.policiesReview, 0);
  assert.ok(plan.changes.some((c) => c.id === 'u1' && c.after === 'personal'));
  assert.ok(plan.changes.some((c) => c.id === 'amb' && c.after === 'personal'));
  writeFileSync(join(h.cwd, 'bad.json'), JSON.stringify({ umbrella: 'maybe' }));
  assert.equal(await h.run('preview', '--project', PROJECT, '--overrides', 'bad.json'), 1);
});

test('rollback restores only what the correction still owns, with audit entries', async () => {
  const h = harness();
  await h.run('preview', '--project', PROJECT);
  const dir = previewDir(h.cwd);
  h.setAnswer(`APPLY 8 ${PROJECT}`);
  await h.run('apply', dir);
  // After the correction the owner edits policy h2's premium: rollback must leave h2 alone.
  h.fs.put('policies/h2', { ...h.fs.decodeAll('policies/h2'), premiumCents: 130000 });
  h.setAnswer('no');
  assert.equal(await h.run('rollback', dir), 1, 'wrong confirmation');
  assert.equal(h.fs.val('policies/h1', 'line'), 'personal');
  h.setAnswer(`ROLLBACK 7 ${PROJECT}`);
  assert.equal(await h.run('rollback', dir), 0, h.logs.join('\n'));
  for (const id of ['h1', 'h3', 'm1', 'r1']) assert.equal(h.fs.val(`policies/${id}`, 'line'), 'commercial', id);
  assert.equal(h.fs.val('policies/h2', 'line'), 'personal', 'edited after the correction: left as is');
  for (const id of ['home1', 'home2', 'race']) assert.equal(h.fs.val(`clients/${id}`, 'classification'), 'commercial', id);
  const rb = auditDocs(h.fs).filter((a) => a.action === 'line_correction_rollback');
  assert.equal(rb.length, 7);
  assert.equal(h.fs.decodeAll(MARKER_PATH).status, 'rolled_back');
  assert.equal(await h.run('rollback', dir), 1, 'second rollback refused');
});

test('outside the emulator only the two real projects are accepted, confirmed by project number', async () => {
  const h = harness();
  const deps = { ...h.deps, emulatorHost: undefined, fetch: async () => ({ ok: true, status: 200, json: async () => ({ projectId: 'pioneer-285cf', projectNumber: '111' }) }) };
  assert.equal(await main(['preview', '--project', 'pioneer-285cf'], deps), 1);
  assert.equal(await main(['preview', '--project', 'someone-else'], deps), 1);
  assert.equal(await main(['preview', '--project', 'demo-x'], deps), 1);
});

test('the script writes only correction fields, updatedBy/updatedAt, audit entries and its marker', () => {
  const src = readFileSync('scripts/prod-line-correction.mts', 'utf8');
  const masks = [...src.matchAll(/fieldPaths: \[([^\]]*)\]/g)].map((m) => m[1].trim());
  assert.deepEqual(masks, ["ch.field, 'updatedBy'", "'status', 'applied', 'skipped', 'policiesChanged', 'clientsChanged'", "'status', 'restored', 'rollbackSkipped'"]);
  assert.doesNotMatch(src, /delete:\s/, 'no deletes');
  assert.doesNotMatch(src, /\bdocuments\/(ledger|statements|brokers|carriers)/);
});

test('an apply that stops part-way still records exactly what changed, and rollback undoes it', async () => {
  const h = harness();
  await h.run('preview', '--project', PROJECT);
  const dir = previewDir(h.cwd);
  let commits = 0;
  // Commit 1 = marker, then 2 changes per commit: commits 2 and 3 land (4 changes), commit 4 fails.
  const flaky = async (url, init) => {
    if (url.endsWith(':commit') && ++commits === 4) return { ok: false, status: 503, json: async () => ({ error: { message: 'unavailable' } }) };
    return h.fs.fetchImpl(url, init);
  };
  h.setAnswer(`APPLY 8 ${PROJECT}`);
  await assert.rejects(main(['apply', dir], { ...h.deps, fetch: flaky, chunk: 2 }), /503/);
  const result = JSON.parse(readFileSync(join(h.cwd, dir, 'apply-result.json'), 'utf8'));
  assert.equal(result.incomplete, true);
  assert.equal(result.applied.length, 4);
  assert.ok(result.applied.every((a) => h.fs.val(`${a.collection}/${a.id}`, a.field) === a.after));
  assert.equal(h.fs.decodeAll(MARKER_PATH).status, 'in_progress', 'a second apply stays blocked');
  assert.equal(auditDocs(h.fs).filter((a) => a.action === 'line_correction').length, 4, 'audit entries only for what landed');
  h.setAnswer(`ROLLBACK 4 ${PROJECT}`);
  assert.equal(await h.run('rollback', dir), 0, h.logs.join('\n'));
  for (const a of result.applied) assert.equal(h.fs.val(`${a.collection}/${a.id}`, a.field), a.before);
});


test('statement evidence decides ambiguous Auto policies only when it is consistent; all of it is reported', async () => {
  const h = harness();
  const P = (id, clientId, policyType, extra = {}) => h.fs.put(`policies/${id}`, { clientId, policyNumber: `PN-${id}`, policyType, line: 'commercial', status: 'active', carrierId: 'TRAV', brokerId: 'BRK-SECRET', namedInsured: '', ...extra });
  h.fs.put('clients/pa', { name: 'Pat Auto', classification: 'commercial', brokerId: 'BRK-SECRET' });
  P('au1', 'pa', 'Auto');
  h.fs.put('clients/ca', { name: 'Example Hauling LLC', classification: 'personal', brokerId: 'BRK-SECRET' });
  P('au2', 'ca', 'Auto');
  h.fs.put('clients/cf', { name: 'Chris Conflict', classification: 'commercial', brokerId: 'BRK-SECRET' });
  P('au3', 'cf', 'Auto');
  h.fs.put('clients/nn', { name: 'Nora None', classification: 'commercial', brokerId: 'BRK-SECRET' });
  P('au4', 'nn', 'Auto');
  h.fs.put('clients/sp', { name: 'Sam Spelling', classification: 'commercial', brokerId: 'BRK-SECRET' });
  P('sp1', 'sp', 'Homowners'); P('sp2', 'sp', 'Genl Liability');
  // Statements: a Personal Lines statement (owner-classified), a carrier statement with a COMMERCIAL AUTO section, a discarded one.
  h.fs.put('statements/S1', { classification: 'personal', title: 'Agency Statement', status: 'posted' });
  h.fs.put('statements/S1/lines/l1', { section: '', match: { status: 'matched', policyId: 'au1' } });
  h.fs.put('statements/S1/lines/l2', { section: '', match: { status: 'matched', policyId: 'au3' } });
  h.fs.put('statements/S1/lines/l3', { section: '', match: { status: 'ambiguous', policyId: 'au4' } });
  h.fs.put('statements/S2', { classification: null, title: 'Monthly Commission', status: 'needs_review' });
  h.fs.put('statements/S2/lines/l1', { section: 'COMMERCIAL AUTO', match: { status: 'matched', policyId: 'au2' } });
  h.fs.put('statements/S2/lines/l2', { section: 'COMMERCIAL AUTO', match: { status: 'matched', policyId: 'au3' } });
  h.fs.put('statements/S3', { classification: 'personal', title: '', status: 'discarded' });
  h.fs.put('statements/S3/lines/l1', { section: '', match: { status: 'matched', policyId: 'au4' } });

  const before = JSON.stringify([...h.fs.docs]);
  assert.equal(await h.run('preview', '--project', PROJECT), 0, h.logs.join('\n'));
  assert.equal(JSON.stringify([...h.fs.docs]), before, 'still read-only');
  const dir = join(h.cwd, previewDir(h.cwd));
  const plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'));
  assert.deepEqual(plan.evidenceAccepted, ['statement_classification', 'statement_section', 'statement_title']);
  const ch = new Map(plan.changes.map((c) => [`${c.collection}/${c.id}`, c.after]));
  assert.equal(ch.get('policies/au1'), 'personal', 'Personal Lines statement');
  assert.equal(ch.get('clients/pa'), 'personal');
  assert.equal(ch.get('policies/au2'), undefined, 'already commercial: unchanged');
  assert.equal(ch.get('clients/ca'), 'commercial', 'COMMERCIAL AUTO section');
  assert.equal(ch.has('policies/au3'), false, 'Personal Lines statement AND Commercial Auto section: conflict');
  assert.equal(ch.has('policies/au4'), false, 'only an unconfirmed match and a discarded statement: no evidence');
  assert.equal(ch.get('policies/sp1'), 'personal', 'Homowners');
  assert.equal(ch.has('policies/sp2'), false, 'Genl Liability is already commercial');
  assert.equal(ch.has('clients/sp'), false, 'mixed client kept');
  const e = plan.counts.evidence;
  assert.equal(e.resolvedPersonal, 1); assert.equal(e.resolvedCommercial, 1); assert.equal(e.conflicting, 1);
  assert.ok(e.noAcceptedEvidence >= 1);
  assert.deepEqual(e.availableNotAccepted.entity_name, undefined, 'the LLC client was decided by statement evidence');
  const evCsv = readFileSync(join(dir, 'evidence-review.csv'), 'utf8');
  assert.match(evCsv, /you classified Personal Lines/);
  assert.match(evCsv, /carrier section ""COMMERCIAL AUTO""/);
  assert.ok(!/BRK-SECRET|brokerId/.test(evCsv));
  const md = readFileSync(join(dir, 'preview.md'), 'utf8');
  assert.match(md, /Ambiguous lines of business — evidence/);
  assert.match(md, /\| Homowners \| homowners → homeowners \|/);
  assert.match(md, /\| Genl Liability \| genl → general \|/);

  // Without evidence nothing ambiguous is decided, and the plan hash differs.
  assert.equal(await h.run('preview', '--project', PROJECT, '--evidence', 'none'), 0);
  const plan2 = JSON.parse(readFileSync(join(h.cwd, previewDir(h.cwd), 'plan.json'), 'utf8'));
  assert.equal(plan2.changes.some((c) => c.id === 'au1'), false);
  assert.notEqual(plan2.planHash, plan.planHash);
  assert.equal(await h.run('preview', '--project', PROJECT, '--evidence', 'guesswork'), 1);
});
