// Copies pdf.js runtime data (CMaps, standard font data, wasm decoders) into public/ so they are
// served same-origin and bundled into dist/. Nothing is ever fetched from a CDN.
// pdf.js's scripting sandbox (quickjs-eval.*) is left out: PageSmith never runs scripts embedded in
// a PDF, and nothing in the app loads it.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'pdfjs-dist');
const dest = join(root, 'public', 'pdfjs');
const unused = name => name.startsWith('quickjs-eval.');
mkdirSync(dest, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  if (existsSync(join(src, dir))) cpSync(join(src, dir), join(dest, dir), { recursive: true, filter: from => !unused(basename(from)) });
}
// Remove copies left by earlier builds that still included the sandbox.
const wasm = join(dest, 'wasm');
if (existsSync(wasm)) for (const name of readdirSync(wasm)) if (unused(name)) rmSync(join(wasm, name));
console.log('pdf.js assets copied to public/pdfjs');
