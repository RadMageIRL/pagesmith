import type { Rotation } from '../engine/types';

/**
 * Overlays are new content drawn on top of a page. They never edit the page's existing text.
 *
 * Position is stored in the "frame" the user placed it in: the page as displayed at
 * `frameRotation`, top-left origin, in PDF points (scale 1). Keeping the frame lets an overlay stay
 * attached to the page content when the page is rotated later, and lets export redraw it upright
 * relative to where the user put it. See geometry.ts for the mappings.
 */
interface OverlayBase {
  id: string;
  pageId: string;
  frameRotation: Rotation;
  x: number;
  y: number;
}

export interface TextOverlay extends OverlayBase {
  kind: 'text';
  text: string;
  fontSize: number;
  color: string;
}

export interface ImageOverlay extends OverlayBase {
  kind: 'image';
  width: number;
  height: number;
  mime: 'image/png' | 'image/jpeg';
  bytes: Uint8Array;
}

export interface RectOverlay extends OverlayBase {
  kind: 'rect';
  width: number;
  height: number;
  color: string;
  /** highlight = translucent fill, box = outline. */
  style: 'highlight' | 'box';
}

export type Overlay = TextOverlay | ImageOverlay | RectOverlay;

export const TEXT_LINE_HEIGHT = 1.2;
/** CSS family the editor uses; it is the same Noto Sans file the exporter embeds, so metrics match. */
export const OVERLAY_FONT_FAMILY = 'PageSmith Sans';
/**
 * Distance from the top of a line box to the baseline, as a fraction of font size, for the bundled
 * Noto Sans at line-height 1.2. The font sets USE_TYPO_METRICS (ascender 1069, descender -293 per
 * 1000 em), so browsers lay out a content area of 1.362em: half-leading (1.2 - 1.362) / 2 plus the
 * ascent gives 0.988. tests/unit/fonts.test.ts re-derives this from the font file.
 */
export const TEXT_BASELINE = 0.988;

export const MIN_FONT_SIZE = 4;
export const MAX_FONT_SIZE = 288;

export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return 16;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size * 2) / 2));
}

/** Accepts only #rgb / #rrggbb; anything else falls back so untrusted values never reach CSS or the PDF. */
export function safeColor(value: string, fallback = '#000000'): string {
  const v = String(value || '').trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return fallback;
}

export function hexToRgb01(hex: string): [number, number, number] {
  const v = safeColor(hex);
  return [parseInt(v.slice(1, 3), 16) / 255, parseInt(v.slice(3, 5), 16) / 255, parseInt(v.slice(5, 7), 16) / 255];
}

/** Sniffs PNG/JPEG magic bytes; the browser-reported MIME type of a picked file is not trusted. */
export function sniffImage(bytes: Uint8Array): 'image/png' | 'image/jpeg' | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}
