import { describe, expect, it, vi } from 'vitest';
import { applyTheme, BACKDROP_VAR, themeCssVariables } from './apply';
import { BASE_BACKGROUND_COLOR, DEFAULT_THEME } from './schema';

describe('themeCssVariables', () => {
  it('paints the base colour behind the starfield, so the canvas fade and the backdrop agree', () => {
    expect(themeCssVariables(DEFAULT_THEME)).toEqual({ [BACKDROP_VAR]: BASE_BACKGROUND_COLOR });
  });

  it('paints the chosen colour for a solid background', () => {
    expect(themeCssVariables({ ...DEFAULT_THEME, background: { mode: 'solid', color: '#0b1a2e' } }))
      .toEqual({ [BACKDROP_VAR]: '#0b1a2e' });
  });
});

describe('applyTheme', () => {
  it('sets every variable on the given root', () => {
    const setProperty = vi.fn();
    applyTheme({ ...DEFAULT_THEME, background: { mode: 'solid', color: '#000000' } }, { style: { setProperty } });
    expect(setProperty).toHaveBeenCalledWith(BACKDROP_VAR, '#000000');
  });
});
