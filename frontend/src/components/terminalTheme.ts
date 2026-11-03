import type { ITheme } from 'xterm';
import { withAlpha } from '../utils/cssColor';
import type { ThemePalette } from '../theme/schema';

// The terminal's colours. xterm paints on a canvas, so it needs values, not
// var()s: they are read with getComputedStyle where the terminal is mounted,
// so a surface that sets its own palette gets a terminal that matches it. The
// terminal is a dark island in either palette (the programs in it, Claude
// Code first, draw for a dark background): in light, App.css gives
// .terminal-island the dark :root tokens back, so these read dark there too.

/** The class on the terminal's container that App.css keeps dark in light. */
export const TERMINAL_ISLAND_CLASS = 'terminal-island';

// In dark the background is see-through, so the starfield glows behind the
// text; in light there is no starfield (App.tsx) and it is opaque.
const BACKGROUND_ALPHA: Record<ThemePalette, number> = { dark: 0xc0, light: 0xff };

export interface TokenSource { getPropertyValue(name: string): string }

export function terminalTheme(css: TokenSource, palette: ThemePalette): ITheme {
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: withAlpha(token('--bg-base', '#0d1117'), BACKGROUND_ALPHA[palette]),
    foreground: token('--text-primary', '#c9d1d9'),
    cursor: token('--accent', '#58a6ff'),
    selectionBackground: token('--terminal-selection', '#264f7880'),
  };
}

/** The palette on <html> now: data-palette="light", absent for dark (theme/apply.ts). */
export function documentPalette(root: { dataset: Record<string, string | undefined> } = document.documentElement): ThemePalette {
  return root.dataset.palette === 'light' ? 'light' : 'dark';
}
