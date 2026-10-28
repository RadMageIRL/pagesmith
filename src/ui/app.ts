import { History } from '../commands/history';
import {
  EMPTY_STATE, addOverlay, addPages, deletePages, movePages, nudgePages, pagesForSource, removeOverlay, rotatePages,
  selectedInOrder, updateOverlay, type DocState,
} from '../commands/state';
import { baseName, PAGE_SIZES } from '../engine/names';
import { chunkPages, describePages, parseRanges } from '../engine/ranges';
import { CancelledError, PdfLoadError, effectiveRotation, newId, normalizeRotation, type PageInfo, type PageRef, type Rotation, type SourceDoc } from '../engine/types';
import { convertView, viewSize } from '../overlay/geometry';
import { OVERLAY_FONT_FAMILY, TEXT_LINE_HEIGHT, clampFontSize, safeColor, sniffImage, type ImageOverlay, type Overlay, type RectOverlay, type TextOverlay } from '../overlay/types';
import { Renderer, type TextRun } from '../render/renderer';
import { findMatches, matchBox } from '../render/textsearch';
import { EngineClient, type Job } from '../worker/client';
import { $, button, h, isEditable } from './dom';
import { downloadBlob } from './download';
import { applyTheme, cycleTheme, storedTheme, themeLabel } from './prefs';

const SOURCE_COLORS = ['#56a36e', '#5d9ee7', '#d6a545', '#a981d0', '#e58a3e', '#e66055'];
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
/** CSS pixels per PDF point at "100%". */
const PX_PER_PT = 96 / 72;
const THUMB_BOX = { width: 150, height: 150 };
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
/** Above this many pages, offscreen bitmaps are released to cap memory. */
const RELEASE_PAGES_ABOVE = 24;
const RELEASE_THUMBS_ABOVE = 150;
const LONG_PRESS_MS = 380;
/** The page title from index.html, shown again whenever no document is open. */
const HOME_TITLE = document.title;

type ZoomMode = number | 'fit-width' | 'fit-page';

interface PageView {
  id: string;
  thumb: HTMLLIElement;
  thumbCanvas: HTMLCanvasElement;
  thumbLabel: HTMLSpanElement;
  page: HTMLDivElement;
  pageCanvas: HTMLCanvasElement;
  pageNumber: HTMLSpanElement;
  layer: HTMLDivElement;
  searchLayer: HTMLDivElement;
  thumbKey: string | null;
  pageKey: string | null;
  thumbAbort: AbortController | null;
  pageAbort: AbortController | null;
  thumbVisible: boolean;
  pageVisible: boolean;
  /** Overlays and scale last drawn, so unchanged layers are not rebuilt on every render. */
  drawn: { overlays: readonly Overlay[]; scale: number; rotation: Rotation; selected: string | null } | null;
}

interface SearchHit { pageId: string; box: { x: number; y: number; width: number; height: number } }

interface CommitOptions { coalesce?: string; panel?: boolean }

interface BusyControl {
  update(label: string, fraction?: number): void;
  /** Shows a Cancel button that runs `fn`. */
  cancellable(fn: () => void): void;
}

export class App {
  private sources = new Map<string, SourceDoc>();
  private history = new History<DocState>(EMPTY_STATE);
  private renderer = new Renderer();
  private engine: EngineClient;
  private fontUrl = new URL('fonts/NotoSans-Regular.ttf', document.baseURI).href;
  private fontFace: FontFace | null = null;
  private views = new Map<string, PageView>();
  private selection = new Set<string>();
  private anchorId: string | null = null;
  private focusId: string | null = null;
  private currentId: string | null = null;
  private selectedOverlayId: string | null = null;
  private zoom: ZoomMode = 'fit-width';
  private scale = PX_PER_PT;
  private dirty = false;
  private rangeText = '';
  private chunkSize = 1;
  private blankSize = 'match';
  private blankLandscape = false;
  private sourceColor = new Map<string, string>();
  private imageUrls = new Map<Uint8Array, string>();
  private dragIds: string[] | null = null;
  private busyDepth = 0;
  private toastTimer = 0;
  private textCheckTimer = 0;
  private suppressClickUntil = 0;
  private scrollLockUntil = 0;
  // search
  private searchQuery = '';
  private searchHits: SearchHit[] = [];
  private searchIndex = -1;
  private searchAbort: AbortController | null = null;
  private textCache = new Map<string, TextRun[]>();
  private searchTimer = 0;

  private thumbs = $('thumbs') as HTMLOListElement;
  private stage = $('stage');
  private pagesView = $('pages-view');
  private panel = $('panel');
  private thumbObserver: IntersectionObserver;
  private pageObserver: IntersectionObserver;

  constructor() {
    this.engine = new EngineClient(this.fontUrl);
    this.thumbObserver = new IntersectionObserver(entries => this.onVisibility(entries, 'thumb'), { root: this.thumbs, rootMargin: '300px 0px' });
    this.pageObserver = new IntersectionObserver(entries => this.onVisibility(entries, 'page'), { root: this.stage, rootMargin: '600px 0px' });
    this.bindChrome();
    this.bindKeyboard();
    this.bindFileDrop();
    this.bindThumbDrag();
    this.bindTouchReorder();
    this.bindSearch();
    applyTheme(storedTheme());
    this.updateThemeButtons();
    new ResizeObserver(() => { if (typeof this.zoom !== 'number') this.applyZoom(); }).observe(this.stage);
    this.render();
  }

  /** True while there are edits that have not been exported (used by the update prompt). */
  get hasUnsavedWork(): boolean { return this.dirty && this.state.pages.length > 0; }

  // ───────────────────────── state ─────────────────────────

  private get state(): DocState { return this.history.present; }

  private commit(next: DocState, options: CommitOptions = {}): void {
    if (!this.history.commit(next, options.coalesce)) return;
    this.dirty = true;
    this.pruneSelection();
    this.render({ panel: options.panel ?? true });
  }

  private undo(): void {
    if (this.history.undo()) { this.pruneSelection(); this.render(); this.toast('Undone'); }
  }

  private redo(): void {
    if (this.history.redo()) { this.pruneSelection(); this.render(); this.toast('Redone'); }
  }

  private pruneSelection(): void {
    const ids = new Set(this.state.pages.map(p => p.id));
    for (const id of [...this.selection]) if (!ids.has(id)) this.selection.delete(id);
    if (this.anchorId && !ids.has(this.anchorId)) this.anchorId = null;
    if (this.focusId && !ids.has(this.focusId)) this.focusId = null;
    if (this.currentId && !ids.has(this.currentId)) this.currentId = this.state.pages[0]?.id ?? null;
    if (this.selectedOverlayId && !this.state.overlays.some(o => o.id === this.selectedOverlayId)) this.selectedOverlayId = null;
  }

  private info(ref: PageRef): PageInfo {
    return this.sources.get(ref.sourceId)!.pages[ref.sourceIndex];
  }

  private rotationOf(ref: PageRef): Rotation {
    return effectiveRotation(this.info(ref), ref);
  }

  private pageIndex(id: string): number {
    return this.state.pages.findIndex(p => p.id === id);
  }

  private selectedIds(): string[] {
    return selectedInOrder(this.state, this.selection).map(p => p.id);
  }

  /** Pages an operation applies to: the selection, or the current page when nothing is selected. */
  private targetIds(): string[] {
    const selected = this.selectedIds();
    if (selected.length) return selected;
    return this.currentId ? [this.currentId] : [];
  }

  // ───────────────────────── loading ─────────────────────────

  /** Opens or appends files. Public so the PWA file handler can hand over launched files. */
  async openFiles(files: File[], mode: 'replace' | 'append'): Promise<void> {
    if (!files.length) return;
    if (mode === 'replace' && this.hasUnsavedWork) {
      const ok = await this.confirm('Replace the current document?', 'Your unsaved changes will be lost. Export first if you want to keep them.', 'Replace');
      if (!ok) return;
    }
    const loaded: SourceDoc[] = [];
    const failures: string[] = [];
    let cancelled = false;
    for (let i = 0; i < files.length && !cancelled; i++) {
      const file = files[i];
      let password: string | undefined;
      for (;;) {
        try {
          const source = await this.busy(async ctl => {
            const job = this.engine.open(file, file.name, password, f => ctl.update(`Reading ${files.length > 1 ? `${i + 1} of ${files.length}` : 'file'}…`, f));
            ctl.cancellable(() => job.cancel());
            ctl.update(`Reading ${files.length > 1 ? `${i + 1} of ${files.length}` : 'file'}…`);
            const doc = await job.promise;
            // pdf.js gets its own fresh read of the file; the buffer is transferred to its worker.
            try {
              await this.renderer.open(doc.id, new Uint8Array(await file.arrayBuffer()), password);
            } catch {
              this.engine.close([doc.id]);
              throw new PdfLoadError('corrupt', 'This PDF is damaged and cannot be displayed.');
            }
            return doc;
          }, 'Reading file…', { rethrow: true });
          if (source) loaded.push(source);
          break;
        } catch (err) {
          if (err instanceof CancelledError) { cancelled = true; break; }
          if (err instanceof PdfLoadError && (err.code === 'needs-password' || err.code === 'bad-password')) {
            const entered = await this.askPassword(file.name, err.code === 'bad-password');
            if (entered === null) { failures.push(`${baseName(file.name)}: skipped (password-protected)`); break; }
            password = entered;
            continue;
          }
          if (err instanceof PdfLoadError && err.code === 'restricted') {
            const ok = await this.confirm('Open a restricted PDF?', `“${baseName(file.name)}” has restrictions set by its author, for example on editing or copying. It opens without a password, but only continue if you have the right to modify it. Exported copies will not carry the restrictions or any encryption.`, 'Open anyway');
            if (!ok) { failures.push(`${baseName(file.name)}: not opened (restricted)`); break; }
            password = '';
            continue;
          }
          failures.push(`${baseName(file.name)}: ${err instanceof PdfLoadError ? err.message : 'This file could not be read.'}`);
          break;
        }
      }
    }
    // What can't carry over into an export is said when the file opens, not discovered later.
    const notes = loaded.flatMap(s => [
      s.form?.xfa ? `“${baseName(s.name)}” has an XFA form: exports keep its standard form fields, not the XFA layer` : '',
      s.form?.signed ? `“${baseName(s.name)}” is digitally signed: an exported copy is a new file, so the signature won't be valid in it` : '',
    ]).filter(Boolean);
    if (failures.length) this.toast([...failures, ...notes].join('  ·  '), { error: true, duration: 7000 + notes.length * 3000 });
    if (cancelled) this.toast('Opening canceled');
    if (!loaded.length) return;

    if (mode === 'replace') await this.clearWorkspace({ keep: loaded.map(s => s.id) });
    let next = this.state;
    const added: PageRef[] = [];
    for (const source of loaded) {
      this.registerSource(source);
      const pages = pagesForSource(source);
      added.push(...pages);
      next = addPages(next, pages);
    }
    if (mode === 'replace') {
      this.history.reset(next);
      this.dirty = false;
      this.currentId = next.pages[0]?.id ?? null;
      this.zoom = 'fit-width';
      this.render();
      this.stage.scrollTo({ top: 0 });
    } else {
      this.commit(next);
      this.selection = new Set(added.map(p => p.id));
      this.anchorId = added[0]?.id ?? null;
      this.render();
      this.scrollToPage(added[0].id);
    }
    const pageCount = loaded.reduce((n, s) => n + s.pages.length, 0);
    const unlocked = loaded.some(s => s.protection !== 'none');
    const opened = `${mode === 'append' ? 'Added' : 'Opened'} ${pageCount} page${pageCount === 1 ? '' : 's'}${unlocked ? ' · unlocked for this session' : ''}`;
    if (!failures.length && !cancelled) this.toast([opened, ...notes].join('  ·  '), notes.length ? { duration: 4000 + notes.length * 5000 } : {});
  }

