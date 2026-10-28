import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { unzipSync } from 'fflate';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { EMPTY_STATE, addOverlay, addPages, deletePages, movePages, pagesForSource, rotatePages, type DocState } from '../../src/commands/state';
import { createBlank, loadSource } from '../../src/engine/load';
import { CancelledError } from '../../src/engine/types';
import { buildPdf, zipFiles, type SourceHandle } from '../../src/export/export';
import { TEXT_BASELINE, type Overlay } from '../../src/overlay/types';
import { a4Landscape, letter, makePdf, makePng } from '../fixtures';
import { loadFont } from '../fontpath';

async function setup(...files: Uint8Array[]) {
  const loaded = await Promise.all(files.map((b, i) => loadSource(b, `f${i}.pdf`)));
  const map = new Map<string, SourceHandle>(loaded.map(l => [l.source.id, { doc: l.doc, pages: l.source.pages }]));
  let state: DocState = EMPTY_STATE;
  for (const l of loaded) state = addPages(state, pagesForSource(l.source));
  return { sources: loaded.map(l => l.source), state, map, lookup: (id: string) => map.get(id) };
}

/** Text items of every page via pdf.js. */
async function textOf(bytes: Uint8Array): Promise<{ str: string; x: number; y: number; angle: number }[][]> {
  const task = getDocument({ data: bytes.slice(), verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    pages.push(content.items.filter(i => 'str' in i && i.str.trim()).map(i => {
      const t = (i as { transform: number[] }).transform;
      return { str: (i as { str: string }).str, x: t[4], y: t[5], angle: Math.round(Math.atan2(t[1], t[0]) * 180 / Math.PI) };
    }));
  }
  await task.destroy();
  return pages;
}
const labels = async (bytes: Uint8Array) => (await textOf(bytes)).map(items => items.map(i => i.str).join(' '));

describe('buildPdf', () => {
  it('re-exports a single-page PDF that reopens unchanged in size', async () => {
    const { state, lookup } = await setup(await letter(1));
    const out = await buildPdf(state.pages, state.overlays, lookup);
    const doc = await PDFDocument.load(out, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    expect(doc.getProducer()).toMatch(/PageSmith/);
  });

  it('merges files with different page sizes, preserving each size and order', async () => {
    const { state, lookup } = await setup(await letter(2, 'L'), await a4Landscape(2, 'A'), await makePdf([{ width: 200, height: 400 }], 'S'));
    const out = await buildPdf(state.pages, state.overlays, lookup);
    const doc = await PDFDocument.load(out);
    expect(doc.getPages().map(p => [p.getWidth(), p.getHeight()])).toEqual([[612, 792], [612, 792], [842, 595], [842, 595], [200, 400]]);
    expect(await labels(out)).toEqual(['L1', 'L2', 'A1', 'A2', 'S1']);
  });

  it('keeps text selectable (pages are copied, not rasterized)', async () => {
    const { state, lookup } = await setup(await letter(3));
    const out = await buildPdf(state.pages, state.overlays, lookup);
    const doc = await PDFDocument.load(out);
    expect(doc.getPage(0).node.Resources()?.get(PDFName.of('Font'))).toBeTruthy();
    expect(await labels(out)).toEqual(['L1', 'L2', 'L3']);
  });

  it('applies reorder, rotation and deletion', async () => {
    const { state: s0, lookup } = await setup(await letter(4));
    const [a, b, , d] = s0.pages.map(p => p.id);
    let s = rotatePages(s0, [b], 90);
    s = rotatePages(s, [d], -90);
    s = deletePages(s, [a]);
    s = movePages(s, [d], 0);
    const out = await buildPdf(s.pages, s.overlays, lookup);
    const doc = await PDFDocument.load(out);
    expect(await labels(out)).toEqual(['L4', 'L2', 'L3']);
    expect(doc.getPages().map(p => p.getRotation().angle)).toEqual([270, 90, 0]);
  });

  it('adds user rotation on top of a page\'s existing /Rotate', async () => {
    const { state, lookup } = await setup(await makePdf([{ width: 612, height: 792, rotation: 90 }]));
    const s = rotatePages(state, [state.pages[0].id], 180);
    const doc = await PDFDocument.load(await buildPdf(s.pages, s.overlays, lookup));
    expect(doc.getPage(0).getRotation().angle).toBe(270);
  });

  it('extracts a subset and exports the same source many times', async () => {
    const { state, lookup } = await setup(await letter(5));
    expect(await labels(await buildPdf([state.pages[1], state.pages[3]], [], lookup))).toEqual(['L2', 'L4']);
    for (let i = 0; i < 3; i++) expect((await PDFDocument.load(await buildPdf(state.pages, [], lookup))).getPageCount()).toBe(5);
  });

  it('inserts generated blank pages between copied ones', async () => {
    const { state, map, lookup } = await setup(await letter(2));
    const blank = await createBlank(842, 595);
    map.set(blank.loaded.source.id, { doc: blank.loaded.doc, pages: blank.loaded.source.pages });
    const s = addPages(state, pagesForSource(blank.loaded.source), 1);
    const out = await buildPdf(s.pages, [], lookup);
    expect((await PDFDocument.load(out)).getPages().map(p => p.getWidth())).toEqual([612, 842, 612]);
    expect(await labels(out)).toEqual(['L1', '', 'L2']);
  });

  it('refuses to export nothing and reports missing sources', async () => {
    await expect(buildPdf([], [], () => undefined)).rejects.toThrow(/no pages/);
    await expect(buildPdf([{ id: 'p', sourceId: 'gone', sourceIndex: 0, rotation: 0 }], [], () => undefined)).rejects.toThrow(/no longer open/);
  });

  it('can be canceled part-way and reports progress up to 1', async () => {
    const { state, lookup } = await setup(await letter(60));
    const controller = new AbortController();
    const run = buildPdf(state.pages, [], lookup, { signal: controller.signal, onProgress: f => { if (f > 0.65) controller.abort(); } });
    await expect(run).rejects.toBeInstanceOf(CancelledError);
    const full: number[] = [];
    await buildPdf(state.pages, [], lookup, { onProgress: f => full.push(f) });
    expect(full.at(-1)).toBe(1);
    expect(full.every((f, i) => i === 0 || f >= full[i - 1])).toBe(true);
  });

  it('removes page-level automatic actions', async () => {
    const raw = await PDFDocument.load(await letter(1));
    raw.getPage(0).node.set(PDFName.of('AA'), raw.context.obj({ O: { S: 'JavaScript', JS: 'app.alert(1)' } }));
    const { state, lookup } = await setup(await raw.save());
    const out = await PDFDocument.load(await buildPdf(state.pages, [], lookup));
    expect(out.getPage(0).node.get(PDFName.of('AA'))).toBeUndefined();
    expect(out.catalog.get(PDFName.of('OpenAction'))).toBeUndefined();
  });
});

describe('zipFiles', () => {
  it('stores every PDF under a unique name and round-trips byte-for-byte', async () => {
    const one = await letter(1), two = await letter(2);
    const zip = zipFiles([{ name: 'a.pdf', bytes: one }, { name: 'a.pdf', bytes: two }, { name: 'b.pdf', bytes: one }]);
    const entries = unzipSync(zip);
    expect(Object.keys(entries)).toEqual(['a.pdf', 'a (2).pdf', 'b.pdf']);
    expect(entries['a (2).pdf']).toEqual(two);
    expect((await PDFDocument.load(entries['a.pdf'])).getPageCount()).toBe(1);
    // "Stores": every local file header names compression method 0 (stored), never 8 (deflate).
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const methods: number[] = [];
    for (let i = 0; view.getUint32(i, true) === 0x04034b50; i += 30 + view.getUint16(i + 26, true) + view.getUint16(i + 28, true) + view.getUint32(i + 18, true)) {
      methods.push(view.getUint16(i + 8, true));
    }
    expect(methods).toEqual([0, 0, 0]);
  });
});

describe('overlays in export', () => {
  const text = (pageId: string, frameRotation: 0 | 90 | 180 | 270, x: number, y: number, t = 'Hello'): Overlay =>
    ({ id: `t${x}${y}${frameRotation}${t}`, pageId, kind: 'text', frameRotation, x, y, text: t, fontSize: 20, color: '#c02020' });

  it('positions text at the requested spot on an unrotated page, with the bundled font embedded as a subset', async () => {
    const { state, lookup, sources } = await setup(await letter(1));
    const s = addOverlay(state, text(state.pages[0].id, 0, 100, 200));
    const out = await buildPdf(s.pages, s.overlays, lookup, { loadFont });
    const hello = (await textOf(out))[0].find(i => i.str === 'Hello')!;
    expect(hello.x).toBeCloseTo(100, 1);
    expect(hello.y).toBeCloseTo(sources[0].pages[0].height - 200 - 20 * TEXT_BASELINE, 1);
    expect(hello.angle).toBe(0);
    // Subset: far smaller than the 629 KB font file.
    expect(out.length).toBeLessThan(60_000);
  });

  it.each([90, 180, 270] as const)('draws text upright for the view it was placed in, on a page rotated %i°', async r => {
    const { state, lookup, sources } = await setup(await letter(1));
    const id = state.pages[0].id;
    const s = addOverlay(rotatePages(state, [id], r), text(id, r, 100, 200));
    const hello = (await textOf(await buildPdf(s.pages, s.overlays, lookup, { loadFont })))[0].find(i => i.str === 'Hello')!;
    const { width: W, height: H } = sources[0].pages[0];
    const b = 200 + 20 * TEXT_BASELINE;
    const expected = { 90: [b, 100], 180: [W - 100, b], 270: [W - b, H - 100] }[r];
    expect(hello.x).toBeCloseTo(expected[0], 1);
    expect(hello.y).toBeCloseTo(expected[1], 1);
    expect(((hello.angle % 360) + 360) % 360).toBe(r);
  });

  it('keeps overlays attached to the page when it is reordered', async () => {
    const { state, lookup } = await setup(await letter(3));
    let s = addOverlay(state, text(state.pages[2].id, 0, 50, 50, 'Note'));
    s = movePages(s, [state.pages[2].id], 0);
    const pages = await textOf(await buildPdf(s.pages, s.overlays, lookup, { loadFont }));
    expect(pages[0].map(i => i.str)).toContain('Note');
    expect(pages[1].map(i => i.str)).not.toContain('Note');
  });

  it('exports Latin, Greek and Cyrillic text; unsupported scripts become "?"', async () => {
    const { state, lookup } = await setup(await letter(1));
    const s = addOverlay(state, text(state.pages[0].id, 0, 72, 72, 'Café Ωμέγα Привет\nTiếng Việt 你好 שלום'));
    const strs = (await textOf(await buildPdf(s.pages, s.overlays, lookup, { loadFont })))[0].map(i => i.str).join(' ');
    expect(strs).toContain('Café Ωμέγα Привет');
    expect(strs).toContain('Tiếng Việt ?? ????');
  });

  it('embeds images and rectangles, deduplicating a reused image', async () => {
    const { state, lookup } = await setup(await letter(2));
    const png = makePng(4, 2);
    let s = addOverlay(state, { id: 'i1', pageId: state.pages[0].id, kind: 'image', frameRotation: 0, x: 72, y: 600, width: 160, height: 80, mime: 'image/png', bytes: png });
    s = addOverlay(s, { id: 'i2', pageId: state.pages[1].id, kind: 'image', frameRotation: 0, x: 72, y: 600, width: 160, height: 80, mime: 'image/png', bytes: png });
    s = addOverlay(s, { id: 'r1', pageId: state.pages[0].id, kind: 'rect', frameRotation: 0, x: 30, y: 60, width: 200, height: 40, color: '#ffe066', style: 'highlight' });
    s = addOverlay(s, { id: 'r2', pageId: state.pages[1].id, kind: 'rect', frameRotation: 0, x: 30, y: 60, width: 200, height: 40, color: '#2060c0', style: 'box' });
    const out = await buildPdf(s.pages, s.overlays, lookup);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(2);
    const images = new TextDecoder('latin1').decode(out).match(/\/Subtype\s*\/Image/g) ?? [];
    expect(images.length).toBe(1);
  });

  it('drops overlays of deleted pages and skips empty text', async () => {
    const { state, lookup } = await setup(await letter(2));
    let s = addOverlay(state, text(state.pages[0].id, 0, 50, 50, 'Gone'));
    s = addOverlay(s, text(state.pages[1].id, 0, 50, 50, '   '));
    s = deletePages(s, [state.pages[0].id]);
    const pages = await textOf(await buildPdf(s.pages, s.overlays, lookup, { loadFont }));
    expect(pages.flat().map(i => i.str)).toEqual(['L2']);
  });
});
