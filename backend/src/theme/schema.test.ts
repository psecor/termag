import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, mergeStoredThemeKeys, normalizeHexColor, normalizeTheme, validateTheme } from './schema';

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
      .toEqual({ ok: true, theme: { version: 1, background: { mode: 'solid', color: '#0b1a2e' }, sidebarActivity: false, sidebarMetaTerm: false, sidebarShowStopped: false, sidebarAskChats: false, sidebarHideAskBoxes: false } });
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
    expect(validateTheme({ version: 1, background: { mode: 'hyperspace' }, fonts: {} }))
      .toMatchObject({ ok: false, error: /unknown keys: fonts/ });
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

  it('keeps sidebarAskChats, defaulting it off (ask chats hidden) when absent, and rejects a non-boolean', () => {
    expect(DEFAULT_THEME.sidebarAskChats).toBe(false);
    expect(validateTheme({ version: 1, background: { mode: 'hyperspace' }, sidebarAskChats: true }))
      .toEqual({ ok: true, theme: { ...DEFAULT_THEME, sidebarAskChats: true } });
    expect(validateTheme({ version: 1, background: { mode: 'hyperspace' }, sidebarAskChats: 'yes' }))
      .toMatchObject({ ok: false, error: /sidebarAskChats/ });
  });

  it('keeps sidebarShowStopped, defaulting it off (stopped boxes hidden) when absent, and rejects a non-boolean', () => {
    expect(DEFAULT_THEME.sidebarShowStopped).toBe(false);
    expect(validateTheme({ version: 1, background: { mode: 'hyperspace' }, sidebarShowStopped: true }))
      .toEqual({ ok: true, theme: { ...DEFAULT_THEME, sidebarShowStopped: true } });
    expect(validateTheme({ version: 1, background: { mode: 'hyperspace' } }))
      .toEqual({ ok: true, theme: DEFAULT_THEME });
    expect(validateTheme({ version: 1, background: { mode: 'hyperspace' }, sidebarShowStopped: 'yes' }))
      .toMatchObject({ ok: false, error: /sidebarShowStopped/ });
  });

  it('keeps sidebarHideAskBoxes, defaulting it off (ask boxes listed) when absent, and rejects a non-boolean', () => {
    expect(DEFAULT_THEME.sidebarHideAskBoxes).toBe(false);
    expect(validateTheme({ version: 1, background: { mode: 'hyperspace' }, sidebarHideAskBoxes: true }))
      .toEqual({ ok: true, theme: { ...DEFAULT_THEME, sidebarHideAskBoxes: true } });
    expect(validateTheme({ version: 1, background: { mode: 'hyperspace' } }))
      .toEqual({ ok: true, theme: DEFAULT_THEME });
    expect(validateTheme({ version: 1, background: { mode: 'hyperspace' }, sidebarHideAskBoxes: 'yes' }))
      .toMatchObject({ ok: false, error: /sidebarHideAskBoxes/ });
  });

  it('keeps starfieldTurkeys only when on, so off is stored as absent, and rejects a non-boolean', () => {
    expect(DEFAULT_THEME.starfieldTurkeys).toBeUndefined();
    expect(validateTheme({ version: 1, background: { mode: 'hyperspace' }, starfieldTurkeys: true }))
      .toEqual({ ok: true, theme: { ...DEFAULT_THEME, starfieldTurkeys: true } });
    expect(validateTheme({ version: 1, background: { mode: 'hyperspace' }, starfieldTurkeys: false }))
      .toEqual({ ok: true, theme: DEFAULT_THEME });
    expect(validateTheme({ version: 1, background: { mode: 'hyperspace' }, starfieldTurkeys: 'yes' }))
      .toMatchObject({ ok: false, error: /starfieldTurkeys/ });
    expect(normalizeTheme({ starfieldTurkeys: true }).starfieldTurkeys).toBe(true);
    expect(normalizeTheme({ starfieldTurkeys: 'true' }).starfieldTurkeys).toBeUndefined();
  });

  it('keeps stored turkeys for a tab that does not send the key, and lets an explicit false clear them', () => {
    const stored = { ...DEFAULT_THEME, starfieldTurkeys: true };
    expect(mergeStoredThemeKeys({ version: 1, background: { mode: 'hyperspace' } }, stored))
      .toMatchObject({ starfieldTurkeys: true });
    expect(mergeStoredThemeKeys({ version: 1, background: { mode: 'hyperspace' }, starfieldTurkeys: false }, stored))
      .toMatchObject({ starfieldTurkeys: false });
  });

  it('keeps dailyTheme only when on, keeps it for a tab that does not send it, and rejects a non-boolean', () => {
    expect(DEFAULT_THEME.dailyTheme).toBeUndefined();
    expect(validateTheme({ version: 1, background: { mode: 'hyperspace' }, dailyTheme: true }))
      .toEqual({ ok: true, theme: { ...DEFAULT_THEME, dailyTheme: true } });
    expect(validateTheme({ version: 1, background: { mode: 'hyperspace' }, dailyTheme: false }))
      .toEqual({ ok: true, theme: DEFAULT_THEME });
    expect(validateTheme({ version: 1, background: { mode: 'hyperspace' }, dailyTheme: 1 }))
      .toMatchObject({ ok: false, error: /dailyTheme/ });
    expect(normalizeTheme({ dailyTheme: true }).dailyTheme).toBe(true);
    expect(normalizeTheme({ dailyTheme: 'true' }).dailyTheme).toBeUndefined();
    const stored = { ...DEFAULT_THEME, dailyTheme: true };
    expect(mergeStoredThemeKeys({ version: 1, background: { mode: 'hyperspace' } }, stored))
      .toMatchObject({ dailyTheme: true });
    expect(mergeStoredThemeKeys({ version: 1, background: { mode: 'hyperspace' }, dailyTheme: false }, stored))
      .toMatchObject({ dailyTheme: false });
  });

  it('keeps a light palette, stores dark as absent, and rejects anything else', () => {
    expect(DEFAULT_THEME.palette).toBeUndefined();
    expect(validateTheme({ ...DEFAULT_THEME, palette: 'light' })).toEqual({ ok: true, theme: { ...DEFAULT_THEME, palette: 'light' } });
    expect(validateTheme({ ...DEFAULT_THEME, palette: 'dark' })).toEqual({ ok: true, theme: DEFAULT_THEME });
    for (const bad of ['system', 'Light', true, null, {}]) {
      expect(validateTheme({ ...DEFAULT_THEME, palette: bad })).toMatchObject({ ok: false, error: /palette/ });
    }
  });

  it('keeps JetBrains Mono for terminals, stores Maple Mono as absent, and rejects anything else', () => {
    expect(DEFAULT_THEME.terminalFont).toBeUndefined();
    expect(validateTheme({ ...DEFAULT_THEME, terminalFont: 'jetbrains' }))
      .toEqual({ ok: true, theme: { ...DEFAULT_THEME, terminalFont: 'jetbrains' } });
    expect(validateTheme({ ...DEFAULT_THEME, terminalFont: 'maple' })).toEqual({ ok: true, theme: DEFAULT_THEME });
    for (const bad of ['jbmono', 'Maple', '', true, null, {}]) {
      expect(validateTheme({ ...DEFAULT_THEME, terminalFont: bad })).toMatchObject({ ok: false, error: /terminalFont/ });
    }
    expect(normalizeTheme({ terminalFont: 'jetbrains' }).terminalFont).toBe('jetbrains');
    for (const other of ['maple', 'jbmono', undefined, 1]) {
      expect(normalizeTheme({ terminalFont: other }).terminalFont).toBeUndefined();
    }
  });

  it('keeps a stored terminal font for a tab that does not send the key, and lets an explicit maple switch back', () => {
    const stored = { ...DEFAULT_THEME, terminalFont: 'jetbrains' };
    expect(mergeStoredThemeKeys({ version: 1, background: { mode: 'hyperspace' } }, stored))
      .toMatchObject({ terminalFont: 'jetbrains' });
    const back = mergeStoredThemeKeys({ ...DEFAULT_THEME, terminalFont: 'maple' }, stored);
    expect(back).toMatchObject({ terminalFont: 'maple' });
    expect(validateTheme(back)).toEqual({ ok: true, theme: DEFAULT_THEME });
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
      .toEqual({ version: 1, background: { mode: 'solid', color: '#abcdef' }, sidebarActivity: false, sidebarMetaTerm: false, sidebarShowStopped: false, sidebarAskChats: false, sidebarHideAskBoxes: false });
  });

  it('falls back to the default background when the stored one is unreadable', () => {
    expect(normalizeTheme({ version: 1, background: { mode: 'solid', color: 'red' } })).toEqual(DEFAULT_THEME);
    expect(normalizeTheme({ version: 1, background: 'solid' })).toEqual(DEFAULT_THEME);
  });

  it('ignores the stored version and unknown keys', () => {
    expect(normalizeTheme({ version: 99, background: { mode: 'solid', color: '#000000' }, future: true }))
      .toEqual({ version: 1, background: { mode: 'solid', color: '#000000' }, sidebarActivity: false, sidebarMetaTerm: false, sidebarShowStopped: false, sidebarAskChats: false, sidebarHideAskBoxes: false });
  });

  it('shows the sidebar activity only when it was stored as true', () => {
    expect(normalizeTheme({ version: 1, background: { mode: 'hyperspace' }, sidebarActivity: true }).sidebarActivity).toBe(true);
    expect(normalizeTheme({ version: 1, background: { mode: 'hyperspace' }, sidebarActivity: 'true' }).sidebarActivity).toBe(false);
  });

  it('shows ask chats only when that was stored as true', () => {
    expect(normalizeTheme({}).sidebarAskChats).toBe(false);
    expect(normalizeTheme({ version: 1, background: { mode: 'hyperspace' }, sidebarAskChats: true }).sidebarAskChats).toBe(true);
    expect(normalizeTheme({ version: 1, background: { mode: 'hyperspace' }, sidebarAskChats: 1 }).sidebarAskChats).toBe(false);
  });

  it('shows projects on stopped boxes only when that was stored as true', () => {
    expect(normalizeTheme({}).sidebarShowStopped).toBe(false);
    expect(normalizeTheme({ version: 1, background: { mode: 'hyperspace' }, sidebarShowStopped: true }).sidebarShowStopped).toBe(true);
    expect(normalizeTheme({ version: 1, background: { mode: 'hyperspace' }, sidebarShowStopped: 1 }).sidebarShowStopped).toBe(false);
  });

  it('hides ask boxes only when that was stored as true', () => {
    expect(normalizeTheme({}).sidebarHideAskBoxes).toBe(false);
    expect(normalizeTheme({ version: 1, background: { mode: 'hyperspace' }, sidebarHideAskBoxes: true }).sidebarHideAskBoxes).toBe(true);
    expect(normalizeTheme({ version: 1, background: { mode: 'hyperspace' }, sidebarHideAskBoxes: 'true' }).sidebarHideAskBoxes).toBe(false);
  });

  it('offers MetaTerm only to users who opted in', () => {
    expect(normalizeTheme({}).sidebarMetaTerm).toBe(false);
    expect(normalizeTheme({ version: 1, background: { mode: 'hyperspace' }, sidebarMetaTerm: true }).sidebarMetaTerm).toBe(true);
    expect(normalizeTheme({ version: 1, background: { mode: 'hyperspace' }, sidebarMetaTerm: 'true' }).sidebarMetaTerm).toBe(false);
  });
});

