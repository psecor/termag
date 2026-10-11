// Per-user theme settings, stored as JSON in User.theme.
//
// This file is mirrored verbatim in backend/src/theme/schema.ts; the two
// copies must stay identical by hand, like the provider registry. The object
// carries a version so later axes (palette, terminal colours, fonts) can be
// added without a migration: a key here, a default, a validator case, a
// CSS-variable mapping in the frontend's theme/apply.ts and a Settings group.

export const THEME_VERSION = 1 as const;

export type ThemeBackground =
  | { mode: 'hyperspace' }
  | { mode: 'solid'; color: string }; // '#rrggbb', lower case

export interface ThemeSettings {
  version: typeof THEME_VERSION;
  background: ThemeBackground;
  // The working-time thermometer and warp-speed readout in the sidebar footer. Opt-in.
  sidebarActivity: boolean;
}

// --bg-base in App.css, and the colour the starfield fades to. The first solid
// preset starts here so switching modes stops the stars without changing the look.
export const BASE_BACKGROUND_COLOR = '#0d1117';

export const DEFAULT_THEME: ThemeSettings = {
  version: THEME_VERSION,
  background: { mode: 'hyperspace' },
  sidebarActivity: false,
};

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
  const extra = unknownKeys(input, ['version', 'background', 'sidebarActivity']);
  if (extra.length) return { ok: false, error: `theme has unknown keys: ${extra.join(', ')}` };
  if (input.version !== THEME_VERSION) return { ok: false, error: `theme.version must be ${THEME_VERSION}` };
  const bg = validateBackground(input.background);
  if (!bg.ok) return bg;
  // Optional so a tab loaded before this key existed can still save its background.
  if ('sidebarActivity' in input && typeof input.sidebarActivity !== 'boolean') {
    return { ok: false, error: 'sidebarActivity must be a boolean' };
  }
  return { ok: true, theme: { version: THEME_VERSION, background: bg.background, sidebarActivity: input.sidebarActivity === true } };
}

/** Lenient read of a stored theme: a fresh row holds {}, and anything unreadable falls back per axis to the default. */
export function normalizeTheme(input: unknown): ThemeSettings {
  if (!isRecord(input)) return DEFAULT_THEME;
  const bg = validateBackground(input.background);
  return {
    version: THEME_VERSION,
    background: bg.ok ? bg.background : DEFAULT_THEME.background,
    sidebarActivity: input.sidebarActivity === true,
  };
}
