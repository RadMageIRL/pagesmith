/// <reference lib="webworker" />
// The engine worker owns every parsed document and does all pdf-lib work: parsing, decrypting,
// building and zipping. The UI thread only ever holds page geometry, so a 500-page export never
// blocks scrolling or input. PDF.js keeps its own separate rendering worker.
import { CancelledError, PdfLoadError } from '../engine/types';
import { createBlank, loadSource } from '../engine/load';
import { buildPdf, zipFiles, type SourceHandle } from '../export/export';
import { TextFont } from '../export/fonts';
import type { EngineRequest, EngineResponse, EngineResult } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const sources = new Map<string, SourceHandle>();
const jobs = new Map<number, AbortController>();
let fontBytes: Promise<Uint8Array> | null = null;
let textFont: TextFont | null = null;

function loadFont(url: string): () => Promise<Uint8Array> {
  return () => {
    fontBytes ??= fetch(url).then(r => {
      if (!r.ok) throw new Error('The bundled font could not be loaded.');
      return r.arrayBuffer();
    }).then(b => new Uint8Array(b)).catch(err => { fontBytes = null; throw err; });
    return fontBytes;
  };
}

function post(message: EngineResponse, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer);
}

/** A transferable buffer that is exactly the bytes (no hidden extra copy when the view is a slice). */
function exact(bytes: Uint8Array): Uint8Array {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
}

async function handle(req: EngineRequest, signal: AbortSignal): Promise<{ result: EngineResult; transfer?: Transferable[] }> {
  const progress = (fraction: number, label?: string) => post({ job: req.job, kind: 'progress', fraction, label });
  switch (req.type) {
    case 'open': {
      // The Blob is a handle to the user's file; reading it here means the UI thread never holds
      // a copy of the document bytes.
      const bytes = new Uint8Array(await req.blob.arrayBuffer());
      const loaded = await loadSource(bytes, req.name, { password: req.password, signal });
      sources.set(loaded.source.id, { doc: loaded.doc, pages: loaded.source.pages });
      return { result: { type: 'open', source: loaded.source } };
    }
    case 'blank': {
      const { loaded, bytes } = await createBlank(req.width, req.height);
      sources.set(loaded.source.id, { doc: loaded.doc, pages: loaded.source.pages });
      const out = exact(bytes);
      return { result: { type: 'blank', source: loaded.source, bytes: out }, transfer: [out.buffer] };
    }
    case 'build': {
      const bytes = exact(await buildPdf(req.pages, req.overlays, id => sources.get(id), { title: req.title, signal, onProgress: f => progress(f), loadFont: loadFont(req.fontUrl) }));
      return { result: { type: 'bytes', bytes }, transfer: [bytes.buffer] };
    }
    case 'buildZip': {
      const files = [];
      for (let i = 0; i < req.parts.length; i++) {
        const part = req.parts[i];
        const bytes = await buildPdf(part.pages, req.overlays, id => sources.get(id), {
          signal, loadFont: loadFont(req.fontUrl),
          onProgress: f => progress((i + f) / req.parts.length * 0.95, `Building part ${i + 1} of ${req.parts.length}…`),
        });
        files.push({ name: part.name, bytes });
      }
      progress(0.97, 'Packing ZIP…');
      const zip = exact(zipFiles(files));
      return { result: { type: 'bytes', bytes: zip }, transfer: [zip.buffer] };
    }
    case 'checkText': {
      textFont ??= TextFont.fromBytes(await loadFont(req.fontUrl)());
      return { result: { type: 'checkText', unsupported: textFont.unsupported(req.text) } };
    }
    case 'close': {
      for (const id of req.ids) sources.delete(id);
      return { result: { type: 'ok' } };
    }
    case 'cancel': {
      jobs.get(req.target)?.abort();
      return { result: { type: 'ok' } };
    }
  }
}

self.addEventListener('message', async (event: MessageEvent<EngineRequest>) => {
  const req = event.data;
  const controller = new AbortController();
  if (req.type !== 'cancel') jobs.set(req.job, controller);
  try {
    const { result, transfer } = await handle(req, controller.signal);
    post({ job: req.job, kind: 'done', result }, transfer);
  } catch (err) {
    if (err instanceof CancelledError || controller.signal.aborted) post({ job: req.job, kind: 'error', code: 'cancelled', message: 'Canceled' });
    else if (err instanceof PdfLoadError) post({ job: req.job, kind: 'error', code: err.code, message: err.message });
    // Only the error's own message is reported; document contents are never logged or posted.
    else post({ job: req.job, kind: 'error', code: 'failed', message: (err as Error)?.message || 'The operation failed.' });
  } finally {
    jobs.delete(req.job);
  }
});
