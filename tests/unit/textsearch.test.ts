import { describe, expect, it } from 'vitest';
import { findMatches, matchBox } from '../../src/render/textsearch';
import type { TextRun } from '../../src/render/renderer';

const run = (str: string, extra: Partial<TextRun> = {}): TextRun => ({ str, x: 100, y: 200, dir: [1, 0], width: str.length * 10, height: 20, ...extra });

describe('findMatches', () => {
  it('is case-insensitive and finds every occurrence in every run', () => {
    expect(findMatches([run('The cat sat'), run('CATALOG'), run('dog')], 'cat')).toEqual([
      { run: 0, start: 4, end: 7 },
      { run: 1, start: 0, end: 3 },
    ]);
    expect(findMatches([run('aaaa')], 'aa')).toHaveLength(2);
  });

  it('ignores empty queries and keeps offsets aligned for non-ASCII text', () => {
    expect(findMatches([run('abc')], '   ')).toEqual([]);
    expect(findMatches([run('İstanbul Straße')], 'straße')).toEqual([{ run: 0, start: 9, end: 15 }]);
  });
});

describe('matchBox', () => {
  it('boxes the matched characters of horizontal text', () => {
    const box = matchBox(run('abcdefghij'), 2, 5);
    expect(box.x).toBeCloseTo(120);
    expect(box.width).toBeCloseTo(30);
    expect(box.y).toBeCloseTo(200 - 18);
    expect(box.height).toBeCloseTo(18 + 5);
  });

  it('follows rotated runs (text running downwards on a rotated page)', () => {
    const box = matchBox(run('abcdefghij', { dir: [0, 1] }), 0, 10);
    expect(box.height).toBeCloseTo(100);
    expect(box.width).toBeCloseTo(23);
    expect(box.y).toBeCloseTo(200);
  });
});
