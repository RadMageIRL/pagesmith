import { CancelledError, PdfLoadError, type LoadErrorCode, type PageRef, type SourceDoc } from '../engine/types';
import type { Overlay } from '../overlay/types';
import type { EngineRequest, EngineResponse, EngineResult } from './protocol';

type Progress = (fraction: number, label?: string) => void;

interface Pending {
  resolve: (result: EngineResult) => void;
  reject: (err: Error) => void;
  progress?: Progress;
}

/** Distributes Omit over a union so each request variant keeps its own fields. */
type RequestBody = EngineRequest extends infer R ? R extends EngineRequest ? Omit<R, 'job'> : never : never;

/** A running engine job: await `promise`, or call `cancel()` to stop it at the next safe point. */
export interface Job<T> {
  promise: Promise<T>;
  cancel(): void;
}

/** UI-thread handle to the engine worker. */
export class EngineClient {
  private worker: Worker;
  private nextJob = 1;
  private pending = new Map<number, Pending>();

  constructor(private readonly fontUrl: string) {
    this.worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module', name: 'pagesmith-engine' });
    this.worker.addEventListener('message', (event: MessageEvent<EngineResponse>) => this.onMessage(event.data));
    this.worker.addEventListener('error', () => {
      for (const p of this.pending.values()) p.reject(new Error('The PDF engine stopped unexpectedly.'));
      this.pending.clear();
    });
  }

  open(blob: Blob, name: string, password?: string, progress?: Progress): Job<SourceDoc> {
    return this.map(this.send({ type: 'open', blob, name, password }, progress), r => (r as Extract<EngineResult, { type: 'open' }>).source);
  }

  blank(width: number, height: number): Job<{ source: SourceDoc; bytes: Uint8Array }> {
    return this.map(this.send({ type: 'blank', width, height }), r => r as Extract<EngineResult, { type: 'blank' }>);
  }

  build(pages: readonly PageRef[], overlays: readonly Overlay[], title: string | undefined, progress?: Progress): Job<Uint8Array> {
    return this.map(this.send({ type: 'build', pages: [...pages], overlays: [...overlays], title, fontUrl: this.fontUrl }, progress), r => (r as Extract<EngineResult, { type: 'bytes' }>).bytes);
  }

  buildZip(parts: { name: string; pages: PageRef[] }[], overlays: readonly Overlay[], progress?: Progress): Job<Uint8Array> {
    return this.map(this.send({ type: 'buildZip', parts, overlays: [...overlays], fontUrl: this.fontUrl }, progress), r => (r as Extract<EngineResult, { type: 'bytes' }>).bytes);
  }

  checkText(text: string): Promise<string[]> {
    return this.map(this.send({ type: 'checkText', text, fontUrl: this.fontUrl }), r => (r as Extract<EngineResult, { type: 'checkText' }>).unsupported).promise;
  }

  close(ids: string[]): void {
    if (ids.length) void this.send({ type: 'close', ids }).promise.catch(() => undefined);
  }

  private send(body: RequestBody, progress?: Progress): Job<EngineResult> {
    const job = this.nextJob++;
    const promise = new Promise<EngineResult>((resolve, reject) => this.pending.set(job, { resolve, reject, progress }));
    this.worker.postMessage({ ...body, job } as EngineRequest);
    return { promise, cancel: () => { if (this.pending.has(job)) this.worker.postMessage({ type: 'cancel', job: this.nextJob++, target: job } satisfies EngineRequest); } };
  }

  private map<A, B>(job: Job<A>, fn: (a: A) => B): Job<B> {
    return { promise: job.promise.then(fn), cancel: job.cancel };
  }

  private onMessage(msg: EngineResponse): void {
    const pending = this.pending.get(msg.job);
    if (!pending) return;
    if (msg.kind === 'progress') { pending.progress?.(msg.fraction, msg.label); return; }
    this.pending.delete(msg.job);
    if (msg.kind === 'done') pending.resolve(msg.result);
    else if (msg.code === 'cancelled') pending.reject(new CancelledError());
    else if (msg.code && msg.code !== 'failed') pending.reject(new PdfLoadError(msg.code as LoadErrorCode, msg.message));
    else pending.reject(new Error(msg.message));
  }
}
