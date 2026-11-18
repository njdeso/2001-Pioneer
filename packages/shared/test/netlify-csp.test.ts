import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Regression (production preview, 17 Nov 2026): the reviewer portal's "View original" showed
// "This content is blocked" — it frames the PDF from a blob: URL (the bytes getReviewerStatementFile returned)
// and the site CSP's frame-src did not allow blob:. Download worked (a download is not a frame).
const toml = readFileSync(fileURLToPath(new URL('../../../netlify.toml', import.meta.url)), 'utf8');
const csp = /Content-Security-Policy = "([^"]+)"/.exec(toml)?.[1] ?? '';
const directive = (name: string) => (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '').split(/\s+/).slice(1);

test('frame-src allows blob: (reviewer PDF viewer) and keeps the existing sources, nothing broader', () => {
  assert.deepEqual(directive('frame-src'), ['https://*.firebaseapp.com', 'https://storage.googleapis.com', 'blob:']);
  for (const wide of ['*', 'https:', 'data:', "'unsafe-inline'"]) assert.ok(!directive('frame-src').includes(wide), `frame-src must not allow ${wide}`);
});

test('the rest of the policy is unchanged: no framing of the app, scripts from self and Google sign-in only', () => {
  assert.deepEqual(directive('frame-ancestors'), ["'none'"]);
  assert.match(toml, /X-Frame-Options = "DENY"/);
  assert.deepEqual(directive('default-src'), ["'self'"]);
  assert.deepEqual(directive('script-src'), ["'self'", 'https://apis.google.com']);
  assert.ok(!csp.includes("'unsafe-eval'"));
  assert.ok(!directive('script-src').includes('blob:'), 'blob: is allowed for frames only, never for scripts');
  assert.deepEqual(directive('base-uri'), ["'self'"]);
  assert.deepEqual(directive('form-action'), ["'self'"]);
  assert.equal(csp.match(/blob:/g)?.length, 1, 'blob: appears once (frame-src)');
});

test('only PDFs are framed in the reviewer portal; everything else is downloaded', () => {
  const portal = readFileSync(fileURLToPath(new URL('../../../apps/admin/src/pages/ReviewerPortal.tsx', import.meta.url)), 'utf8');
  assert.match(portal, /if \(mode === 'download' \|\| r\.contentType !== 'application\/pdf'\) saveBlob\(r\.downloadName, blob\);/);
  assert.match(portal, /return new Blob\(\[bytes\], \{ type: r\.contentType \}\);/, 'the blob carries the server-chosen type (application/pdf for PDFs)');
  assert.equal((portal.match(/<iframe /g) ?? []).length, 1);
});
