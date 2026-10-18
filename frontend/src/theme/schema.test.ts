import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, normalizeHexColor, normalizeTheme, validateTheme } from './schema';

describe('normalizeHexColor', () => {
  it('canonicalizes case, whitespace, a missing hash and 3-digit shorthand', () => {
    expect(normalizeHexColor(' #0D1117 ')).toBe('#0d1117');
    expect(normalizeHexColor('0d1117')).toBe('#0d1117');
    expect(normalizeHexColor('#abc')).toBe('#aabbcc');
  });

  it('rejects anything that is not a hex colour', () => {
    for (const bad of ['red', '#12345', '#1234567', 'rgb(0,0,0)', '', 12, null, undefined, {}]) {
      expect(normalizeHexColor(bad)).toBeNull();
    }
  });
});

describe('validateTheme', () => {
  it('accepts the default theme and a solid colour, canonicalizing the colour', () => {
    expect(validateTheme(DEFAULT_THEME)).toEqual({ ok: true, theme: DEFAULT_THEME });
    expect(validateTheme({ version: 1, background: { mode: 'solid', color: '#0B1A2E' } }))
      .toEqual({ ok: true, theme: { version: 1, background: { mode: 'solid', color: '#0b1a2e' }, sidebarActivity: false, sidebarMetaTerm: false } });
  });

  it('rejects a missing or wrong version', () => {
    expect(validateTheme({ background: { mode: 'hyperspace' } })).toMatchObject({ ok: false, error: /version/ });
    expect(validateTheme({ version: 2, background: { mode: 'hyperspace' } })).toMatchObject({ ok: false, error: /version/ });
  });

  it('rejects unknown modes, bad colours and a colour on the starfield', () => {
    expect(validateTheme({ version: 1, background: { mode: 'plaid' } })).toMatchObject({ ok: false, error: /mode/ });
    expect(validateTheme({ version: 1, background: { mode: 'solid', color: 'red' } })).toMatchObject({ ok: false, error: /color/ });
    expect(validateTheme({ version: 1, background: { mode: 'solid' } })).toMatchObject({ ok: false, error: /color/ });
    expect(validateTheme({ version: 1, background: { mode: 'hyperspace', color: '#000000' } }))
      .toMatchObject({ ok: false, error: /only valid/ });
  });

  it('rejects unknown keys at both levels', () => {
    expect(validateTheme({ version: 1, background: { mode: 'hyperspace' }, palette: {} }))
      .toMatchObject({ ok: false, error: /unknown keys: palette/ });
    expect(validateTheme({ version: 1, background: { mode: 'hyperspace', opacity: 1 } }))
      .toMatchObject({ ok: false, error: /unknown keys: opacity/ });
  });

  it('keeps sidebarActivity, defaulting it off when absent, and rejects a non-boolean', () => {
    expect(validateTheme({ version: 1, background: { mode: 'hyperspace' }, sidebarActivity: true }))
      .toEqual({ ok: true, theme: { ...DEFAULT_THEME, sidebarActivity: true } });
    expect(validateTheme({ version: 1, background: { mode: 'hyperspace' } })).toEqual({ ok: true, theme: DEFAULT_THEME });
    expect(validateTheme({ version: 1, background: { mode: 'hyperspace' }, sidebarActivity: 'yes' }))
      .toMatchObject({ ok: false, error: /sidebarActivity/ });
  });

  it('keeps sidebarMetaTerm, defaulting it off when absent, and rejects a non-boolean', () => {
    expect(DEFAULT_THEME.sidebarMetaTerm).toBe(false);
    expect(validateTheme({ version: 1, background: { mode: 'hyperspace' }, sidebarMetaTerm: true }))
      .toEqual({ ok: true, theme: { ...DEFAULT_THEME, sidebarMetaTerm: true } });
    expect(validateTheme({ version: 1, background: { mode: 'hyperspace' }, sidebarMetaTerm: 1 }))
      .toMatchObject({ ok: false, error: /sidebarMetaTerm/ });
  });

  it('rejects non-objects', () => {
    for (const bad of [null, undefined, 'hyperspace', 1, [], true]) {
      expect(validateTheme(bad)).toMatchObject({ ok: false });
    }
  });
});

describe('normalizeTheme', () => {
  it('turns an empty or missing row into the default', () => {
    for (const stored of [{}, null, undefined, 'nope', 7, []]) {
      expect(normalizeTheme(stored)).toEqual(DEFAULT_THEME);
    }
  });

  it('keeps a valid background and canonicalizes its colour', () => {
    expect(normalizeTheme({ version: 1, background: { mode: 'solid', color: '#ABCDEF' } }))
      .toEqual({ version: 1, background: { mode: 'solid', color: '#abcdef' }, sidebarActivity: false, sidebarMetaTerm: false });
  });

  it('falls back to the default background when the stored one is unreadable', () => {
    expect(normalizeTheme({ version: 1, background: { mode: 'solid', color: 'red' } })).toEqual(DEFAULT_THEME);
    expect(normalizeTheme({ version: 1, background: 'solid' })).toEqual(DEFAULT_THEME);
  });

  it('ignores the stored version and unknown keys', () => {
    expect(normalizeTheme({ version: 99, background: { mode: 'solid', color: '#000000' }, future: true }))
      .toEqual({ version: 1, background: { mode: 'solid', color: '#000000' }, sidebarActivity: false, sidebarMetaTerm: false });
  });

  it('shows the sidebar activity only when it was stored as true', () => {
    expect(normalizeTheme({ version: 1, background: { mode: 'hyperspace' }, sidebarActivity: true }).sidebarActivity).toBe(true);
    expect(normalizeTheme({ version: 1, background: { mode: 'hyperspace' }, sidebarActivity: 'true' }).sidebarActivity).toBe(false);
  });

  it('offers MetaTerm only to users who opted in', () => {
    expect(normalizeTheme({}).sidebarMetaTerm).toBe(false);
    expect(normalizeTheme({ version: 1, background: { mode: 'hyperspace' }, sidebarMetaTerm: true }).sidebarMetaTerm).toBe(true);
    expect(normalizeTheme({ version: 1, background: { mode: 'hyperspace' }, sidebarMetaTerm: 'true' }).sidebarMetaTerm).toBe(false);
  });
});
