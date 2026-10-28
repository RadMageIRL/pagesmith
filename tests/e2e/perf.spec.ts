import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { clickDownload, openPdf, readDownload, thumbs } from './helpers';

test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

const results: Record<string, unknown>[] = [];

for (const [file, pages] of [['large-100.pdf', 100], ['large-300.pdf', 300], ['large-500.pdf', 500], ['heavy-120.pdf', 120]] as const) {
  test(`large document: ${file}`, async ({ page }) => {
    await page.goto('/');
    // Record main-thread long tasks: with the engine in a worker, export must not block the UI.
    await page.evaluate(() => {
      const w = window as unknown as { longTasks: { start: number; duration: number }[] };
      w.longTasks = [];
      new PerformanceObserver(list => { for (const e of list.getEntries()) w.longTasks.push({ start: e.startTime, duration: e.duration }); }).observe({ type: 'longtask', buffered: false });
    });

    let t = Date.now();
    await openPdf(page, file);
    await expect(thumbs(page)).toHaveCount(pages, { timeout: 60_000 });
    await expect(page.locator('#pages-view .page').first()).not.toHaveClass(/placeholder/);
    const openMs = Date.now() - t;

    // Jump to the last page: it renders on demand.
    t = Date.now();
    await page.keyboard.press('End');
    await expect(page.locator('#pages-view .page').last()).not.toHaveClass(/placeholder/, { timeout: 20_000 });
    const jumpMs = Date.now() - t;

    // Reorder and rotate something so the export has real work.
    await thumbs(page).last().click();
    await page.keyboard.press(']');

    const exportStart = await page.evaluate(() => performance.now());
    t = Date.now();
    const download = await clickDownload(page, () => page.locator('#export-button').click());
    const exportMs = Date.now() - t;
    const exportEnd = await page.evaluate(() => performance.now());
    const longest = await page.evaluate(([a, b]) => Math.max(0, ...(window as unknown as { longTasks: { start: number; duration: number }[] }).longTasks
      .filter(x => x.start >= a && x.start <= b).map(x => x.duration)), [exportStart, exportEnd]);
    // While exporting, the UI keeps responding: a frame callback runs promptly.
    const doc = await readDownload(download);
    expect(doc.getPageCount()).toBe(pages);
    expect(doc.getPage(pages - 1).getRotation().angle).toBe(90);

    const heapMB = await page.evaluate(() => Math.round(((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1048576));
    const domCanvases = await page.evaluate(() => [...document.querySelectorAll('#pages-view canvas')].filter(c => (c as HTMLCanvasElement).width > 0).length);
    results.push({ file, sizeMB: Math.round(statSync(join(import.meta.dirname, '.fixtures', file)).size / 1048576), pages, openMs, jumpToLastMs: jumpMs, exportMs, longestMainThreadTaskDuringExportMs: Math.round(longest), uiHeapMB: heapMB, pageBitmapsAlive: domCanvases });
    // Generous bounds; the numbers themselves are reported.
    expect(openMs).toBeLessThan(30_000);
    expect(exportMs).toBeLessThan(60_000);
    expect(longest).toBeLessThan(250);
    expect(domCanvases).toBeLessThan(40);
  });
}

test.afterAll(() => {
  const dir = join(import.meta.dirname, '..', '..', 'test-results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'perf.json'), JSON.stringify(results, null, 2));
  console.log('PERF', JSON.stringify(results));
});
