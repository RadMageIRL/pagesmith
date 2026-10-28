import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { addPdf, clickDownload, downloadText, pdfText, readZip, expectPageCount, fixture, openPdf, readDownload, thumbs, watchErrors } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('shows the empty state with the privacy statement', async ({ page }) => {
  await expect(page.locator('#empty-state')).toBeVisible();
  await expect(page.locator('.drop-target')).toContainText('Your PDFs stay in your browser.');
  await expect(page.locator('#export-button')).toBeDisabled();
});

test('opens a multi-page PDF, renders thumbnails and preview, and makes no network requests for it', async ({ page }) => {
  const errors = watchErrors(page);
  const external: string[] = [];
  page.on('request', req => { if (!req.url().startsWith('http://localhost:4173')) external.push(req.url()); });
  await openPdf(page, 'letter-5.pdf');
  await expectPageCount(page, 5);
  await expect(page.locator('#status-file')).toHaveText('letter-5.pdf');
  await expect(page.locator('#page-jump')).toHaveValue('1');
  await expect(page.locator('#page-total')).toHaveText('5');
  // First page preview finished rendering (placeholder removed, canvas has pixels).
  const first = page.locator('#pages-view .page').first();
  await expect(first).not.toHaveClass(/placeholder/);
  expect(await first.locator('canvas').evaluate((c: HTMLCanvasElement) => c.width)).toBeGreaterThan(100);
  expect(await thumbs(page).first().locator('canvas').evaluate((c: HTMLCanvasElement) => c.width)).toBeGreaterThan(20);
  expect(external).toEqual([]);
  expect(errors.filter(e => /Content Security Policy|Refused/.test(e))).toEqual([]);
});

test('asks for the password of an encrypted PDF, rejects a wrong one, and unlocks it', async ({ page }) => {
  await openPdf(page, 'encrypted.pdf');
  const dialog = page.locator('#password-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('encrypted');
  await page.locator('#password-input').fill('nope');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.locator('#password-error')).toBeVisible();
  await page.locator('#password-input').fill('user-pw');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expectPageCount(page, 2);
  await expect(page.locator('#toast')).toContainText('unlocked');
  const download = await clickDownload(page, () => page.locator('#export-button').click());
  expect(await downloadText(download)).toEqual(['E1', 'E2']);
  // Nothing about the password is kept in storage.
  expect(await page.evaluate(() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage))).not.toContain('user-pw');
});

test('skipping the password leaves the file closed', async ({ page }) => {
  await openPdf(page, 'encrypted.pdf');
  await page.getByRole('button', { name: 'Skip file' }).click();
  await expect(page.locator('#toast')).toContainText('skipped');
  await expect(page.locator('#empty-state')).toBeVisible();
});

test('owner-restricted PDFs need explicit consent', async ({ page }) => {
  await openPdf(page, 'restricted.pdf');
  await expect(page.locator('#confirm-dialog')).toContainText('restrictions set by its author');
  await page.getByRole('button', { name: 'Open anyway' }).click();
  await expectPageCount(page, 2);
});

test('reports corrupt and non-PDF files and keeps the valid ones', async ({ page }) => {
  await openPdf(page, 'corrupt.pdf', 'not-a-pdf.pdf', 'one-page.pdf');
  await expect(page.locator('#toast')).toContainText('corrupt: ');
  await expect(page.locator('#toast')).toContainText('damaged');
  await expect(page.locator('#toast')).toContainText('not a PDF');
  await expectPageCount(page, 1);
});