describe('normalizeTheme palette', () => {
  it('reads light back and anything else as dark (absent)', () => {
    expect(normalizeTheme({ version: 1, background: { mode: 'hyperspace' }, palette: 'light' }).palette).toBe('light');
    for (const other of ['dark', 'system', undefined, 1]) {
      expect(normalizeTheme({ version: 1, background: { mode: 'hyperspace' }, palette: other })).toEqual(DEFAULT_THEME);
    }
  });
});

describe('mergeStoredThemeKeys', () => {
  const stored = { version: 1, background: { mode: 'hyperspace' }, palette: 'light', sidebarActivity: true, sidebarMetaTerm: true };

  it('fills the optional keys a stale client left out from the stored theme', () => {
    expect(mergeStoredThemeKeys({ version: 1, background: { mode: 'solid', color: '#000000' } }, stored))
      .toEqual({ version: 1, background: { mode: 'solid', color: '#000000' }, palette: 'light', sidebarActivity: true, sidebarMetaTerm: true, sidebarShowStopped: false, sidebarAskChats: false, sidebarHideAskBoxes: false });
  });

  it('lets keys the client sent win, including an explicit dark', () => {
    expect(mergeStoredThemeKeys({ ...DEFAULT_THEME, palette: 'dark' }, stored))
      .toEqual({ ...DEFAULT_THEME, palette: 'dark' });
  });

  it('adds nothing for a palette stored as dark, and fills no required key', () => {
    expect(mergeStoredThemeKeys({ version: 1 }, {})).toEqual({ version: 1, sidebarActivity: false, sidebarMetaTerm: false, sidebarShowStopped: false, sidebarAskChats: false, sidebarHideAskBoxes: false });
  });

  it('passes non-objects and unknown keys through for the validator to reject', () => {
    expect(mergeStoredThemeKeys('nope', stored)).toBe('nope');
    expect(validateTheme(mergeStoredThemeKeys({ ...DEFAULT_THEME, fonts: {} }, stored))).toMatchObject({ ok: false, error: /unknown keys: fonts/ });
  });
});
