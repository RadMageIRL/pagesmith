import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.icc': 'application/octet-stream', '.txt': 'text/plain',
};

/** Serves a private copy of dist/ so a test can "deploy" a new version without touching dist/. */
export async function serveDistCopy(): Promise<{ url: string; root: string; deploy(file: string, edit: (text: string) => string): void; close(): Promise<void> }> {
  const root = mkdtempSync(join(tmpdir(), 'pagesmith-dist-'));
  cpSync(join(import.meta.dirname, '..', '..', 'dist'), root, { recursive: true });
  const server: Server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url!, 'http://x').pathname)).replace(/^[/\\]+/, '');
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
    url: `http://127.0.0.1:${port}/`,
    root,
    deploy: (file, edit) => writeFileSync(join(root, file), edit(readFileSync(join(root, file), 'utf8'))),
    close: () => new Promise<void>(resolve => server.close(() => { rmSync(root, { recursive: true, force: true }); resolve(); })),
  };
}