test('rotates, deletes, reorders with undo/redo, and exports a valid PDF', async ({ page }) => {
  await openPdf(page, 'letter-5.pdf');
  await expectPageCount(page, 5);

  await thumbs(page).nth(1).click();
  await page.getByRole('button', { name: '⟳ Rotate right' }).click();
  await expect(thumbs(page).nth(1)).toContainText('↻90°');
  // The rotated preview is landscape now.
  const box = await page.locator('#pages-view .page').nth(1).boundingBox();
  expect(box!.width).toBeGreaterThan(box!.height);

  await thumbs(page).nth(3).click({ modifiers: ['Control'] });
  await expect(page.locator('#status-selected')).toHaveText('2 selected');
  await page.keyboard.press('Delete');
  await expectPageCount(page, 3);

  await page.keyboard.press('Control+z');
  await expectPageCount(page, 5);
  await page.keyboard.press('Control+y');
  await expectPageCount(page, 3);
  await page.locator('#undo-button').click();
  await page.locator('#undo-button').click();
  await expect(thumbs(page).nth(1)).not.toContainText('↻');
  await page.locator('#redo-button').click();
  await expect(thumbs(page).nth(1)).toContainText('↻90°');

  // Keyboard reorder: move page 5 to the front.
  await thumbs(page).nth(4).click();
  for (let i = 0; i < 4; i++) await page.keyboard.press('Alt+ArrowUp');
  await expect(thumbs(page).first()).toHaveAttribute('title', /page 5$/);

  const download = await clickDownload(page, () => page.locator('#export-button').click());
  expect(download.suggestedFilename()).toBe('letter-5-edited.pdf');
  const doc = await readDownload(download);
  expect(doc.getPageCount()).toBe(5);
  expect(doc.getPages().map(p => p.getRotation().angle)).toEqual([0, 0, 90, 0, 0]);
});

test('reorders pages by dragging thumbnails', async ({ page }) => {
  await openPdf(page, 'letter-5.pdf');
  await expectPageCount(page, 5);
  await thumbs(page).nth(0).dragTo(thumbs(page).nth(2), { targetPosition: { x: 40, y: 150 } });
  await expect(thumbs(page).nth(2)).toHaveAttribute('title', /page 1$/);
  await expect(thumbs(page).nth(0)).toHaveAttribute('title', /page 2$/);
  await page.keyboard.press('Control+z');
  await expect(thumbs(page).nth(0)).toHaveAttribute('title', /page 1$/);
});

test('merges PDFs with different page sizes', async ({ page }) => {
  await openPdf(page, 'letter-5.pdf');
  await expectPageCount(page, 5);
  await addPdf(page, 'a4-landscape-2.pdf');
  await expectPageCount(page, 7);
  await expect(page.locator('#status-file')).toHaveText('letter-5.pdf + 1 more');
  // Move the first landscape page to the very front across documents.
  await thumbs(page).nth(5).click();
  for (let i = 0; i < 5; i++) await page.getByRole('button', { name: '↑ Move up' }).click();
  await expect(thumbs(page).first()).toHaveAttribute('title', /a4-landscape-2\.pdf - page 1$/);
  const download = await clickDownload(page, () => page.locator('#export-button').click());
  expect(download.suggestedFilename()).toBe('a4-landscape-2-merged.pdf');
  const doc = await readDownload(download);
  expect(doc.getPages().map(p => [p.getWidth(), p.getHeight()])).toEqual([[842, 595], [612, 792], [612, 792], [612, 792], [612, 792], [612, 792], [842, 595]]);
});

