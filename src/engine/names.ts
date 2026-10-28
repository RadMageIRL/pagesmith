// Pure helpers shared by the UI thread and the engine worker (no pdf-lib import here, so the UI
// bundle stays free of it).

/** Untrusted filename → something safe to show and to reuse in download names. */
export function cleanFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = String(name || '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  return (cleaned || 'document.pdf').slice(0, 180);
}

/** "Quarterly Report.pdf" → "Quarterly Report". Strips characters invalid in Windows/Unix filenames. */
export function baseName(name: string): string {
  const stem = cleanFileName(name).replace(/\.pdf$/i, '');
  const safe = stem.replace(/[<>:"/\\|?*]+/g, '-').replace(/\s+/g, ' ').replace(/^[.\s-]+|[.\s]+$/g, '');
  return safe.slice(0, 80) || 'document';
}

/** Standard page sizes in points, for blank-page insertion. */
export const PAGE_SIZES: Record<string, [number, number]> = {
  Letter: [612, 792],
  Legal: [612, 1008],
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  A3: [841.89, 1190.55],
  Tabloid: [792, 1224],
};
