import { describe, expect, it } from 'vitest';
import { documentPalette, terminalTheme } from './terminalTheme';

// The dark :root tokens, as getComputedStyle reads them on .terminal-island in either palette.
const DARK_TOKENS: Record<string, string> = {
  '--bg-base': '#0d1117',
  '--text-primary': '#c9d1d9',
  '--accent': '#58a6ff',
  '--terminal-selection': '#264f7880',
};
const css = (map: Record<string, string>) => ({ getPropertyValue: (name: string) => map[name] ?? '' });

describe('terminalTheme', () => {
  it('draws dark exactly as before: the base at c0 so the starfield shows', () => {
    expect(terminalTheme(css(DARK_TOKENS), 'dark')).toEqual({
      background: '#0d1117c0',
      foreground: '#c9d1d9',
      cursor: '#58a6ff',
      selectionBackground: '#264f7880',
    });
  });

  it('draws light with the same dark colours, the background opaque', () => {
    expect(terminalTheme(css(DARK_TOKENS), 'light')).toEqual({
      background: '#0d1117ff',
      foreground: '#c9d1d9',
      cursor: '#58a6ff',
      selectionBackground: '#264f7880',
    });
  });

  it('takes a base that is not a 6-digit hex', () => {
    expect(terminalTheme(css({ ...DARK_TOKENS, '--bg-base': 'rgb(24, 26, 31)' }), 'dark').background).toBe('rgba(24, 26, 31, 0.753)');
  });

  it('falls back to the dark values with no tokens at all', () => {
    expect(terminalTheme(css({}), 'dark')).toEqual(terminalTheme(css(DARK_TOKENS), 'dark'));
  });
});

describe('documentPalette', () => {
  it('reads data-palette, absent as dark', () => {
    expect(documentPalette({ dataset: {} })).toBe('dark');
    expect(documentPalette({ dataset: { palette: 'light' } })).toBe('light');
  });
});