  private registerSource(source: SourceDoc): void {
    this.sources.set(source.id, source);
    if (!source.generated) this.sourceColor.set(source.id, SOURCE_COLORS[this.sourceColor.size % SOURCE_COLORS.length]);
  }

  /** Drops every document and releases buffers, canvases, object URLs and pdf.js workers. */
  private async clearWorkspace(options: { keep?: string[] } = {}): Promise<void> {
    const keep = new Set(options.keep ?? []);
    for (const view of this.views.values()) this.destroyView(view);
    this.views.clear();
    const dropped: string[] = [];
    for (const id of [...this.sources.keys()]) {
      if (keep.has(id)) continue;
      this.sources.delete(id);
      dropped.push(id);
      await this.renderer.close(id);
    }
    this.engine.close(dropped);
    for (const url of this.imageUrls.values()) URL.revokeObjectURL(url);
    this.imageUrls.clear();
    this.sourceColor.clear();
    this.textCache.clear();
    this.closeSearch();
    this.history.reset(EMPTY_STATE);
    this.selection.clear();
    this.anchorId = this.focusId = this.currentId = this.selectedOverlayId = null;
    this.dirty = false;
    this.rangeText = '';
  }

  private async resetWorkspace(): Promise<void> {
    if (!this.state.pages.length) return;
    if (this.dirty && !(await this.confirm('Clear the workspace?', 'All open documents and unsaved changes will be removed. Your original files are not affected.', 'Clear'))) return;
    await this.clearWorkspace();
    this.render();
    this.toast('Workspace cleared');
  }

  private async insertBlank(): Promise<void> {
    if (!this.state.pages.length) return;
    // After the last selected page if there is a selection, else after the page in view.
    const selected = this.selectedIds();
    const anchorId = selected.length ? selected[selected.length - 1] : this.currentId;
    const current = this.state.pages.find(p => p.id === anchorId) ?? this.state.pages[this.state.pages.length - 1];
    let [w, h] = this.blankSize === 'match'
      ? [viewSize(this.info(current), this.rotationOf(current)).width, viewSize(this.info(current), this.rotationOf(current)).height]
      : PAGE_SIZES[this.blankSize] ?? PAGE_SIZES.Letter;
    if (this.blankSize !== 'match') [w, h] = this.blankLandscape ? [Math.max(w, h), Math.min(w, h)] : [Math.min(w, h), Math.max(w, h)];
    const result = await this.busy(() => this.engine.blank(w, h).promise, 'Adding page…');
    if (!result) return;
    try {
      await this.renderer.open(result.source.id, result.bytes);
    } catch {
      this.toast('The blank page could not be created.', { error: true });
      return;
    }
    this.registerSource(result.source);
    const page = pagesForSource(result.source);
    const at = this.pageIndex(current.id) + 1;
    this.commit(addPages(this.state, page, at));
    this.selection = new Set([page[0].id]);
    this.anchorId = this.focusId = this.currentId = page[0].id;
    this.render();
    this.scrollToPage(page[0].id);
    this.toast(`Inserted a blank page after page ${at}`);
  }

  // ───────────────────────── export ─────────────────────────

  private defaultName(): string {
    const first = this.state.pages.map(p => this.sources.get(p.sourceId)).find(s => s && !s.generated);
    return first ? baseName(first.name) : 'document';
  }

  private protectionNote(): string {
    return [...new Set(this.state.pages.map(p => p.sourceId))].some(id => this.sources.get(id)?.protection !== 'none')
      ? ' · not password-protected' : '';
  }

  private async exportAll(): Promise<void> {
    if (!this.state.pages.length || this.busyDepth) return;
    const merged = new Set(this.state.pages.map(p => p.sourceId).filter(id => !this.sources.get(id)?.generated)).size > 1;
    const name = `${this.defaultName()}-${merged ? 'merged' : 'edited'}.pdf`;
    const bytes = await this.busy(ctl => {
      const job = this.engine.build(this.state.pages, this.state.overlays, this.defaultName(), f => ctl.update('Building PDF…', f));
      ctl.cancellable(() => job.cancel());
      return job.promise;
    }, 'Building PDF…');
    if (!bytes) return;
    downloadBlob(bytes, name, 'application/pdf');
    this.dirty = false;
    this.toast(`Saved ${name}${this.protectionNote()}`);
  }

  /** Each group becomes one PDF; several groups are delivered as a single ZIP. */
  private async exportGroups(groups: number[][], label: 'extract' | 'split'): Promise<void> {
    if (this.busyDepth) return;
    const base = this.defaultName();
    const parts = groups.map((g, i) => {
      const pages = describePages(g);
      const name = label === 'extract' || groups.length === 1 ? `${base}-pages-${pages}.pdf` : `${base}-part-${i + 1}-pages-${pages}.pdf`;
      return { name, pages: g.map(n => this.state.pages[n - 1]) };
    });
    const single = parts.length === 1;
    const bytes = await this.busy(ctl => {
      const job: Job<Uint8Array> = single
        ? this.engine.build(parts[0].pages, this.state.overlays, undefined, f => ctl.update('Building PDF…', f))
        : this.engine.buildZip(parts, this.state.overlays, (f, l) => ctl.update(l ?? 'Building files…', f));
      ctl.cancellable(() => job.cancel());
      return job.promise;
    }, single ? 'Building PDF…' : 'Building files…');
    if (!bytes) return;
    const name = single ? parts[0].name : `${base}-split-${parts.length}-files.zip`;
    downloadBlob(bytes, name, single ? 'application/pdf' : 'application/zip');
    this.toast(single ? `Saved ${name}` : `Saved ${name} (${parts.length} PDFs)`);
  }

  private extractSelected(): void {
    const ids = this.targetIds();
    if (!ids.length) return;
    void this.exportGroups([ids.map(id => this.pageIndex(id) + 1)], 'extract');
  }

  private splitByRanges(): void {
    try {
      void this.exportGroups(parseRanges(this.rangeText, this.state.pages.length), 'split');
    } catch (err) {
      this.toast((err as Error).message, { error: true });
    }
  }

  private splitEvery(): void {
    try {
      void this.exportGroups(chunkPages(this.state.pages.length, this.chunkSize), 'split');
    } catch (err) {
      this.toast((err as Error).message, { error: true });
    }
  }

  // ───────────────────────── page operations ─────────────────────────

  private rotate(delta: number): void {
    const ids = this.targetIds();
    if (!ids.length) return;
    this.commit(rotatePages(this.state, ids, delta));
    this.toast(`Rotated ${ids.length} page${ids.length === 1 ? '' : 's'} ${delta > 0 ? 'right' : 'left'}`);
  }

  private deleteSelected(): void {
    const ids = this.targetIds();
    if (!ids.length) return;
    if (ids.length === this.state.pages.length) {
      this.toast('A document needs at least one page. Use Clear to close it instead.', { error: true });
      return;
    }
    const firstIndex = this.pageIndex(ids[0]);
    this.commit(deletePages(this.state, ids));
    const next = this.state.pages[Math.min(firstIndex, this.state.pages.length - 1)];
    this.selection = new Set(next ? [next.id] : []);
    this.anchorId = this.focusId = this.currentId = next?.id ?? null;
    this.render();
    this.toast(`Deleted ${ids.length} page${ids.length === 1 ? '' : 's'} · Ctrl+Z to undo`);
  }

  private nudge(direction: -1 | 1): void {
    const ids = this.targetIds();
    if (!ids.length) return;
    this.commit(nudgePages(this.state, ids, direction), { coalesce: `nudge:${ids.join(',')}` });
    this.scrollThumbIntoView(ids[direction < 0 ? 0 : ids.length - 1]);
  }

  // ───────────────────────── selection & navigation ─────────────────────────