test('extracts selected pages and splits by ranges without changing the open document', async ({ page }) => {
  await openPdf(page, 'letter-5.pdf');
  await expectPageCount(page, 5);
  await thumbs(page).nth(1).click();
  await thumbs(page).nth(3).click({ modifiers: ['Shift'] });
  const extract = await clickDownload(page, () => page.getByRole('button', { name: /Extract 3 pages/ }).click());
  expect(extract.suggestedFilename()).toBe('letter-5-pages-2-4.pdf');
  // Each fixture page carries its own label, so this pins exactly which pages came out, in order.
  expect(await downloadText(extract)).toEqual(['L2', 'L3', 'L4']);

  await page.getByLabel('Page ranges').fill('1-2, 5');
  const zip = await clickDownload(page, () => page.getByRole('button', { name: 'Split' }).first().click());
  expect(zip.suggestedFilename()).toBe('letter-5-split-2-files.zip');
  const entries = await readZip(zip);
  expect(Object.keys(entries)).toEqual(['letter-5-part-1-pages-1-2.pdf', 'letter-5-part-2-pages-5.pdf']);
  expect(await Promise.all(Object.values(entries).map(pdfText))).toEqual([['L1', 'L2'], ['L5']]);
  await expectPageCount(page, 5);

  // A single range is a plain PDF, not a ZIP.
  await page.getByLabel('Page ranges').fill('3');
  const single = await clickDownload(page, () => page.getByRole('button', { name: 'Split' }).first().click());
  expect(single.suggestedFilename()).toBe('letter-5-pages-3.pdf');
  expect(await downloadText(single)).toEqual(['L3']);

  // Every N pages.
  await page.getByLabel('Pages per file').fill('2');
  const chunks = await clickDownload(page, () => page.getByRole('button', { name: 'Split' }).nth(1).click());
  expect(chunks.suggestedFilename()).toBe('letter-5-split-3-files.zip');
  const chunkEntries = await readZip(chunks);
  expect(Object.keys(chunkEntries)).toEqual(['letter-5-part-1-pages-1-2.pdf', 'letter-5-part-2-pages-3-4.pdf', 'letter-5-part-3-pages-5.pdf']);
  expect(await Promise.all(Object.values(chunkEntries).map(pdfText))).toEqual([['L1', 'L2'], ['L3', 'L4'], ['L5']]);

  await page.getByLabel('Page ranges').fill('4-9');
  await page.getByRole('button', { name: 'Split' }).first().click();
  await expect(page.locator('#toast')).toContainText('past the last page');
});

test('extracted pages follow the current page order, not the original file order', async ({ page }) => {
  await openPdf(page, 'letter-5.pdf');
  await expectPageCount(page, 5);
  // Move page 5 to the front: the order is now L5 L1 L2 L3 L4.
  await thumbs(page).nth(4).click();
  for (let i = 0; i < 4; i++) await page.keyboard.press('Alt+ArrowUp');
  await expect(thumbs(page).first()).toHaveAttribute('title', /page 5$/);
  await thumbs(page).nth(0).click();
  await thumbs(page).nth(2).click({ modifiers: ['Control'] });
  const extract = await clickDownload(page, () => page.getByRole('button', { name: /Extract 2 pages/ }).click());
  expect(await downloadText(extract)).toEqual(['L5', 'L2']);
});

test('a file name containing markup is shown as plain text and never runs', async ({ page }) => {
  const name = '<img src=x onerror="window.__pwned=1">.pdf';
  await page.locator('#open-input').setInputFiles({ name, mimeType: 'application/pdf', buffer: readFileSync(fixture('letter-5.pdf')) });
  await expectPageCount(page, 5);
  await expect(page.locator('#status-file')).toHaveText(name);
  await expect(page.locator('.source-list .name')).toHaveText(name);
  await expect(thumbs(page).first()).toHaveAttribute('title', `${name} - page 1`);
  await expect(page).toHaveTitle(`${name} - PageSmith`);
  expect(await page.locator('img[src="x"]').count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
});

test('adds, edits, moves and exports a text overlay; undo removes it', async ({ page }) => {
  await openPdf(page, 'one-page.pdf');
  await expectPageCount(page, 1);
  await page.getByRole('button', { name: 'T  Text' }).click();
  const area = page.getByLabel('Text', { exact: true });
  await expect(area).toBeFocused();
  await area.fill('Approved by QA');
  const overlay = page.locator('.ov-text');
  await expect(overlay).toHaveText('Approved by QA');
  await page.getByLabel('Font size').fill('24');

  const before = await overlay.boundingBox();
  const cx = before!.x + before!.width / 2, cy = before!.y + before!.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy + 80, { steps: 5 });
  await page.mouse.up();
  const after = await overlay.boundingBox();
  expect(after!.x - before!.x).toBeCloseTo(120, 0);
  expect(after!.y - before!.y).toBeCloseTo(80, 0);

  const download = await clickDownload(page, () => page.locator('#export-button').click());
  const doc = await readDownload(download);
  expect(doc.getPageCount()).toBe(1);
  expect((await downloadText(download))[0]).toContain('Approved by QA');

  await page.keyboard.press('Escape');
  for (let i = 0; i < 4; i++) await page.keyboard.press('Control+z');
  await expect(page.locator('.ov')).toHaveCount(0);
});

