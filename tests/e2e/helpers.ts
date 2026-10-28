import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Download, type Page } from '@playwright/test';
import { PDFDocument } from '@cantoo/pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export const fixture = (name: string) => join(import.meta.dirname, '.fixtures', name);

export async function openPdf(page: Page, ...names: string[]): Promise<void> {
  await page.locator('#open-input').setInputFiles(names.map(fixture));
}

export async function addPdf(page: Page, ...names: string[]): Promise<void> {
  await page.locator('#add-input').setInputFiles(names.map(fixture));
}

export const thumbs = (page: Page) => page.locator('#thumbs .thumb');

export async function expectPageCount(page: Page, n: number): Promise<void> {
  await expect(thumbs(page)).toHaveCount(n);
  await expect(page.locator('#pages-view .page')).toHaveCount(n);
}

/** Reads a downloaded PDF back with pdf-lib to prove it is valid. */
export async function readDownload(download: Download): Promise<PDFDocument> {
  const path = await download.path();
  return PDFDocument.load(readFileSync(path!));
}

export async function clickDownload(page: Page, action: () => Promise<void>): Promise<Download> {
  const [download] = await Promise.all([page.waitForEvent('download'), action()]);
  return download;
}

/** Collects console errors and CSP violations so tests can assert the page stayed clean. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(err.message));
  return errors;
}

/** All text strings of a downloaded PDF, page by page, extracted with pdf.js. */
export async function downloadText(download: Download): Promise<string[]> {
  return pdfText(new Uint8Array(readFileSync((await download.path())!)));
}

/** All text strings of a PDF, page by page, extracted with pdf.js. */
export async function pdfText(bytes: Uint8Array): Promise<string[]> {
  const task = getDocument({ data: bytes.slice(), verbosity: 0 });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    pages.push(content.items.map(i => ('str' in i ? i.str : '')).join(' '));
  }
  await task.destroy();
  return pages;
}

/** Entries of a downloaded ZIP, by file name. */
export async function readZip(download: Download): Promise<Record<string, Uint8Array>> {
  const { unzipSync } = await import('fflate');
  return unzipSync(new Uint8Array(readFileSync((await download.path())!)));
}
