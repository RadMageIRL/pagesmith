// Verifies exports with readers that share no code with PageSmith's own libraries (see readers.ts).
import { describe, expect, it } from 'vitest';
import { EMPTY_STATE, addOverlay, addPages, deletePages, movePages, pagesForSource, rotatePages, type DocState } from '../../src/commands/state';
import { createBlank, loadSource } from '../../src/engine/load';
import type { Rotation } from '../../src/engine/types';
import { buildPdf, type SourceHandle } from '../../src/export/export';
import type { Overlay } from '../../src/overlay/types';
import { USER_PASSWORD, a4Landscape, letter, makeEncryptedPdf, makeLargePdf, makePdf, makePng, makeScannedPdf } from '../fixtures';
import { loadFont } from '../fontpath';
import { hasPdftotext, readWithPdfium, readWithPdftotext } from '../readers';

async function setup(...files: Uint8Array[]) {
  const loaded = await Promise.all(files.map((b, i) => loadSource(b, `f${i}.pdf`)));
  const map = new Map<string, SourceHandle>(loaded.map(l => [l.source.id, { doc: l.doc, pages: l.source.pages }]));
  let state: DocState = EMPTY_STATE;
  for (const l of loaded) state = addPages(state, pagesForSource(l.source));
  return { state, map, lookup: (id: string) => map.get(id) };
}

const near = (a: number[], b: number[], tolerance = 12) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance);
const xpdf = hasPdftotext ? it : it.skip;

