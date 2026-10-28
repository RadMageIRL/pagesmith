import type { TextRun } from './renderer';

export interface Match { run: number; start: number; end: number }
export interface Box { x: number; y: number; width: number; height: number }

/**
 * Case-insensitive matches of `query` inside each text run. Lower-casing is done per character so
 * offsets in the folded string stay aligned with the original (no length-changing normalization).
 */
export function findMatches(runs: readonly Pick<TextRun, 'str'>[], query: string): Match[] {
  const q = fold(query.trim());
  if (!q) return [];
  const out: Match[] = [];
  runs.forEach((run, i) => {
    const hay = fold(run.str);
    let at = hay.indexOf(q);
    while (at !== -1) {
      out.push({ run: i, start: at, end: at + q.length });
      at = hay.indexOf(q, at + Math.max(1, q.length));
    }
  });
  return out;
}

function fold(text: string): string {
  return Array.from(text, ch => {
    const lower = ch.toLowerCase();
    return lower.length === ch.length ? lower : ch;
  }).join('');
}

/**
 * Axis-aligned box (view space, scale 1) around characters [start, end) of a run. Character
 * positions are interpolated along the run's advance, which is exact for monospace text and close
 * for proportional text - enough to mark where a hit is.
 */
export function matchBox(run: TextRun, start: number, end: number): Box {
  const len = Math.max(1, run.str.length);
  const [dx, dy] = run.dir;
  const ux = dy, uy = -dx; // "up" from the baseline in a y-down space
  const a = run.width * (start / len), b = run.width * (end / len);
  const ascent = run.height * 0.9, descent = run.height * 0.25;
  const points: [number, number][] = [];
  for (const t of [a, b]) {
    const px = run.x + dx * t, py = run.y + dy * t;
    points.push([px + ux * ascent, py + uy * ascent], [px - ux * descent, py - uy * descent]);
  }
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
