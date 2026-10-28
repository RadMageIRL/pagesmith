// Core document model. Nothing in src/engine, src/commands, src/overlay or src/export touches the
// DOM; the PDF-manipulating parts run inside the engine Web Worker (src/worker).

export type Rotation = 0 | 90 | 180 | 270;

/** Geometry of one page as stored in the source file (before any PageSmith rotation). */
export interface PageInfo {
  /** Crop box origin and size, in PDF points. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The page's own /Rotate value. */
  rotation: Rotation;
}

/**
 * How a source was protected when opened. Unlocked sources are decrypted in memory only; exports
 * are written unencrypted and the UI says so.
 */
export type Protection = 'none' | 'password' | 'restrictions';

/** A loaded input file, as the UI sees it. The bytes live in the engine worker, not here. */
export interface SourceDoc {
  id: string;
  name: string;
  pages: PageInfo[];
  protection: Protection;
  /** True for pages PageSmith created (blank pages). */
  generated?: boolean;
  /**
   * Set when the file has an interactive form. Its fields carry over into exports; an XFA layer
   * doesn't, and a digital signature can't survive being written into a new file.
   */
  form?: { xfa: boolean; signed: boolean };
}

/** One page in the working document: a pointer into a source plus PageSmith's extra rotation. */
export interface PageRef {
  id: string;
  sourceId: string;
  sourceIndex: number;
  /** Rotation added by the user, on top of the page's own /Rotate. */
  rotation: Rotation;
}

export type LoadErrorCode = 'not-pdf' | 'corrupt' | 'needs-password' | 'bad-password' | 'restricted' | 'empty' | 'too-large' | 'cancelled';

export class PdfLoadError extends Error {
  constructor(public readonly code: LoadErrorCode, message: string) {
    super(message);
    this.name = 'PdfLoadError';
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Canceled');
    this.name = 'CancelledError';
  }
}

export function normalizeRotation(value: number): Rotation {
  const r = (((Math.round(value / 90) * 90) % 360) + 360) % 360;
  return r as Rotation;
}

/** Total on-screen rotation of a page: its own /Rotate plus the user's rotation. */
export function effectiveRotation(info: PageInfo, ref: PageRef): Rotation {
  return normalizeRotation(info.rotation + ref.rotation);
}

let counter = 0;
export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Cooperative cancellation: long operations call this between steps. */
export function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError();
}
