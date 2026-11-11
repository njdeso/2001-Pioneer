// Tests for scripts/prod-fingerprint.py against a LOCAL fake Firestore REST server and a fake gcloud
// (no Google access). Covers paging, token expiry → refresh → same read repeated, a token still refused
// after refresh (fails), a refresh that cannot be obtained (fails), and a page that hangs once (retried).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve('scripts/prod-fingerprint.py');
const doc = (path, fields) => ({ name: `projects/p/databases/(default)/documents/${path}`, fields });
function dataset({ policyCount = 250, tweak = false } = {}) {
  const c = {
    clients: [1, 2, 3].map((i) => doc(`clients/c${i}`, { name: { stringValue: `Client ${i}` } })),
    policies: Array.from({ length: policyCount }, (_, i) => doc(`policies/p${String(i).padStart(4, '0')}`, { policyNumber: { stringValue: `N${i}` }, premiumCents: { integerValue: String(tweak && i === 200 ? 1 : 1000 + i) } })),
    statements: [doc('statements/s1', {}), doc('statements/s2', {})],
    ledger: [doc('ledger/e1', { amountCents: { integerValue: '5000' }, brokerCents: { integerValue: '2000' }, agencyCents: { integerValue: '3000' }, postingStatus: { stringValue: 'posted' } })],
    'statements/s1/lines': [doc('statements/s1/lines/00001', { amount: { integerValue: '5000' } })],
    'statements/s2/lines': [],
  };
  for (const k of ['policyKeys', 'carriers', 'brokers', 'statementKeys', 'settings', 'users']) c[k] = [];
  return c;
}

/** Fake Firestore. behaviour: { validTokens:Set, expireAfter:{token,n}, hangOnce:path } */
function fakeFirestore(data, behaviour) {
  let requests = 0; let hung = false; const seen = [];
  const server = createServer((req, res) => {
    requests++;
    const token = (req.headers.authorization ?? '').replace('Bearer ', '');
    seen.push(token);
    const expired = behaviour.expireAfter && token === behaviour.expireAfter.token && requests > behaviour.expireAfter.n;
    if (!behaviour.validTokens.has(token) || expired) { res.writeHead(401); res.end('{"error":{"code":401,"status":"UNAUTHENTICATED"}}'); return; }
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST' && u.pathname.endsWith(':runAggregationQuery')) { res.end(JSON.stringify([{ result: { aggregateFields: { n: { integerValue: '0' } } } }])); return; }
    const path = decodeURIComponent(u.pathname.split('/documents/')[1] ?? '');
    const size = Number(u.searchParams.get('pageSize')); const start = Number(u.searchParams.get('pageToken') ?? 0);
    if (behaviour.hangOnce === `${path}@${start}` && !hung) { hung = true; return; } // never answers: client must time out and retry
    const all = data[path] ?? [];
    const page = all.slice(start, start + size);
    res.end(JSON.stringify({ documents: page, ...(start + size < all.length ? { nextPageToken: String(start + size) } : {}) }));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port, stats: () => ({ requests, seen }) })));
}

async function runFp(port, token, { gcloudToken = 'T2', gcloudFails = false, env = {} } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'fp-')); const bin = join(work, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'gcloud'), gcloudFails ? '#!/usr/bin/env bash\necho "ERROR: not signed in" >&2; exit 1\n' : `#!/usr/bin/env bash\necho ${gcloudToken}\n`);
  chmodSync(join(bin, 'gcloud'), 0o755);
  return new Promise((ok) => {
    const p = spawn('python3', ['-u', SCRIPT, 'p', token], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FP_FIRESTORE_BASE: `http://127.0.0.1:${port}`, FP_REQUEST_TIMEOUT: '2', ...env } });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => ok({ code, out, err }));
  });
}

test('pages of 100: every policy is read and fingerprinted; output is deterministic and change-sensitive', async () => {
  const f = await fakeFirestore(dataset(), { validTokens: new Set(['T1']) });
  const a = await runFp(f.port, 'T1'); const b = await runFp(f.port, 'T1');
  f.server.close();
  assert.equal(a.code, 0, a.err);
  assert.match(a.out, /^ {2}FP policies +250 [0-9a-f]{64}$/m);
  assert.match(a.out, /^ {2}FP statement lines +1 /m);
  assert.match(a.out, /^ {2}TOTAL amountCents +5000$/m);
  assert.match(a.out, /FP-COMPLETE 11 collections fingerprinted, \d+ requests, 0 token refreshes/);
  assert.match(a.err, /policies: 200 read …/, 'page-by-page progress');
  assert.equal(a.out.replace(/FP-COMPLETE.*/, ''), b.out.replace(/FP-COMPLETE.*/, ''));
  const g = await fakeFirestore(dataset({ tweak: true }), { validTokens: new Set(['T1']) });
  const c = await runFp(g.port, 'T1'); g.server.close();
  const line = (o) => o.match(/FP policies .*/)[0];
  assert.notEqual(line(c.out), line(a.out), 'one changed policy changes the fingerprint');
});

test('token expires mid-run (HTTP 401): refreshed via gcloud and the same read repeated; result identical', async () => {
  const base = await fakeFirestore(dataset(), { validTokens: new Set(['T1']) });
  const ref = await runFp(base.port, 'T1'); base.server.close();
  const f = await fakeFirestore(dataset(), { validTokens: new Set(['T1', 'T2']), expireAfter: { token: 'T1', n: 3 } });
  const r = await runFp(f.port, 'T1', { gcloudToken: 'T2' });
  f.server.close();
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /access token refreshed \(HTTP 401 from Firestore\)/);
  assert.match(r.out, /1 token refreshes/);
  assert.equal(r.out.replace(/FP-COMPLETE.*/, ''), ref.out.replace(/FP-COMPLETE.*/, ''), 'same fingerprint as an uninterrupted run');
  assert.ok(f.stats().seen.includes('T2'));
});

test('a token refused even after refresh fails explicitly (exit 2), never continues', async () => {
  const f = await fakeFirestore(dataset(), { validTokens: new Set(['T1']), expireAfter: { token: 'T1', n: 2 } });
  const r = await runFp(f.port, 'T1', { gcloudToken: 'BAD' });
  f.server.close();
  assert.equal(r.code, 2);
  assert.match(r.out, /FINGERPRINT FAILED: HTTP 401 .*refused even with a freshly issued token/);
  assert.doesNotMatch(r.out, /FP-COMPLETE/);
});

test('if gcloud cannot issue a new token, the run fails explicitly', async () => {
  const f = await fakeFirestore(dataset(), { validTokens: new Set(['T1']), expireAfter: { token: 'T1', n: 2 } });
  const r = await runFp(f.port, 'T1', { gcloudFails: true });
  f.server.close();
  assert.equal(r.code, 2);
  assert.match(r.out, /FINGERPRINT FAILED: could not refresh the access token/);
  assert.doesNotMatch(r.out, /FP-COMPLETE/);
});

test('a page that never answers times out and is read again from the same position', async () => {
  const f = await fakeFirestore(dataset(), { validTokens: new Set(['T1']), hangOnce: 'policies@100' });
  const r = await runFp(f.port, 'T1');
  f.server.close();
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /temporary problem .*retrying/);
  assert.match(r.out, /^ {2}FP policies +250 /m);
});

test('the test-only base URL cannot point anywhere but this machine', async () => {
  const r = await runFp(1, 'T1', { env: { FP_FIRESTORE_BASE: 'https://evil.example.com' } });
  assert.equal(r.code, 2);
  assert.match(r.err, /may only point at localhost/);
});
