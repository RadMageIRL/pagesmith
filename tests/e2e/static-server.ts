import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.icc': 'application/octet-stream', '.txt': 'text/plain',
};

/** A stand-in for another app on the same site, for checking that PageSmith leaves it alone. */
const NEIGHBOR = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Neighbor</title></head><body><p>Another app on the same site</p></body></html>';

/**
 * Serves a private copy of dist/ so a test can "deploy" a new version without touching dist/.
 * With `base` (such as '/pagesmith/') the app lives under that path the way radmagelabs.com
 * proxies it, and the site root and /other/ are stand-ins for the rest of the site.
 */
export async function serveDistCopy(options: { base?: string } = {}): Promise<{ url: string; root: string; deploy(file: string, edit: (text: string) => string): void; close(): Promise<void> }> {
  const base = options.base ?? '/';
  const root = mkdtempSync(join(tmpdir(), 'pagesmith-dist-'));
  cpSync(join(import.meta.dirname, '..', '..', 'dist'), root, { recursive: true });
  const server: Server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url!, 'http://x').pathname);
    if (base !== '/' && !pathname.startsWith(base)) {
      if (pathname === '/' || pathname === '/other/') res.writeHead(200, { 'Content-Type': 'text/html' }).end(NEIGHBOR);
      else res.writeHead(404).end();
      return;
    }
    const path = normalize(pathname.slice(base.length)).replace(/^[/\\]+/, '');
    const file = join(root, path === '' || path === '.' ? 'index.html' : path);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    try {
      const body = readFileSync(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}${base}`,
    root,
    deploy: (file, edit) => writeFileSync(join(root, file), edit(readFileSync(join(root, file), 'utf8'))),
    close: () => new Promise<void>(resolve => server.close(() => { rmSync(root, { recursive: true, force: true }); resolve(); })),
  };
}
