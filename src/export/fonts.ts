import fontkit from '@cantoo/fontkit';

/**
 * Scripts that need OpenType shaping (glyph reordering, conjuncts, contextual forms). pdf-lib draws
 * glyphs in logical order without GPOS positioning, so even when the font has the glyphs the
 * result would be wrong - these are treated as unsupported rather than exported incorrectly.
 * Hebrew/Arabic (right-to-left) and the Indic, Southeast-Asian and Tibetan blocks are covered.
 */
const COMPLEX_RANGES: [number, number][] = [
  [0x0590, 0x08ff], [0x0900, 0x0dff], [0x0e00, 0x0eff], [0x0f00, 0x109f], [0x1780, 0x17ff],
  [0xa8e0, 0xa8ff], [0xfb1d, 0xfdff], [0xfe70, 0xfeff],
];

function isComplex(cp: number): boolean {
  return COMPLEX_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

/** Character coverage of the bundled overlay font (Noto Sans: Latin, Greek, Cyrillic, Vietnamese). */
export class TextFont {
  private constructor(private readonly has: (cp: number) => boolean) {}

  static fromBytes(bytes: Uint8Array): TextFont {
    const font = fontkit.create(bytes as Parameters<typeof fontkit.create>[0]) as { hasGlyphForCodePoint(cp: number): boolean };
    return new TextFont(cp => font.hasGlyphForCodePoint(cp));
  }

  supports(ch: string): boolean {
    if (ch === '\n') return true;
    const cp = ch.codePointAt(0)!;
    return !isComplex(cp) && this.has(cp);
  }

  /** Distinct characters that can't be drawn (shown to the user before export). */
  unsupported(text: string): string[] {
    const out = new Set<string>();
    for (const ch of normalize(text)) if (!this.supports(ch)) out.add(ch);
    return [...out];
  }

  /** Replaces undrawable characters with "?" so export never fails on user text. */
  sanitize(text: string): string {
    return Array.from(normalize(text)).map(ch => (this.supports(ch) ? ch : '?')).join('');
  }
}

function normalize(text: string): string {
  return text.normalize('NFC').replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
}
