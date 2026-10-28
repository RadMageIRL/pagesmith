// Locally generated, non-sensitive PDF fixtures shared by unit and browser tests.
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { PDFDocument, StandardFonts, degrees, rgb } from '@cantoo/pdf-lib';

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
function loadQpdf(): Promise<Qpdf> {
  qpdf ??= (async () => {
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve('@neslinesli93/qpdf-wasm/dist/qpdf.wasm');
    const createModule = (await import('@neslinesli93/qpdf-wasm')).default as unknown as (opts: object) => Promise<Qpdf>;
    return createModule({ locateFile: () => wasmPath, wasmBinary: readFileSync(wasmPath), noInitialRun: true, print: () => {}, printErr: () => {} });
  })();
  return qpdf;
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
