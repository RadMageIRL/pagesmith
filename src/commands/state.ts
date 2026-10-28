import { newId, normalizeRotation, type PageRef, type SourceDoc } from '../engine/types';
import type { Overlay } from '../overlay/types';

/**
 * The undoable part of the workspace. States are treated as immutable: every command returns a
 * new object and leaves its input untouched, which is what makes snapshot undo/redo safe.
 */
export interface DocState {
  pages: readonly PageRef[];
  overlays: readonly Overlay[];
}

export const EMPTY_STATE: DocState = Object.freeze({ pages: [], overlays: [] });

export function pagesForSource(source: SourceDoc): PageRef[] {
  return source.pages.map((_, index) => ({ id: newId('p'), sourceId: source.id, sourceIndex: index, rotation: 0 }));
}

/** Appends pages (for merge / "Add PDF"). `at` inserts at an index instead. */
export function addPages(state: DocState, pages: PageRef[], at = state.pages.length): DocState {
  const index = Math.max(0, Math.min(at, state.pages.length));
  return { ...state, pages: [...state.pages.slice(0, index), ...pages, ...state.pages.slice(index)] };
}

export function rotatePages(state: DocState, ids: Iterable<string>, delta: number): DocState {
  const set = new Set(ids);
  if (!set.size) return state;
  return { ...state, pages: state.pages.map(p => (set.has(p.id) ? { ...p, rotation: normalizeRotation(p.rotation + delta) } : p)) };
}

/** Removes pages and any overlays drawn on them. */
export function deletePages(state: DocState, ids: Iterable<string>): DocState {
  const set = new Set(ids);
  if (!set.size) return state;
  return { pages: state.pages.filter(p => !set.has(p.id)), overlays: state.overlays.filter(o => !set.has(o.pageId)) };
}

/**
 * Moves the given pages, keeping their relative order, so they sit before the page that is
 * currently at `targetIndex` (or at the end when targetIndex === pages.length).
 */
export function movePages(state: DocState, ids: Iterable<string>, targetIndex: number): DocState {
  const set = new Set(ids);
  if (!set.size) return state;
  const moving = state.pages.filter(p => set.has(p.id));
  const before = state.pages.slice(0, Math.max(0, targetIndex)).filter(p => !set.has(p.id)).length;
  const rest = state.pages.filter(p => !set.has(p.id));
  const pages = [...rest.slice(0, before), ...moving, ...rest.slice(before)];
  return pages.every((p, i) => p === state.pages[i]) ? state : { ...state, pages };
}

/** Shifts each selected page one step earlier (-1) or later (+1); used by keyboard and touch controls. */
export function nudgePages(state: DocState, ids: Iterable<string>, direction: -1 | 1): DocState {
  const set = new Set(ids);
  const pages = [...state.pages];
  const order = direction < 0 ? pages.map((_, i) => i) : pages.map((_, i) => pages.length - 1 - i);
  let changed = false;
  for (const i of order) {
    const j = i + direction;
    if (!set.has(pages[i].id) || j < 0 || j >= pages.length || set.has(pages[j].id)) continue;
    [pages[i], pages[j]] = [pages[j], pages[i]];
    changed = true;
  }
  return changed ? { ...state, pages } : state;
}

export function addOverlay(state: DocState, overlay: Overlay): DocState {
  return { ...state, overlays: [...state.overlays, overlay] };
}

export function updateOverlay(state: DocState, id: string, patch: Partial<Overlay>): DocState {
  let changed = false;
  const overlays = state.overlays.map(o => {
    if (o.id !== id) return o;
    changed = true;
    return { ...o, ...patch, id: o.id, kind: o.kind, pageId: o.pageId } as Overlay;
  });
  return changed ? { ...state, overlays } : state;
}

export function removeOverlay(state: DocState, id: string): DocState {
  const overlays = state.overlays.filter(o => o.id !== id);
  return overlays.length === state.overlays.length ? state : { ...state, overlays };
}

/** Pages in a stable selection order (document order), regardless of click order. */
export function selectedInOrder(state: DocState, ids: Iterable<string>): PageRef[] {
  const set = new Set(ids);
  return state.pages.filter(p => set.has(p.id));
}
