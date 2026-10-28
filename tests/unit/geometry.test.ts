import { describe, expect, it } from 'vitest';
import type { PageInfo, Rotation } from '../../src/engine/types';
import { convertView, pageToView, uprightAnchor, viewSize, viewToPage } from '../../src/overlay/geometry';
import { clampFontSize, safeColor, sniffImage } from '../../src/overlay/types';
import { makePng } from '../fixtures';

const info: PageInfo = { x: 0, y: 0, width: 600, height: 800, rotation: 0 };
const cropped: PageInfo = { x: 50, y: 25, width: 600, height: 800, rotation: 0 };
const rotations: Rotation[] = [0, 90, 180, 270];

describe('view/page mapping', () => {
  it('maps the view top-left corner to the page corner that rotation brings there', () => {
    // Clockwise display rotation: 90 brings the page's bottom-left to the view's top-left.
    expect(viewToPage({ x: 0, y: 0 }, 0, info)).toEqual({ x: 0, y: 800 });
    expect(viewToPage({ x: 0, y: 0 }, 90, info)).toEqual({ x: 0, y: 0 });
    expect(viewToPage({ x: 0, y: 0 }, 180, info)).toEqual({ x: 600, y: 0 });
    expect(viewToPage({ x: 0, y: 0 }, 270, info)).toEqual({ x: 600, y: 800 });
  });

  it('swaps view dimensions for quarter turns', () => {
    expect(viewSize(info, 90)).toEqual({ width: 800, height: 600 });
    expect(viewSize(info, 180)).toEqual({ width: 600, height: 800 });
  });

  it('keeps every view corner inside the page for every rotation', () => {
    for (const r of rotations) {
      const { width, height } = viewSize(info, r);
      const corners = [[0, 0], [width, 0], [0, height], [width, height]].map(([x, y]) => viewToPage({ x, y }, r, info));
      const xs = corners.map(c => c.x).sort((a, b) => a - b), ys = corners.map(c => c.y).sort((a, b) => a - b);
      expect([xs[0], xs[3], ys[0], ys[3]]).toEqual([0, 600, 0, 800]);
    }
  });

  it('round-trips points, including crop box offsets', () => {
    for (const box of [info, cropped]) for (const r of rotations) {
      const p = { x: 123.5, y: 456.25 };
      const back = pageToView(viewToPage(p, r, box), r, box);
      expect(back.x).toBeCloseTo(p.x);
      expect(back.y).toBeCloseTo(p.y);
    }
    expect(viewToPage({ x: 0, y: 0 }, 0, cropped)).toEqual({ x: 50, y: 825 });
  });

  it('converts between display rotations through page space', () => {
    // A point near the page's top-left, shown at 0°, appears near the top-right after a 90° turn.
    const p = convertView({ x: 10, y: 20 }, 0, 90, info);
    expect(p).toEqual({ x: 780, y: 10 });
    expect(convertView(p, 90, 0, info)).toEqual({ x: 10, y: 20 });
  });

  it('anchors upright content at its bottom-left with the rotation as a CCW angle', () => {
    expect(uprightAnchor({ x: 100, y: 100 }, 50, 0, info)).toEqual({ x: 100, y: 650, angle: 0 });
    // At 90°, the view's downward direction is page +x, so the bottom-left sits 50pt further along x.
    expect(uprightAnchor({ x: 100, y: 100 }, 50, 90, info)).toEqual({ x: 150, y: 100, angle: 90 });
  });
});

describe('overlay value guards', () => {
  it('sanitizes colors', () => {
    expect(safeColor('#ABC')).toBe('#aabbcc');
    expect(safeColor('#12ab9F')).toBe('#12ab9f');
    expect(safeColor('red; background:url(x)')).toBe('#000000');
  });
  it('clamps font sizes', () => {
    expect(clampFontSize(1)).toBe(4);
    expect(clampFontSize(9999)).toBe(288);
    expect(clampFontSize(NaN)).toBe(16);
    expect(clampFontSize(12.3)).toBe(12.5);
  });
  it('sniffs image types from bytes, not names', () => {
    expect(sniffImage(makePng(2, 2))).toBe('image/png');
    expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe('image/jpeg');
    expect(sniffImage(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeNull();
  });
});
