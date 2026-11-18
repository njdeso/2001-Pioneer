import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, degrees } from 'pdf-lib';
import { AI_PROMPT_VERSION, aiStatementSchema, buildAiRequest, extractWithClaude, isSummaryRow, scanNote, STATEMENT_SCHEMA, type AiInput, type PdfScanInfo } from '../src/statements/ai.ts';
import { reconcileStatement } from '../src/statements/reconcile.ts';
import { suggestPayerFromFileName, type PayerCandidate } from '../src/statements/payerHint.ts';
import { pageLayout, pdfToTextLines } from '../src/pdfText.ts';

/**
 * Regression tests for the Security Mutual (SMIC) statement format: a landscape statement scanned sideways,
 * with policy transactions on page 1 and monthly / year-to-date totals on page 2, and no legible carrier
 * name. "SMIC Nov 26.pdf" failed with "carrierName: Too small" because the reader required a carrier name.
 *
 * Every name, policy number and amount below is SYNTHETIC (the real statement is not in the repository).
 * All Claude calls are mocked: no network, no API key, no real documents.
 */

const FAKE_KEY = 'sk-test-not-a-real-key';
const noSleep = async () => {};
const pdfInput = (scan?: PdfScanInfo): AiInput =>
  ({ kind: 'pdf', base64: Buffer.from('%PDF-1.4 synthetic smic').toString('base64'), pageCount: 2, scan });

const line = (o: Partial<Record<string, unknown>>) => ({
  page: 1, insuredName: '', policyNumber: '', paymentReceived: '', paidCommission: '', commissionRate: '',
  policyTermCommission: '', premiumForCommission: '', transactionPremium: '', effectiveDate: '', transactionCode: '',
  transactionType: 'new_business', section: '', ...o,
});

/** Page 1: four transactions (one negative endorsement). Synthetic sum of paid commission: 217.50. */
const TRANSACTIONS = [
  line({ insuredName: 'ANDERSON, MARK', policyNumber: 'HO 1234567', paidCommission: '45.00', commissionRate: '15%', premiumForCommission: '300.00', effectiveDate: '11/01/26', transactionCode: 'NEW', transactionType: 'new_business' }),
  line({ insuredName: 'BAKER HOME LLC', policyNumber: 'CP 2345678', paidCommission: '120.00', commissionRate: '15%', premiumForCommission: '800.00', effectiveDate: '11/05/26', transactionCode: 'REN', transactionType: 'continuation' }),
  // An insured whose name starts with "Total" is a real transaction: it has a policy number.
  line({ insuredName: 'TOTAL HOME SERVICES LLC', policyNumber: 'BOP 3456789', paidCommission: '60.00', commissionRate: '15%', premiumForCommission: '400.00', effectiveDate: '11/12/26', transactionCode: 'NEW', transactionType: 'new_business' }),
  line({ insuredName: 'CARTER, JEAN', policyNumber: 'HO 4567890', paidCommission: '7.50-', commissionRate: '15%', premiumForCommission: '50.00-', effectiveDate: '11/20/26', transactionCode: 'END', transactionType: 'endorsement' }),
];

/** What the reader returns for a statement with no printed carrier name and a page-2 summary. */
function smicAnswer(over: Record<string, unknown> = {}) {
  return {
    carrierName: '',
    agencyCode: '',
    statementMonth: '2026-11',
    statementDate: '11/30/26',
    totals: { commissionPayable: '217.50', monthCommissionPayable: '217.50', paymentReceived: '', premiumForCommission: '1,450.00', transactionPremium: '', ytdCommissionPayable: '2,418.75' },
    adjustments: [],
    sections: [],
    lines: TRANSACTIONS.map((l) => ({ ...l })),
    ...over,
  };
}

/** The same statement when the reader (wrongly) also lists the page-2 summary figures as rows. */
const SUMMARY_ROWS = [
  line({ page: 2, insuredName: 'MONTH TOTAL', paidCommission: '217.50', premiumForCommission: '1,450.00', transactionType: 'other' }),
  line({ page: 2, insuredName: 'YEAR TO DATE', paidCommission: '2,418.75', premiumForCommission: '16,125.00', transactionType: 'other' }),
  line({ page: 2, insuredName: '', policyNumber: 'YTD TOTALS', paidCommission: '2,418.75', transactionType: 'other' }),
];

