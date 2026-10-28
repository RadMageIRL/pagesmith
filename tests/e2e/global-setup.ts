import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { a4Landscape, latin1, letter, makeCorruptPdf, makeEncryptedPdf, makeHeavyPdf, makeLargePdf, makePdf, makePng, makeScannedPdf } from '../fixtures';

export const FIXTURE_DIR = join(import.meta.dirname, '.fixtures');

/** Text pages followed by image-only ("scanned") pages. */
async function partlyScanned(): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const bytes of [await letter(2, 'T'), await makeScannedPdf(2)]) {
    const src = await PDFDocument.load(bytes);
    (await out.copyPages(src, src.getPageIndices())).forEach(p => out.addPage(p));
  }
  return out.save();
}

export default async function globalSetup(): Promise<void> {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const files: Record<string, () => Promise<Uint8Array> | Uint8Array> = {
    'one-page.pdf': () => letter(1, 'O'),
    'letter-5.pdf': () => letter(5, 'L'),
    'a4-landscape-2.pdf': () => a4Landscape(2, 'A'),
    'rotated.pdf': () => makePdf([{ width: 612, height: 792, rotation: 90 }, { width: 612, height: 792 }], 'R'),
    'encrypted.pdf': () => makeEncryptedPdf('aes-256'),
    'restricted.pdf': () => makeEncryptedPdf('owner-only'),
    'scanned.pdf': () => makeScannedPdf(3),
    'partly-scanned.pdf': partlyScanned,
    'corrupt.pdf': () => makeCorruptPdf(),
    'not-a-pdf.pdf': () => latin1('just some text pretending to be a pdf'),
    'signature.png': () => makePng(60, 20, [20, 40, 160]),
  };
  for (const [name, make] of Object.entries(files)) writeFileSync(join(FIXTURE_DIR, name), await make());
  // Large documents are slow to generate, so they are cached between runs.
  for (const n of [100, 300, 500]) {
    const path = join(FIXTURE_DIR, `large-${n}.pdf`);
    if (!existsSync(path)) writeFileSync(path, await makeLargePdf(n));
  }
  const heavy = join(FIXTURE_DIR, 'heavy-120.pdf');
  if (!existsSync(heavy)) writeFileSync(heavy, await makeHeavyPdf(120));
}
