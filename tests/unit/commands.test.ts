import { describe, expect, it } from 'vitest';
import { History } from '../../src/commands/history';
import { EMPTY_STATE, addOverlay, addPages, deletePages, movePages, nudgePages, removeOverlay, rotatePages, updateOverlay, type DocState } from '../../src/commands/state';
import type { PageRef } from '../../src/engine/types';
import type { TextOverlay } from '../../src/overlay/types';

const refs = (ids: string[]): PageRef[] => ids.map((id, i) => ({ id, sourceId: 's', sourceIndex: i, rotation: 0 }));
const ids = (s: DocState) => s.pages.map(p => p.id);
const base = (): DocState => addPages(EMPTY_STATE, refs(['a', 'b', 'c', 'd', 'e']));
const text = (id: string, pageId: string): TextOverlay => ({ id, pageId, kind: 'text', frameRotation: 0, x: 10, y: 10, text: 'hi', fontSize: 12, color: '#000000' });

describe('page commands', () => {
  it('appends and inserts pages', () => {
    const s = addPages(base(), refs(['x', 'y']), 1);
    expect(ids(s)).toEqual(['a', 'x', 'y', 'b', 'c', 'd', 'e']);
  });

  it('rotates selected pages in both directions and wraps', () => {
    let s = rotatePages(base(), ['b', 'd'], 90);
    expect(s.pages.map(p => p.rotation)).toEqual([0, 90, 0, 90, 0]);
    s = rotatePages(s, ['b'], -90);
    s = rotatePages(s, ['b'], -90);
    expect(s.pages[1].rotation).toBe(270);
    s = rotatePages(rotatePages(rotatePages(s, ['d'], 90), ['d'], 90), ['d'], 90);
    expect(s.pages[3].rotation).toBe(0);
  });

  it('deletes pages and their overlays', () => {
    let s = addOverlay(base(), text('o1', 'b'));
    s = addOverlay(s, text('o2', 'c'));
    s = deletePages(s, ['b', 'e']);
    expect(ids(s)).toEqual(['a', 'c', 'd']);
    expect(s.overlays.map(o => o.id)).toEqual(['o2']);
  });

  it('moves a single page forwards and backwards', () => {
    expect(ids(movePages(base(), ['a'], 3))).toEqual(['b', 'c', 'a', 'd', 'e']);
    expect(ids(movePages(base(), ['e'], 0))).toEqual(['e', 'a', 'b', 'c', 'd']);
    expect(ids(movePages(base(), ['b'], 5))).toEqual(['a', 'c', 'd', 'e', 'b']);
  });

  it('moves a non-contiguous multi-selection as a block, keeping relative order', () => {
    expect(ids(movePages(base(), ['d', 'a'], 3))).toEqual(['b', 'c', 'a', 'd', 'e']);
    expect(ids(movePages(base(), ['b', 'e'], 0))).toEqual(['b', 'e', 'a', 'c', 'd']);
  });

  it('returns the same state for a no-op move so history records nothing', () => {
    const s = base();
    expect(movePages(s, ['b'], 1)).toBe(s);
    expect(movePages(s, ['b'], 2)).toBe(s);
  });

  it('nudges selected pages and stops at the edges', () => {
    expect(ids(nudgePages(base(), ['b', 'd'], -1))).toEqual(['b', 'a', 'd', 'c', 'e']);
    expect(ids(nudgePages(base(), ['d', 'e'], 1))).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(ids(nudgePages(base(), ['a', 'b'], -1))).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('never mutates its input', () => {
    const s = base();
    const before = JSON.stringify(s);
    rotatePages(s, ['a'], 90); deletePages(s, ['a']); movePages(s, ['a'], 4); nudgePages(s, ['c'], 1);
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('overlay commands', () => {
  it('updates fields but never identity', () => {
    let s = addOverlay(base(), text('o1', 'a'));
    s = updateOverlay(s, 'o1', { text: 'changed', id: 'hacked', pageId: 'z' } as Partial<TextOverlay>);
    expect(s.overlays[0]).toMatchObject({ id: 'o1', pageId: 'a', text: 'changed' });
    expect(removeOverlay(s, 'nope')).toBe(s);
    expect(removeOverlay(s, 'o1').overlays).toHaveLength(0);
  });
});

describe('History', () => {
  it('undoes and redoes page operations', () => {
    const h = new History<DocState>(base());
    h.commit(rotatePages(h.present, ['a'], 90));
    h.commit(deletePages(h.present, ['b']));
    h.commit(movePages(h.present, ['e'], 0));
    expect(ids(h.present)).toEqual(['e', 'a', 'c', 'd']);
    h.undo();
    expect(ids(h.present)).toEqual(['a', 'c', 'd', 'e']);
    h.undo();
    expect(ids(h.present)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(h.present.pages[0].rotation).toBe(90);
    h.undo();
    expect(h.present.pages[0].rotation).toBe(0);
    expect(h.canUndo).toBe(false);
    expect(h.undo()).toBeNull();
    h.redo(); h.redo();
    expect(ids(h.present)).toEqual(['a', 'c', 'd', 'e']);
    expect(h.canRedo).toBe(true);
  });

  it('drops the redo branch after a new commit', () => {
    const h = new History<DocState>(base());
    h.commit(deletePages(h.present, ['a']));
    h.undo();
    h.commit(deletePages(h.present, ['b']));
    expect(h.canRedo).toBe(false);
    expect(ids(h.present)).toEqual(['a', 'c', 'd', 'e']);
  });

  it('ignores unchanged states', () => {
    const h = new History<DocState>(base());
    expect(h.commit(h.present)).toBe(false);
    expect(h.canUndo).toBe(false);
  });

  it('coalesces a burst of edits into one undo step, and seal() ends the burst', () => {
    const h = new History<DocState>(addOverlay(base(), text('o1', 'a')));
    for (const t of ['h', 'he', 'hel', 'hello']) h.commit(updateOverlay(h.present, 'o1', { text: t }), 'type:o1');
    h.seal();
    h.commit(updateOverlay(h.present, 'o1', { text: 'hello!' }), 'type:o1');
    h.undo();
    expect((h.present.overlays[0] as TextOverlay).text).toBe('hello');
    h.undo();
    expect((h.present.overlays[0] as TextOverlay).text).toBe('hi');
  });

  it('caps history length', () => {
    const h = new History<number>(0, 3);
    for (let i = 1; i <= 10; i++) h.commit(i);
    let undos = 0;
    while (h.undo() !== null) undos++;
    expect(undos).toBe(3);
    expect(h.present).toBe(7);
  });
});