  private clickPage(id: string, event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }, from: 'thumb' | 'page'): void {
    const toggle = event.ctrlKey || event.metaKey;
    if (event.shiftKey && this.anchorId) {
      const a = this.pageIndex(this.anchorId), b = this.pageIndex(id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      if (!toggle) this.selection.clear();
      for (let i = lo; i <= hi; i++) this.selection.add(this.state.pages[i].id);
    } else if (toggle) {
      if (this.selection.has(id)) this.selection.delete(id); else this.selection.add(id);
      this.anchorId = id;
    } else {
      this.selection = new Set([id]);
      this.anchorId = id;
    }
    this.focusId = id;
    this.currentId = id;
    this.selectedOverlayId = null;
    this.render();
    if (from === 'thumb') {
      this.scrollToPage(id);
      if (window.matchMedia('(max-width: 720px)').matches) this.setDrawer('sidebar', false);
    }
  }

  private toggleSelect(id: string): void {
    if (this.selection.has(id)) this.selection.delete(id); else this.selection.add(id);
    this.anchorId = this.focusId = id;
    this.render();
  }

  private selectAll(): void {
    this.selection = new Set(this.state.pages.map(p => p.id));
    this.render();
  }

  private selectNone(): void {
    this.selection.clear();
    this.selectedOverlayId = null;
    this.render();
  }

  private moveFocus(delta: number, extend: boolean): void {
    if (!this.state.pages.length) return;
    const from = this.focusId ?? this.currentId ?? this.state.pages[0].id;
    const index = Math.max(0, Math.min(this.state.pages.length - 1, this.pageIndex(from) + delta));
    const id = this.state.pages[index].id;
    this.clickPage(id, { shiftKey: extend, ctrlKey: false, metaKey: false }, 'page');
    this.scrollThumbIntoView(id);
    this.scrollToPage(id);
  }

  /** Scrolls to page n (1-based) without changing the selection. */
  private goToPage(n: number): void {
    const ref = this.state.pages[Math.max(0, Math.min(this.state.pages.length - 1, Math.round(n) - 1))];
    if (!ref) return;
    this.currentId = ref.id;
    this.scrollToPage(ref.id, true);
    this.scrollThumbIntoView(ref.id);
    this.updateChrome();
  }

  private stepPage(delta: number): void {
    const index = this.currentId ? this.pageIndex(this.currentId) : 0;
    this.goToPage(index + 1 + delta);
  }

  // ───────────────────────── overlays ─────────────────────────

  /** Top-left spot for a new overlay: just inside the visible part of the current page, below existing overlays. */
  private placementFor(ref: PageRef): { x: number; y: number } {
    const view = this.views.get(ref.id);
    const rotation = this.rotationOf(ref);
    const size = viewSize(this.info(ref), rotation);
    let top = 0;
    // While a programmatic scroll is still animating, the page is headed for the top of the stage;
    // measuring it mid-flight would put the overlay somewhere the user won't be looking.
    if (view && Date.now() >= this.scrollLockUntil) {
      const pageRect = view.page.getBoundingClientRect(), stageRect = this.stage.getBoundingClientRect();
      top = Math.max(0, (stageRect.top - pageRect.top) / this.scale);
    }
    let y = top + Math.min(72, size.height * 0.1);
    for (const o of this.state.overlays) {
      if (o.pageId !== ref.id || o.frameRotation !== rotation) continue;
      const height = o.kind === 'text' ? o.text.split('\n').length * TEXT_LINE_HEIGHT * o.fontSize : o.height;
      y = Math.max(y, o.y + height + 12);
    }
    return { x: Math.min(72, size.width * 0.1), y: Math.min(size.height - 40, y) };
  }

  private overlayTarget(): PageRef | null {
    const id = this.currentId ?? this.selectedIds()[0] ?? this.state.pages[0]?.id;
    return this.state.pages.find(p => p.id === id) ?? null;
  }

  /** Loads the bundled overlay font into the page so on-screen text uses the exact export metrics. */
  private ensureOverlayFont(): void {
    if (this.fontFace) return;
    this.fontFace = new FontFace(OVERLAY_FONT_FAMILY, `url(${this.fontUrl})`, { display: 'block' });
    document.fonts.add(this.fontFace);
    this.fontFace.load().then(() => this.render({ panel: false }), () => undefined);
  }

  private addText(): void {
    const ref = this.overlayTarget();
    if (!ref) return;
    this.ensureOverlayFont();
    const overlay: TextOverlay = { id: newId('o'), pageId: ref.id, kind: 'text', frameRotation: this.rotationOf(ref), ...this.placementFor(ref), text: 'Your text', fontSize: 18, color: '#111111' };
    this.selectedOverlayId = overlay.id;
    this.commit(addOverlay(this.state, overlay));
    this.revealOverlay(overlay.id);
    this.setDrawer('panel', true);
    const area = this.panel.querySelector('textarea');
    area?.focus();
    area?.select();
  }

  private addRect(style: RectOverlay['style']): void {
    const ref = this.overlayTarget();
    if (!ref) return;
    const overlay: RectOverlay = {
      id: newId('o'), pageId: ref.id, kind: 'rect', frameRotation: this.rotationOf(ref), ...this.placementFor(ref),
      width: 200, height: style === 'highlight' ? 22 : 80, color: style === 'highlight' ? '#ffd400' : '#d03030', style,
    };
    this.selectedOverlayId = overlay.id;
    this.commit(addOverlay(this.state, overlay));
    this.revealOverlay(overlay.id);
  }

  private async addImage(file: File): Promise<void> {
    const ref = this.overlayTarget();
    if (!ref) return;
    if (file.size > MAX_IMAGE_BYTES) { this.toast('That image is larger than 15 MB.', { error: true }); return; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mime = sniffImage(bytes);
    if (!mime) { this.toast('Signature images must be PNG or JPEG.', { error: true }); return; }
    let natural: { width: number; height: number };
    try {
      const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
      natural = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
    } catch {
      this.toast('That image could not be decoded.', { error: true });
      return;
    }
    const width = Math.min(180, natural.width);
    const height = Math.max(4, width * natural.height / natural.width);
    const overlay: ImageOverlay = { id: newId('o'), pageId: ref.id, kind: 'image', frameRotation: this.rotationOf(ref), ...this.placementFor(ref), width, height, mime, bytes };
    this.selectedOverlayId = overlay.id;
    this.commit(addOverlay(this.state, overlay));
    this.revealOverlay(overlay.id);
    this.toast('Signature added - drag to position, use the handle to resize');
  }

  private duplicateOverlay(): void {
    const o = this.selectedOverlay();
    if (!o) return;
    const copy = { ...o, id: newId('o'), x: o.x + 12, y: o.y + 12 } as Overlay;
    this.selectedOverlayId = copy.id;
    this.commit(addOverlay(this.state, copy));
    this.toast('Duplicated');
  }

  /** Scrolls just enough to show a freshly added overlay. */
  private revealOverlay(id: string): void {
    const node = this.pagesView.querySelector<HTMLElement>(`.ov[data-id="${CSS.escape(id)}"]`);
    if (!node) return;
    const stage = this.stage.getBoundingClientRect(), rect = node.getBoundingClientRect();
    if (rect.top < stage.top + 8 || rect.bottom > stage.bottom - 8) {
      this.stage.scrollTop += rect.top - stage.top - stage.height / 3;
    }
  }

  private selectedOverlay(): Overlay | null {
    return this.state.overlays.find(o => o.id === this.selectedOverlayId) ?? null;
  }

  private selectOverlay(id: string | null): void {
    if (this.selectedOverlayId === id) return;
    this.selectedOverlayId = id;
    for (const node of this.pagesView.querySelectorAll<HTMLElement>('.ov')) node.classList.toggle('selected', node.dataset.id === id);
    this.renderPanel();
    this.history.seal();
  }

  private deleteOverlay(): void {
    const overlay = this.selectedOverlay();
    if (!overlay) return;
    this.selectedOverlayId = null;
    this.commit(removeOverlay(this.state, overlay.id));
    this.toast('Removed · Ctrl+Z to undo');
  }

  private patchOverlay(patch: Partial<Overlay>, coalesce?: string, panel = false): void {
    if (!this.selectedOverlayId) return;
    this.commit(updateOverlay(this.state, this.selectedOverlayId, patch), { coalesce, panel });
  }

  private imageUrl(o: ImageOverlay): string {
    let url = this.imageUrls.get(o.bytes);
    if (!url) {
      url = URL.createObjectURL(new Blob([o.bytes as Uint8Array<ArrayBuffer>], { type: o.mime }));
      this.imageUrls.set(o.bytes, url);
    }
    return url;
  }

  /** Positions an overlay element for the page's current rotation and zoom. */
  private placeOverlay(node: HTMLElement, o: Overlay, ref: PageRef): void {
    const info = this.info(ref), rotation = this.rotationOf(ref), s = this.scale;
    const p = convertView({ x: o.x, y: o.y }, o.frameRotation, rotation, info);
    node.style.left = `${p.x * s}px`;
    node.style.top = `${p.y * s}px`;
    const delta = normalizeRotation(rotation - o.frameRotation);
    node.style.transform = delta ? `rotate(${delta}deg)` : '';
    if (o.kind === 'text') {
      node.style.fontSize = `${clampFontSize(o.fontSize) * s}px`;
      node.style.color = safeColor(o.color);
    } else {
      node.style.width = `${o.width * s}px`;
      node.style.height = `${o.height * s}px`;
    }
    if (o.kind === 'rect') {
      const color = safeColor(o.color);
      node.style.background = o.style === 'highlight' ? color : 'transparent';
      node.style.border = o.style === 'box' ? `${2 * s}px solid ${color}` : '0';
    }
  }

  private renderOverlays(view: PageView, ref: PageRef, overlays: readonly Overlay[]): void {
    const rotation = this.rotationOf(ref);
    const d = view.drawn;
    if (d && d.scale === this.scale && d.rotation === rotation && d.selected === this.selectedOverlayId && d.overlays.length === overlays.length && d.overlays.every((o, i) => o === overlays[i])) return;
    view.drawn = { overlays, scale: this.scale, rotation, selected: this.selectedOverlayId };
    view.layer.replaceChildren();
    for (const o of overlays) {
      const label = o.kind === 'text' ? `Text: ${o.text.slice(0, 40)}` : o.kind === 'image' ? 'Signature image' : o.style === 'highlight' ? 'Highlight' : 'Box';
      const node = h('div', { class: `ov ov-${o.kind}${o.kind === 'rect' ? ` ${o.style}` : ''}${o.id === this.selectedOverlayId ? ' selected' : ''}`, attrs: { 'data-id': o.id, role: 'button', tabindex: 0, 'aria-label': label } });
      if (o.kind === 'text') {
        this.ensureOverlayFont();
        node.textContent = o.text;
        if (!o.text.trim()) node.classList.add('empty-text');
      } else if (o.kind === 'image') {
        node.append(h('img', { attrs: { src: this.imageUrl(o), alt: '', draggable: 'false' } }));
      }
      const handle = h('span', { class: 'ov-handle', attrs: { 'aria-hidden': 'true' } });
      handle.addEventListener('pointerdown', e => this.startOverlayDrag(e, o.id, node, 'resize'));
      node.append(handle);
      node.addEventListener('pointerdown', e => this.startOverlayDrag(e, o.id, node, 'move'));
      node.addEventListener('focus', () => this.selectOverlay(o.id));
      this.placeOverlay(node, o, ref);
      view.layer.append(node);
    }
  }

  private startOverlayDrag(event: PointerEvent, id: string, node: HTMLElement, mode: 'move' | 'resize'): void {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    const start = this.state.overlays.find(o => o.id === id);
    if (!start) return;
    const ref = this.state.pages.find(p => p.id === start.pageId)!;
    this.currentId = ref.id;
    this.selectOverlay(id);
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    const info = this.info(ref);
    const delta = normalizeRotation(this.rotationOf(ref) - start.frameRotation) * Math.PI / 180;
    const frame = viewSize(info, start.frameRotation);
    // Text resizes by scaling its font; its natural width (in points) is the reference length.
    const textWidth = start.kind === 'text' ? Math.max(8, node.offsetWidth / this.scale) : 0;
    let latest: Overlay = start;
    const x0 = event.clientX, y0 = event.clientY;
    const move = (e: PointerEvent) => {
      // Screen movement → the overlay's own frame (undo the extra display rotation).
      const dx = (e.clientX - x0) / this.scale, dy = (e.clientY - y0) / this.scale;
      const fx = dx * Math.cos(delta) + dy * Math.sin(delta);
      const fy = -dx * Math.sin(delta) + dy * Math.cos(delta);
      if (mode === 'move') {
        latest = { ...start, x: clamp(start.x + fx, -20, frame.width - 10), y: clamp(start.y + fy, -10, frame.height - 10) };
      } else if (start.kind === 'text') {
        latest = { ...start, fontSize: clampFontSize(start.fontSize * Math.max(0.1, (textWidth + fx) / textWidth)) };
      } else {
        let width = clamp(start.width + fx, 8, frame.width * 2);
        let height = clamp(start.height + fy, 4, frame.height * 2);
        if (start.kind === 'image') height = width * start.height / start.width;
        if (start.kind === 'image' && height < 4) { height = 4; width = height * start.width / start.height; }
        latest = { ...start, width, height } as Overlay;
      }
      this.placeOverlay(node, latest, ref);
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      if (latest !== start) this.commit(updateOverlay(this.state, id, latest), { panel: true });
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  private nudgeOverlay(dx: number, dy: number): void {
    const o = this.selectedOverlay();
    if (!o) return;
    const ref = this.state.pages.find(p => p.id === o.pageId)!;
    // Arrow keys move in screen directions, so convert through the page's display rotation.
    const delta = normalizeRotation(this.rotationOf(ref) - o.frameRotation) * Math.PI / 180;
    const fx = dx * Math.cos(delta) + dy * Math.sin(delta), fy = -dx * Math.sin(delta) + dy * Math.cos(delta);
    this.patchOverlay({ x: o.x + Math.round(fx), y: o.y + Math.round(fy) }, `nudge-ov:${o.id}`, true);
  }

  // ───────────────────────── rendering ─────────────────────────

  private render(options: { panel?: boolean } = {}): void {
    const hasDoc = this.state.pages.length > 0;
    $('empty-state').hidden = hasDoc;
    this.pagesView.hidden = !hasDoc;
    this.syncViews();
    if (options.panel !== false) this.renderPanel();
    this.updateChrome();
    if (this.searchQuery) this.scheduleSearch(0);
  }

  private updateChrome(): void {
    const hasDoc = this.state.pages.length > 0;
    for (const id of ['add-button', 'export-button', 'search-button']) ($(id) as HTMLButtonElement).disabled = !hasDoc;
    ($('undo-button') as HTMLButtonElement).disabled = !this.history.canUndo;
    ($('redo-button') as HTMLButtonElement).disabled = !this.history.canRedo;
    for (const id of ['zoom-in', 'zoom-out', 'zoom-label', 'fit-width', 'fit-page', 'select-all', 'select-none']) ($(id) as HTMLButtonElement).disabled = !hasDoc;
    const count = this.state.pages.length;
    $('page-count-label').textContent = String(count);
    const names = [...new Set(this.state.pages.map(p => p.sourceId))].map(id => this.sources.get(id)).filter(s => s && !s.generated).map(s => s!.name);
    const fileLabel = !names.length ? (count ? 'untitled' : 'no document') : names.length === 1 ? names[0] : `${names[0]} + ${names.length - 1} more`;
    $('status-file').textContent = fileLabel;
    $('status-file').title = names.join('\n');
    const current = this.currentId ? this.pageIndex(this.currentId) + 1 : 0;
    $('status-pages-label').hidden = hasDoc;
    $('page-jump-wrap').hidden = !hasDoc;
    const jump = $('page-jump') as HTMLInputElement;
    if (document.activeElement !== jump) jump.value = String(current || 1);
    $('page-total').textContent = String(count);
    $('status-selected').textContent = `${this.selection.size} selected`;
    $('zoom-label').textContent = hasDoc ? `${Math.round(this.scale / PX_PER_PT * 100)}%` : '-';
    $('fit-width').setAttribute('aria-pressed', String(this.zoom === 'fit-width'));
    $('fit-page').setAttribute('aria-pressed', String(this.zoom === 'fit-page'));
    document.title = names.length ? `${names[0]} - PageSmith` : HOME_TITLE;
  }

  /** Creates, reorders, updates and removes page views to match the state, keyed by page id. */
  private syncViews(): void {
    const pages = this.state.pages;
    const live = new Set(pages.map(p => p.id));
    for (const [id, view] of this.views) if (!live.has(id)) { this.destroyView(view); this.views.delete(id); }
    if (typeof this.zoom !== 'number') this.scale = this.fitScale();
    const multiSource = this.isMultiSource();
    const overlaysByPage = this.overlaysByPage();
    pages.forEach((ref, index) => {
      let view = this.views.get(ref.id);
      if (!view) { view = this.createView(ref); this.views.set(ref.id, view); }
      // insertBefore moves existing nodes, so this both inserts and reorders.
      if (this.thumbs.children[index] !== view.thumb) this.thumbs.insertBefore(view.thumb, this.thumbs.children[index] ?? null);
      if (this.pagesView.children[index] !== view.page) this.pagesView.insertBefore(view.page, this.pagesView.children[index] ?? null);
      this.updateView(view, ref, index, multiSource, overlaysByPage.get(ref.id) ?? EMPTY_OVERLAYS);
    });
  }

  private isMultiSource(): boolean {
    return new Set(this.state.pages.map(p => p.sourceId).filter(id => !this.sources.get(id)?.generated)).size > 1;
  }

  private overlaysByPage(): Map<string, Overlay[]> {
    const map = new Map<string, Overlay[]>();
    for (const o of this.state.overlays) {
      const list = map.get(o.pageId);
      if (list) list.push(o); else map.set(o.pageId, [o]);
    }
    return map;
  }

  private createView(ref: PageRef): PageView {
    const thumbCanvas = h('canvas', { attrs: { 'aria-hidden': 'true' } });
    const thumbLabel = h('span', { class: 'thumb-label' });
    const thumb = h('li', { class: 'thumb', attrs: { role: 'option', draggable: 'true', 'data-id': ref.id } }, [
      h('span', { class: 'thumb-frame' }, [thumbCanvas]),
      thumbLabel,
    ]);
    thumb.addEventListener('click', e => { if (Date.now() > this.suppressClickUntil) this.clickPage(ref.id, e, 'thumb'); });
    const pageCanvas = h('canvas', { attrs: { 'aria-hidden': 'true' } });
    const layer = h('div', { class: 'overlay-layer' });
    const searchLayer = h('div', { class: 'search-layer', attrs: { 'aria-hidden': 'true' } });
    const pageNumber = h('span', { class: 'page-number' });
    const page = h('div', { class: 'page placeholder', attrs: { 'data-id': ref.id } }, [pageCanvas, searchLayer, layer, pageNumber]);
    page.addEventListener('pointerdown', e => {
      if ((e.target as HTMLElement).closest('.ov')) return;
      if (this.selectedOverlayId) this.selectOverlay(null);
      if (this.currentId !== ref.id || !this.selection.has(ref.id)) this.clickPage(ref.id, e, 'page');
    });
    const view: PageView = { id: ref.id, thumb, thumbCanvas, thumbLabel, page, pageCanvas, pageNumber, layer, searchLayer, thumbKey: null, pageKey: null, thumbAbort: null, pageAbort: null, thumbVisible: false, pageVisible: false, drawn: null };
    this.thumbObserver.observe(thumb);
    this.pageObserver.observe(page);
    return view;
  }

  private updateView(view: PageView, ref: PageRef, index: number, multiSource: boolean, overlays: readonly Overlay[]): void {
    const info = this.info(ref), rotation = this.rotationOf(ref);
    const size = viewSize(info, rotation);
    const selected = this.selection.has(ref.id);
    view.thumb.classList.toggle('selected', selected);
    view.thumb.classList.toggle('focused', this.focusId === ref.id);
    view.thumb.setAttribute('aria-selected', String(selected));
    const source = this.sources.get(ref.sourceId)!;
    view.thumb.title = source.generated ? 'Blank page' : `${source.name} - page ${ref.sourceIndex + 1}`;
    const children: (Node | string)[] = [];
    if (multiSource && !source.generated) {
      const chip = h('span', { class: 'source-chip', attrs: { 'aria-hidden': 'true' } });
      chip.style.setProperty('--chip', this.sourceColor.get(ref.sourceId) ?? '');
      children.push(chip);
    }
    children.push(String(index + 1));
    if (source.generated) children.push(h('span', { class: 'thumb-badge', text: 'blank' }));
    if (ref.rotation) children.push(h('span', { class: 'thumb-badge', text: `↻${ref.rotation}°` }));
    view.thumbLabel.replaceChildren(...children);
    view.thumb.setAttribute('aria-label', `Page ${index + 1}${source.generated ? ', blank' : ''}${ref.rotation ? `, rotated ${ref.rotation} degrees` : ''}${multiSource && !source.generated ? `, from ${source.name}` : ''}`);
    const ts = Math.min(THUMB_BOX.width / size.width, THUMB_BOX.height / size.height);
    view.thumbCanvas.style.width = `${Math.round(size.width * ts)}px`;
    view.thumbCanvas.style.height = `${Math.round(size.height * ts)}px`;
    const thumbKey = `${ref.sourceId}|${ref.sourceIndex}|${rotation}`;
    if (view.thumbKey !== thumbKey) { view.thumbKey = null; view.thumbAbort?.abort(); this.maybeRender(view, 'thumb', thumbKey, ref, ts); }

    view.page.style.width = `${Math.round(size.width * this.scale)}px`;
    view.page.style.height = `${Math.round(size.height * this.scale)}px`;
    view.page.classList.toggle('active', this.currentId === ref.id && this.state.pages.length > 1);
    view.page.setAttribute('aria-label', `Page ${index + 1}`);
    view.pageNumber.textContent = String(index + 1);
    const pageKey = `${ref.sourceId}|${ref.sourceIndex}|${rotation}|${this.scale.toFixed(3)}`;
    if (view.pageKey !== pageKey) { view.pageKey = null; view.pageAbort?.abort(); this.maybeRender(view, 'page', pageKey, ref, this.scale); }
    this.renderOverlays(view, ref, overlays);
    this.renderSearchLayer(view);
  }

  private onVisibility(entries: IntersectionObserverEntry[], kind: 'thumb' | 'page'): void {
    const multiSource = this.isMultiSource();
    let overlaysByPage: Map<string, Overlay[]> | null = null;
    const total = this.state.pages.length;
    for (const entry of entries) {
      const id = (entry.target as HTMLElement).dataset.id!;
      const view = this.views.get(id);
      const index = this.pageIndex(id);
      const ref = this.state.pages[index];
      if (!view || !ref) continue;
      const refresh = () => { overlaysByPage ??= this.overlaysByPage(); this.updateView(view, ref, index, multiSource, overlaysByPage.get(id) ?? EMPTY_OVERLAYS); };
      if (kind === 'thumb') {
        view.thumbVisible = entry.isIntersecting;
        if (entry.isIntersecting && !view.thumbKey) refresh();
        if (!entry.isIntersecting && total > RELEASE_THUMBS_ABOVE) {
          view.thumbAbort?.abort();
          view.thumbKey = null;
          view.thumbCanvas.width = view.thumbCanvas.height = 0;
        }
      } else {
        view.pageVisible = entry.isIntersecting;
        if (entry.isIntersecting && !view.pageKey) refresh();
        // Far-offscreen pages give their bitmap back in long documents to cap memory.
        if (!entry.isIntersecting && total > RELEASE_PAGES_ABOVE) {
          view.pageAbort?.abort();
          view.pageKey = null;
          view.pageCanvas.width = view.pageCanvas.height = 0;
          view.page.classList.add('placeholder');
        }
      }
    }
  }

  private maybeRender(view: PageView, kind: 'thumb' | 'page', key: string, ref: PageRef, scale: number): void {
    if (kind === 'thumb' ? !view.thumbVisible : !view.pageVisible) return;
    const abort = new AbortController();
    const canvas = kind === 'thumb' ? view.thumbCanvas : view.pageCanvas;
    if (kind === 'thumb') { view.thumbAbort = abort; view.thumbKey = key; } else { view.pageAbort = abort; view.pageKey = key; }
    this.renderer.renderPage(ref.sourceId, ref.sourceIndex, this.rotationOf(ref), scale, canvas, abort.signal).then(done => {
      if (done && kind === 'page') view.page.classList.remove('placeholder');
      if (!done && !abort.signal.aborted) { if (kind === 'thumb') view.thumbKey = null; else view.pageKey = null; }
    }).catch(() => {
      if (kind === 'page' && !view.page.querySelector('.page-error')) {
        view.page.classList.remove('placeholder');
        view.page.append(h('div', { class: 'page-error', text: 'This page could not be displayed. It will still be included when you export.' }));
      }
    });
  }

  private destroyView(view: PageView): void {
    view.thumbAbort?.abort();
    view.pageAbort?.abort();
    this.thumbObserver.unobserve(view.thumb);
    this.pageObserver.unobserve(view.page);
    view.thumbCanvas.width = view.thumbCanvas.height = 0;
    view.pageCanvas.width = view.pageCanvas.height = 0;
    view.thumb.remove();
    view.page.remove();
  }

  // ───────────────────────── zoom & scrolling ─────────────────────────

  private fitScale(): number {
    const phone = window.matchMedia('(max-width: 720px)').matches;
    const availableW = this.stage.clientWidth - (phone ? 20 : 76);
    if (this.zoom === 'fit-page') {
      const ref = this.state.pages.find(p => p.id === this.currentId) ?? this.state.pages[0];
      if (!ref) return PX_PER_PT;
      const size = viewSize(this.info(ref), this.rotationOf(ref));
      const availableH = this.stage.clientHeight - (phone ? 28 : 44);
      return clamp(Math.min(availableW / size.width, availableH / size.height), 0.1, 6);
    }
    const widest = Math.max(1, ...this.state.pages.map(p => viewSize(this.info(p), this.rotationOf(p)).width));
    return clamp(availableW / widest, 0.1, 6);
  }

  private setZoom(zoom: ZoomMode): void {
    this.zoom = zoom;
    this.applyZoom(true);
  }

  private applyZoom(force = false): void {
    if (!this.state.pages.length) return;
    const anchor = this.currentId ?? this.state.pages[0].id;
    const anchorView = this.views.get(anchor);
    const offset = anchorView ? (this.stage.scrollTop - anchorView.page.offsetTop) / Math.max(1, anchorView.page.offsetHeight) : 0;
    const next = typeof this.zoom === 'number' ? this.zoom * PX_PER_PT : this.fitScale();
    if (!force && Math.abs(next - this.scale) < 0.001) return;
    this.scale = next;
    this.render({ panel: false });
    if (!anchorView) return;
    if (this.zoom === 'fit-page') this.stage.scrollTop = anchorView.page.offsetTop - 14;
    else this.stage.scrollTop = anchorView.page.offsetTop + offset * anchorView.page.offsetHeight;
  }

  private zoomStep(direction: 1 | -1): void {
    const current = this.scale / PX_PER_PT;
    const next = direction > 0 ? ZOOM_STEPS.find(z => z > current + 0.001) : [...ZOOM_STEPS].reverse().find(z => z < current - 0.001);
    if (next) this.setZoom(next);
  }

  private scrollToPage(id: string, instant = false): void {
    const view = this.views.get(id);
    if (!view) return;
    // The target is already the current page; don't let the scroll animation reassign it.
    this.scrollLockUntil = Date.now() + (instant ? 120 : 800);
    const smooth = !instant && !matchMedia('(prefers-reduced-motion: reduce)').matches && this.state.pages.length < 60;
    this.stage.scrollTo({ top: view.page.offsetTop - 16, behavior: smooth ? 'smooth' : 'auto' });
  }

  private scrollThumbIntoView(id: string): void {
    this.views.get(id)?.thumb.scrollIntoView({ block: 'nearest' });
  }

  /** Tracks which page is in view so the status bar and "add" actions follow scrolling. */
  private onStageScroll = (): void => {
    const pages = this.state.pages;
    if (!pages.length || Date.now() < this.scrollLockUntil) return;
    // Binary search on layout offsets: exact right after programmatic jumps (unlike the
    // visibility observer, which updates a frame later) and cheap for 500-page documents.
    const line = this.stage.scrollTop + this.stage.clientHeight * 0.35;
    let lo = 0, hi = pages.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const top = this.views.get(pages[mid].id)?.page.offsetTop ?? 0;
      if (top <= line) lo = mid; else hi = mid - 1;
    }
    const best: string | null = pages[lo].id;
    if (best && best !== this.currentId) {
      this.currentId = best;
      for (const view of this.views.values()) view.page.classList.toggle('active', view.id === best && this.state.pages.length > 1);
      this.updateChrome();
      if (!this.selection.size && !this.selectedOverlayId) this.renderPanel();
    }
  };

  // ───────────────────────── search ─────────────────────────

  private bindSearch(): void {
    const input = $('search-input') as HTMLInputElement;
    input.addEventListener('input', () => { this.searchQuery = input.value; this.scheduleSearch(220); });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); this.stepSearch(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') { e.preventDefault(); this.closeSearch(); }
    });
    $('search-button').addEventListener('click', () => this.openSearch());
    $('search-next').addEventListener('click', () => this.stepSearch(1));
    $('search-prev').addEventListener('click', () => this.stepSearch(-1));
    $('search-close').addEventListener('click', () => this.closeSearch());
  }

  private openSearch(): void {
    if (!this.state.pages.length) return;
    $('search-bar').hidden = false;
    const input = $('search-input') as HTMLInputElement;
    input.focus();
    input.select();
  }

  private closeSearch(): void {
    $('search-bar').hidden = true;
    this.searchAbort?.abort();
    this.searchQuery = '';
    ($('search-input') as HTMLInputElement).value = '';
    this.searchHits = [];
    this.searchIndex = -1;
    $('search-count').textContent = '';
    $('search-note').hidden = true;
    for (const view of this.views.values()) view.searchLayer.replaceChildren();
  }

  private scheduleSearch(delay: number): void {
    clearTimeout(this.searchTimer);
    this.searchTimer = window.setTimeout(() => void this.runSearch(), delay);
  }

  /** Extracts text page by page through pdf.js (cached), collecting hit boxes in each page's view space. */
  private async runSearch(): Promise<void> {
    this.searchAbort?.abort();
    const abort = new AbortController();
    this.searchAbort = abort;
    const query = this.searchQuery.trim();
    const previous = this.searchHits[this.searchIndex];
    this.searchHits = [];
    this.searchIndex = -1;
    const note = $('search-note');
    note.hidden = true;
    if (!query) {
      $('search-count').textContent = '';
      for (const view of this.views.values()) view.searchLayer.replaceChildren();
      return;
    }
    const pages = [...this.state.pages];
    let withoutText = 0;
    const hits: SearchHit[] = [];
    for (let i = 0; i < pages.length; i++) {
      const ref = pages[i];
      const rotation = this.rotationOf(ref);
      const key = `${ref.sourceId}|${ref.sourceIndex}|${rotation}`;
      let runs = this.textCache.get(key);
      if (!runs) {
        if (i % 5 === 0) $('search-count').textContent = `${Math.round(i / pages.length * 100)}%…`;
        try { runs = await this.renderer.pageText(ref.sourceId, ref.sourceIndex, rotation); } catch { runs = []; }
        if (abort.signal.aborted) return;
        this.textCache.set(key, runs);
      }
      if (!runs.some(r => r.str.trim())) { if (!this.sources.get(ref.sourceId)?.generated) withoutText++; continue; }
      for (const m of findMatches(runs, query)) hits.push({ pageId: ref.id, box: matchBox(runs[m.run], m.start, m.end) });
    }
    if (abort.signal.aborted) return;
    this.searchHits = hits;
    const keep = previous ? hits.findIndex(h => h.pageId === previous.pageId && Math.abs(h.box.y - previous.box.y) < 1 && Math.abs(h.box.x - previous.box.x) < 1) : -1;
    this.searchIndex = hits.length ? (keep >= 0 ? keep : this.firstHitFromCurrent()) : -1;
    this.updateSearchCount();
    const searchable = pages.filter(p => !this.sources.get(p.sourceId)?.generated).length;
    if (searchable && withoutText === searchable) {
      note.textContent = 'This document has no text layer - it looks like a scanned image. Searching scanned pages needs OCR, which PageSmith doesn’t do yet.';
      note.hidden = false;
    } else if (withoutText) {
      note.textContent = `${withoutText} page${withoutText === 1 ? ' has' : 's have'} no text layer (blank or scanned) and could not be searched.`;
      note.hidden = false;
    }
    for (const view of this.views.values()) this.renderSearchLayer(view);
    if (keep < 0 && this.searchIndex >= 0) this.revealHit();
  }

  private firstHitFromCurrent(): number {
    const from = this.currentId ? this.pageIndex(this.currentId) : 0;
    const index = this.searchHits.findIndex(h => this.pageIndex(h.pageId) >= from);
    return index >= 0 ? index : 0;
  }

  private updateSearchCount(): void {
    $('search-count').textContent = this.searchHits.length ? `${this.searchIndex + 1} of ${this.searchHits.length}` : this.searchQuery.trim() ? 'no matches' : '';
  }

  private stepSearch(direction: 1 | -1): void {
    if (!this.searchHits.length) return;
    this.searchIndex = (this.searchIndex + direction + this.searchHits.length) % this.searchHits.length;
    this.updateSearchCount();
    for (const view of this.views.values()) this.renderSearchLayer(view);
    this.revealHit();
  }

  private revealHit(): void {
    const hit = this.searchHits[this.searchIndex];
    const view = hit && this.views.get(hit.pageId);
    if (!hit || !view) return;
    this.currentId = hit.pageId;
    this.stage.scrollTo({ top: Math.max(0, view.page.offsetTop + hit.box.y * this.scale - this.stage.clientHeight / 3) });
    this.updateChrome();
  }

  private renderSearchLayer(view: PageView): void {
    if (!this.searchHits.length) { if (view.searchLayer.firstChild) view.searchLayer.replaceChildren(); return; }
    const current = this.searchHits[this.searchIndex];
    const nodes: HTMLElement[] = [];
    for (const hit of this.searchHits) {
      if (hit.pageId !== view.id) continue;
      const node = h('span', { class: `search-hit${hit === current ? ' current' : ''}` });
      node.style.left = `${hit.box.x * this.scale}px`;
      node.style.top = `${hit.box.y * this.scale}px`;
      node.style.width = `${hit.box.width * this.scale}px`;
      node.style.height = `${hit.box.height * this.scale}px`;
      nodes.push(node);
    }
    view.searchLayer.replaceChildren(...nodes);
  }

  // ───────────────────────── right panel ─────────────────────────

  private renderPanel(): void {
    const overlay = this.selectedOverlay();
    if (!this.state.pages.length) {
      this.panel.replaceChildren(h('div', { class: 'panel-section' }, [
        h('div', { class: 'section-title', text: 'start' }),
        h('p', { class: 'hint', text: 'Open a PDF to reorder, rotate, delete, merge, split or annotate its pages. Files are processed on this device and never uploaded.' }),
      ]));
      return;
    }
    this.panel.replaceChildren(...(overlay ? this.overlayPanel(overlay) : this.pagePanel()));
  }

  private pagePanel(): HTMLElement[] {
    const ids = this.targetIds();
    const n = ids.length;
    const explicit = this.selection.size > 0;
    const scope = explicit ? `${n} selected` : this.currentId ? `page ${this.pageIndex(this.currentId) + 1}` : '';
    const touch = matchMedia('(pointer: coarse)').matches;
    const pages = h('section', { class: 'panel-section', attrs: { 'aria-label': 'Page operations' } }, [
      h('div', { class: 'section-title' }, ['pages', h('span', { class: 'count', text: scope })]),
      h('div', { class: 'btn-grid' }, [
        button('⟲ Rotate left', () => this.rotate(-90), { disabled: !n, title: 'Rotate 90° counter-clockwise ([)' }),
        button('⟳ Rotate right', () => this.rotate(90), { disabled: !n, title: 'Rotate 90° clockwise (])' }),
        button('↑ Move up', () => this.nudge(-1), { disabled: !n, title: 'Move earlier (Alt+↑)' }),
        button('↓ Move down', () => this.nudge(1), { disabled: !n, title: 'Move later (Alt+↓)' }),
        button(`Delete ${n > 1 ? `${n} pages` : 'page'}`, () => this.deleteSelected(), { class: 'button danger wide', disabled: !n, title: 'Delete (Del)' }),
      ]),
      h('p', { class: 'hint', text: touch ? 'Tap thumbnails to select. Long-press a thumbnail, then drag, to reorder.' : explicit ? 'Ctrl/⌘-click or Shift-click thumbnails to change the selection. Drag thumbnails to reorder.' : 'Acting on the page in view. Click thumbnails to select; drag them to reorder.' }),
    ]);

    const sizeSelect = h('select', { attrs: { 'aria-label': 'Blank page size' } }, [
      h('option', { text: 'Same as current page', attrs: { value: 'match' } }),
      ...Object.entries(PAGE_SIZES).map(([name, [w, hh]]) => h('option', { text: `${name} (${Math.round(w / 72 * 25.4)}×${Math.round(hh / 72 * 25.4)} mm)`, attrs: { value: name } })),
    ]);
    sizeSelect.value = this.blankSize;
    sizeSelect.addEventListener('change', () => { this.blankSize = sizeSelect.value; this.renderPanel(); });
    const orientation = (['portrait', 'landscape'] as const).map(o => button(o, () => { this.blankLandscape = o === 'landscape'; this.renderPanel(); }, { class: '', disabled: this.blankSize === 'match', attrs: { 'aria-pressed': String(this.blankLandscape === (o === 'landscape')) } }));
    const blank = h('section', { class: 'panel-section', attrs: { 'aria-label': 'Insert blank page' } }, [
      h('div', { class: 'section-title' }, ['blank page', h('span', { class: 'count', text: this.currentId ? `after page ${this.pageIndex(this.currentId) + 1}` : '' })]),
      h('label', { class: 'field' }, ['Size', sizeSelect]),
      h('div', { class: 'segmented', attrs: { role: 'group', 'aria-label': 'Orientation', style: 'margin-bottom:10px' } }, orientation),
      button('+ Insert blank page', () => void this.insertBlank(), { class: 'button block', title: 'Insert after the current page (B)' }),
    ]);

    const rangeInput = h('input', { attrs: { type: 'text', placeholder: 'e.g. 1-3, 5, 8-', 'aria-label': 'Page ranges', inputmode: 'text', spellcheck: 'false' } });
    rangeInput.value = this.rangeText;
    rangeInput.addEventListener('input', () => { this.rangeText = rangeInput.value; });
    rangeInput.addEventListener('keydown', e => { if (e.key === 'Enter') this.splitByRanges(); });
    const chunkInput = h('input', { attrs: { type: 'number', min: 1, max: Math.max(1, this.state.pages.length), step: 1, 'aria-label': 'Pages per file' } });
    chunkInput.value = String(this.chunkSize);
    chunkInput.addEventListener('input', () => { this.chunkSize = Math.floor(Number(chunkInput.value)); });
    const split = h('section', { class: 'panel-section', attrs: { 'aria-label': 'Extract and split' } }, [
      h('div', { class: 'section-title', text: 'extract & split' }),
      button(`Extract ${n > 1 ? `${n} pages` : 'page'} to new PDF`, () => this.extractSelected(), { class: 'button block', disabled: !n }),
      h('label', { class: 'field', attrs: { style: 'margin-top:12px' } }, ['Split by ranges - one file per range', h('div', { class: 'field-row', attrs: { style: 'margin:5px 0 0' } }, [rangeInput, button('Split', () => this.splitByRanges())])]),
      h('label', { class: 'field' }, ['Split every N pages', h('div', { class: 'field-row', attrs: { style: 'margin:5px 0 0' } }, [chunkInput, button('Split', () => this.splitEvery())])]),
      h('p', { class: 'hint', text: 'Several files download together as one ZIP. Your open document and the originals are not changed.' }),
    ]);

    const add = h('section', { class: 'panel-section', attrs: { 'aria-label': 'Add to page' } }, [
      h('div', { class: 'section-title' }, ['add to page', h('span', { class: 'count', text: this.currentId ? `page ${this.pageIndex(this.currentId) + 1}` : '' })]),
      h('div', { class: 'btn-grid' }, [
        button('T  Text', () => this.addText(), { title: 'Add text (T)' }),
        button('✎ Signature', () => ($('image-input') as HTMLInputElement).click(), { title: 'Place a PNG or JPEG signature image' }),
        button('▬ Highlight', () => this.addRect('highlight'), { title: 'Add highlight (H)' }),
        button('▢ Box', () => this.addRect('box')),
      ]),
      h('p', { class: 'hint', text: 'These add new content on top of the page; click one later to move, resize, edit or delete it. Editing the PDF’s existing text isn’t supported.' }),
    ]);

    const sourceIds = [...new Set(this.state.pages.map(p => p.sourceId))].filter(id => !this.sources.get(id)?.generated);
    const docs = h('section', { class: 'panel-section', attrs: { 'aria-label': 'Documents' } }, [
      h('div', { class: 'section-title' }, ['documents', h('span', { class: 'count', text: String(sourceIds.length) })]),
      h('ul', { class: 'source-list' }, sourceIds.map(id => {
        const s = this.sources.get(id)!;
        const chip = h('span', { class: 'source-chip', attrs: { 'aria-hidden': 'true' } });
        chip.style.setProperty('--chip', this.sourceColor.get(id) ?? '');
        const used = this.state.pages.filter(p => p.sourceId === id).length;
        return h('li', { title: s.name }, [chip, h('span', { class: 'name', text: s.name }), s.protection !== 'none' ? h('span', { class: 'count', text: '🔓', title: 'Unlocked for this session; exports are not password-protected' }) : null, h('span', { class: 'count', text: `${used}p` })]);
      })),
      h('div', { class: 'btn-grid', attrs: { style: 'margin-top:10px' } }, [
        button('+ Add PDF', () => ($('add-input') as HTMLInputElement).click()),
        button('Clear', () => void this.resetWorkspace(), { class: 'button danger' }),
      ]),
    ]);
    // Phones have no room for Search in the toolbar, so it lives in the Tools drawer there.
    const find = h('section', { class: 'panel-section mobile-only-block', attrs: { 'aria-label': 'Search' } }, [
      button('⌕ Search text', () => { this.setDrawer('panel', false); this.openSearch(); }, { class: 'button block' }),
    ]);
    return [find, pages, blank, split, add, docs];
  }

  private overlayPanel(o: Overlay): HTMLElement[] {
    const title = o.kind === 'text' ? 'text' : o.kind === 'image' ? 'signature' : o.style;
    const fields: HTMLElement[] = [];
    if (o.kind === 'text') {
      const area = h('textarea', { attrs: { 'aria-label': 'Text', spellcheck: 'true', rows: 4 } });
      area.value = o.text;
      const warn = h('p', { class: 'hint warn' });
      warn.hidden = true;
      const check = (text: string) => {
        clearTimeout(this.textCheckTimer);
        this.textCheckTimer = window.setTimeout(() => {
          void this.engine.checkText(text).then(bad => {
            warn.hidden = !bad.length;
            warn.textContent = bad.length ? `Not in the bundled font, will export as “?”: ${bad.slice(0, 12).join(' ')}${bad.length > 12 ? ' …' : ''}. Latin, Greek and Cyrillic are supported.` : '';
          }, () => undefined);
        }, 250);
      };
      check(o.text);
      area.addEventListener('input', () => {
        check(area.value);
        this.patchOverlay({ text: area.value.slice(0, 5000) }, `text:${o.id}`);
      });
      area.addEventListener('blur', () => this.history.seal());
      const size = h('input', { attrs: { type: 'number', min: 4, max: 288, step: 1, 'aria-label': 'Font size' } });
      size.value = String(o.fontSize);
      size.addEventListener('input', () => { if (size.value) this.patchOverlay({ fontSize: clampFontSize(Number(size.value)) }, `size:${o.id}`); });
      fields.push(h('label', { class: 'field' }, ['Text', area]), warn,
        h('div', { class: 'field-row' }, [h('label', { class: 'field' }, ['Size (pt)', size]), this.colorField(o)]),
        h('p', { class: 'hint', text: 'Drag the round handle to scale the text.' }));
    } else if (o.kind === 'image') {
      const width = h('input', { attrs: { type: 'number', min: 8, step: 1, 'aria-label': 'Width in points' } });
      width.value = String(Math.round(o.width));
      width.addEventListener('input', () => {
        const w = clamp(Number(width.value) || o.width, 8, 2000);
        this.patchOverlay({ width: w, height: w * o.height / o.width }, `w:${o.id}`);
      });
      fields.push(h('label', { class: 'field' }, ['Width (pt)', width]), h('p', { class: 'hint', text: 'Drag to move, or use the round handle to resize. Aspect ratio is kept.' }));
    } else {
      const width = h('input', { attrs: { type: 'number', min: 4, step: 1, 'aria-label': 'Width in points' } });
      const height = h('input', { attrs: { type: 'number', min: 2, step: 1, 'aria-label': 'Height in points' } });
      width.value = String(Math.round(o.width));
      height.value = String(Math.round(o.height));
      width.addEventListener('input', () => this.patchOverlay({ width: clamp(Number(width.value) || o.width, 4, 4000) }, `w:${o.id}`));
      height.addEventListener('input', () => this.patchOverlay({ height: clamp(Number(height.value) || o.height, 2, 4000) }, `h:${o.id}`));
      const styleButtons = (['highlight', 'box'] as const).map(style => button(style, () => this.patchOverlay({ style } as Partial<RectOverlay>, undefined, true), { class: '', attrs: { 'aria-pressed': String(o.style === style) } }));
      fields.push(
        h('div', { class: 'field-row' }, [h('label', { class: 'field' }, ['W (pt)', width]), h('label', { class: 'field' }, ['H (pt)', height])]),
        h('div', { class: 'field-row' }, [h('label', { class: 'field' }, ['Style', h('div', { class: 'segmented', attrs: { role: 'group' } }, styleButtons)]), this.colorField(o)]),
      );
    }
    const pageNo = this.pageIndex(o.pageId) + 1;
    return [
      h('section', { class: 'panel-section', attrs: { 'aria-label': `${title} properties` } }, [
        h('div', { class: 'section-title' }, [title, h('span', { class: 'count', text: `on page ${pageNo}` })]),
        ...fields,
        h('div', { class: 'btn-grid', attrs: { style: 'margin-top:4px' } }, [
          button('Duplicate', () => this.duplicateOverlay(), { title: 'Duplicate (Ctrl+D)' }),
          button('Delete', () => this.deleteOverlay(), { class: 'button danger', title: 'Delete (Del)' }),
          button('Done', () => this.selectOverlay(null), { class: 'button wide', title: 'Deselect (Esc)' }),
        ]),
        h('p', { class: 'hint', text: 'Drag on the page to move. Arrow keys nudge by 1 pt (Shift: 10 pt).' }),
      ]),
    ];
  }

  private colorField(o: TextOverlay | RectOverlay): HTMLElement {
    const input = h('input', { attrs: { type: 'color', 'aria-label': 'Color' } });
    input.value = safeColor(o.color);
    input.addEventListener('input', () => this.patchOverlay({ color: safeColor(input.value) }, `color:${o.id}`));
    return h('label', { class: 'field' }, ['Color', input]);
  }

  // ───────────────────────── chrome & events ─────────────────────────

  private bindChrome(): void {
    const openInput = $('open-input') as HTMLInputElement;
    const addInput = $('add-input') as HTMLInputElement;
    const imageInput = $('image-input') as HTMLInputElement;
    const takeFiles = (input: HTMLInputElement) => { const files = [...(input.files ?? [])]; input.value = ''; return files; };
    $('open-button').addEventListener('click', () => openInput.click());
    $('empty-open').addEventListener('click', () => openInput.click());
    $('add-button').addEventListener('click', () => addInput.click());
    openInput.addEventListener('change', () => void this.openFiles(takeFiles(openInput), 'replace'));
    addInput.addEventListener('change', () => void this.openFiles(takeFiles(addInput), 'append'));
    imageInput.addEventListener('change', () => { const [file] = takeFiles(imageInput); if (file) void this.addImage(file); });
    $('undo-button').addEventListener('click', () => this.undo());
    $('redo-button').addEventListener('click', () => this.redo());
    $('export-button').addEventListener('click', () => void this.exportAll());
    $('select-all').addEventListener('click', () => this.selectAll());
    $('select-none').addEventListener('click', () => this.selectNone());
    $('zoom-in').addEventListener('click', () => this.zoomStep(1));
    $('zoom-out').addEventListener('click', () => this.zoomStep(-1));
    $('zoom-label').addEventListener('click', () => this.setZoom(1));
    $('fit-width').addEventListener('click', () => this.setZoom('fit-width'));
    $('fit-page').addEventListener('click', () => this.setZoom('fit-page'));
    const jump = $('page-jump') as HTMLInputElement;
    jump.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); const n = parseInt(jump.value, 10); if (n) this.goToPage(n); jump.blur(); }
      if (e.key === 'Escape') { jump.blur(); }
    });
    jump.addEventListener('focus', () => jump.select());
    jump.addEventListener('blur', () => this.updateChrome());
    for (const id of ['theme-toggle', 'theme-toggle-dialog']) $(id).addEventListener('click', () => { const mode = cycleTheme(); this.updateThemeButtons(); this.toast(themeLabel(mode)); });
    const about = $('about-dialog') as HTMLDialogElement;
    $('about-button').addEventListener('click', () => about.showModal());
    about.addEventListener('click', e => { if (e.target === about) about.close(); });
    $('pages-toggle').addEventListener('click', () => this.setDrawer('sidebar', !$('sidebar').classList.contains('open')));
    $('panel-toggle').addEventListener('click', () => this.setDrawer('panel', !this.panel.classList.contains('open')));
    const scrim = h('div', { class: 'scrim', attrs: { 'aria-hidden': 'true' } });
    scrim.addEventListener('click', () => { this.setDrawer('sidebar', false); this.setDrawer('panel', false); });
    $('workspace').append(scrim);
    this.stage.addEventListener('scroll', this.onStageScroll, { passive: true });
    this.stage.addEventListener('pointerdown', e => { if (e.target === this.stage || e.target === this.pagesView) this.selectOverlay(null); });
    window.addEventListener('beforeunload', e => { if (this.hasUnsavedWork) e.preventDefault(); });
  }

  private setDrawer(which: 'sidebar' | 'panel', open: boolean): void {
    const node = which === 'sidebar' ? $('sidebar') : this.panel;
    node.classList.toggle('open', open);
    $(which === 'sidebar' ? 'pages-toggle' : 'panel-toggle').setAttribute('aria-expanded', String(open));
    const anyOpen = $('sidebar').classList.contains('open') || this.panel.classList.contains('open');
    document.querySelector('.scrim')?.classList.toggle('visible', anyOpen);
  }

  private updateThemeButtons(): void {
    const label = themeLabel(storedTheme());
    for (const id of ['theme-toggle', 'theme-toggle-dialog']) {
      $(id).textContent = label;
      $(id).setAttribute('aria-label', `Color theme: ${storedTheme()}. Click to cycle system, light, dark.`);
    }
  }

  private bindKeyboard(): void {
    document.addEventListener('keydown', e => {
      if (document.querySelector('dialog[open]') || this.busyDepth) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const inField = isEditable(e.target);
      if (mod && key === 'o') { e.preventDefault(); ($('open-input') as HTMLInputElement).click(); return; }
      if (mod && key === 's') { e.preventDefault(); void this.exportAll(); return; }
      if (mod && key === 'f' && this.state.pages.length) { e.preventDefault(); this.openSearch(); return; }
      if (mod && key === 'g' && this.state.pages.length) { e.preventDefault(); ($('page-jump') as HTMLInputElement).focus(); return; }
      if (e.key === 'F3' && this.searchHits.length) { e.preventDefault(); this.stepSearch(e.shiftKey ? -1 : 1); return; }
      if (inField) {
        if (e.key === 'Escape') (e.target as HTMLElement).blur();
        return;
      }
      if (mod && key === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
      if (mod && key === 'y') { e.preventDefault(); this.redo(); return; }
      if (!this.state.pages.length) return;
      if (mod && key === 'a') { e.preventDefault(); this.selectAll(); return; }
      if (mod && key === 'd') { e.preventDefault(); this.duplicateOverlay(); return; }
      if (mod) return;
      const overlay = this.selectedOverlay();
      if (overlay && e.key.startsWith('Arrow')) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        this.nudgeOverlay(e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0);
        return;
      }
      switch (e.key) {
        case 'Delete': case 'Backspace': e.preventDefault(); if (overlay) this.deleteOverlay(); else this.deleteSelected(); break;
        case 'Escape':
          if (!$('search-bar').hidden) this.closeSearch();
          else if (overlay) this.selectOverlay(null); else this.selectNone();
          this.setDrawer('sidebar', false); this.setDrawer('panel', false);
          break;
        case '[': this.rotate(-90); break;
        case ']': this.rotate(90); break;
        case '+': case '=': this.zoomStep(1); break;
        case '-': case '_': this.zoomStep(-1); break;
        case '0': this.setZoom('fit-width'); break;
        case '9': this.setZoom('fit-page'); break;
        case '1': this.setZoom(1); break;
        case 'b': case 'B': void this.insertBlank(); break;
        case 't': case 'T': e.preventDefault(); this.addText(); break;
        case 'h': case 'H': this.addRect('highlight'); break;
        case 'PageUp': e.preventDefault(); this.stepPage(-1); break;
        case 'PageDown': e.preventDefault(); this.stepPage(1); break;
        case 'ArrowUp': case 'ArrowLeft': e.preventDefault(); if (e.altKey) this.nudge(-1); else this.moveFocus(-1, e.shiftKey); break;
        case 'ArrowDown': case 'ArrowRight': e.preventDefault(); if (e.altKey) this.nudge(1); else this.moveFocus(1, e.shiftKey); break;
        case 'Home': e.preventDefault(); this.moveFocus(-this.state.pages.length, e.shiftKey); break;
        case 'End': e.preventDefault(); this.moveFocus(this.state.pages.length, e.shiftKey); break;
        case ' ': if (this.focusId && (e.target as HTMLElement).closest?.('#thumbs')) { e.preventDefault(); this.toggleSelect(this.focusId); } break;
      }
    });
  }

  private bindFileDrop(): void {
    const veil = $('drop-veil');
    const target = $('drop-target');
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    window.addEventListener('dragenter', e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      if (this.state.pages.length) veil.classList.add('visible'); else target.classList.add('hover');
    });
    window.addEventListener('dragleave', e => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) { veil.classList.remove('visible'); target.classList.remove('hover'); }
    });
    window.addEventListener('dragover', e => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer!.dropEffect = 'copy'; } });
    window.addEventListener('drop', e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      veil.classList.remove('visible');
      target.classList.remove('hover');
      const files = [...(e.dataTransfer?.files ?? [])];
      void this.openFiles(files, this.state.pages.length ? 'append' : 'replace');
    });
  }

  /** Where a drop at clientY lands in the thumbnail list: insertion index plus the node to mark. */
  private thumbDropTarget(clientX: number, clientY: number, eventTarget?: EventTarget | null): { index: number; node: HTMLElement | null; after: boolean } {
    const hit = (eventTarget instanceof HTMLElement ? eventTarget : document.elementFromPoint(clientX, clientY)) as HTMLElement | null;
    const node = hit?.closest<HTMLElement>('.thumb') ?? null;
    if (!node) {
      // Below the last thumbnail → end; above the first → start.
      const first = this.thumbs.firstElementChild?.getBoundingClientRect();
      return { index: first && clientY < first.top ? 0 : this.state.pages.length, node: null, after: true };
    }
    const rect = node.getBoundingClientRect();
    const after = clientY > rect.top + rect.height / 2;
    return { index: this.pageIndex(node.dataset.id!) + (after ? 1 : 0), node, after };
  }

  private markDrop(node: HTMLElement | null, after: boolean): void {
    this.thumbs.querySelectorAll('.drop-before, .drop-after').forEach(n => n.classList.remove('drop-before', 'drop-after'));
    node?.classList.add(after ? 'drop-after' : 'drop-before');
  }

  private dropPages(ids: string[], index: number): void {
    const before = this.state;
    this.commit(movePages(this.state, ids, index));
    if (this.state !== before) this.toast(`Moved ${ids.length} page${ids.length === 1 ? '' : 's'}`);
  }

  /** HTML5 drag-and-drop reordering of thumbnails (mouse and pen). */
  private bindThumbDrag(): void {
    const clearMarks = () => this.thumbs.querySelectorAll('.drop-before, .drop-after, .dragging').forEach(n => n.classList.remove('drop-before', 'drop-after', 'dragging'));
    this.thumbs.addEventListener('dragstart', e => {
      const node = (e.target as HTMLElement).closest<HTMLElement>('.thumb');
      if (!node || !e.dataTransfer) return;
      const id = node.dataset.id!;
      if (!this.selection.has(id)) { this.selection = new Set([id]); this.anchorId = id; this.render(); }
      this.dragIds = this.selectedIds();
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-pagesmith-pages', this.dragIds.join(','));
      for (const pid of this.dragIds) this.views.get(pid)?.thumb.classList.add('dragging');
    });
    this.thumbs.addEventListener('dragover', e => {
      if (!this.dragIds) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'move';
      const { node, after } = this.thumbDropTarget(e.clientX, e.clientY, e.target);
      this.markDrop(node, after);
      const rect = this.thumbs.getBoundingClientRect();
      if (e.clientY < rect.top + 40) this.thumbs.scrollBy(0, -12); else if (e.clientY > rect.bottom - 40) this.thumbs.scrollBy(0, 12);
    });
    this.thumbs.addEventListener('drop', e => {
      if (!this.dragIds) return;
      e.preventDefault();
      e.stopPropagation();
      const { index } = this.thumbDropTarget(e.clientX, e.clientY, e.target);
      const ids = this.dragIds;
      this.dragIds = null;
      clearMarks();
      this.dropPages(ids, index);
    });
    this.thumbs.addEventListener('dragend', () => { this.dragIds = null; clearMarks(); });
  }

  /**
   * Touch reordering: HTML5 drag-and-drop doesn't fire for touch, so a long-press on a thumbnail
   * starts a drag that follows the finger. A quick swipe still scrolls the list as usual.
   */
  private bindTouchReorder(): void {
    let timer = 0;
    let start: { x: number; y: number; id: string } | null = null;
    let dragging: string[] | null = null;
    let ghost: HTMLElement | null = null;
    let last = { x: 0, y: 0 };
    let scrollTimer = 0;
    const reset = () => {
      clearTimeout(timer);
      clearInterval(scrollTimer);
      start = null;
      dragging = null;
      ghost?.remove();
      ghost = null;
      this.thumbs.querySelectorAll('.touch-dragging').forEach(n => n.classList.remove('touch-dragging'));
      this.markDrop(null, false);
    };
    this.thumbs.addEventListener('touchstart', e => {
      if (e.touches.length !== 1) { reset(); return; }
      const node = (e.target as HTMLElement).closest<HTMLElement>('.thumb');
      if (!node) return;
      const t = e.touches[0];
      start = { x: t.clientX, y: t.clientY, id: node.dataset.id! };
      last = { x: t.clientX, y: t.clientY };
      timer = window.setTimeout(() => {
        if (!start) return;
        const id = start.id;
        if (!this.selection.has(id)) { this.selection = new Set([id]); this.anchorId = this.focusId = id; this.render(); }
        dragging = this.selectedIds();
        for (const pid of dragging) this.views.get(pid)?.thumb.classList.add('touch-dragging');
        ghost = h('div', { class: 'drag-ghost', text: `Move ${dragging.length} page${dragging.length === 1 ? '' : 's'}` });
        ghost.style.left = `${last.x}px`;
        ghost.style.top = `${last.y}px`;
        document.body.append(ghost);
        navigator.vibrate?.(12);
        // Keep scrolling while the finger rests near the list's top or bottom edge.
        scrollTimer = window.setInterval(() => {
          const rect = this.thumbs.getBoundingClientRect();
          if (last.y < rect.top + 48) this.thumbs.scrollBy(0, -14); else if (last.y > rect.bottom - 48) this.thumbs.scrollBy(0, 14);
        }, 40);
      }, LONG_PRESS_MS);
    }, { passive: true });
    this.thumbs.addEventListener('touchmove', e => {
      const t = e.touches[0];
      last = { x: t.clientX, y: t.clientY };
      if (!dragging) {
        // Moving before the long-press fires means the user is scrolling.
        if (start && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) { clearTimeout(timer); start = null; }
        return;
      }
      e.preventDefault();
      if (ghost) { ghost.style.left = `${t.clientX}px`; ghost.style.top = `${t.clientY}px`; }
      const { node, after } = this.thumbDropTarget(t.clientX, t.clientY);
      this.markDrop(node, after);
    }, { passive: false });
    const finish = (e: TouchEvent) => {
      if (dragging) {
        e.preventDefault();
        const t = e.changedTouches[0];
        const { index } = this.thumbDropTarget(t.clientX, t.clientY);
        const ids = dragging;
        reset();
        this.suppressClickUntil = Date.now() + 400;
        this.dropPages(ids, index);
      } else {
        reset();
      }
    };
    this.thumbs.addEventListener('touchend', finish, { passive: false });
    this.thumbs.addEventListener('touchcancel', reset);
    this.thumbs.addEventListener('contextmenu', e => { if (start || dragging) e.preventDefault(); });
  }

  // ───────────────────────── feedback ─────────────────────────

  toast(message: string, options: { error?: boolean; duration?: number } = {}): void {
    const node = $('toast');
    node.textContent = message;
    node.classList.toggle('error', !!options.error);
    node.classList.add('visible');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => node.classList.remove('visible'), options.duration ?? (options.error ? 5000 : 2200));
  }

  /**
   * Runs work behind a progress card with optional Cancel. Errors become a toast and the result is
   * undefined; with `rethrow`, errors propagate to the caller instead.
   */
  private async busy<T>(work: (ctl: BusyControl) => Promise<T>, initial = 'Working…', options: { rethrow?: boolean } = {}): Promise<T | undefined> {
    const card = $('busy'), label = $('busy-label'), bar = $('busy-bar'), cancel = $('busy-cancel') as HTMLButtonElement;
    const progress = bar.parentElement!;
    this.busyDepth++;
    // Short operations finish before the card appears, so it doesn't flash.
    const timer = window.setTimeout(() => { card.hidden = false; }, 150);
    let onCancel: (() => void) | null = null;
    const cancelHandler = () => { if (onCancel) { label.textContent = 'Canceling…'; cancel.disabled = true; onCancel(); } };
    cancel.addEventListener('click', cancelHandler);
    const ctl: BusyControl = {
      update: (text, fraction) => {
        if (cancel.disabled && onCancel) return;
        label.textContent = text;
        progress.classList.toggle('indeterminate', fraction === undefined);
        if (fraction !== undefined) bar.style.width = `${Math.round(clamp(fraction, 0, 1) * 100)}%`;
      },
      cancellable: fn => { onCancel = fn; cancel.hidden = false; cancel.disabled = false; },
    };
    ctl.update(initial);
    try {
      return await work(ctl);
    } catch (err) {
      if (options.rethrow) throw err;
      if (err instanceof CancelledError) { this.toast('Canceled'); return undefined; }
      console.error('PageSmith operation failed:', (err as Error)?.name);
      this.toast(`Something went wrong: ${(err as Error)?.message || 'unknown error'}`, { error: true, duration: 7000 });
      return undefined;
    } finally {
      clearTimeout(timer);
      cancel.removeEventListener('click', cancelHandler);
      cancel.hidden = true;
      this.busyDepth--;
      if (!this.busyDepth) { card.hidden = true; bar.style.width = '0'; }
    }
  }

  confirm(title: string, body: string, ok: string): Promise<boolean> {
    const dialog = $('confirm-dialog') as HTMLDialogElement;
    $('confirm-title').textContent = title;
    $('confirm-body').textContent = body;
    $('confirm-ok').textContent = ok;
    dialog.returnValue = '';
    dialog.showModal();
    return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true }));
  }

  /** Asks for a document password. Resolves null when the user skips the file. Never stored. */
  private askPassword(fileName: string, retry: boolean): Promise<string | null> {
    const dialog = $('password-dialog') as HTMLDialogElement;
    const input = $('password-input') as HTMLInputElement;
    $('password-file').textContent = baseName(fileName);
    $('password-error').hidden = !retry;
    input.value = '';
    dialog.returnValue = '';
    dialog.showModal();
    input.focus();
    return new Promise(resolve => dialog.addEventListener('close', () => {
      const value = input.value;
      input.value = '';
      resolve(dialog.returnValue === 'ok' ? value : null);
    }, { once: true }));
  }
}

const EMPTY_OVERLAYS: readonly Overlay[] = Object.freeze([]);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
