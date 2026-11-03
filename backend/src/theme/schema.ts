// Per-user theme settings, stored as JSON in User.theme.
//
// This file is mirrored verbatim in frontend/src/theme/schema.ts; the two
// copies must stay identical by hand, like the provider registry. The object
// carries a version so later axes (terminal colours, fonts) can be
// added without a migration: a key here, a default, a validator case, a
// CSS-variable mapping in the frontend's theme/apply.ts and a Settings group.

export const THEME_VERSION = 1 as const;

export type ThemeBackground =
  | { mode: 'hyperspace' }
  | { mode: 'solid'; color: string }; // '#rrggbb', lower case

export type ThemePalette = 'dark' | 'light';

// The face terminals are set in. Maple Mono (the default) is rounder than the
// JetBrains Mono of --font-mono, with a cursive italic; JetBrains Mono's
// italic is a plain slant. Code blocks and the file viewer keep --font-mono.
export type TerminalFont = 'maple' | 'jetbrains';

export interface ThemeSettings {
  version: typeof THEME_VERSION;
  background: ThemeBackground;
  // The colour palette. Absent means dark, and dark is stored that way, so
  // DEFAULT_THEME and every theme saved before the key existed read as dark.
  palette?: ThemePalette;
  // The working-time thermometer and warp-speed readout in the sidebar footer. Opt-in.
  sidebarActivity: boolean;
  // The MetaTerm entry (and the pinned MetaTerm row) at the top of the project
  // list. Opt-in: on a first run it reads like a place to work, and people
  // ended up working on the orchestrator.
  sidebarMetaTerm: boolean;
  // Projects on stopped, hibernated or terminated boxes in the full UI's
  // Projects list. Off (the default) folds them behind the list's "Show
  // stopped (N)" toggle.
  sidebarShowStopped: boolean;
  // Leave boxes and projects made for `termag ask` (createdFor 'ask') out of
  // the full UI's Projects list, so it shows only what the person started.
  // Off by default: everything is listed.
  sidebarHideAskBoxes: boolean;
  // Thanksgiving: the starfield draws little turkeys instead of stars.
  // Absent means off, and off is stored that way, like palette. Opt-in,
  // offered behind thanksgiving-turkeys-enabled.
  starfieldTurkeys?: boolean;
  // Terminals' font. Absent means Maple Mono, and Maple Mono is stored that
  // way, like palette, so DEFAULT_THEME and every older theme read as it.
  terminalFont?: TerminalFont;
}

// --bg-base in App.css, and the colour the starfield fades to. The first solid
// preset starts here so switching modes stops the stars without changing the look.
export const BASE_BACKGROUND_COLOR = '#0d1117';

// The backdrop behind the workspace per palette: --bg-base in each. Light has
// no starfield, so with background 'hyperspace' it shows its own base instead;
// the setting itself is kept, and dark brings the stars back.
export const BASE_BACKGROUND_COLORS: Record<ThemePalette, string> = {
  dark: BASE_BACKGROUND_COLOR,
  light: '#ffffff',
};

export const DEFAULT_THEME: ThemeSettings = {
  version: THEME_VERSION,
  background: { mode: 'hyperspace' },
  sidebarActivity: false,
  sidebarMetaTerm: false,
  sidebarShowStopped: false,
  sidebarHideAskBoxes: false,
};

// The keys a client may leave out of a save (validateTheme reads each as its
// default). PUT /auth/me/preferences fills absent ones from the stored theme
// (mergeStoredThemeKeys), so a tab loaded before a key existed keeps the
// user's choice instead of resetting it.
export const OPTIONAL_THEME_KEYS = ['palette', 'sidebarActivity', 'sidebarMetaTerm', 'sidebarShowStopped', 'sidebarHideAskBoxes', 'starfieldTurkeys', 'terminalFont'] as const;

const HEX6 = /^#[0-9a-f]{6}$/;
const HEX3 = /^#[0-9a-f]{3}$/;

/** Canonical '#rrggbb' for a CSS hex colour (3 or 6 digits, any case, '#' optional); null if it is not one. */
export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let v = value.trim().toLowerCase();
  if (!v.startsWith('#')) v = `#${v}`;
  if (HEX3.test(v)) v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return HEX6.test(v) ? v : null;
}

export type ThemeValidation = { ok: true; theme: ThemeSettings } | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function unknownKeys(obj: Record<string, unknown>, allowed: string[]): string[] {
  return Object.keys(obj).filter(k => !allowed.includes(k));
}

