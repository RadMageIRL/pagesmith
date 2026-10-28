import { PDFDocument } from '@cantoo/pdf-lib';
import { cleanFileName } from './names';
import { PdfLoadError, checkCancelled, newId, normalizeRotation, type PageInfo, type Protection, type SourceDoc } from './types';

/** Hard ceiling so a single drop can't exhaust the tab's memory. */
export const MAX_FILE_BYTES = 512 * 1024 * 1024;
/** Objects parsed per event-loop turn; lower = more responsive to cancel, slower overall. */
const PARSE_SPEED = 600;

export interface LoadedSource {
  source: SourceDoc;
  doc: PDFDocument;
}

export interface LoadOptions {
  /**
   * undefined: try without a password. A string (including '') is used to decrypt. Owner-restricted
   * files open with '', but only after the user has explicitly agreed (see 'restricted').
   */
  password?: string;
  signal?: AbortSignal;
}

/** PDF headers may be preceded by junk, but the spec tolerance is the first 1024 bytes. */
export function hasPdfHeader(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length - 5, 1024);
  for (let i = 0; i <= limit; i++) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) return true;
  }
  return false;
}

/**
 * Parses a file with pdf-lib. Throws PdfLoadError with a user-presentable message.
 *
 * Encryption is never ignored: an encrypted file either needs the user's password, or - when it
 * only carries owner restrictions - the caller must confirm and pass password '' explicitly.
 */
export async function loadSource(bytes: Uint8Array, name: string, options: LoadOptions = {}): Promise<LoadedSource> {
  if (bytes.length > MAX_FILE_BYTES) throw new PdfLoadError('too-large', 'This file is larger than 512 MB.');
  if (!hasPdfHeader(bytes)) throw new PdfLoadError('not-pdf', 'This file is not a PDF.');
  let doc: PDFDocument;
  let protection: Protection = 'none';
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false, parseSpeed: PARSE_SPEED, ignoreEncryption: true });
  } catch {
    checkCancelled(options.signal);
    throw new PdfLoadError('corrupt', 'This PDF is damaged or uses a structure PageSmith cannot read.');
  }
  checkCancelled(options.signal);
  if (doc.isEncrypted) {
    if (options.password === undefined) {
      const ownerOnly = await PDFDocument.load(bytes, { updateMetadata: false, parseSpeed: PARSE_SPEED, password: '' }).then(() => true, () => false);
      checkCancelled(options.signal);
      if (ownerOnly) throw new PdfLoadError('restricted', 'This PDF has usage restrictions set by its author.');
      throw new PdfLoadError('needs-password', 'This PDF is password-protected.');
    }
    try {
      doc = await PDFDocument.load(bytes, { updateMetadata: false, parseSpeed: PARSE_SPEED, password: options.password });
    } catch {
      checkCancelled(options.signal);
      throw new PdfLoadError('bad-password', 'That password is not correct.');
    }
    protection = options.password === '' ? 'restrictions' : 'password';
  }
  let pages: PageInfo[];
  try {
    pages = doc.getPages().map(page => {
      const box = page.getCropBox();
      return { x: box.x, y: box.y, width: Math.abs(box.width), height: Math.abs(box.height), rotation: normalizeRotation(page.getRotation().angle) };
    });
  } catch {
    throw new PdfLoadError('corrupt', 'This PDF is damaged: its page tree could not be read.');
  }
  if (!pages.length) throw new PdfLoadError('empty', 'This PDF has no pages.');
  if (pages.some(p => !Number.isFinite(p.width) || !Number.isFinite(p.height) || p.width <= 0 || p.height <= 0)) {
    throw new PdfLoadError('corrupt', 'This PDF has a page with invalid dimensions.');
  }
  return { source: { id: newId('s'), name: cleanFileName(name), pages, protection }, doc };
}

/** A one-page document of the given size, used for blank-page insertion. */
export async function createBlank(width: number, height: number): Promise<{ loaded: LoadedSource; bytes: Uint8Array }> {
  const w = Math.min(14400, Math.max(36, width)), h = Math.min(14400, Math.max(36, height));
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.addPage([w, h]);
  const bytes = await doc.save();
  return { loaded: { source: { id: newId('b'), name: 'Blank page', pages: [{ x: 0, y: 0, width: w, height: h, rotation: 0 }], protection: 'none', generated: true }, doc }, bytes };
}

export { PAGE_SIZES, baseName, cleanFileName } from './names';
