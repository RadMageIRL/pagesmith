import { expect, test } from '@playwright/test';
import { clickDownload, downloadText, expectPageCount, openPdf, readDownload, thumbs } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('inserts blank pages of a chosen size, with undo', async ({ page }) => {
  await openPdf(page, 'letter-5.pdf');
  await expectPageCount(page, 5);
  await thumbs(page).nth(1).click();
  await page.getByLabel('Blank page size').selectOption('A4');
  await page.getByRole('button', { name: 'landscape' }).click();
  await page.getByRole('button', { name: '+ Insert blank page' }).click();
  await expectPageCount(page, 6);
  await expect(thumbs(page).nth(2)).toContainText('blank');
  // Keyboard shortcut inserts another, matching the current page.
  await page.locator('#stage').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('b');
  await expectPageCount(page, 7);
  await page.keyboard.press('Control+z');
  await expectPageCount(page, 6);
  const doc = await readDownload(await clickDownload(page, () => page.locator('#export-button').click()));
  expect(doc.getPages().map(p => Math.round(p.getWidth()))).toEqual([612, 612, 842, 612, 612, 612]);
});

test('searches text, steps through hits, and highlights them', async ({ page }) => {
  await openPdf(page, 'letter-5.pdf');
  await expectPageCount(page, 5);
  await page.keyboard.press('Control+f');
  await expect(page.locator('#search-input')).toBeFocused();
  await page.locator('#search-input').fill('l');
  await expect(page.locator('#search-count')).toHaveText('1 of 5');
  await page.locator('#search-input').fill('L4');
  await expect(page.locator('#search-count')).toHaveText('1 of 1');
  await expect(page.locator('#status-pages')).toContainText('of 5');
  await expect(page.locator('#page-jump')).toHaveValue('4');
  await expect(page.locator('.search-hit.current')).toHaveCount(1);
  await page.locator('#search-input').fill('zzz');
  await expect(page.locator('#search-count')).toHaveText('no matches');
  await page.keyboard.press('Escape');
  await expect(page.locator('#search-bar')).toBeHidden();
  await expect(page.locator('.search-hit')).toHaveCount(0);
});

test('explains that scanned PDFs cannot be searched', async ({ page }) => {
  await openPdf(page, 'scanned.pdf');
  await expectPageCount(page, 3);
  await page.locator('#search-button').click();
  await page.locator('#search-input').fill('anything');
  await expect(page.locator('#search-note')).toContainText('scanned');
  await expect(page.locator('#search-note')).toContainText('OCR');
});

test('reports partly scanned PDFs page count without a text layer', async ({ page }) => {
  await openPdf(page, 'partly-scanned.pdf');
  await expectPageCount(page, 4);
  await page.keyboard.press('Control+f');
  await page.locator('#search-input').fill('T2');
  await expect(page.locator('#search-count')).toHaveText('1 of 1');
  await expect(page.locator('#search-note')).toContainText('2 pages have no text layer (blank or scanned)');
});

test('jumps to a page and navigates with PageUp/PageDown', async ({ page }) => {
  await openPdf(page, 'letter-5.pdf');
  await expectPageCount(page, 5);
  await page.keyboard.press('Control+g');
  await expect(page.locator('#page-jump')).toBeFocused();
  await page.locator('#page-jump').fill('4');
  await page.keyboard.press('Enter');
  await expect(page.locator('#page-jump')).toHaveValue('4');
  await expect.poll(async () => page.locator('#pages-view .page').nth(3).evaluate(el => {
    const stage = document.getElementById('stage')!.getBoundingClientRect();
    return Math.abs(el.getBoundingClientRect().top - stage.top) < 40;
  })).toBe(true);
  await page.keyboard.press('PageUp');
  await expect(page.locator('#page-jump')).toHaveValue('3');
  await page.keyboard.press('PageDown');
  await page.keyboard.press('PageDown');
  await expect(page.locator('#page-jump')).toHaveValue('5');
});

