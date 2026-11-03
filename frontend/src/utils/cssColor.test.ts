import { describe, expect, it } from 'vitest';
import { withAlpha } from './cssColor';

describe('withAlpha', () => {
  it("appends the alpha's hex digits to a six-digit hex, as the terminal always has", () => {
    expect(withAlpha('#0d1117', 0xc0)).toBe('#0d1117c0');
    expect(withAlpha(' #0D1117 ', 0xc0)).toBe('#0D1117c0');
  });

  it('widens a short hex and replaces a hex alpha that is already there', () => {
    expect(withAlpha('#abc', 0x80)).toBe('#aabbcc80');
    expect(withAlpha('#abcd', 0x80)).toBe('#aabbcc80');
    expect(withAlpha('#0d1117ff', 0x40)).toBe('#0d111740');
  });

  it('turns rgb() and rgba(), commas or spaces, into rgba() with the new alpha', () => {
    expect(withAlpha('rgb(24, 26, 31)', 0xc0)).toBe('rgba(24, 26, 31, 0.753)');
    expect(withAlpha('rgba(24, 26, 31, 0.5)', 0xff)).toBe('rgba(24, 26, 31, 1)');
    expect(withAlpha('rgb(24 26 31 / 50%)', 0)).toBe('rgba(24, 26, 31, 0)');
    expect(withAlpha('rgb(100%, 0%, 50%)', 0xc0)).toBe('rgba(255, 0, 128, 0.753)');
  });

  it('leaves anything else as it is, opaque rather than broken', () => {
    expect(withAlpha('color-mix(in srgb, red 50%, blue)', 0xc0)).toBe('color-mix(in srgb, red 50%, blue)');
    expect(withAlpha('transparent', 0xc0)).toBe('transparent');
  });
});