function validateBackground(input: unknown): { ok: true; background: ThemeBackground } | { ok: false; error: string } {
  if (!isRecord(input)) return { ok: false, error: 'background must be an object' };
  const extra = unknownKeys(input, ['mode', 'color']);
  if (extra.length) return { ok: false, error: `background has unknown keys: ${extra.join(', ')}` };
  switch (input.mode) {
    case 'hyperspace':
      if ('color' in input) return { ok: false, error: 'background.color is only valid with mode "solid"' };
      return { ok: true, background: { mode: 'hyperspace' } };
    case 'solid': {
      const color = normalizeHexColor(input.color);
      if (!color) return { ok: false, error: 'background.color must be a hex colour like #0d1117' };
      return { ok: true, background: { mode: 'solid', color } };
    }
    default:
      return { ok: false, error: 'background.mode must be "hyperspace" or "solid"' };
  }
}

/** Strict check of a theme sent by the client. Unknown keys are rejected so stale fields never accumulate. */
export function validateTheme(input: unknown): ThemeValidation {
  if (!isRecord(input)) return { ok: false, error: 'theme must be an object' };
  const extra = unknownKeys(input, ['version', 'background', ...OPTIONAL_THEME_KEYS]);
  if (extra.length) return { ok: false, error: `theme has unknown keys: ${extra.join(', ')}` };
  if (input.version !== THEME_VERSION) return { ok: false, error: `theme.version must be ${THEME_VERSION}` };
  const bg = validateBackground(input.background);
  if (!bg.ok) return bg;
  // Optional so a tab loaded before these keys existed can still save its background.
  for (const key of ['sidebarActivity', 'sidebarMetaTerm', 'sidebarShowStopped', 'sidebarHideAskBoxes', 'starfieldTurkeys'] as const) {
    if (key in input && typeof input[key] !== 'boolean') return { ok: false, error: `${key} must be a boolean` };
  }
  if ('palette' in input && input.palette !== 'dark' && input.palette !== 'light') {
    return { ok: false, error: 'palette must be "dark" or "light"' };
  }
  if ('terminalFont' in input && input.terminalFont !== 'maple' && input.terminalFont !== 'jetbrains') {
    return { ok: false, error: 'terminalFont must be "maple" or "jetbrains"' };
  }
  return {
    ok: true,
    theme: {
      version: THEME_VERSION,
      background: bg.background,
      ...(input.palette === 'light' ? { palette: 'light' as const } : {}),
      sidebarActivity: input.sidebarActivity === true,
      sidebarMetaTerm: input.sidebarMetaTerm === true,
      sidebarShowStopped: input.sidebarShowStopped === true,
      sidebarHideAskBoxes: input.sidebarHideAskBoxes === true,
      ...(input.starfieldTurkeys === true ? { starfieldTurkeys: true } : {}),
      ...(input.terminalFont === 'jetbrains' ? { terminalFont: 'jetbrains' as const } : {}),
    },
  };
}

/**
 * A theme sent by the client with each absent optional key taken from the
 * stored theme. Anything that is not an object passes through untouched, for
 * validateTheme to reject; unknown keys pass through too, and are rejected there.
 */
export function mergeStoredThemeKeys(input: unknown, stored: unknown): unknown {
  if (!isRecord(input)) return input;
  const current = normalizeTheme(stored);
  const merged: Record<string, unknown> = { ...input };
  for (const key of OPTIONAL_THEME_KEYS) {
    if (!(key in merged) && current[key] !== undefined) merged[key] = current[key];
  }
  return merged;
}

/** Lenient read of a stored theme: a fresh row holds {}, and anything unreadable falls back per axis to the default. */
export function normalizeTheme(input: unknown): ThemeSettings {
  if (!isRecord(input)) return DEFAULT_THEME;
  const bg = validateBackground(input.background);
  return {
    version: THEME_VERSION,
    background: bg.ok ? bg.background : DEFAULT_THEME.background,
    ...(input.palette === 'light' ? { palette: 'light' as const } : {}),
    sidebarActivity: input.sidebarActivity === true,
    sidebarMetaTerm: input.sidebarMetaTerm === true,
    sidebarShowStopped: input.sidebarShowStopped === true,
    sidebarHideAskBoxes: input.sidebarHideAskBoxes === true,
    ...(input.starfieldTurkeys === true ? { starfieldTurkeys: true } : {}),
    ...(input.terminalFont === 'jetbrains' ? { terminalFont: 'jetbrains' as const } : {}),
  };
}