test('places a signature image, highlight and box', async ({ page }) => {
  await openPdf(page, 'one-page.pdf');
  await expectPageCount(page, 1);
  await page.locator('#image-input').setInputFiles(fixture('signature.png'));
  await expect(page.locator('.ov-image img')).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: '▬ Highlight' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: '▢ Box' }).click();
  await expect(page.locator('.ov')).toHaveCount(3);
  await page.keyboard.press('Delete');
  await expect(page.locator('.ov')).toHaveCount(2);
  const download = await clickDownload(page, () => page.locator('#export-button').click());
  const contents = (await import('node:fs')).readFileSync((await download.path())!, 'latin1');
  expect(contents).toMatch(/\/Subtype\s*\/Image/);
  expect((await readDownload(download)).getPageCount()).toBe(1);
});

test('rejects non-image signature files', async ({ page }) => {
  await openPdf(page, 'one-page.pdf');
  await expectPageCount(page, 1);
  await page.locator('#image-input').setInputFiles(fixture('one-page.pdf'));
  await expect(page.locator('#toast')).toContainText('PNG or JPEG');
});

test('opening repeatedly replaces the workspace cleanly', async ({ page }) => {
  for (let i = 0; i < 4; i++) {
    await openPdf(page, i % 2 ? 'one-page.pdf' : 'letter-5.pdf');
    await expectPageCount(page, i % 2 ? 1 : 5);
  }
  // Modified documents ask before being replaced.
  await page.keyboard.press(']');
  await openPdf(page, 'letter-5.pdf');
  await expect(page.locator('#confirm-dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Replace' }).click();
  await expectPageCount(page, 5);
  await expect(page.locator('#undo-button')).toBeDisabled();
});

test('clear resets the workspace', async ({ page }) => {
  await openPdf(page, 'letter-5.pdf');
  await expectPageCount(page, 5);
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator('#empty-state')).toBeVisible();
  await expectPageCount(page, 0);
});

test('zoom controls and fit width', async ({ page }) => {
  await openPdf(page, 'one-page.pdf');
  await expectPageCount(page, 1);
  const width = async () => (await page.locator('#pages-view .page').boundingBox())!.width;
  const fit = await width();
  await page.locator('#zoom-in').click();
  expect(await width()).toBeGreaterThan(fit);
  await page.locator('#zoom-out').click();
  await page.locator('#zoom-out').click();
  expect(await width()).toBeLessThan(fit);
  await page.locator('#fit-width').click();
  expect(Math.abs(await width() - fit)).toBeLessThan(2);
  await page.locator('#zoom-label').click();
  expect(Math.abs(await width() - 816)).toBeLessThan(2);
  // Fit page: the whole page is visible inside the stage.
  await page.locator('#fit-page').click();
  const stage = (await page.locator('#stage').boundingBox())!;
  const box = (await page.locator('#pages-view .page').boundingBox())!;
  expect(box.height).toBeLessThanOrEqual(stage.height);
  await expect(page.locator('#fit-page')).toHaveAttribute('aria-pressed', 'true');
});

test('theme toggle cycles and persists without storing document data', async ({ page }) => {
  await openPdf(page, 'one-page.pdf');
  await expectPageCount(page, 1);
  await page.locator('#theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.locator('#theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const storage = await page.evaluate(() => JSON.stringify(localStorage));
  expect(storage).toBe(JSON.stringify({ pagesmith_theme: 'dark' }));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
