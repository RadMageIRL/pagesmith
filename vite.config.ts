/// <reference types="vitest/config" />
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { defineConfig, type Plugin, type ResolvedConfig } from 'vite';

/**
 * Adds a strict Content-Security-Policy to the built page. Inline scripts are allowed only by
 * hash, every fetch stays same-origin, and plugins/frames/forms are disabled. Dev builds skip it
 * because Vite's HMR client needs websockets and inline styles.
 */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'pagesmith-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
      const policy = [
        "default-src 'self'",
        `script-src 'self' 'wasm-unsafe-eval' ${hashes.join(' ')}`,
        "worker-src 'self' blob:",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' blob: data:",
        "font-src 'self' data: blob:",
        "connect-src 'self' blob: data:",
        "manifest-src 'self'",
        "object-src 'none'",
        "frame-src 'none'",
        "base-uri 'self'",
        "form-action 'none'",
      ].join('; ');
      return html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="${policy}">`);
    },
  };
}

/**
 * Ships the license and the third-party notices next to the app, since the minified bundles drop
 * every license comment. The About dialog links to both.
 */
function licenseFiles(): Plugin {
  return {
    name: 'pagesmith-license-files',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'LICENSE.txt', source: readFileSync('LICENSE', 'utf8') });
      this.emitFile({ type: 'asset', fileName: 'THIRD-PARTY-NOTICES.txt', source: readFileSync('THIRD-PARTY-NOTICES.txt', 'utf8') });
    },
  };
}

/**
 * Writes dist/sw.js from src/sw-template.js with a precache list of every built file and a version
 * derived from the package version and their contents, so any change to the app produces a new service
 * worker, and building the same sources twice produces identical files.
 */
function serviceWorker(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'pagesmith-sw',
    apply: 'build',
    configResolved(resolved) { config = resolved; },
    closeBundle() {
      const outDir = config.build.outDir;
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else files.push(relative(outDir, full).split(sep).join('/'));
        }
      };
      walk(outDir);
      const precache = files.filter(f => f !== 'sw.js' && !f.endsWith('.map')).sort();
      const hash = createHash('sha256');
      for (const f of precache) hash.update(f).update(readFileSync(join(outDir, f)));
      // No date or other build-time input: the same sources always build the same service worker.
      const version = `${JSON.parse(readFileSync('package.json', 'utf8')).version}-${hash.digest('hex').slice(0, 12)}`;
      const template = readFileSync('src/sw-template.js', 'utf8');
      const urls = ['./', ...precache.map(f => `./${f}`)];
      writeFileSync(join(outDir, 'sw.js'), template.replace('__VERSION__', version).replace('__PRECACHE__', JSON.stringify(urls, null, 0)));
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [contentSecurityPolicy(), licenseFiles(), serviceWorker()],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2500,
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
});
