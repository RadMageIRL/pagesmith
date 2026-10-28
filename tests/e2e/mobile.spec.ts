import { expect, test, type Page } from '@playwright/test';
import { clickDownload, expectPageCount, openPdf, readDownload, thumbs } from './helpers';

const noHorizontalOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);

/** Real touch input through the Chrome DevTools protocol: press, hold, drag, release. */
async function touchDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, holdMs: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
  await page.waitForTimeout(holdMs);
  for (let i = 1; i <= 8; i++) {
    const x = from.x + (to.x - from.x) * i / 8, y = from.y + (to.y - from.y) * i / 8;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

const center = async (page: Page, index: number) => {
  const box = (await thumbs(page).nth(index).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

test('mobile layout has no horizontal overflow and drawers work', async ({ page }) => {
  await page.goto('/');
  expect(await noHorizontalOverflow(page)).toBe(true);
  await openPdf(page, 'letter-5.pdf');
  await expectPageCount(page, 5);
  expect(await noHorizontalOverflow(page)).toBe(true);

  await expect(page.locator('#sidebar')).not.toBeInViewport();
  await page.locator('#pages-toggle').click();
  await expect(page.locator('#sidebar')).toBeInViewport();
  await thumbs(page).nth(2).tap();
  await expect(page.locator('#sidebar')).not.toBeInViewport();
  await expect(page.locator('#page-jump')).toHaveValue('3');

  await page.locator('#panel-toggle').tap();
  await expect(page.locator('#panel')).toBeInViewport();
  await page.getByRole('button', { name: '⟳ Rotate right' }).tap();
  await page.getByRole('button', { name: '↑ Move up' }).tap();
  expect(await noHorizontalOverflow(page)).toBe(true);

  const download = await clickDownload(page, () => page.locator('#export-button').tap());
  const doc = await readDownload(download);
  expect(doc.getPages().map(p => p.getRotation().angle)).toEqual([0, 90, 0, 0, 0]);
});

test('long-press and drag reorders thumbnails by touch; a quick swipe does not', async ({ page }) => {
  await page.goto('/');
  await openPdf(page, 'letter-5.pdf');
  await expectPageCount(page, 5);
  await page.locator('#pages-toggle').click();
  await expect(page.locator('#sidebar')).toBeInViewport();
  await page.waitForTimeout(300);

  // A short press (150 ms, well under the 380 ms long-press) and then a swipe to the same spot the
  // long-press below drops on: no reorder. The hold and the real drop target are what make this fail
  // if the long-press delay ever gets too short or a swipe ever starts a drag.
  const below2 = async () => { const c = await center(page, 1); return { x: c.x, y: c.y + 40 }; };
  await touchDrag(page, await center(page, 0), await below2(), 150);
  await page.waitForTimeout(200);
  await expect(thumbs(page).nth(0)).toHaveAttribute('title', /page 1$/);
  await expect(thumbs(page).nth(1)).toHaveAttribute('title', /page 2$/);

  // Long-press page 1 and drop it below page 2.
  await touchDrag(page, await center(page, 0), await below2(), 600);
  await expect(thumbs(page).nth(0)).toHaveAttribute('title', /page 2$/);
  await expect(thumbs(page).nth(1)).toHaveAttribute('title', /page 1$/);
  await expect(page.locator('#toast')).toContainText('Moved 1 page');
  // Undo covers touch moves too.
  await page.locator('#undo-button').tap();
  await expect(thumbs(page).nth(0)).toHaveAttribute('title', /page 1$/);
});

test('search is reachable from the tools drawer on phones', async ({ page }) => {
  await page.goto('/');
  await openPdf(page, 'letter-5.pdf');
  await expectPageCount(page, 5);
  await page.locator('#panel-toggle').tap();
  await page.getByRole('button', { name: '⌕ Search text' }).tap();
  await expect(page.locator('#search-input')).toBeFocused();
  await page.locator('#search-input').fill('L5');
  await expect(page.locator('#search-count')).toHaveText('1 of 1');
  await expect(page.locator('#page-jump')).toHaveValue('5');
  expect(await noHorizontalOverflow(page)).toBe(true);
});

test('page previews fit the phone width', async ({ page }) => {
  await page.goto('/');
  await openPdf(page, 'a4-landscape-2.pdf');
  await expectPageCount(page, 2);
  const box = await page.locator('#pages-view .page').first().boundingBox();
  const vw = page.viewportSize()!.width;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(vw);
});