function jsonReply(body: unknown) {
  return new Response(JSON.stringify({ stop_reason: 'end_turn', usage: { input_tokens: 5000, output_tokens: 1500 }, content: [{ type: 'text', text: JSON.stringify(body) }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}
function mockFetch(...responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); const r = responses.shift(); if (!r) throw new Error('unexpected call'); return r; }) as unknown as typeof fetch;
  return { f, calls };
}

const CARRIERS: PayerCandidate[] = [
  { id: 'smic', name: 'Security Mutual Ins Co', code: 'SECMUT', aliases: ['SMIC'], status: 'active' },
  { id: 'trav', name: 'Travelers', code: 'TRAV', aliases: ['Travelers Personal'], status: 'active' },
  { id: 'utica', name: 'Utica National Insurance Group', code: 'UTICA', aliases: ['Utica Mutual Ins Co'], status: 'active' },
  { id: 'old', name: 'Old Carrier', code: 'OLDC', aliases: ['Nov'], status: 'inactive' },
];

// ---------------------------------------------------------------------------
// 1. Empty carrier name

test('SMIC: a statement with no printed carrier name is accepted (was "carrierName: Too small")', async () => {
  assert.equal(aiStatementSchema.safeParse(smicAnswer()).success, true);
  const { f } = mockFetch(jsonReply(smicAnswer()));
  const res = await extractWithClaude({ apiKey: FAKE_KEY, input: pdfInput(), fetchImpl: f, sleep: noSleep });
  assert.equal(res.ok, true, res.ok ? '' : res.message);
  if (!res.ok) return;
  assert.equal(res.statement.carrierName, '', 'no carrier name is invented');
  assert.ok(res.statement.issues.some((i) => i.code === 'no_carrier_name' && i.level === 'warning'));
  assert.equal(res.statement.lines.length, 4);
});

test('SMIC: whitespace-only carrier name is treated as blank; a printed name is kept exactly', async () => {
  const { f } = mockFetch(jsonReply(smicAnswer({ carrierName: '   ' })), jsonReply(smicAnswer({ carrierName: 'Security Mutual Insurance Company' })));
  const a = await extractWithClaude({ apiKey: FAKE_KEY, input: pdfInput(), fetchImpl: f, sleep: noSleep });
  const b = await extractWithClaude({ apiKey: FAKE_KEY, input: pdfInput(), fetchImpl: f, sleep: noSleep });
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  assert.equal(a.statement.carrierName, '');
  assert.equal(b.statement.carrierName, 'Security Mutual Insurance Company');
  assert.ok(!b.statement.issues.some((i) => i.code === 'no_carrier_name'));
});

// ---------------------------------------------------------------------------
// 2. Transactions vs. monthly / year-to-date summary totals

test('SMIC: page-1 transactions reconcile exactly to the printed month total; YTD is informational only', async () => {
  const { f } = mockFetch(jsonReply(smicAnswer()));
  const res = await extractWithClaude({ apiKey: FAKE_KEY, input: pdfInput(), fetchImpl: f, sleep: noSleep });
  assert.ok(res.ok);
  if (!res.ok) return;
  const r = reconcileStatement(res.statement);
  assert.equal(r.reconciled, true, r.blockingReasons.join('; '));
  assert.equal(r.totals.commissionCents, 21750);
  assert.equal(r.totals.negativeCommissionCents, -750);
  assert.equal(res.statement.stated.ytdCommissionPayableCents, 241875);
  assert.ok(!res.statement.lines.some((l) => l.paidCommissionCents === 241875), 'YTD never becomes a line');
});

test('SMIC: summary totals listed as rows are kept out of the transactions and reported, not posted', async () => {
  const answer = smicAnswer({ lines: [...TRANSACTIONS, ...SUMMARY_ROWS].map((l) => ({ ...l })) });
  const { f } = mockFetch(jsonReply(answer));
  const res = await extractWithClaude({ apiKey: FAKE_KEY, input: pdfInput(), fetchImpl: f, sleep: noSleep });
  assert.ok(res.ok);
  if (!res.ok) return;
  const s = res.statement;
  assert.equal(s.lines.length, 4, 'only the four transactions are lines');
  assert.deepEqual(s.lines.map((l) => l.lineNo), [1, 2, 3, 4]);
  assert.deepEqual(s.lines.map((l) => l.policyNumberRaw), ['HO 1234567', 'CP 2345678', 'BOP 3456789', 'HO 4567890']);
  const excluded = s.issues.filter((i) => i.code === 'summary_row_excluded');
  assert.equal(excluded.length, 3);
  assert.ok(excluded.every((i) => i.level === 'warning'));
  assert.match(excluded[0].text, /Page 2: "MONTH TOTAL".*217\.50/);
  assert.match(excluded[1].text, /YEAR TO DATE.*2,418\.75/);
  const r = reconcileStatement(s);
  assert.equal(r.reconciled, true, r.blockingReasons.join('; '));
  assert.equal(r.totals.commissionCents, 21750, 'month and YTD totals are not added to commission');
});

test('SMIC: a YTD figure recorded as the statement total does not reconcile (never posted silently)', async () => {
  const answer = smicAnswer({ totals: { ...smicAnswer().totals, commissionPayable: '2,418.75', monthCommissionPayable: '2,418.75' } });
  const { f } = mockFetch(jsonReply(answer));
  const res = await extractWithClaude({ apiKey: FAKE_KEY, input: pdfInput(), fetchImpl: f, sleep: noSleep });
  assert.ok(res.ok);
  if (!res.ok) return;
  const r = reconcileStatement(res.statement);
  assert.equal(r.reconciled, false);
  assert.equal(r.checks.find((c) => c.key === 'commission')?.differenceCents, 21750 - 241875);
});

test('SMIC: summary rows with no totals recorded still block approval (nothing is inferred)', async () => {
  const answer = smicAnswer({
    totals: { commissionPayable: '', monthCommissionPayable: '', paymentReceived: '', premiumForCommission: '', transactionPremium: '', ytdCommissionPayable: '' },
    lines: [...TRANSACTIONS, ...SUMMARY_ROWS].map((l) => ({ ...l })),
  });
  const { f } = mockFetch(jsonReply(answer));
  const res = await extractWithClaude({ apiKey: FAKE_KEY, input: pdfInput(), fetchImpl: f, sleep: noSleep });
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.ok(res.statement.issues.some((i) => i.code === 'no_total' && i.level === 'error'));
  assert.equal(res.statement.stated.commissionPayableCents, null, 'an excluded summary row never becomes the stated total');
  assert.equal(reconcileStatement(res.statement).reconciled, false);
});

test('summary-row detection: only rows without any policy-number digits that are labelled as totals', () => {
  assert.equal(isSummaryRow({ insuredName: 'MONTH TOTAL', policyNumber: '' }), true);
  assert.equal(isSummaryRow({ insuredName: 'Year-to-Date', policyNumber: '' }), true);
  assert.equal(isSummaryRow({ insuredName: '', policyNumber: 'YTD', transactionCode: '' }), true);
  assert.equal(isSummaryRow({ insuredName: 'Grand Total', policyNumber: '—' }), true);
  assert.equal(isSummaryRow({ insuredName: 'TOTAL HOME SERVICES LLC', policyNumber: 'BOP 3456789' }), false);
  assert.equal(isSummaryRow({ insuredName: 'Summary Farms Inc', policyNumber: 'FP 99881' }), false);
  assert.equal(isSummaryRow({ insuredName: 'ANDERSON, MARK', policyNumber: '' }), false, 'a missing policy number alone is not a total');
  assert.equal(isSummaryRow({ insuredName: 'Totalis Corp', policyNumber: '' }), false, 'whole words only');
});

// ---------------------------------------------------------------------------
// 3. Carrier from the file name and existing aliases

test('SMIC: "SMIC Nov 26.pdf" suggests Security Mutual Ins Co via its alias, and always needs confirmation', () => {
  const h = suggestPayerFromFileName('SMIC Nov 26.pdf', CARRIERS);
  assert.equal(h.kind, 'suggested');
  if (h.kind !== 'suggested') return;
  assert.equal(h.suggestion.payerId, 'smic');
  assert.equal(h.suggestion.payerName, 'Security Mutual Ins Co');
  assert.equal(h.suggestion.matchedOn, 'alias');
  assert.equal(h.suggestion.matchedTerm, 'SMIC');
  assert.equal(h.suggestion.needsConfirmation, true);
  assert.equal(h.suggestion.source, 'file_name');
  assert.match(h.note, /does not print a carrier name/);
  assert.match(h.note, /Confirm/);
});

test('file-name suggestion: separators, case, code and full name', () => {
  for (const name of ['smic_nov_26.pdf', 'SMIC-Nov-26.PDF', '2026-11 SMIC statement.pdf', 'SECMUT Nov.pdf', 'Security Mutual Ins Co Nov 26.pdf']) {
    const h = suggestPayerFromFileName(name, CARRIERS);
    assert.equal(h.kind === 'suggested' && h.suggestion.payerId, 'smic', name);
  }
});

test('file-name suggestion: no guess when uncertain', () => {
  assert.equal(suggestPayerFromFileName('Nov 26.pdf', CARRIERS).kind, 'none', 'inactive carrier alias and month words ignored');
  assert.equal(suggestPayerFromFileName('SMICX Nov 26.pdf', CARRIERS).kind, 'none', 'whole words only');
  assert.equal(suggestPayerFromFileName('Insurance Commission Statement Nov.pdf', CARRIERS).kind, 'none', 'generic words never identify a carrier');
  assert.equal(suggestPayerFromFileName('Mutual Ins Co.pdf', CARRIERS).kind, 'none');
  assert.equal(suggestPayerFromFileName('scan0001.pdf', CARRIERS).kind, 'none');
  assert.equal(suggestPayerFromFileName('SMIC Nov 26.pdf', []).kind, 'none', 'nothing is created');
  const two = suggestPayerFromFileName('SMIC Travelers Nov.pdf', CARRIERS);
  assert.equal(two.kind, 'ambiguous');
  const dup = suggestPayerFromFileName('SMIC Nov 26.pdf', [...CARRIERS, { id: 'smic2', name: 'Somerset Mutual', code: 'SOM', aliases: ['SMIC'] }]);
  assert.equal(dup.kind, 'ambiguous');
  if (dup.kind === 'ambiguous') assert.deepEqual(dup.candidates.map((c) => c.id).sort(), ['smic', 'smic2']);
});

// ---------------------------------------------------------------------------
// 4. Scanned and rotated PDFs (original sent unchanged)

test('SMIC: a sideways scan is sent unchanged with a layout note; text PDFs get no note', () => {
  const scan = { imageOnly: true, layout: [{ page: 1, rotate: 90, landscape: true }, { page: 2, rotate: 90, landscape: true }] };
  const input = pdfInput(scan);
  const req = buildAiRequest('claude-sonnet-5-5', input, 32000) as { system: string; messages: { content: { type: string; text?: string; source?: { data: string } }[] }[] };
  const [doc, ask] = req.messages[0].content;
  assert.equal(doc.type, 'document');
  assert.equal(doc.source?.data, (input as { base64: string }).base64, 'the PDF bytes are sent exactly as stored');
  assert.match(ask.text ?? '', /no text layer/);
  assert.match(ask.text ?? '', /Pages 1, 2 are stored with a rotation/);
  assert.match(ask.text ?? '', /upright orientation/);
  assert.match(req.system, /scanned sideways/);
  assert.match(req.system, /year-to-date totals/);
  assert.match(req.system, /leave carrierName ""/);

  const plain = buildAiRequest('m', pdfInput({ imageOnly: false, layout: [{ page: 1, rotate: 0, landscape: false }] }), 1000) as { messages: { content: { text?: string }[] }[] };
  assert.equal(plain.messages[0].content[1].text, 'Extract this commission statement as JSON matching the required schema.');
  assert.equal(scanNote(undefined), null);
  assert.match(scanNote({ imageOnly: false, layout: [{ page: 2, rotate: 0, landscape: true }] }) ?? '', /^Page 2 is landscape/);
  assert.equal(AI_PROMPT_VERSION, 'statement-extract-v4');
  assert.match(JSON.stringify(STATEMENT_SCHEMA), /Never a year-to-date figure/);
});

test('page layout: /Rotate and media box give the displayed orientation', () => {
  assert.deepEqual(pageLayout(1, 0, [0, 0, 612, 792]), { page: 1, rotate: 0, landscape: false });
  assert.deepEqual(pageLayout(1, 0, [0, 0, 792, 612]), { page: 1, rotate: 0, landscape: true });
  assert.deepEqual(pageLayout(1, 90, [0, 0, 612, 792]), { page: 1, rotate: 90, landscape: true });
  assert.deepEqual(pageLayout(1, 270, [0, 0, 792, 612]), { page: 1, rotate: 270, landscape: false });
  assert.deepEqual(pageLayout(1, -90, [0, 0, 612, 792]), { page: 1, rotate: 270, landscape: true });
  assert.deepEqual(pageLayout(1, undefined, undefined), { page: 1, rotate: 0, landscape: false });
});

test('SMIC: an image-only, rotated two-page PDF is detected as a scan with its layout', async () => {
  const pdf = await PDFDocument.create();
  const p1 = pdf.addPage([612, 792]); p1.setRotation(degrees(90)); // portrait page turned sideways
  p1.drawRectangle({ x: 50, y: 50, width: 200, height: 100 }); // graphics only, no text layer (like a scan)
  pdf.addPage([792, 612]); // landscape page, no rotation
  const bytes = await pdf.save();
  const t = await pdfToTextLines(bytes);
  assert.equal(t.pageCount, 2);
  assert.equal(t.hasText, false);
  assert.deepEqual(t.layout, [{ page: 1, rotate: 90, landscape: true }, { page: 2, rotate: 0, landscape: true }]);
  const note = scanNote({ imageOnly: !t.hasText, layout: t.layout });
  assert.match(note ?? '', /Page 1 is stored with a rotation/);
  assert.match(note ?? '', /Pages 1, 2 are landscape/);
});