describe('exports read by PDFium and Xpdf', () => {
  it('mixed sizes, rotations, blank pages and reordering', async () => {
    const { state: s0, map, lookup } = await setup(await letter(2, 'L'), await a4Landscape(1, 'A'), await makePdf([{ width: 612, height: 792, rotation: 90 }], 'R'));
    const blank = await createBlank(300, 400);
    map.set(blank.loaded.source.id, { doc: blank.loaded.doc, pages: blank.loaded.source.pages });
    let s = addPages(s0, pagesForSource(blank.loaded.source), 2);
    const [l1, l2, b, a1, r1] = s.pages.map(p => p.id);
    s = rotatePages(s, [l2], 90);
    s = rotatePages(s, [r1], 90); // R1 already has /Rotate 90 → 180 total
    s = movePages(s, [a1], 0);
    expect(s.pages.map(p => p.id)).toEqual([a1, l1, l2, b, r1]);
    const out = await buildPdf(s.pages, [], lookup);

    const pages = await readWithPdfium(out);
    expect(pages.map(p => [Math.round(p.width), Math.round(p.height)])).toEqual([[842, 595], [612, 792], [792, 612], [300, 400], [612, 792]]);
    expect(pages.map(p => p.text.trim())).toEqual(['A1', 'L1', 'L2', '', 'R1']);
    if (hasPdftotext) expect(readWithPdftotext(out).map(t => t.trim())).toEqual(['A1', 'L1', 'L2', '', 'R1']);
  });

  it.each([0, 90, 180, 270] as Rotation[])('overlays land where they were placed on a page displayed at %i°', async r => {
    const { state, lookup } = await setup(await letter(1, 'P'));
    const id = state.pages[0].id;
    let s = rotatePages(state, [id], r);
    // Positions are in the view the user saw (rotated r°), top-left origin, points.
    const image: Overlay = { id: 'img', pageId: id, kind: 'image', frameRotation: r, x: 100, y: 150, width: 120, height: 60, mime: 'image/png', bytes: makePng(12, 6, [20, 40, 160]) };
    const highlight: Overlay = { id: 'hl', pageId: id, kind: 'rect', frameRotation: r, x: 300, y: 300, width: 100, height: 30, color: '#ffd400', style: 'highlight' };
    const label: Overlay = { id: 'tx', pageId: id, kind: 'text', frameRotation: r, x: 100, y: 400, text: `Mark ${r}`, fontSize: 24, color: '#000000' };
    for (const o of [image, highlight, label]) s = addOverlay(s, o);
    const out = await buildPdf(s.pages, s.overlays, lookup, { loadFont });

    const [page] = await readWithPdfium(out);
    const portrait = r === 0 || r === 180;
    expect([Math.round(page.width), Math.round(page.height)]).toEqual(portrait ? [612, 792] : [792, 612]);
    // Image: solid color inside, white just outside each edge.
    expect(near(page.pixel(160, 180), [20, 40, 160])).toBe(true);
    expect(near(page.pixel(104, 154), [20, 40, 160])).toBe(true);
    expect(near(page.pixel(216, 206), [20, 40, 160])).toBe(true);
    for (const [x, y] of [[96, 180], [224, 180], [160, 146], [160, 214]]) expect(near(page.pixel(x, y), [255, 255, 255])).toBe(true);
    // Highlight: 40% yellow multiplied over white.
    expect(near(page.pixel(350, 315), [255, 239, 153], 16)).toBe(true);
    expect(near(page.pixel(350, 290), [255, 255, 255])).toBe(true);
    // Overlay text is real, selectable text.
    expect(page.text).toContain(`Mark ${r}`);
    if (hasPdftotext) expect(readWithPdftotext(out)[0]).toContain(`Mark ${r}`);
  });

  it('keeps the original text selectable and adds multilingual overlay text', async () => {
    const { state, lookup } = await setup(await letter(2, 'S'));
    const s = addOverlay(state, { id: 't', pageId: state.pages[1].id, kind: 'text', frameRotation: 0, x: 72, y: 300, text: 'Ωμέγα Привет Café', fontSize: 18, color: '#202020' });
    const out = await buildPdf(s.pages, s.overlays, lookup, { loadFont });
    const pages = await readWithPdfium(out);
    expect(pages[0].text).toContain('S1');
    expect(pages[1].text).toContain('S2');
    expect(pages[1].text).toContain('Ωμέγα Привет Café');
    if (hasPdftotext) expect(readWithPdftotext(out)[1]).toContain('Ωμέγα Привет Café');
  });

  it('scanned pages stay image-only and render', async () => {
    const { state, lookup } = await setup(await makeScannedPdf(3));
    const out = await buildPdf(deletePages(state, [state.pages[1].id]).pages, [], lookup);
    const pages = await readWithPdfium(out);
    expect(pages).toHaveLength(2);
    expect(pages.every(p => p.text.trim() === '')).toBe(true);
    // The scan image covers the page: a mid-page pixel is the scan's gray, not blank white.
    expect(near(pages[0].pixel(306, 396), [235, 235, 228], 6)).toBe(true);
    if (hasPdftotext) expect(readWithPdftotext(out).every(t => t.trim() === '')).toBe(true);
  });

  it('a 500-page document survives reordering and export', async () => {
    const { state, lookup } = await setup(await makeLargePdf(500));
    const last = state.pages[499].id;
    const s = movePages(rotatePages(state, [last], 90), [last], 0);
    const out = await buildPdf(s.pages, [], lookup);
    const pages = await readWithPdfium(out);
    expect(pages).toHaveLength(500);
    expect(pages[0].text).toContain('Page 500 of 500');
    expect(pages[1].text).toContain('Page 1 of 500');
    expect(pages[0].width).toBeGreaterThan(pages[0].height); // rotated
    if (hasPdftotext) {
      const text = readWithPdftotext(out);
      expect(text).toHaveLength(500);
      expect(text[499]).toContain('Page 499 of 500');
    }
  }, 60_000);

  it('an unlocked encrypted PDF exports as a normal, readable file', async () => {
    const encrypted = await makeEncryptedPdf('aes-256');
    // PDFium itself needs the password for the original…
    expect(await readWithPdfium(encrypted).then(() => 'opened', () => 'refused')).toBe('refused');
    expect((await readWithPdfium(encrypted, USER_PASSWORD)).map(p => p.text.trim())).toEqual(['E1', 'E2']);
    const loaded = await loadSource(encrypted, 'locked.pdf', { password: USER_PASSWORD });
    const map = new Map([[loaded.source.id, { doc: loaded.doc, pages: loaded.source.pages }]]);
    const out = await buildPdf(pagesForSource(loaded.source), [], id => map.get(id));
    // …but not for the export.
    expect((await readWithPdfium(out)).map(p => p.text.trim())).toEqual(['E1', 'E2']);
    if (hasPdftotext) expect(readWithPdftotext(out).map(t => t.trim())).toEqual(['E1', 'E2']);
  });
});

xpdf('pdftotext is available for independent text checks', () => {
  expect(hasPdftotext).toBe(true);
});
