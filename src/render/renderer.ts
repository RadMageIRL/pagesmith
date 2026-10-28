import { GlobalWorkerOptions, getDocument, RenderingCancelledException, AnnotationMode, Util, type PDFDocumentLoadingTask, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Rotation } from '../engine/types';

GlobalWorkerOptions.workerSrc = workerUrl;

/** Largest canvas we'll allocate, in device pixels, so deep zoom on huge pages can't exhaust memory. */
const MAX_CANVAS_PIXELS = 4096 * 4096;
const MAX_CONCURRENT = 3;

function assetUrl(path: string): string {
  return new URL(path, document.baseURI).href;
}

/** A positioned run of text: baseline start (x, y), unit baseline direction, advance width and font height. */
export interface TextRun { str: string; x: number; y: number; dir: [number, number]; width: number; height: number }

interface Entry { task: PDFDocumentLoadingTask; doc: Promise<PDFDocumentProxy> }

/**
 * Preview rendering with pdf.js. Each source is opened once; pages are painted onto canvases on
 * demand through a small queue so scrolling a 500-page file doesn't start 500 renders at once.
 * Only canvas output is used: no annotation, text, or XFA layers, so links and embedded scripts in
 * a PDF are never live in the page.
 */
export class Renderer {
  private docs = new Map<string, Entry>();
  private queue: (() => void)[] = [];
  private active = 0;

  /**
   * Opens a source for preview. pdf.js transfers `data` to its own worker, so callers hand over a
   * buffer they no longer need (read fresh from the File) and the UI thread keeps no copy.
   */
  open(sourceId: string, data: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
    const existing = this.docs.get(sourceId);
    if (existing) return existing.doc;
    const task = getDocument({
      data,
      password,
      cMapUrl: assetUrl('pdfjs/cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: assetUrl('pdfjs/standard_fonts/'),
      wasmUrl: assetUrl('pdfjs/wasm/'),
      iccUrl: assetUrl('pdfjs/iccs/'),
      enableXfa: false,
      verbosity: 0,
    });
    const entry = { task, doc: task.promise };
    this.docs.set(sourceId, entry);
    entry.doc.catch(() => this.docs.delete(sourceId));
    return entry.doc;
  }

  /**
   * Paints one page. `rotation` is the total display rotation; `scale` is CSS pixels per PDF point.
   * Resolves false if canceled through `signal`.
   */
  async renderPage(sourceId: string, index: number, rotation: Rotation, scale: number, canvas: HTMLCanvasElement, signal: AbortSignal): Promise<boolean> {
    const entry = this.docs.get(sourceId);
    if (!entry) return false;
    await this.slot(signal);
    let task: RenderTask | null = null;
    try {
      if (signal.aborted) return false;
      const doc = await entry.doc;
      const page = await doc.getPage(index + 1);
      if (signal.aborted) return false;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      let viewport = page.getViewport({ scale: scale * dpr, rotation });
      const pixels = viewport.width * viewport.height;
      if (pixels > MAX_CANVAS_PIXELS) viewport = page.getViewport({ scale: scale * dpr * Math.sqrt(MAX_CANVAS_PIXELS / pixels), rotation });
      // Draw offscreen-sized into a fresh canvas, then swap, so the old image stays up until the new one is ready.
      const scratch = document.createElement('canvas');
      scratch.width = Math.max(1, Math.floor(viewport.width));
      scratch.height = Math.max(1, Math.floor(viewport.height));
      task = page.render({ canvas: scratch, viewport, annotationMode: AnnotationMode.ENABLE });
      const onAbort = () => task?.cancel();
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        await task.promise;
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
      if (signal.aborted) return false;
      canvas.width = scratch.width;
      canvas.height = scratch.height;
      canvas.getContext('2d')?.drawImage(scratch, 0, 0);
      scratch.width = scratch.height = 0;
      return true;
    } catch (err) {
      if (err instanceof RenderingCancelledException || signal.aborted) return false;
      throw err;
    } finally {
      this.release();
    }
  }

  /**
   * Text of one page, for search. Returns positioned runs in view space at scale 1 for the given
   * rotation (top-left origin, points), so highlights can be drawn at any zoom.
   */
  async pageText(sourceId: string, index: number, rotation: Rotation): Promise<TextRun[]> {
    const entry = this.docs.get(sourceId);
    if (!entry) return [];
    const doc = await entry.doc;
    const page = await doc.getPage(index + 1);
    const viewport = page.getViewport({ scale: 1, rotation });
    const content = await page.getTextContent();
    const runs: TextRun[] = [];
    for (const item of content.items) {
      if (!('str' in item) || !item.str) continue;
      // Item transform → viewport space. Direction (a, b) is the baseline direction; the font
      // height is the length of the (c, d) column.
      const [a, b, c, d, e, f] = Util.transform(viewport.transform, item.transform);
      const height = Math.hypot(c, d) || Math.hypot(a, b);
      const len = Math.hypot(a, b) || 1;
      // item.width is already in page units; a scale-1 viewport only rotates, so lengths carry over.
      runs.push({ str: item.str, x: e, y: f, dir: [a / len, b / len], width: item.width, height });
    }
    page.cleanup();
    return runs;
  }

  async close(sourceId: string): Promise<void> {
    const entry = this.docs.get(sourceId);
    this.docs.delete(sourceId);
    if (entry) await entry.task.destroy().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    const ids = [...this.docs.keys()];
    await Promise.all(ids.map(id => this.close(id)));
  }

  private slot(signal: AbortSignal): Promise<void> {
    if (this.active < MAX_CONCURRENT) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise(resolve => {
      const start = () => { this.active++; resolve(); };
      this.queue.push(start);
      signal.addEventListener('abort', () => {
        const i = this.queue.indexOf(start);
        if (i >= 0) { this.queue.splice(i, 1); this.active++; resolve(); }
      }, { once: true });
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}
