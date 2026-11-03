import { describe, expect, it } from 'vitest';
import { boxHue, boxStripeColor } from './boxColor';

describe('boxStripeColor', () => {
  it('is null for a project with no box', () => {
    expect(boxStripeColor(null)).toBeNull();
    expect(boxStripeColor(undefined)).toBeNull();
    expect(boxStripeColor('')).toBeNull();
  });

  it('is the box\'s hue at the palette\'s saturation and lightness, the same on every call', () => {
    const id = 'cmvxbiimksywertch4cm8ddyo';
    expect(boxStripeColor(id)).toBe(`hsl(${boxHue(id)}, var(--box-saturation), var(--box-lightness))`);
    expect(boxStripeColor(id)).toBe(boxStripeColor(id));
  });

  it('keeps the hue it always had', () => {
    // 'a' is 97, 'ab' is 97 * 31 + 98.
    expect(boxHue('a')).toBe(97);
    expect(boxHue('ab')).toBe((97 * 31 + 98) % 360);
  });
});
