// Independent PDF readers for verification: PDFium (Chrome's PDF engine, WASM build) and Xpdf's
// pdftotext (if installed). Neither shares code with pdf-lib (which writes the files) or pdf.js
// (which PageSmith previews with), so they catch problems those libraries would agree on.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium';

let pdfium: Promise<WrappedPdfiumModule> | null = null;
function loadPdfium(): Promise<WrappedPdfiumModule> {
  pdfium ??= (async () => {
    const require = createRequire(import.meta.url);
    const wasmBinary = readFileSync(require.resolve('@embedpdf/pdfium/pdfium.wasm'));
    const m = await init({ wasmBinary: wasmBinary.buffer.slice(wasmBinary.byteOffset, wasmBinary.byteOffset + wasmBinary.byteLength) as ArrayBuffer });
    m.PDFiumExt_Init();
    return m;
  })();
  return pdfium;
}

export interface PdfiumPage {
  width: number;
  height: number;
  text: string;
  /** RGB at (x, y) in points from the top-left of the page as displayed (after /Rotate). */
  pixel(x: number, y: number): [number, number, number];
}

/** Opens a PDF with PDFium and returns per-page size, text and a rendered bitmap (1 px = 1 pt). */
export async function readWithPdfium(bytes: Uint8Array, password = ''): Promise<PdfiumPage[]> {
  const m = await loadPdfium();
  const heap = () => (m.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8;
  const malloc = m.pdfium.wasmExports.malloc, free = m.pdfium.wasmExports.free;
  const data = malloc(bytes.length);
  heap().set(bytes, data);
  const doc = m.FPDF_LoadMemDocument(data, bytes.length, password);
  if (!doc) { free(data); throw new Error(`PDFium could not open the file (error ${m.FPDF_GetLastError()})`); }
  const pages: PdfiumPage[] = [];
  try {
    const count = m.FPDF_GetPageCount(doc);
    for (let i = 0; i < count; i++) {
      const page = m.FPDF_LoadPage(doc, i);
      const width = m.FPDF_GetPageWidthF(page), height = m.FPDF_GetPageHeightF(page);
      const textPage = m.FPDFText_LoadPage(page);
      const chars = m.FPDFText_CountChars(textPage);
      let text = '';
      if (chars > 0) {
        // malloc'd memory isn't zeroed; clear it so the string always ends at a NUL.
        const buf = malloc((chars + 1) * 2);
        heap().fill(0, buf, buf + (chars + 1) * 2);
        m.FPDFText_GetText(textPage, 0, chars, buf);
        text = m.pdfium.UTF16ToString(buf);
        free(buf);
      }
      m.FPDFText_ClosePage(textPage);
      const w = Math.round(width), h = Math.round(height);
      const bitmap = m.FPDFBitmap_Create(w, h, 0);
      m.FPDFBitmap_FillRect(bitmap, 0, 0, w, h, 0xffffffff);
      m.FPDF_RenderPageBitmap(bitmap, page, 0, 0, w, h, 0, 0);
      const stride = m.FPDFBitmap_GetStride(bitmap);
      const pixels = heap().slice(m.FPDFBitmap_GetBuffer(bitmap), m.FPDFBitmap_GetBuffer(bitmap) + stride * h);
      m.FPDFBitmap_Destroy(bitmap);
      m.FPDF_ClosePage(page);
      pages.push({
        width, height, text,
        pixel: (x, y) => {
          const o = Math.floor(y) * stride + Math.floor(x) * 4; // BGRA
          return [pixels[o + 2], pixels[o + 1], pixels[o]];
        },
      });
    }
  } finally {
    m.FPDF_CloseDocument(doc);
    free(data);
  }
  return pages;
}

/** True when Xpdf/Poppler pdftotext is on PATH. */
export const hasPdftotext = spawnSync('pdftotext', ['-v'], { encoding: 'utf8' }).error === undefined;

/** Text per page via pdftotext (pages are separated by form feeds). */
export function readWithPdftotext(bytes: Uint8Array): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'pagesmith-xpdf-'));
  try {
    const file = join(dir, 'in.pdf');
    writeFileSync(file, bytes);
    const result = spawnSync('pdftotext', ['-enc', 'UTF-8', file, '-'], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`pdftotext failed: ${result.stderr}`);
    const pages = result.stdout.split('\f');
    if (pages.at(-1)?.trim() === '') pages.pop();
    return pages;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
