import { BASE_BACKGROUND_COLORS, ThemePalette, ThemeSettings } from './schema';

// The CSS custom properties a theme sets on <html>. One entry per themed
// surface; App.css keeps reading variables. The palette is not a variable but
// html[data-palette], so App.css can redefine its :root tokens in one block.
export const BACKDROP_VAR = '--bg-backdrop';

// Where the last applied palette is remembered, so index.html's pre-paint
// script can set data-palette before /auth/me answers. Keep the key in sync
// with that script.
export const PALETTE_STORAGE_KEY = 'termag.palette';

// <meta name="theme-color"> per palette: the browser and phone chrome around
// the page. Dark is index.html's static value (--bg-surface).
export const THEME_COLOR: Record<ThemePalette, string> = { dark: '#161b22', light: '#f6f8fa' };

// A solid colour is the user's own and applies as it is in either palette;
// otherwise the backdrop is the palette's base, which the starfield fades to
// in dark (light has no starfield: showStarfield).
export function themeCssVariables(theme: ThemeSettings): Record<string, string> {
  const bg = theme.background;
  return { [BACKDROP_VAR]: bg.mode === 'solid' ? bg.color : BASE_BACKGROUND_COLORS[themePalette(theme)] };
}

/** Whether the theme draws the starfield: it asks for it and the palette is dark. */
export function showStarfield(theme: ThemeSettings): boolean {
  return theme.background.mode === 'hyperspace' && themePalette(theme) === 'dark';
}

export function themePalette(theme: ThemeSettings): ThemePalette {
  return theme.palette === 'light' ? 'light' : 'dark';
}

export interface StyleRoot {
  style: { setProperty(name: string, value: string): void };
  dataset: Record<string, string | undefined>;
}

export interface PaletteDocument {
  querySelector(selector: string): { setAttribute(name: string, value: string): void } | null;
}

export interface PaletteStorage { setItem(key: string, value: string): void }

/**
 * Applies a theme to <html>: the CSS variables, the palette switch
 * (data-palette="light", absent for dark; not data-theme, which LaunchPad's
 * page-base CSS targets), color-scheme for native controls and scrollbars,
 * the theme-color meta tag, and the palette cache for the next first paint.
 */
export function applyTheme(
  theme: ThemeSettings,
  root: StyleRoot,
  doc: PaletteDocument | null = typeof document === 'undefined' ? null : document,
  storage: PaletteStorage | null = safeLocalStorage(),
): void {
  for (const [name, value] of Object.entries(themeCssVariables(theme))) root.style.setProperty(name, value);
  const palette = themePalette(theme);
  if (palette === 'light') root.dataset.palette = 'light';
  else delete root.dataset.palette;
  root.style.setProperty('color-scheme', palette);
  doc?.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[palette]);
  try {
    storage?.setItem(PALETTE_STORAGE_KEY, palette);
  } catch {
    // Storage full or blocked: the next first paint is dark until /auth/me answers.
  }
}

function safeLocalStorage(): PaletteStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // Some privacy modes throw on the getter itself.
  }
}
