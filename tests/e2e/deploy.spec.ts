import { expect, test, type Page } from '@playwright/test';
import { clickDownload, downloadText, expectPageCount, openPdf } from './helpers';
import { serveDistCopy } from './static-server';

// radmagelabs.com serves PageSmith under /pagesmith/, next to other apps on the same origin. These
// checks run the production build under that path, with stand-ins for the rest of the site.
test.use({ serviceWorkers: 'allow' });

async function record(page: Page) {
  const requests: string[] = [];
  const failed: string[] = [];
  const errors: string[] = [];
  page.on('request', r => requests.push(r.url()));
  page.on('response', r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    const w = window as unknown as { cspViolations: string[] };
    w.cspViolations = [];
    document.addEventListener('securitypolicyviolation', e => w.cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  return { requests, failed, errors };
}

async function waitForController(page: Page): Promise<void> {
  await page.waitForFunction(async () => {
    await navigator.serviceWorker.ready;
    return !!navigator.serviceWorker.controller;
  }, undefined, { timeout: 20_000 });
}

test('under /pagesmith/ every request stays inside the path, and rendering, fonts and export work', async ({ page }) => {
  const server = await serveDistCopy({ base: '/pagesmith/' });
  try {
    const seen = await record(page);
    await page.goto(server.url);
    await openPdf(page, 'letter-5.pdf');
    await expectPageCount(page, 5);
    const first = page.locator('#pages-view .page').first();
    await expect(first).not.toHaveClass(/placeholder/);
    expect(await first.locator('canvas').evaluate((c: HTMLCanvasElement) => c.width)).toBeGreaterThan(100);
    // Search uses pdf.js's text layer; a text overlay needs the bundled font in the engine worker.
    await page.keyboard.press('Control+f');
    await page.locator('#search-input').fill('L3');
    await expect(page.locator('#search-count')).toHaveText('1 of 1');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'T  Text' }).click();
    await page.getByLabel('Text', { exact: true }).fill('Under the subpath');
    const text = await downloadText(await clickDownload(page, () => page.locator('#export-button').click()));
    expect(text).toHaveLength(5);
    expect(text.join(' ')).toContain('Under the subpath');

    expect(seen.failed).toEqual([]);
    expect(seen.requests.filter(u => !u.startsWith(server.url) && !u.startsWith('blob:') && !u.startsWith('data:'))).toEqual([]);
    expect(seen.errors).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations)).toEqual([]);
  } finally {
    await server.close();
  }
});

test('the service worker is scoped to /pagesmith/ and leaves the rest of the site alone', async ({ page }) => {
  const server = await serveDistCopy({ base: '/pagesmith/' });
  try {
    await page.goto(server.url);
    await waitForController(page);
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.scope)).toBe(server.url);
    expect(await page.evaluate(() => caches.keys())).toEqual([expect.stringMatching(/^pagesmith-/)]);
    const origin = new URL(server.url).origin;
    for (const other of [`${origin}/`, `${origin}/other/`]) {
      await page.goto(other);
      await expect(page.locator('body')).toContainText('Another app on the same site');
      expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
      expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()) ?? null)).toBeNull();
    }
  } finally {
    await server.close();
  }
});

test('under /pagesmith/ the app works offline after the first visit, license files included', async ({ page, context }) => {
  const server = await serveDistCopy({ base: '/pagesmith/' });
  try {
    await page.goto(server.url);
    await waitForController(page);
    await context.setOffline(true);
    await page.reload();
    await openPdf(page, 'letter-5.pdf');
    await expectPageCount(page, 5);
    await expect(page.locator('#pages-view .page').first()).not.toHaveClass(/placeholder/);
    await page.goto(`${server.url}THIRD-PARTY-NOTICES.txt`);
    await expect(page.locator('body')).toContainText('PageSmith: third-party notices');
    await page.goto(`${server.url}LICENSE.txt`);
    await expect(page.locator('body')).toContainText('GNU GENERAL PUBLIC LICENSE');
  } finally {
    await context.setOffline(false);
    await server.close();
  }
});
