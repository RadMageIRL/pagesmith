import type { PageInfo, Rotation } from '../engine/types';

/**
 * Coordinate spaces:
 *   page space - PDF user space of the unrotated page: origin bottom-left, y up, offset by the crop box.
 *   view space - the page as displayed at rotation R (clockwise, like /Rotate): origin top-left,
 *                y down, in points. Its size is width×height for 0/180 and height×width for 90/270.
 */
export interface Point { x: number; y: number }

export function viewSize(info: PageInfo, rotation: Rotation): { width: number; height: number } {
  return rotation === 90 || rotation === 270 ? { width: info.height, height: info.width } : { width: info.width, height: info.height };
}

export function viewToPage(p: Point, rotation: Rotation, info: PageInfo): Point {
  const { width: W, height: H } = info;
  let x: number, y: number;
  switch (rotation) {
    case 0: x = p.x; y = H - p.y; break;
    case 90: x = p.y; y = p.x; break;
    case 180: x = W - p.x; y = p.y; break;
    case 270: x = W - p.y; y = H - p.x; break;
  }
  return { x: x + info.x, y: y + info.y };
}

export function pageToView(p: Point, rotation: Rotation, info: PageInfo): Point {
  const { width: W, height: H } = info;
  const x = p.x - info.x, y = p.y - info.y;
  switch (rotation) {
    case 0: return { x, y: H - y };
    case 90: return { x: y, y: x };
    case 180: return { x: W - x, y };
    case 270: return { x: H - y, y: W - x };
  }
}

/** Re-expresses a view-space point from one display rotation in another. */
export function convertView(p: Point, from: Rotation, to: Rotation, info: PageInfo): Point {
  return from === to ? { ...p } : pageToView(viewToPage(p, from, info), to, info);
}

/**
 * Where to draw content in page space so it appears upright, top-left at `topLeft`, in a view
 * rotated by `rotation`: returns the anchor point that becomes the content's own bottom-left
 * corner, and the counter-clockwise angle (pdf-lib's convention) to draw it at.
 */
export function uprightAnchor(topLeft: Point, height: number, rotation: Rotation, info: PageInfo): { x: number; y: number; angle: number } {
  const anchor = viewToPage({ x: topLeft.x, y: topLeft.y + height }, rotation, info);
  return { ...anchor, angle: rotation };
}
