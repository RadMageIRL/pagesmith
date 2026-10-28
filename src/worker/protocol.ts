import type { LoadErrorCode, PageRef, SourceDoc } from '../engine/types';
import type { Overlay } from '../overlay/types';

/** Messages from the UI thread to the engine worker. Every request carries a job id. */
export type EngineRequest =
  | { type: 'open'; job: number; blob: Blob; name: string; password?: string }
  | { type: 'blank'; job: number; width: number; height: number }
  | { type: 'build'; job: number; pages: PageRef[]; overlays: Overlay[]; title?: string; fontUrl: string }
  | { type: 'buildZip'; job: number; parts: { name: string; pages: PageRef[] }[]; overlays: Overlay[]; fontUrl: string }
  | { type: 'checkText'; job: number; text: string; fontUrl: string }
  | { type: 'close'; job: number; ids: string[] }
  | { type: 'cancel'; job: number; target: number };

export type EngineResult =
  | { type: 'open'; source: SourceDoc }
  | { type: 'blank'; source: SourceDoc; bytes: Uint8Array }
  | { type: 'bytes'; bytes: Uint8Array }
  | { type: 'checkText'; unsupported: string[] }
  | { type: 'ok' };

/** Messages from the worker back to the UI. */
export type EngineResponse =
  | { job: number; kind: 'progress'; fraction: number; label?: string }
  | { job: number; kind: 'done'; result: EngineResult }
  | { job: number; kind: 'error'; message: string; code?: LoadErrorCode | 'cancelled' | 'failed' };
