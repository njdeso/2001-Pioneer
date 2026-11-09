/**
 * PDF → text lines, page by page, using pdfjs-dist (server side). Exposed as
 * "@asm/shared/pdf" so only Cloud Functions load pdfjs.
 *
 * Security: untrusted PDFs are parsed with eval disabled and no font loading/rendering;
 * only the text layer is read.
 */

export interface PdfText {
  pages: string[][];
  pageCount: number;
  /** False when the PDF has (almost) no text layer — e.g. a scan — and needs AI. */
  hasText: boolean;
}

interface TextItem { str: string; transform: number[] }

export async function pdfToTextLines(data: Uint8Array, maxPages = 60): Promise<PdfText> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
    getDocument(opts: Record<string, unknown>): { promise: Promise<{ numPages: number; getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }> }>; destroy(): Promise<void> };
  };
  const task = pdfjs.getDocument({
    data: new Uint8Array(data), // pdfjs takes ownership of the buffer
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    if (doc.numPages > maxPages) throw new Error(`PDF has ${doc.numPages} pages; the limit is ${maxPages}`);
    const pages: string[][] = [];
    let chars = 0;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const rows = new Map<number, { x: number; s: string }[]>();
      for (const item of content.items as TextItem[]) {
        if (typeof item?.str !== 'string' || !item.str) continue;
        const y = Math.round(item.transform[5]);
        const key = [...rows.keys()].find((k) => Math.abs(k - y) <= 1) ?? y;
        const row = rows.get(key) ?? [];
        row.push({ x: item.transform[4], s: item.str });
        rows.set(key, row);
      }
      const lines = [...rows.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([, items]) => items.sort((a, b) => a.x - b.x).map((i) => i.s).join(' ').replace(/\s+$/, ''));
      chars += lines.join('').replace(/\s/g, '').length;
      pages.push(lines);
    }
    return { pages, pageCount: doc.numPages, hasText: chars >= 40 * Math.max(1, doc.numPages) / 4 };
  } finally {
    await task.destroy();
  }
}
