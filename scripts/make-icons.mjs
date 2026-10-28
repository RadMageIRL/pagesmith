// Renders the app icons (PNG) from public/favicon.svg with headless Chrome. Run once after
// changing the logo: node scripts/make-icons.mjs
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const svg = readFileSync('public/favicon.svg', 'utf8');
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
async function render(size, file, maskable = false) {
  await page.setViewportSize({ width: size, height: size });
  // Maskable icons get a full-bleed background and the logo inside the 80% safe zone.
  const body = maskable
    ? `<div style="width:${size}px;height:${size}px;background:#101311;display:grid;place-items:center"><div style="width:${size * 0.72}px;height:${size * 0.72}px">${svg}</div></div>`
    : `<div style="width:${size}px;height:${size}px">${svg}</div>`;
  await page.setContent(`<html><body style="margin:0;background:transparent">${body}<style>svg{width:100%;height:100%;display:block}</style></body></html>`);
  await page.screenshot({ path: file, omitBackground: !maskable });
}
await render(192, 'public/icons/icon-192.png');
await render(512, 'public/icons/icon-512.png');
await render(512, 'public/icons/icon-maskable-512.png', true);
await browser.close();
console.log('icons written to public/icons');
