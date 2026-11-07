import { readFileSync } from 'node:fs';

/**
 * Renders the anonymized Travelers fixture into a PDF with the same text layout as the
 * carrier's statement ("¡"-separated columns, repeated page headers, totals block, footer),
 * so tests exercise the real pipeline: PDF bytes → text extraction → parser → reconciliation.
 */

export interface TravelersFixture {
  carrierTitle: string;
  monthLine: string;
  agencyName: string;
  agencyCode: string;
  statementDate: string;
  rows: string[][];
  totals: { paymentReceived: string; paidCommission: string; premiumForCommission: string; fee: string; transactionPremium: string };
  summary: { plBusinessOnly: string; policyholdersFee: string; combined: string; reportSharedCost: string; rsaAdjustment: string; monthPayable: string; ytdPayable: string };
}

export function loadFixture(): TravelersFixture {
  return JSON.parse(readFileSync(new URL('../fixtures/travelers-pl-dec2025-anonymized.json', import.meta.url), 'utf8'));
}

const S = ' ¡ ';

export function fixtureToPages(f: TravelersFixture, rowsPerPage = 24): string[][] {
  const header = [
    f.carrierTitle,
    f.monthLine,
    `AGENT: ${f.agencyName} ¡AGENT CODE: ${f.agencyCode}¡SEC AGT: ${f.agencyCode} ${f.agencyName} ¡`,
    `NAME OF INSURED${S}POLICY NUMBER${S}PAYMENT${S}PAID${S}COMM${S}POLICY TERM${S}PREMIUM FOR${S}POL-EFF-DT${S}PMT${S}POLHOLDERS${S}TRANSACTION`,
    `${S}${S}RECEIVED${S}COMMISSION${S}RATE${S}COMMISSION${S}COMMISSION${S}TRANS-CODE${S}MTD${S}SRVS FEE${S}PREMIUM`,
  ];
  const pages: string[][] = [];
  for (let i = 0; i < f.rows.length; i += rowsPerPage) {
    const page = [...header, ...f.rows.slice(i, i + rowsPerPage).map((r) => r.join(S))];
    pages.push(page);
  }
  const t = f.totals;
  pages[pages.length - 1].push(
    ['TOTAL COMMISSION PAYABLE PL', t.paymentReceived, t.paidCommission, '', '', t.premiumForCommission, '', '', t.fee, t.transactionPremium].join(S),
    `POLICYHOLDERS SERVICES FEE ${f.summary.policyholdersFee}`,
    `SECONDARY AGENT TOTAL ${f.summary.combined}`,
  );
  const s = f.summary;
  pages.push([
    f.carrierTitle, f.monthLine, `AGENT: ${f.agencyName} ¡AGENT CODE: ${f.agencyCode}¡`,
    `TOTAL COMMISSION PAYABLE - PL BUSINESS ONLY ${s.plBusinessOnly}`,
    '( ABOVE INCLUDES SUB AND SEC AGENTS )',
    `POLICYHOLDERS SERVICES FEE ${s.policyholdersFee}`,
    `COMBINED CURRENT MONTH TOTAL COMMISSION ${s.combined}`,
    `REPORT SHARED COST ${s.reportSharedCost}`,
    `RSA NEW BUSINESS COMMISSION ADJUSTMENT ${s.rsaAdjustment}`,
    `TOTAL MONTH COMMISSION PAYABLE $${s.monthPayable} TOTAL YEAR TO DATE COMMISSION PAYABLE $${s.ytdPayable}`,
    'PAYMENT METHOD I - COMMISSION PAID ON FIRST INSTALLMENT',
  ]);
  pages.forEach((p, i) => p.push(`${String(i + 1).padStart(5, '0')}/${String(i + 1).padStart(5, '0')}/${String(pages.length).padStart(5, '0')} 00000 0000 SYNTEST ${f.statementDate}`));
  return pages;
}

/** Build a real PDF (Courier, landscape) whose text layer reproduces the pages. */
export async function fixtureToPdf(pages: string[][]): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Courier);
  for (const lines of pages) {
    const page = doc.addPage([1008, 612]);
    let y = 590;
    for (const line of lines) {
      page.drawText(line, { x: 20, y, size: 6.5, font });
      y -= 16;
    }
  }
  return doc.save();
}
