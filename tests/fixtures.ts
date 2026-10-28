// Locally generated, non-sensitive PDF fixtures shared by unit and browser tests.
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFRef, PDFString, StandardFonts, decodePDFRawStream, degrees, rgb } from '@cantoo/pdf-lib';

export interface FixturePage { width: number; height: number; rotation?: number; label?: string }

/** Each page is labeled with text (e.g. "A1") so tests can identify it after reordering. */
export async function makePdf(pages: FixturePage[], prefix = 'P'): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Fixture ${prefix}`);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  pages.forEach((spec, i) => {
    const page = doc.addPage([spec.width, spec.height]);
    if (spec.rotation) page.setRotation(degrees(spec.rotation));
    const label = spec.label ?? `${prefix}${i + 1}`;
    page.drawRectangle({ x: 10, y: 10, width: spec.width - 20, height: spec.height - 20, borderColor: rgb(0.2, 0.4, 0.3), borderWidth: 2 });
    page.drawText(label, { x: 40, y: spec.height - 80, size: 36, font, color: rgb(0.1, 0.1, 0.1) });
  });
  return doc.save({ useObjectStreams: false });
}

export const letter = (n: number, prefix = 'L') => makePdf(Array.from({ length: n }, () => ({ width: 612, height: 792 })), prefix);
export const a4Landscape = (n: number, prefix = 'A') => makePdf(Array.from({ length: n }, () => ({ width: 842, height: 595 })), prefix);

/** Encryption schemes produced independently with qpdf (WASM build), keyed by fixture name. */
export type EncryptionScheme = 'rc4-40' | 'rc4-128' | 'aes-128' | 'aes-256' | 'owner-only';
export const USER_PASSWORD = 'user-pw';
export const OWNER_PASSWORD = 'owner-pw';

type Qpdf = { FS: { writeFile(p: string, d: Uint8Array): void; readFile(p: string): Uint8Array }; callMain(args: string[]): number };
let qpdf: Promise<Qpdf> | null = null;
/** Collects qpdf's stdout while set (its --json output goes there); null passes output through. */
let qpdfOut: string[] | null = null;
function loadQpdf(): Promise<Qpdf> {
  qpdf ??= (async () => {
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve('@neslinesli93/qpdf-wasm/dist/qpdf.wasm');
    const createModule = (await import('@neslinesli93/qpdf-wasm')).default as unknown as (opts: object) => Promise<Qpdf>;
    // This build ignores the print hook and binds console.log when the module is created, so a
    // dispatcher installed for that moment decides where its output goes from then on.
    const log = console.log;
    console.log = (...parts: unknown[]) => { if (qpdfOut) qpdfOut.push(parts.join(' ')); else log(...parts); };
    try {
      return await createModule({ locateFile: () => wasmPath, wasmBinary: readFileSync(wasmPath), noInitialRun: true, printErr: () => {} });
    } finally {
      console.log = log;
    }
  })();
  return qpdf;
}

/**
 * Which of `markers` appear anywhere in a PDF, read two independent ways: qpdf rewrites it with
 * every stream decoded and nothing compressed, and pdf-lib decodes each stream and prints every
 * other object. A marker counts as present in plain text, as hex, or as UTF-16 hex, the forms a PDF
 * can spell text in. This looks at the file's objects, not at what a viewer shows.
 */
export async function findMarkers(bytes: Uint8Array, markers: string[]): Promise<{ qpdf: string[]; pdfLib: string[] }> {
  const q = await loadQpdf();
  const id = Math.random().toString(36).slice(2);
  q.FS.writeFile(`/scan-${id}.pdf`, bytes);
  const code = q.callMain(['--qdf', '--object-streams=disable', '--decode-level=all', '--compress-streams=n', `/scan-${id}.pdf`, `/scan-${id}-out.pdf`]);
  if (code !== 0 && code !== 3) throw new Error(`qpdf exited with ${code}`); // 3: finished with warnings
  const qpdfText = Buffer.from(q.FS.readFile(`/scan-${id}-out.pdf`)).toString('latin1');

  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const parts: string[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      parts.push(obj.dict.toString());
      try { parts.push(Buffer.from(decodePDFRawStream(obj).decode()).toString('latin1')); } catch { parts.push(Buffer.from(obj.contents).toString('latin1')); }
    } else {
      parts.push(obj.toString());
    }
  }
  const spellings = (marker: string) => [
    marker,
    Buffer.from(marker, 'latin1').toString('hex'),
    Buffer.from(marker, 'utf16le').swap16().toString('hex'),
  ].map(s => s.toUpperCase());
  const found = (corpus: string) => {
    const upper = corpus.toUpperCase();
    return markers.filter(m => spellings(m).some(s => upper.includes(s)));
  };
  return { qpdf: found(qpdfText), pdfLib: found(parts.join('\n')) };
}

/** A form field as qpdf reports it: fully qualified name, value, and the page its widget is on. */
export interface QpdfField { fullname: string; value: unknown; pageposfrom1: number; fieldtype: string }

/**
 * Reads a PDF with qpdf, independently of the pdf-lib fork that wrote it: the interactive form's
 * fields (one entry per widget) and how many page objects the file contains in total, including
 * any that no page tree points at.
 */
export async function inspectWithQpdf(bytes: Uint8Array): Promise<{ hasForm: boolean; fields: QpdfField[]; pageObjects: number; widgetObjects: number }> {
  const q = await loadQpdf();
  const id = Math.random().toString(36).slice(2);
  q.FS.writeFile(`/inspect-${id}.pdf`, bytes);
  const lines: string[] = [];
  qpdfOut = lines;
  let code: number;
  try {
    code = q.callMain(['--json=2', '--json-key=acroform', '--json-key=qpdf', `/inspect-${id}.pdf`]);
  } finally {
    qpdfOut = null;
  }
  if (code !== 0) throw new Error(`qpdf exited with ${code}`);
  const json = JSON.parse(lines.join('\n'));
  const objects = Object.values(json.qpdf[1] as Record<string, { value?: Record<string, unknown> }>);
  return {
    hasForm: json.acroform.hasacroform,
    fields: json.acroform.fields.map((f: QpdfField) => ({ fullname: f.fullname, value: f.value, pageposfrom1: f.pageposfrom1, fieldtype: f.fieldtype })),
    pageObjects: objects.filter(o => o.value?.['/Type'] === '/Page').length,
    // Every widget annotation in the file, whether or not a page shows it.
    widgetObjects: objects.filter(o => o.value?.['/Subtype'] === '/Widget').length,
  };
}

/** Encrypts a PDF with qpdf - an implementation independent of the pdf-lib fork that decrypts it. */
export async function encryptWithQpdf(bytes: Uint8Array, scheme: EncryptionScheme): Promise<Uint8Array> {
  const q = await loadQpdf();
  const id = Math.random().toString(36).slice(2);
  q.FS.writeFile(`/in-${id}.pdf`, bytes);
  const user = scheme === 'owner-only' ? '' : USER_PASSWORD;
  const args: Record<EncryptionScheme, string[]> = {
    'rc4-40': ['--allow-weak-crypto', `/in-${id}.pdf`, '--encrypt', user, OWNER_PASSWORD, '40', '--'],
    'rc4-128': ['--allow-weak-crypto', `/in-${id}.pdf`, '--encrypt', user, OWNER_PASSWORD, '128', '--use-aes=n', '--'],
    'aes-128': [`/in-${id}.pdf`, '--encrypt', user, OWNER_PASSWORD, '128', '--use-aes=y', '--'],
    'aes-256': [`/in-${id}.pdf`, '--encrypt', user, OWNER_PASSWORD, '256', '--'],
    'owner-only': [`/in-${id}.pdf`, '--encrypt', '', OWNER_PASSWORD, '256', '--modify=none', '--extract=n', '--'],
  };
  const code = q.callMain([...args[scheme], `/out-${id}.pdf`]);
  if (code !== 0) throw new Error(`qpdf exited with ${code}`);
  return q.FS.readFile(`/out-${id}.pdf`);
}

/**
 * A two-page fillable form, labeled F1 and F2: a text field "name" with a widget on both pages, a
 * checked checkbox "agree", a dropdown "color" set to Green and a radio group "size" set to M on
 * page 1, and a text field "notes" on page 2 only.
 */
export async function makeFormPdf(flags: { xfa?: boolean; signed?: boolean; needAppearances?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.load(await makePdf([{ width: 612, height: 792 }, { width: 612, height: 792 }], 'F'));
  const [p1, p2] = doc.getPages();
  const form = doc.getForm();
  const name = form.createTextField('name');
  name.setText('Ada Lovelace');
  name.addToPage(p1, { x: 40, y: 600, width: 240, height: 24 });
  name.addToPage(p2, { x: 40, y: 600, width: 240, height: 24 });
  const agree = form.createCheckBox('agree');
  agree.addToPage(p1, { x: 40, y: 560, width: 18, height: 18 });
  agree.check();
  const color = form.createDropdown('color');
  color.addOptions(['Red', 'Green', 'Blue']);
  color.select('Green');
  color.addToPage(p1, { x: 40, y: 520, width: 120, height: 24 });
  const size = form.createRadioGroup('size');
  for (const [i, option] of ['S', 'M', 'L'].entries()) size.addOptionToPage(option, p1, { x: 40 + i * 30, y: 480, width: 18, height: 18 });
  size.select('M');
  const notes = form.createTextField('notes');
  notes.setText('Second page only');
  notes.addToPage(p2, { x: 40, y: 560, width: 240, height: 24 });
  // A second, low-level pass (pdf-lib strips XFA whenever its form API touches a document): the
  // form-wide default appearance and resources that Acrobat and LibreOffice write, plus optional
  // markers, an (empty) XFA packet and SigFlags saying the file holds a signature.
  const marked = await PDFDocument.load(await doc.save());
  const acroForm = marked.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
  const helvetica = marked.context.register(marked.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }));
  acroForm.set(PDFName.of('DA'), PDFString.of('/Helv 0 Tf 0 g'));
  acroForm.set(PDFName.of('DR'), marked.context.obj({ Font: { Helv: helvetica } }));
  if (flags.needAppearances) {
    // Like forms from tools that leave drawing to the viewer: "notes" has no appearance stream.
    acroForm.set(PDFName.of('NeedAppearances'), marked.context.obj(true));
    for (const [, obj] of marked.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFDict) || obj.lookupMaybe(PDFName.of('T'), PDFString, PDFHexString)?.decodeText() !== 'notes') continue;
      // The appearance lives on the widget, which pdf-lib makes a kid of the named field.
      for (const widget of [obj, ...(obj.lookupMaybe(PDFName.of('Kids'), PDFArray)?.asArray() ?? []).map(k => marked.context.lookup(k, PDFDict))]) widget.delete(PDFName.of('AP'));
    }
  }
  if (flags.xfa) acroForm.set(PDFName.of('XFA'), marked.context.obj([]));
  if (flags.signed) acroForm.set(PDFName.of('SigFlags'), marked.context.obj(3));
  return marked.save({ updateFieldAppearances: false });
}

/**
 * Three pages, L1 to L3, where page 3 also carries the text SECRET-PAGE-THREE and page 1 has a
 * link to page 3, the way a table of contents does.
 */
export async function makeLinkedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = [1, 2, 3].map(n => {
    const page = doc.addPage([612, 792]);
    page.drawText(`L${n}`, { x: 40, y: 712, size: 36, font });
    if (n === 3) page.drawText('SECRET-PAGE-THREE', { x: 40, y: 660, size: 14, font });
    return page;
  });
  const link = doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [40, 600, 200, 620], Border: [0, 0, 0], Dest: [pages[2].ref, PDFName.of('Fit')] });
  pages[0].node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(link)]));
  return doc.save();
}

/** Markers that exist only on page 3 of makeConfidentialPdf, each in a different kind of object. */
export const CONFIDENTIAL = {
  text: 'SECRET-TEXT-THREE',
  note: 'SECRET-NOTE-THREE',
  file: 'SECRET-FILE-THREE',
  value: 'SECRET-VALUE-THREE',
};

/**
 * Three pages, K1, K2 and a confidential page 3, built so that exporting pages 1 (and 2) has every
 * reason to drag page 3 along:
 *   page 1: a link to page 3 (/Dest), a GoTo action to page 3, a link to page 2, a comment
 *           "KEEP-NOTE-ONE" written as a reply (/IRT) to page 3's comment, the field
 *           contact.name = KEEP-VALUE, and an image it shares with page 3;
 *   page 3: CONFIDENTIAL.text in its content, a comment holding CONFIDENTIAL.note, an attached file
 *           holding CONFIDENTIAL.file, and the field contact.secret = CONFIDENTIAL.value, which
 *           shares the "contact" parent with page 1's field (its appearance draws the value too).
 */
export async function makeConfidentialPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const image = await doc.embedPng(makePng(16, 16, [30, 120, 200]));
  const [p1, p2, p3] = [1, 2, 3].map(() => doc.addPage([612, 792]));
  p1.drawText('K1', { x: 40, y: 712, size: 36, font });
  p2.drawText('K2', { x: 40, y: 712, size: 36, font });
  p3.drawText('K3', { x: 40, y: 712, size: 36, font });
  p3.drawText(CONFIDENTIAL.text, { x: 40, y: 660, size: 14, font });
  for (const page of [p1, p3]) page.drawImage(image, { x: 400, y: 700, width: 32, height: 32 });

  const form = doc.getForm();
  const name = form.createTextField('contact.name');
  name.setText('KEEP-VALUE');
  name.addToPage(p1, { x: 40, y: 500, width: 200, height: 24 });
  const secret = form.createTextField('contact.secret');
  secret.setText(CONFIDENTIAL.value);
  secret.addToPage(p3, { x: 40, y: 500, width: 260, height: 24 });
  form.updateFieldAppearances(font);

  const register = (dict: Record<string, unknown>) => ctx.register(ctx.obj(dict as Parameters<typeof ctx.obj>[0]));
  const note3 = register({ Type: 'Annot', Subtype: 'Text', Rect: [40, 600, 60, 620], Contents: PDFString.of(CONFIDENTIAL.note), P: p3.ref });
  const file = ctx.register(ctx.stream(CONFIDENTIAL.file, { Type: 'EmbeddedFile' }));
  const attachment3 = register({ Type: 'Annot', Subtype: 'FileAttachment', Rect: [80, 600, 100, 620], FS: { Type: 'Filespec', F: PDFString.of('notes.txt'), EF: { F: file } }, P: p3.ref });
  const toPage3 = register({ Type: 'Annot', Subtype: 'Link', Rect: [40, 640, 200, 660], Border: [0, 0, 0], Dest: [p3.ref, PDFName.of('Fit')] });
  const gotoPage3 = register({ Type: 'Annot', Subtype: 'Link', Rect: [40, 610, 200, 630], Border: [0, 0, 0], A: { S: 'GoTo', D: [p3.ref, PDFName.of('Fit')] } });
  const toPage2 = register({ Type: 'Annot', Subtype: 'Link', Rect: [40, 580, 200, 600], Border: [0, 0, 0], Dest: [p2.ref, PDFName.of('Fit')] });
  const reply1 = register({ Type: 'Annot', Subtype: 'Text', Rect: [300, 600, 320, 620], Contents: PDFString.of('KEEP-NOTE-ONE'), IRT: note3, P: p1.ref });
  const addAnnots = (page: typeof p1, refs: PDFRef[]) => {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray) ?? ctx.obj([]);
    for (const ref of refs) annots.push(ref);
    page.node.set(PDFName.of('Annots'), annots);
  };
  addAnnots(p1, [toPage3, gotoPage3, toPage2, reply1]);
  addAnnots(p3, [note3, attachment3]);
  return doc.save({ useObjectStreams: false });
}

export async function makeEncryptedPdf(scheme: EncryptionScheme = 'aes-256'): Promise<Uint8Array> {
  return encryptWithQpdf(await letter(2, 'E'), scheme);
}

/** A "scanned" document: each page is only an image, with no text layer. */
export async function makeScannedPdf(pages = 2): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const png = await doc.embedPng(makePng(40, 52, [235, 235, 228]));
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]).drawImage(png, { x: 0, y: 0, width: 612, height: 792 });
  return doc.save();
}

/** Pages carrying a unique incompressible photo-like image each: tens of MB, slow to copy and save. */
export async function makeHeavyPdf(pages: number, side = 400): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const raw = randomBytes(side * side * 3);
    const png = await doc.embedPng(encodePng(side, side, raw));
    const page = doc.addPage([612, 792]);
    page.drawImage(png, { x: 56, y: 150, width: 500, height: 500 });
    page.drawText(`Heavy page ${i}`, { x: 56, y: 700, size: 24, font });
  }
  return doc.save();
}

/** A long document with text and vector content on every page, for performance tests. */
export async function makeLargePdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage(i % 7 === 0 ? [842, 595] : [612, 792]);
    const { width, height } = page.getSize();
    page.drawRectangle({ x: 20, y: 20, width: width - 40, height: height - 40, borderColor: rgb(0.2, 0.4, 0.3), borderWidth: 1.5 });
    page.drawText(`Page ${i} of ${pages}`, { x: 50, y: height - 70, size: 28, font });
    for (let line = 0; line < 30; line++) page.drawText(`Line ${line + 1}: the quick brown fox jumps over the lazy dog ${i}-${line}`, { x: 50, y: height - 120 - line * 18, size: 10, font, color: rgb(0.25, 0.25, 0.25) });
    for (let k = 0; k < 12; k++) page.drawCircle({ x: 60 + k * 40, y: 60, size: 12, borderColor: rgb(0.5, 0.3, 0.6), borderWidth: 1 });
  }
  return doc.save();
}

/** PDF header followed by garbage. */
export function makeCorruptPdf(): Uint8Array {
  return latin1('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj << /Type /Catalog /Pages 9 0 R >>\nthis is not a valid pdf body\n%%EOF\n');
}

/** A real PDF cut off half way through. */
export async function makeTruncatedPdf(): Promise<Uint8Array> {
  const bytes = await letter(3, 'T');
  return bytes.slice(0, Math.floor(bytes.length / 3));
}

export function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** Encodes a solid-color RGB PNG with correct CRCs (zlib from Node). */
export function makePng(width: number, height: number, [r, g, b]: [number, number, number] = [200, 30, 30]): Uint8Array {
  const pixels = new Uint8Array(width * height * 3);
  for (let i = 0; i < pixels.length; i += 3) pixels.set([r, g, b], i);
  return encodePng(width, height, pixels);
}

/** Encodes raw RGB pixels as a PNG. */
export function encodePng(width: number, height: number, pixels: Uint8Array): Uint8Array {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    raw.set(pixels.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return new Uint8Array(png);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
