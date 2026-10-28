import { expect, test, type Page } from '@playwright/test';
import { clickDownload, downloadText, expectPageCount, fixture, openPdf } from './helpers';
import { serveDistCopy } from './static-server';

test.use({ serviceWorkers: 'allow' });

async function waitForController(page: Page): Promise<void> {
  await page.waitForFunction(async () => {
    await navigator.serviceWorker.ready;
    return !!navigator.serviceWorker.controller;
  }, undefined, { timeout: 20_000 });
}

test('installable: manifest, icons and file handler are served', async ({ page, request }) => {
  await page.goto('/');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  const manifest = await (await request.get(`/${href!.replace('./', '')}`)).json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.file_handlers[0].accept['application/pdf']).toEqual(['.pdf']);
  for (const icon of manifest.icons) expect((await request.get(`/${icon.src}`)).ok()).toBe(true);
});

test('works fully offline after the first visit', async ({ page, context }) => {
  await page.goto('/');
  await waitForController(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#empty-state')).toBeVisible();
  await openPdf(page, 'letter-5.pdf');
  await expectPageCount(page, 5);
  await expect(page.locator('#pages-view .page').first()).not.toHaveClass(/placeholder/);
  // Text overlays need the bundled font, which must come from the cache.
  await page.getByRole('button', { name: 'T  Text' }).click();
  await page.getByLabel('Text', { exact: true }).fill('Offline edit');
  const text = await downloadText(await clickDownload(page, () => page.locator('#export-button').click()));
  expect(text[0]).toContain('Offline edit');
  // The license files the About dialog links to open as themselves from the cache, not as the app.
  await page.goto('/THIRD-PARTY-NOTICES.txt');
  await expect(page.locator('body')).toContainText('PageSmith: third-party notices');
});

test('an update waits for the user and never reloads mid-edit', async ({ page }) => {
  const server = await serveDistCopy();
  try {
    await page.goto(server.url);
    await waitForController(page);
    await page.locator('#open-input').setInputFiles(fixture('letter-5.pdf'));
    await expectPageCount(page, 5);
    await page.keyboard.press(']'); // unsaved edit
    await page.evaluate(() => { (window as unknown as { marker: number }).marker = 42; });

    // "Deploy" a new version, then let the browser's update check find it.
    server.deploy('sw.js', text => text.replace(/const VERSION = '[^']+'/, "const VERSION = 'test-update'"));
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())?.update(); });

    await expect(page.locator('#update-bar')).toBeVisible({ timeout: 20_000 });
    // Still the same session: nothing reloaded, edits intact.
    expect(await page.evaluate(() => (window as unknown as { marker: number }).marker)).toBe(42);
    await expect(page.locator('#thumbs .thumb').first()).toContainText('↻90°');
    // Reloading with unsaved work asks first; declining keeps everything.
    await page.locator('#update-reload').click();
    await expect(page.locator('#confirm-dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    expect(await page.evaluate(() => (window as unknown as { marker: number }).marker)).toBe(42);
    // "Later" hides the prompt without doing anything.
    await page.locator('#update-later').click();
    await expect(page.locator('#update-bar')).toBeHidden();
    expect(await page.evaluate(() => (window as unknown as { marker: number }).marker)).toBe(42);
  } finally {
    await server.close();
  }
});

test('accepting an update activates the new version with a single reload', async ({ page }) => {
  const server = await serveDistCopy();
  try {
    await page.goto(server.url);
    await waitForController(page);
    server.deploy('sw.js', text => text.replace(/const VERSION = '[^']+'/, "const VERSION = 'test-update'"));
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())?.update(); });
    await expect(page.locator('#update-bar')).toBeVisible({ timeout: 20_000 });
    // No unsaved work → no confirmation; one reload into the new version.
    await Promise.all([page.waitForEvent('load'), page.locator('#update-reload').click()]);
    await expect(page.locator('#empty-state')).toBeVisible();
    await expect.poll(() => page.evaluate(() => caches.keys())).toContain('pagesmith-test-update');
  } finally {
    await server.close();
  }
});
