/**
 * Page-range parsing for split/extract. Input is 1-based and human-written:
 *   "1-3, 5, 8-"   → [[1,2,3],[5],[8..last]]
 *   "-2"           → [[1,2]]
 * Each comma-separated group becomes one output document when splitting.
 */
export class PageRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageRangeError';
  }
}

export function parseRanges(input: string, pageCount: number): number[][] {
  const text = input.trim();
  if (!text) throw new PageRangeError('Enter at least one page or range, for example 1-3, 5.');
  const groups: number[][] = [];
  for (const raw of text.split(/[,;]+/)) {
    const part = raw.trim();
    if (!part) continue;
    const match = /^(\d*)\s*(?:[-–]\s*(\d*))?$/.exec(part);
    if (!match || (!match[1] && match[2] === undefined)) throw new PageRangeError(`"${part}" is not a page or range.`);
    const isRange = part.includes('-') || part.includes('–');
    const start = match[1] ? Number(match[1]) : 1;
    const end = isRange ? (match[2] ? Number(match[2]) : pageCount) : start;
    if (start < 1 || end < 1) throw new PageRangeError('Pages are numbered from 1.');
    if (start > pageCount || end > pageCount) throw new PageRangeError(`"${part}" goes past the last page (${pageCount}).`);
    if (end < start) throw new PageRangeError(`"${part}" runs backwards.`);
    const group: number[] = [];
    for (let n = start; n <= end; n++) group.push(n);
    groups.push(group);
  }
  if (!groups.length) throw new PageRangeError('Enter at least one page or range, for example 1-3, 5.');
  return groups;
}

/** Splits into consecutive chunks of `size` pages: every 2 pages of 5 → [[1,2],[3,4],[5]]. */
export function chunkPages(pageCount: number, size: number): number[][] {
  if (!Number.isInteger(size) || size < 1) throw new PageRangeError('Chunk size must be a whole number of at least 1.');
  const groups: number[][] = [];
  for (let start = 1; start <= pageCount; start += size) {
    const group: number[] = [];
    for (let n = start; n < start + size && n <= pageCount; n++) group.push(n);
    groups.push(group);
  }
  return groups;
}

/** [1,2,3,5,7,8] → "1-3_5_7-8" for filenames. */
export function describePages(pages: number[]): string {
  const sorted = [...pages].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i] + 1) i++;
    out.push(start === sorted[i] ? `${start}` : `${start}-${sorted[i]}`);
  }
  return out.join('_');
}
