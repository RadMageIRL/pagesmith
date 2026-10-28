import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument } from '@cantoo/pdf-lib';
import { MAX_FILE_BYTES, PAGE_SIZES, baseName, cleanFileName, createBlank, hasPdfHeader, loadSource } from '../../src/engine/load';
import { CancelledError, PdfLoadError } from '../../src/engine/types';
import { chunkPages, describePages, parseRanges } from '../../src/engine/ranges';
import { OWNER_PASSWORD, USER_PASSWORD, encryptWithQpdf, latin1, letter, makeCorruptPdf, makeEncryptedPdf, makeFormPdf, makePdf, makeTruncatedPdf, type EncryptionScheme } from '../fixtures';

async function loadError(bytes: Uint8Array, password?: string): Promise<PdfLoadError> {
  try {
    await loadSource(bytes, 'x.pdf', { password });
  } catch (err) {
    expect(err).toBeInstanceOf(PdfLoadError);
    return err as PdfLoadError;
  }
  throw new Error('expected load to fail');
}

async function pdfjsText(bytes: Uint8Array): Promise<string[]> {
  const task = getDocument({ data: bytes.slice(), verbosity: 0 });
  const doc = await task.promise;
  const out: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) out.push((await (await doc.getPage(n)).getTextContent()).items.map(i => ('str' in i ? i.str : '')).join(''));
  await task.destroy();
  return out;
}

describe('loadSource', () => {
  it('loads a single-page PDF', async () => {
    const { source } = await loadSource(await letter(1), 'one.pdf');
    expect(source.pages).toHaveLength(1);
    expect(source.pages[0]).toMatchObject({ width: 612, height: 792, rotation: 0 });
    expect(source.name).toBe('one.pdf');
    expect(source.protection).toBe('none');
  });

  it('loads a multi-page PDF with mixed sizes and existing rotation', async () => {
    const bytes = await makePdf([{ width: 612, height: 792 }, { width: 842, height: 595, rotation: 90 }, { width: 300, height: 300 }]);
    const { source } = await loadSource(bytes, 'mixed.pdf');
    expect(source.pages.map(p => [p.width, p.height, p.rotation])).toEqual([[612, 792, 0], [842, 595, 90], [300, 300, 0]]);
  });

  it('rejects non-PDF data', async () => {
    expect((await loadError(latin1('hello world, definitely not a pdf'))).code).toBe('not-pdf');
    expect((await loadError(new Uint8Array())).code).toBe('not-pdf');
  });

  it('rejects corrupt and truncated PDFs without throwing anything else', async () => {
    expect(['corrupt', 'empty']).toContain((await loadError(makeCorruptPdf())).code);
    expect(['corrupt', 'empty']).toContain((await loadError(await makeTruncatedPdf())).code);
  });

  it('reports a form, and the parts of it that cannot carry over into an export', async () => {
    expect((await loadSource(await letter(1), 'plain.pdf')).source.form).toBeUndefined();
    expect((await loadSource(await makeFormPdf(), 'form.pdf')).source.form).toEqual({ xfa: false, signed: false });
    expect((await loadSource(await makeFormPdf({ xfa: true }), 'form.pdf')).source.form).toEqual({ xfa: true, signed: false });
    expect((await loadSource(await makeFormPdf({ signed: true }), 'form.pdf')).source.form).toEqual({ xfa: false, signed: true });
  });

  it('reports a file the parser itself rejects as damaged', async () => {
    // Passes the header check, but pdf-lib cannot parse the version number.
    const err = await loadError(latin1('%PDF-x.y\n1 0 obj\n<<>>\nendobj\n'));
    expect(err.code).toBe('corrupt');
    expect(err.message).toBe('This PDF is damaged or uses a structure PageSmith cannot read.');
  });

  it('rejects files over 512 MB before reading them, and accepts exactly 512 MB', async () => {
    // Only the length is read before the size check, so a stand-in avoids allocating 512 MB.
    const ofLength = (length: number) => ({ length }) as unknown as Uint8Array;
    expect(MAX_FILE_BYTES).toBe(512 * 1024 * 1024);
    expect((await loadError(ofLength(MAX_FILE_BYTES + 1))).code).toBe('too-large');
    // At the limit the size check passes and the (empty) stand-in fails the header check instead.
    expect((await loadError(ofLength(MAX_FILE_BYTES))).code).toBe('not-pdf');
  });

  it('loads the same file repeatedly as independent sources', async () => {
    const bytes = await letter(2);
    const loaded = await Promise.all(Array.from({ length: 5 }, () => loadSource(bytes, 'same.pdf')));
    expect(new Set(loaded.map(s => s.source.id)).size).toBe(5);
    loaded.forEach(s => expect(s.source.pages).toHaveLength(2));
  });

  it('stops when canceled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(loadSource(await letter(3), 'x.pdf', { signal: controller.signal })).rejects.toBeInstanceOf(CancelledError);
  });

  it('finds headers preceded by junk', () => {
    expect(hasPdfHeader(latin1('junk junk %PDF-1.4 ...'))).toBe(true);
    expect(hasPdfHeader(latin1('PDF-1.4'))).toBe(false);
  });
});