test('text overlays can be resized with the handle, duplicated, edited later and removed', async ({ page }) => {
  await openPdf(page, 'one-page.pdf');
  await expectPageCount(page, 1);
  await page.locator('#stage').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('t');
  await page.getByLabel('Text', { exact: true }).fill('Resize me');
  await page.keyboard.press('Escape'); // leave the textarea
  const handle = page.locator('.ov-text .ov-handle');
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 10, { steps: 6 });
  await page.mouse.up();
  const size = Number(await page.getByLabel('Font size').inputValue());
  expect(size).toBeGreaterThan(22);

  await page.keyboard.press('Control+d');
  await expect(page.locator('.ov-text')).toHaveCount(2);
  // Re-select the first one later and change it.
  await page.getByRole('button', { name: 'Done' }).click();
  // The duplicate sits 12pt down-right, so the original's top-left corner is still clickable.
  await page.locator('.ov-text').first().click({ position: { x: 3, y: 3 } });
  await page.getByLabel('Text', { exact: true }).fill('Edited later');
  await expect(page.locator('.ov-text').first()).toHaveText('Edited later');
  await page.locator('.ov-text').nth(1).click();
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('.ov-text')).toHaveCount(1);
  const text = await downloadText(await clickDownload(page, () => page.locator('#export-button').click()));
  expect(text[0]).toContain('Edited later');
  expect(text[0]).not.toContain('Resize me');
});

test('warns about characters the bundled font cannot export', async ({ page }) => {
  await openPdf(page, 'one-page.pdf');
  await expectPageCount(page, 1);
  await page.getByRole('button', { name: 'T  Text' }).click();
  await page.getByLabel('Text', { exact: true }).fill('Привет 你好');
  await expect(page.locator('.panel .hint.warn')).toContainText('你 好');
  await page.getByLabel('Text', { exact: true }).fill('Привет Ωμέγα');
  await expect(page.locator('.panel .hint.warn')).toBeHidden();
  const text = await downloadText(await clickDownload(page, () => page.locator('#export-button').click()));
  expect(text[0]).toContain('Привет Ωμέγα');
});

test('overlays on a page with its own /Rotate export upright where they were placed', async ({ page }) => {
  await openPdf(page, 'rotated.pdf');
  await expectPageCount(page, 2);
  await page.getByRole('button', { name: 'T  Text' }).click();
  await page.getByLabel('Text', { exact: true }).fill('Upright');
  const download = await clickDownload(page, () => page.locator('#export-button').click());
  const doc = await readDownload(download);
  expect(doc.getPage(0).getRotation().angle).toBe(90);
  expect((await downloadText(download))[0]).toContain('Upright');
});

test('export of a large document can be canceled', async ({ page }) => {
  await openPdf(page, 'heavy-120.pdf');
  await expect(thumbs(page)).toHaveCount(120, { timeout: 30_000 });
  let downloads = 0;
  page.on('download', () => downloads++);
  // Exports finish in well under a second, faster than a person can react, so press Export and
  // Cancel in the same task: the cancel message reaches the worker right behind the build request
  // and must stop it at its first checkpoint.
  await page.evaluate(() => {
    (document.getElementById('export-button') as HTMLButtonElement).click();
    (document.getElementById('busy-cancel') as HTMLButtonElement).click();
  });
  await expect(page.locator('#toast')).toHaveText('Canceled');
  await expect(page.locator('#busy')).toBeHidden();
  await page.waitForTimeout(500);
  expect(downloads).toBe(0);
  // The engine is still usable afterwards.
  const doc = await readDownload(await clickDownload(page, () => page.locator('#export-button').click()));
  expect(doc.getPageCount()).toBe(120);
});

