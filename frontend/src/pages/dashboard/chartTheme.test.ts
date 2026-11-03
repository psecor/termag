import { describe, expect, it } from 'vitest';
import { HUE, opaque, wash } from './chartTheme';
import { PROVIDERS, providerBadgeStyle, providerColor } from '../../providers/registry';
import { currentPalette } from '../../theme/usePalette';

describe('opaque and wash', () => {
  it('opaque drops a registry colour\'s alpha and passes a token through', () => {
    expect(opaque('rgba(31, 111, 235, 0.6)')).toBe('rgb(31, 111, 235)');
    expect(opaque(HUE.blue)).toBe('var(--series-blue)');
  });

  it('wash is a color-mix, so a var() series washes and follows the palette', () => {
    expect(wash(HUE.teal)).toBe('color-mix(in srgb, var(--series-teal) 12%, transparent)');
    expect(wash('rgba(31, 111, 235, 0.6)', 0.14)).toBe('color-mix(in srgb, rgb(31, 111, 235) 14%, transparent)');
    expect(wash('#3987e5')).toBe('color-mix(in srgb, #3987e5 12%, transparent)');
  });
});

describe('the palette a chart reads', () => {
  it('is light only for data-palette="light" (absent = dark)', () => {
    expect(currentPalette({ dataset: { palette: 'light' } })).toBe('light');
    expect(currentPalette({ dataset: {} })).toBe('dark');
    expect(currentPalette(null)).toBe('dark');
  });

  it('picks the registry pair for it', () => {
    expect(providerColor(PROVIDERS.human, 'dark')).toBe(PROVIDERS.human.color);
    expect(providerColor(PROVIDERS.human, 'light')).toBe(PROVIDERS.human.lightColor);
    expect(providerBadgeStyle(PROVIDERS.claude, 'dark')).toEqual({
      borderColor: 'rgba(88, 166, 255, 0.45)', background: 'rgba(31, 111, 235, 0.16)',
    });
  });
});
