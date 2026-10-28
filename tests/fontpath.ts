import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The same Noto Sans file the app serves from public/fonts. */
export const FONT_PATH = join(import.meta.dirname, '..', 'public', 'fonts', 'NotoSans-Regular.ttf');
export const loadFont = async () => new Uint8Array(readFileSync(FONT_PATH));
