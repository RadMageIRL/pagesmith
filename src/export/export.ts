import { BlendMode, PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, PDFObjectCopier, PDFPage, PDFPageLeaf, PDFRef, PDFStream, PDFString, degrees, rgb, type PDFFont, type PDFImage, type PDFObject } from '@cantoo/pdf-lib';
import fontkit from '@cantoo/fontkit';
import { zipSync } from 'fflate';
import { checkCancelled, effectiveRotation, type PageInfo, type PageRef } from '../engine/types';
import { uprightAnchor } from '../overlay/geometry';
import { TEXT_BASELINE, TEXT_LINE_HEIGHT, clampFontSize, hexToRgb01, type Overlay } from '../overlay/types';
import { APP_VERSION } from '../version';
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
 * Builds a new PDF from page references. Pages are copied as objects, never rasterized, so vector
 * content and selectable text survive. Fillable form fields on the exported pages keep working,
 * and pages that weren't exported never end up in the file. Sources are not modified.
 */
export async function buildPdf(pages: readonly PageRef[], overlays: readonly Overlay[], lookup: SourceLookup, options: ExportOptions = {}): Promise<Uint8Array> {
  if (!pages.length) throw new Error('There are no pages to export.');
  const { signal } = options;
  const out = await PDFDocument.create({ updateMetadata: false });
  const now = new Date();
  out.setProducer(`PageSmith ${APP_VERSION}`);
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
  const forms: FormSource[] = [];
  let done = 0;
  for (const [sourceId, positions] of bySource) {
    checkCancelled(signal);
    const source = lookup(sourceId);
    if (!source) throw new Error('A page refers to a document that is no longer open.');
    const { pages: result, copier } = await copyPagesByRef(out, source.doc, positions.map(i => pages[i].sourceIndex));
    result.forEach((page, k) => { copied[positions[k]] = page; });
    forms.push({ doc: source.doc, copier });
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
  await out.flush();
  rebuildForm(out, forms);
  dropForeignPages(out);
  // Form fields keep the appearances their author made. pdf-lib only redraws fields once its form
  // API has been used on a document, which export never does; false keeps that from changing.
  const bytes = await out.save({ objectsPerTick: 300, updateFieldAppearances: false });
  checkCancelled(signal);
  options.onProgress?.(1);
  return bytes;
}

interface FormSource { doc: PDFDocument; copier: PDFObjectCopier }

/**
 * Like pdf-lib's copyPages, but each page is copied through its reference. A link or form field
 * that points at another copied page then lands on that page's copy, instead of pulling in a
 * second, hidden copy of it.
 */
async function copyPagesByRef(out: PDFDocument, src: PDFDocument, indices: number[]): Promise<{ pages: PDFPage[]; copier: PDFObjectCopier }> {
  await src.flush();
  const copier = PDFObjectCopier.for(src.context, out.context);
  const srcPages = src.getPages();
  const seen = new Set<number>();
  const pages = indices.map(i => {
    // The same page twice can't share one object in the page tree, so a repeat gets its own copy.
    if (seen.has(i)) {
      const node = copier.copy(srcPages[i].node);
      return PDFPage.of(node, out.context.register(node), out);
    }
    seen.add(i);
    const ref = copier.copy(srcPages[i].ref);
    return PDFPage.of(out.context.lookup(ref, PDFDict) as PDFPageLeaf, ref, out);
  });
  return { pages, copier };
}

const AcroForm = PDFName.of('AcroForm');
const Kids = PDFName.of('Kids');
const Parent = PDFName.of('Parent');

function isWidget(dict: PDFObject | undefined): dict is PDFDict {
  return dict instanceof PDFDict && dict.get(PDFName.of('Subtype')) === PDFName.of('Widget');
}

/**
 * Restores the interactive form. Copied pages bring their widgets and, through /Parent, the fields
 * those widgets belong to, but the list of fields lives in the source's /AcroForm, which the new
 * document doesn't have; without it viewers show the fields as flat pictures. Only fields with a
 * widget on an exported page are listed, widgets on pages that weren't exported are dropped, and a
 * field whose name another merged file already uses is renamed so the two stay independent.
 * XFA is not carried over.
 */
function rebuildForm(out: PDFDocument, sources: FormSource[]): void {
  const ctx = out.context;
  const withForms = sources.map(s => ({ ...s, form: s.doc.catalog.lookupMaybe(AcroForm, PDFDict) })).filter(s => s.form);
  if (!withForms.length) return;

  const placed = new Set<PDFRef>();
  for (const page of out.getPages()) {
    for (const annot of page.node.Annots()?.asArray() ?? []) if (annot instanceof PDFRef && isWidget(ctx.lookup(annot))) placed.add(annot);
  }
  const roots: PDFRef[] = [];
  for (const widget of placed) {
    let ref = widget;
    for (let parent = ctx.lookup(ref, PDFDict).get(Parent); parent instanceof PDFRef && ctx.lookup(parent) instanceof PDFDict; parent = ctx.lookup(ref, PDFDict).get(Parent)) ref = parent;
    if (!roots.includes(ref)) roots.push(ref);
  }
  // Keeps the branches that still end in a placed widget; returns whether anything is left.
  const prune = (ref: PDFRef): boolean => {
    const dict = ctx.lookup(ref, PDFDict);
    const kids = dict.lookupMaybe(Kids, PDFArray);
    if (!kids) return placed.has(ref);
    const keep = kids.asArray().filter(k => k instanceof PDFRef && (isWidget(ctx.lookup(k)) && !ctx.lookup(k, PDFDict).has(Kids) ? placed.has(k) : prune(k)));
    dict.set(Kids, ctx.obj(keep));
    return keep.length > 0;
  };
  const fields = roots.filter(prune);

  const used = new Set<string>();
  for (const ref of fields) {
    const dict = ctx.lookup(ref, PDFDict);
    const name = dict.lookupMaybe(PDFName.of('T'), PDFString, PDFHexString)?.decodeText();
    if (name === undefined) continue;
    let unique = name;
    for (let n = 2; used.has(unique); n++) unique = `${name}_${n}`;
    used.add(unique);
    if (unique !== name) dict.set(PDFName.of('T'), PDFHexString.fromText(unique));
  }

  const acro = ctx.obj({ Fields: fields });
  const resources = ctx.obj({});
  for (const { form, copier } of withForms) {
    const da = form!.get(PDFName.of('DA'));
    if (da && !acro.has(PDFName.of('DA'))) acro.set(PDFName.of('DA'), copier.copy(da));
    if (form!.get(PDFName.of('NeedAppearances'))?.toString() === 'true') acro.set(PDFName.of('NeedAppearances'), ctx.obj(true));
    // Default resources (the fonts fields are typed in): the first file to name a resource keeps it.
    const dr = form!.lookupMaybe(PDFName.of('DR'), PDFDict);
    if (!dr) continue;
    for (const [category, entries] of copier.copy(dr).entries()) {
      const target = resources.lookupMaybe(category, PDFDict);
      const incoming = ctx.lookupMaybe(entries, PDFDict);
      if (!target || !incoming) { if (!resources.has(category)) resources.set(category, entries); continue; }
      for (const [name, value] of incoming.entries()) if (!target.has(name)) target.set(name, value);
    }
  }
  if (resources.keys().length) acro.set(PDFName.of('DR'), resources);
  out.catalog.set(AcroForm, ctx.register(acro));
}

/**
 * Keeps pages that weren't exported out of the file. A link, form field or comment on an exported
 * page can point at a page that was left out (or at a comment on one), and copying follows every
 * such reference, so that page or comment, content and all, would otherwise travel inside the
 * export where anyone can recover it. Every reference to a page outside the export, and to an
 * annotation that belongs to one, is cut (it can only have been a dead link or a reply to a comment
 * that is gone), then every object nothing refers to any more is dropped.
 */
function dropForeignPages(out: PDFDocument): void {
  const ctx = out.context;
  const kept = new Set(out.getPages().map(p => p.ref));
  const isPage = (o: PDFObject | undefined) => o instanceof PDFPageLeaf || (o instanceof PDFDict && o.get(PDFName.of('Type')) === PDFName.of('Page'));
  const annotsOf = (page: PDFObject | undefined) => (page instanceof PDFDict ? page.lookupMaybe(PDFName.of('Annots'), PDFArray)?.asArray() ?? [] : []).filter((a): a is PDFRef => a instanceof PDFRef);
  const foreignPages = new Set<PDFRef>();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) if (isPage(obj) && !kept.has(ref)) foreignPages.add(ref);
  // An annotation belongs to a left-out page when that page lists it or it names that page as its
  // own (/P); anything an exported page lists stays.
  const keptAnnots = new Set([...kept].flatMap(ref => annotsOf(ctx.lookup(ref))));
  const foreignAnnots = new Set([...foreignPages].flatMap(ref => annotsOf(ctx.lookup(ref))));
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    const page = obj instanceof PDFDict ? obj.get(PDFName.of('P')) : undefined;
    if (page instanceof PDFRef && foreignPages.has(page)) foreignAnnots.add(ref);
  }
  for (const ref of keptAnnots) foreignAnnots.delete(ref);
  const foreign = (value: PDFObject) => value instanceof PDFRef && (foreignPages.has(value) || foreignAnnots.has(value));
  const reached = new Set<PDFRef>();
  const queue: PDFObject[] = [ctx.trailerInfo.Root, ctx.trailerInfo.Info].filter((o): o is PDFObject => !!o);
  while (queue.length) {
    const item = queue.pop()!;
    if (item instanceof PDFRef) {
      if (reached.has(item)) continue;
      reached.add(item);
      const target = ctx.lookup(item);
      if (target) queue.push(target);
    } else if (item instanceof PDFDict) {
      for (const [key, value] of item.entries()) {
        if (foreign(value)) item.delete(key);
        else queue.push(value);
      }
    } else if (item instanceof PDFArray) {
      for (let i = 0; i < item.size(); i++) {
        const value = item.get(i);
        if (foreign(value)) item.set(i, PDFNull);
        else queue.push(value);
      }
    } else if (item instanceof PDFStream) {
      queue.push(item.dict);
    }
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!reached.has(ref)) ctx.delete(ref);
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