// Fixtures are encrypted by qpdf, an implementation independent of the pdf-lib fork under test,
// and decrypted output is checked with pdf.js - a third implementation.
describe('encrypted PDFs', () => {
  const schemes: EncryptionScheme[] = ['rc4-40', 'rc4-128', 'aes-128', 'aes-256'];

  it.each(schemes)('%s: asks for a password, rejects a wrong one, and unlocks with the right one', async scheme => {
    const original = await letter(2, 'E');
    const bytes = await encryptWithQpdf(original, scheme);
    expect((await loadError(bytes)).code).toBe('needs-password');
    expect((await loadError(bytes, 'wrong')).code).toBe('bad-password');
    expect((await loadError(bytes, '')).code).toBe('bad-password');
    const { source, doc } = await loadSource(bytes, 'locked.pdf', { password: USER_PASSWORD });
    expect(source.protection).toBe('password');
    const out = await PDFDocument.create();
    (await out.copyPages(doc, doc.getPageIndices())).forEach(p => out.addPage(p));
    expect(await pdfjsText(await out.save())).toEqual(['E1', 'E2']);
  });

  it('accepts the owner password too', async () => {
    const { source } = await loadSource(await makeEncryptedPdf('aes-256'), 'x.pdf', { password: OWNER_PASSWORD });
    expect(source.pages).toHaveLength(2);
  });

  it('reports owner-restricted files instead of silently opening them', async () => {
    const bytes = await makeEncryptedPdf('owner-only');
    const err = await loadError(bytes);
    expect(err.code).toBe('restricted');
    // Only an explicit, consented empty password opens it.
    const { source } = await loadSource(bytes, 'restricted.pdf', { password: '' });
    expect(source.protection).toBe('restrictions');
  });
});

describe('blank pages', () => {
  it('creates a one-page document of the requested size, clamped to sane bounds', async () => {
    const { loaded, bytes } = await createBlank(...PAGE_SIZES.A4);
    expect(loaded.source.generated).toBe(true);
    expect(loaded.source.pages[0].width).toBeCloseTo(595.28);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    expect((await createBlank(1, 99999)).loaded.source.pages[0]).toMatchObject({ width: 36, height: 14400 });
  });
});

describe('file names', () => {
  it('strips control and bidi-override characters', () => {
    expect(cleanFileName('ev\u202eil\u0007.pdf')).toBe('evil.pdf');
    expect(cleanFileName('')).toBe('document.pdf');
  });
  it('produces safe base names', () => {
    expect(baseName('Quarterly Report.PDF')).toBe('Quarterly Report');
    expect(baseName('../../etc/passwd')).toBe('etc-passwd');
    expect(baseName('a<b>:c?.pdf')).toBe('a-b-c-');
    expect(baseName('.pdf')).toBe('document');
  });
});

describe('parseRanges', () => {
  it('parses pages, ranges and open ranges', () => {
    expect(parseRanges('1-3, 5, 8-', 10)).toEqual([[1, 2, 3], [5], [8, 9, 10]]);
    expect(parseRanges('-2', 5)).toEqual([[1, 2]]);
    expect(parseRanges(' 4 ; 2 – 3 ', 5)).toEqual([[4], [2, 3]]);
  });
  it('rejects invalid input with helpful messages', () => {
    expect(() => parseRanges('', 5)).toThrow(/at least one/);
    expect(() => parseRanges('0', 5)).toThrow(/from 1/);
    expect(() => parseRanges('3-9', 5)).toThrow(/past the last page/);
    expect(() => parseRanges('4-2', 5)).toThrow(/backwards/);
    expect(() => parseRanges('abc', 5)).toThrow(/not a page/);
  });
  it('chunks and describes pages', () => {
    expect(chunkPages(5, 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(() => chunkPages(5, 0)).toThrow();
    expect(describePages([7, 1, 2, 3, 5, 8])).toBe('1-3_5_7-8');
  });
});