test('no document data leaves the browser, from the first page load on', async ({ page }) => {
  const requests: { url: string; method: string; hasBody: boolean }[] = [];
  const consoleErrors: string[] = [];
  page.on('request', req => requests.push({ url: req.url(), method: req.method(), hasBody: !!req.postDataBuffer() }));
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  // A request the CSP blocks never reaches the network, so record the blocks themselves too.
  await page.addInitScript(() => {
    const w = window as unknown as { cspViolations: string[] };
    w.cspViolations = [];
    document.addEventListener('securitypolicyviolation', e => w.cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  // beforeEach already loaded the app; load it again now that everything is being recorded.
  await page.goto('/');
  await openPdf(page, 'letter-5.pdf');
  await expectPageCount(page, 5);
  await page.getByRole('button', { name: 'T  Text' }).click();
  await page.getByLabel('Text', { exact: true }).fill('Private note');
  await page.keyboard.press('Control+f');
  await page.locator('#search-input').fill('L3');
  await expect(page.locator('#search-count')).toHaveText('1 of 1');
  await clickDownload(page, () => page.locator('#export-button').click());
  const offOrigin = requests.filter(r => !r.url.startsWith('http://localhost:4173/') && !r.url.startsWith('blob:') && !r.url.startsWith('data:'));
  expect(offOrigin).toEqual([]);
  expect(requests.filter(r => r.method !== 'GET' || r.hasBody)).toEqual([]);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations)).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('the production build carries a strict Content-Security-Policy', async ({ request }) => {
  const html = await (await request.get('/')).text();
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1];
  expect(csp).toBeTruthy();
  const directives = Object.fromEntries(csp!.split(';').map(d => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
  expect(directives['default-src']).toEqual(["'self'"]);
  expect(directives['connect-src']).toEqual(["'self'", 'blob:', 'data:']);
  expect(directives['object-src']).toEqual(["'none'"]);
  expect(directives['frame-src']).toEqual(["'none'"]);
  expect(directives['form-action']).toEqual(["'none'"]);
  expect(directives['base-uri']).toEqual(["'self'"]);
  expect(directives['script-src']).toContain("'self'");
  expect(directives['script-src']).not.toContain("'unsafe-inline'");
  expect(directives['script-src']).not.toContain("'unsafe-eval'");
});

test('the license and third-party notices ship with the app and are linked from About', async ({ page, request }) => {
  await page.locator('#about-button').click();
  const links = page.locator('#about-dialog .about-links a');
  await expect(links).toHaveText(['License', 'Third-party notices', 'Source code']);
  await expect(links.nth(2)).toHaveAttribute('href', 'https://github.com/RadMageIRL/pagesmith');
  for (const [index, expected] of [[0, 'GNU GENERAL PUBLIC LICENSE'], [1, 'PageSmith: third-party notices']] as const) {
    const response = await request.get(`/${await links.nth(index).getAttribute('href')}`);
    expect(response.ok()).toBe(true);
    expect(await response.text()).toContain(expected);
  }
  // pdf.js's scripting sandbox is never used, so it is neither shipped nor cached for offline use.
  const sw = await (await request.get('/sw.js')).text();
  expect(sw).toContain('./THIRD-PARTY-NOTICES.txt');
  expect(sw).not.toContain('quickjs');
});

test('on-screen text baseline matches the exported baseline (same font, same metrics)', async ({ page }) => {
  await openPdf(page, 'one-page.pdf');
  await expectPageCount(page, 1);
  await page.getByRole('button', { name: 'T  Text' }).click();
  await page.getByLabel('Text', { exact: true }).fill('Baseline');
  await page.getByLabel('Font size').fill('40');
  await page.evaluate(() => document.fonts.ready);
  const result = await page.locator('.ov-text').evaluate(el => {
    // A zero-size inline-block sits exactly on the baseline of the line it's in.
    const probe = document.createElement('span');
    probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
    el.insertBefore(probe, el.firstChild);
    const offset = probe.getBoundingClientRect().top - el.getBoundingClientRect().top;
    probe.remove();
    return { offset, fontSize: parseFloat(getComputedStyle(el).fontSize), family: getComputedStyle(el).fontFamily, loaded: document.fonts.check(`40px "PageSmith Sans"`) };
  });
  expect(result.loaded).toBe(true);
  expect(result.family).toContain('PageSmith Sans');
  // Exporter: baseline = top + 0.988 × size. Allow one CSS pixel of rounding.
  expect(Math.abs(result.offset - 0.988 * result.fontSize)).toBeLessThanOrEqual(1);
});

test('an overlay added right after jumping to a page appears in view on that page', async ({ page }) => {
  await openPdf(page, 'letter-5.pdf');
  await expectPageCount(page, 5);
  await page.keyboard.press('End');
  await page.waitForTimeout(400);
  // Jump back and add immediately, while the smooth scroll is still running.
  await thumbs(page).nth(1).click();
  await page.getByRole('button', { name: 'T  Text' }).click();
  const overlay = page.locator('.ov-text');
  await expect(overlay).toBeInViewport();
  expect(await overlay.evaluate(el => [...document.querySelectorAll('#pages-view .page')].indexOf(el.closest('.page')!))).toBe(1);
  const offset = await overlay.evaluate(el => el.getBoundingClientRect().top - el.closest('.page')!.getBoundingClientRect().top);
  expect(offset).toBeLessThan(200);
});
