import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import fontkit from '@cantoo/fontkit';
import { TextFont } from '../../src/export/fonts';
import { TEXT_BASELINE, TEXT_LINE_HEIGHT } from '../../src/overlay/types';
import { FONT_PATH } from '../fontpath';

const bytes = new Uint8Array(readFileSync(FONT_PATH));

describe('bundled overlay font', () => {
  it('has the line metrics TEXT_BASELINE is derived from', () => {
    const font = fontkit.create(bytes as never) as unknown as { unitsPerEm: number; 'OS/2': { typoAscender: number; typoDescender: number; fsSelection: { useTypoMetrics: boolean } } };
    const os2 = font['OS/2'];
    // Browsers use the typo metrics because USE_TYPO_METRICS is set.
    expect(os2.fsSelection.useTypoMetrics).toBe(true);
    const ascent = os2.typoAscender / font.unitsPerEm, descent = -os2.typoDescender / font.unitsPerEm;
    const baseline = (TEXT_LINE_HEIGHT - (ascent + descent)) / 2 + ascent;
    expect(TEXT_BASELINE).toBeCloseTo(baseline, 4);
  });

  it('reports exactly the characters it cannot draw', () => {
    const font = TextFont.fromBytes(bytes);
    expect(font.unsupported('Hello, Ωμέγα, Привет, Tiếng Việt \u2014 “quotes” €')).toEqual([]);
    expect(font.unsupported('a你b好😀')).toEqual(['你', '好', '😀']);
    // Hebrew/Arabic need bidi and shaping; Devanagari is in the font but needs shaping too.
    expect(font.unsupported('שלום')).toHaveLength(4);
    expect(font.unsupported('हिन्दी').length).toBeGreaterThan(0);
    expect(font.sanitize('x你\r\ny')).toBe('x?\ny');
  });
});
