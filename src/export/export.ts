import { BlendMode, PDFDocument, PDFName, PDFPage, degrees, rgb, type PDFFont, type PDFImage } from '@cantoo/pdf-lib';
import fontkit from '@cantoo/fontkit';
import { zipSync } from 'fflate';
import { checkCancelled, effectiveRotation, type PageInfo, type PageRef } from '../engine/types';
import { uprightAnchor } from '../overlay/geometry';
import { TEXT_BASELINE, TEXT_LINE_HEIGHT, clampFontSize, hexToRgb01, type Overlay } from '../overlay/types';
import { TextFont } from './fonts';

export interface SourceHandle {
  doc: PDFDocument;
  pages: PageInfo[];
}
export type SourceLookup = (id: string) => SourceHandle | undefined;

export interface ExportOptions {
  title?: string;
  /** Called with 0..1 while the document is built. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** Supplies the overlay font file (fetched in the browser, read from disk in tests). */
  loadFont?: () => Promise<Uint8Array>;
}

/**
 * Builds a new PDF from page references. Pages are copied as objects (copyPages), never
 * rasterized, so vector content and selectable text survive. Sources are not modified.
 */
export async function buildPdf(pages: readonly PageRef[], overlays: readonly Overlay[], lookup: SourceLookup, options: ExportOptions = {}): Promise<Uint8Array> {
  if (!pages.length) throw new Error('There are no pages to export.');
  const { signal } = options;
  const out = await PDFDocument.create({ updateMetadata: false });
  const now = new Date();
  out.setProducer('PageSmith 0.2.0');
  out.setCreator('PageSmith');
  out.setCreationDate(now);
  out.setModificationDate(now);
  if (options.title) out.setTitle(options.title);

  // Copy pages one source at a time (one copier per source shares fonts/images), then restore order.
  const bySource = new Map<string, number[]>();
  pages.forEach((p, i) => {
    const list = bySource.get(p.sourceId) ?? [];
    list.push(i);
    bySource.set(p.sourceId, list);
  });
  const copied: PDFPage[] = new Array(pages.length);
  let done = 0;
  for (const [sourceId, positions] of bySource) {
    checkCancelled(signal);
    const source = lookup(sourceId);
    if (!source) throw new Error('A page refers to a document that is no longer open.');
    const result = await out.copyPages(source.doc, positions.map(i => pages[i].sourceIndex));
    result.forEach((page, k) => { copied[positions[k]] = page; });
    done += positions.length;
    options.onProgress?.(done / pages.length * 0.6);
  }

  const overlaysByPage = new Map<string, Overlay[]>();
  for (const o of overlays) {
    const list = overlaysByPage.get(o.pageId) ?? [];
    list.push(o);
    overlaysByPage.set(o.pageId, list);
  }
  const ctx: DrawContext = { doc: out, images: new Map(), font: null, loadFont: options.loadFont };

  for (let i = 0; i < pages.length; i++) {
    if (i % 25 === 0) { checkCancelled(signal); await tick(); }
    const ref = pages[i];
    const page = copied[i];
    out.addPage(page);
    // Page-level automatic actions (open/close scripts) are dropped; document-level JavaScript and
    // OpenAction never come along because the output catalog is brand new.
    page.node.delete(PDFName.of('AA'));
    const info = lookup(ref.sourceId)!.pages[ref.sourceIndex];
    page.setRotation(degrees(effectiveRotation(info, ref)));
    for (const overlay of overlaysByPage.get(ref.id) ?? []) await drawOverlay(ctx, page, overlay, info);
    options.onProgress?.(0.6 + (i + 1) / pages.length * 0.2);
  }
  checkCancelled(signal);
  const bytes = await out.save({ objectsPerTick: 300 });
  checkCancelled(signal);
  options.onProgress?.(1);
  return bytes;
}

export interface ZipEntry { name: string; bytes: Uint8Array }

/**
 * Packs several PDFs into one ZIP. Entries are stored, not deflated: PDF streams are already
 * compressed, so deflating again costs time for almost no size gain.
 */
export function zipFiles(entries: ZipEntry[]): Uint8Array {
  const used = new Set<string>();
  const files: Record<string, [Uint8Array, { level: 0; mtime: Date }]> = {};
  for (const entry of entries) {
    let name = entry.name, n = 2;
    while (used.has(name.toLowerCase())) name = entry.name.replace(/(\.[^.]+)?$/, ` (${n++})$1`);
    used.add(name.toLowerCase());
    files[name] = [entry.bytes, { level: 0, mtime: new Date() }];
  }
  return zipSync(files);
}

interface DrawContext {
  doc: PDFDocument;
  images: Map<Uint8Array, PDFImage>;
  font: { pdf: PDFFont; text: TextFont } | null;
  loadFont?: () => Promise<Uint8Array>;
}

async function overlayFont(ctx: DrawContext): Promise<{ pdf: PDFFont; text: TextFont }> {
  if (!ctx.font) {
    if (!ctx.loadFont) throw new Error('No font is available for text overlays.');
    const bytes = await ctx.loadFont();
    ctx.doc.registerFontkit(fontkit);
    // Subsetting keeps only the glyphs used, typically a few KB instead of the full 600 KB face.
    ctx.font = { pdf: await ctx.doc.embedFont(bytes, { subset: true }), text: TextFont.fromBytes(bytes) };
  }
  return ctx.font;
}

async function drawOverlay(ctx: DrawContext, page: PDFPage, overlay: Overlay, info: PageInfo): Promise<void> {
  const frame = overlay.frameRotation;
  const topLeft = { x: overlay.x, y: overlay.y };
  if (overlay.kind === 'text') {
    if (!overlay.text.trim()) return;
    const font = await overlayFont(ctx);
    const size = clampFontSize(overlay.fontSize);
    const text = font.text.sanitize(overlay.text);
    const anchor = uprightAnchor(topLeft, TEXT_BASELINE * size, frame, info);
    const [r, g, b] = hexToRgb01(overlay.color);
    page.drawText(text, { x: anchor.x, y: anchor.y, size, font: font.pdf, color: rgb(r, g, b), lineHeight: TEXT_LINE_HEIGHT * size, rotate: degrees(anchor.angle) });
  } else if (overlay.kind === 'rect') {
    const anchor = uprightAnchor(topLeft, overlay.height, frame, info);
    const [r, g, b] = hexToRgb01(overlay.color);
    const color = rgb(r, g, b);
    if (overlay.style === 'highlight') {
      page.drawRectangle({ x: anchor.x, y: anchor.y, width: overlay.width, height: overlay.height, rotate: degrees(anchor.angle), color, opacity: 0.4, blendMode: BlendMode.Multiply });
    } else {
      page.drawRectangle({ x: anchor.x, y: anchor.y, width: overlay.width, height: overlay.height, rotate: degrees(anchor.angle), borderColor: color, borderWidth: 2 });
    }
  } else {
    let image = ctx.images.get(overlay.bytes);
    if (!image) {
      image = overlay.mime === 'image/png' ? await ctx.doc.embedPng(overlay.bytes) : await ctx.doc.embedJpg(overlay.bytes);
      ctx.images.set(overlay.bytes, image);
    }
    const anchor = uprightAnchor(topLeft, overlay.height, frame, info);
    page.drawImage(image, { x: anchor.x, y: anchor.y, width: overlay.width, height: overlay.height, rotate: degrees(anchor.angle) });
  }
}

/** Yields to the event loop so cancel messages and progress posts get through. */
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
