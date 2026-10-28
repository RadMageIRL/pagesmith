// Only UI preferences are ever written to localStorage - never document content or file names.
const THEME_KEY = 'pagesmith_theme';
export type ThemeMode = 'system' | 'light' | 'dark';
const THEMES: ThemeMode[] = ['system', 'light', 'dark'];

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode / storage blocked: preference just won't persist */ }
}

export function storedTheme(): ThemeMode {
  const value = read(THEME_KEY);
  return THEMES.includes(value as ThemeMode) ? (value as ThemeMode) : 'system';
}

// Three states, not two: with no attribute set the stylesheet follows prefers-color-scheme,
// so "system" is a real choice rather than an unlabeled default.
export function applyTheme(mode: ThemeMode): void {
  if (mode === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = getComputedStyle(document.body).backgroundColor || '#101311';
}

export function cycleTheme(): ThemeMode {
  const next = THEMES[(THEMES.indexOf(storedTheme()) + 1) % THEMES.length];
  write(THEME_KEY, next);
  applyTheme(next);
  return next;
}

export function themeLabel(mode: ThemeMode): string {
  return `Theme: ${mode === 'system' ? 'sys' : mode}`;
}
