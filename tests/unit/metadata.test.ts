import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '../../src/version';

const root = join(import.meta.dirname, '..', '..');
const read = (file: string) => readFileSync(join(root, file), 'utf8');
const html = read('index.html');
const meta = (attr: 'name' | 'property', key: string) => new RegExp(`<meta ${attr}="${key}" content="([^"]*)">`).exec(html)?.[1];

describe('version', () => {
  it('is the same in package.json, the lockfile, src/version.ts, the About dialog and the structured data', () => {
    const pkg = JSON.parse(read('package.json')).version;
    const lock = JSON.parse(read('package-lock.json'));
    expect(APP_VERSION).toBe(pkg);
    expect([lock.version, lock.packages[''].version]).toEqual([pkg, pkg]);
    expect(html).toContain(`pagesmith <span class="muted">v${pkg}</span>`);
    expect(html).toContain(`"softwareVersion":"${pkg}"`);
  });
});

describe('search and sharing metadata', () => {
  const CANONICAL = 'https://radmagelabs.com/pagesmith/';

  it('has the title, description and canonical address of the radmagelabs.com page', () => {
    expect(/<title>([^<]*)<\/title>/.exec(html)?.[1]).toBe('PageSmith - Free Private PDF Editor | RadMage Labs');
    expect(meta('name', 'description')).toBe('Merge, split, reorder, rotate, and annotate PDFs for free in your browser. Private, offline-capable, and open source. No uploads or accounts.');
    expect(html).toContain(`<link rel="canonical" href="${CANONICAL}">`);
    expect(html).not.toMatch(/<meta name="robots"/);
  });

  it('has Open Graph and Twitter tags with an absolute 1200x630 preview image', () => {
    expect(meta('property', 'og:url')).toBe(CANONICAL);
    expect(meta('property', 'og:type')).toBe('website');
    expect(meta('property', 'og:title')).toBeTruthy();
    expect(meta('property', 'og:description')).toBeTruthy();
    expect(meta('property', 'og:image')).toBe('https://radmagelabs.com/assets/og/pagesmith.png');
    expect([meta('property', 'og:image:width'), meta('property', 'og:image:height')]).toEqual(['1200', '630']);
    expect(meta('property', 'og:image:alt')).toBeTruthy();
    expect(meta('name', 'twitter:card')).toBe('summary_large_image');
  });

  it('has valid WebApplication structured data that points at the same page and image', () => {
    const json = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1];
    const data = JSON.parse(json!);
    expect(data).toMatchObject({ '@type': 'WebApplication', name: 'PageSmith', url: CANONICAL, isAccessibleForFree: true, screenshot: meta('property', 'og:image') });
    expect(data.description).toBe(meta('name', 'description'));
  });
});
