import { describe, expect, it, vi } from 'vitest';
import { applyTheme, BACKDROP_VAR, PALETTE_STORAGE_KEY, showStarfield, StyleRoot, THEME_COLOR, themeCssVariables, themePalette } from './apply';
import { BASE_BACKGROUND_COLOR, BASE_BACKGROUND_COLORS, DEFAULT_THEME } from './schema';

describe('themeCssVariables', () => {
  it('paints the base colour behind the starfield, so the canvas fade and the backdrop agree', () => {
    expect(themeCssVariables(DEFAULT_THEME)).toEqual({ [BACKDROP_VAR]: BASE_BACKGROUND_COLOR });
  });

  it('paints the chosen colour for a solid background', () => {
    expect(themeCssVariables({ ...DEFAULT_THEME, background: { mode: 'solid', color: '#0b1a2e' } }))
      .toEqual({ [BACKDROP_VAR]: '#0b1a2e' });
  });

  it('paints the light base in light with the starfield chosen, since light draws no stars', () => {
    expect(themeCssVariables({ ...DEFAULT_THEME, palette: 'light' })).toEqual({ [BACKDROP_VAR]: BASE_BACKGROUND_COLORS.light });
    expect(BASE_BACKGROUND_COLORS.dark).toBe(BASE_BACKGROUND_COLOR);
  });

  it('paints a saved solid colour as it is in light too', () => {
    expect(themeCssVariables({ ...DEFAULT_THEME, palette: 'light', background: { mode: 'solid', color: '#0b1a2e' } }))
      .toEqual({ [BACKDROP_VAR]: '#0b1a2e' });
  });
});

describe('showStarfield', () => {
  it('draws the stars only when asked for and the palette is dark', () => {
    expect(showStarfield(DEFAULT_THEME)).toBe(true);
    expect(showStarfield({ ...DEFAULT_THEME, palette: 'dark' })).toBe(true);
    expect(showStarfield({ ...DEFAULT_THEME, palette: 'light' })).toBe(false);
    expect(showStarfield({ ...DEFAULT_THEME, background: { mode: 'solid', color: '#000000' } })).toBe(false);
  });
});

describe('themePalette', () => {
  it('reads an absent palette as dark', () => {
    expect(themePalette(DEFAULT_THEME)).toBe('dark');
    expect(themePalette({ ...DEFAULT_THEME, palette: 'light' })).toBe('light');
  });
});

function fakeRoot(): StyleRoot & { setProperty: ReturnType<typeof vi.fn> } {
  const setProperty = vi.fn();
  return { style: { setProperty }, dataset: {}, setProperty };
}

function fakeDoc() {
  const setAttribute = vi.fn();
  const querySelector = vi.fn(() => ({ setAttribute }));
  return { doc: { querySelector }, querySelector, setAttribute };
}

describe('applyTheme', () => {
  it('sets every variable on the given root', () => {
    const root = fakeRoot();
    applyTheme({ ...DEFAULT_THEME, background: { mode: 'solid', color: '#000000' } }, root, null, null);
    expect(root.setProperty).toHaveBeenCalledWith(BACKDROP_VAR, '#000000');
  });

  it('switches to light with data-palette, color-scheme, the theme-color meta and the cache', () => {
    const root = fakeRoot();
    const { doc, querySelector, setAttribute } = fakeDoc();
    const setItem = vi.fn();
    applyTheme({ ...DEFAULT_THEME, palette: 'light' }, root, doc, { setItem });
    expect(root.dataset.palette).toBe('light');
    expect(root.dataset).not.toHaveProperty('theme');
    expect(root.setProperty).toHaveBeenCalledWith('color-scheme', 'light');
    expect(querySelector).toHaveBeenCalledWith('meta[name="theme-color"]');
    expect(setAttribute).toHaveBeenCalledWith('content', THEME_COLOR.light);
    expect(setItem).toHaveBeenCalledWith(PALETTE_STORAGE_KEY, 'light');
  });

  it('removes data-palette for dark, so dark is the attribute-free default', () => {
    const root = fakeRoot();
    root.dataset.palette = 'light';
    const { doc, setAttribute } = fakeDoc();
    const setItem = vi.fn();
    applyTheme(DEFAULT_THEME, root, doc, { setItem });
    expect(root.dataset).not.toHaveProperty('palette');
    expect(root.setProperty).toHaveBeenCalledWith('color-scheme', 'dark');
    expect(setAttribute).toHaveBeenCalledWith('content', THEME_COLOR.dark);
    expect(setItem).toHaveBeenCalledWith(PALETTE_STORAGE_KEY, 'dark');
  });

  it('survives a missing meta tag and storage that throws', () => {
    const root = fakeRoot();
    const setItem = vi.fn(() => { throw new Error('QuotaExceededError'); });
    expect(() => applyTheme({ ...DEFAULT_THEME, palette: 'light' }, root, { querySelector: () => null }, { setItem })).not.toThrow();
    expect(root.dataset.palette).toBe('light');
  });
});

describe('index.html pre-paint script', () => {
  it('reads the same cache key and sets the same light theme-color as applyTheme', async () => {
    const { readFileSync } = await import('node:fs');
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    expect(html).toContain(`localStorage.getItem('${PALETTE_STORAGE_KEY}') === 'light'`);
    expect(html).toContain(`dataset.palette = 'light'`);
    expect(html).toContain(`'${THEME_COLOR.light}'`);
    expect(html).toContain(`<meta name="theme-color" content="${THEME_COLOR.dark}" />`);
  });
});
