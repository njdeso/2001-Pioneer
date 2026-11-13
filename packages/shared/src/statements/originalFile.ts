/**
 * Access to a statement's original file (the uploaded PDF / workbook). The original is evidence, not part
 * of the financial record: it can be viewed or downloaded in EVERY status — pending, approved, posted —
 * whenever it was stored. Viewing never changes the statement, its lines or its posting.
 */
export type OriginalFileAccess = { available: true } | { available: false; reason: string };

export function originalFileAccess(s: { status: string; originalPath?: string | null }): OriginalFileAccess {
  if (typeof s.originalPath === 'string' && s.originalPath.trim()) return { available: true };
  if (s.status === 'awaiting_upload') return { available: false, reason: 'The original file has not been uploaded yet.' };
  if (s.status === 'processing') return { available: false, reason: 'The original file is still being stored. Try again in a moment.' };
  return { available: false, reason: 'The original file was never stored for this statement (the upload did not complete), so it cannot be shown. Upload the statement again if you need the file.' };
}

/** Content-Disposition for the signed link: inline to view, attachment to download. */
export function originalFileDisposition(fileName: unknown, download: boolean): string {
  const name = String(fileName ?? 'statement').replace(/["\\\r\n]/g, '').trim() || 'statement';
  return `${download ? 'attachment' : 'inline'}; filename="${name}"`;
}
