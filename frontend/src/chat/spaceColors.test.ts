import { describe, expect, it } from 'vitest';
import { SPACE_COLORS, spaceColor, spaceColorStyle, spacePalette } from './spaceColors';

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// App.css's dark surfaces, and the light surfaces a light theme would use.
const SURFACES = ['#0d1117', '#161b22', '#21262d', '#2d333b', '#ffffff', '#f6f8fa'];

const at = (name: string, createdAt: string) => ({ name, createdAt });

describe('SPACE_COLORS', () => {
  it('has distinct colours, each at least 3:1 against every dark and light surface', () => {
    expect(new Set(SPACE_COLORS.map(c => c.hex)).size).toBe(SPACE_COLORS.length);
    for (const { key, hex } of SPACE_COLORS) {
      for (const bg of SURFACES) expect(contrast(hex, bg), `${key} on ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('spaceColor', () => {
  it('is the same for the same name, ignoring surrounding whitespace', () => {
    expect(spaceColor('billing-api')).toEqual(spaceColor('billing-api'));
    expect(spaceColor(' billing-api ')).toEqual(spaceColor('billing-api'));
  });

  it('spreads names over the palette', () => {
    const used = new Set(Array.from({ length: 200 }, (_, i) => spaceColor(`space-${i}`).key));
    expect(used.size).toBe(SPACE_COLORS.length);
  });
});

describe('spacePalette', () => {
  it('gives each space its preferred colour when nothing clashes', () => {
    const colorOf = spacePalette([at('billing-api', '2026-01-01')]);
    expect(colorOf('billing-api')).toEqual(spaceColor('billing-api'));
  });

  it('moves a newer space off an older one\'s colour, and never the older one', () => {
    const names = Array.from({ length: 60 }, (_, i) => `s-${i}`);
    const older = names[0];
    const clash = names.find(n => n !== older && spaceColor(n).key === spaceColor(older).key)!;
    const colorOf = spacePalette([at(clash, '2026-02-01'), at(older, '2026-01-01')]);
    expect(colorOf(older)).toEqual(spaceColor(older));
    expect(colorOf(clash).key).not.toBe(colorOf(older).key);
  });

  it('gives the first nine spaces nine colours, then reuses the least used', () => {
    const spaces = Array.from({ length: SPACE_COLORS.length + 1 }, (_, i) => at(`team-${i}`, `2026-01-${String(i + 10)}`));
    const colorOf = spacePalette(spaces);
    const first = spaces.slice(0, SPACE_COLORS.length).map(s => colorOf(s.name).key);
    expect(new Set(first).size).toBe(SPACE_COLORS.length);
  });

  it('does not repaint existing spaces when a newer one is added', () => {
    const before = [at('alpha', '2026-01-01'), at('beta', '2026-01-02'), at('gamma', '2026-01-03')];
    const colorOf = spacePalette(before);
    const after = spacePalette([...before, at('delta', '2026-01-04')]);
    for (const { name } of before) expect(after(name)).toEqual(colorOf(name));
  });

  it('tells a new space the colour it will get once created', () => {
    const before = [at('alpha', '2026-01-01'), at('beta', '2026-01-02')];
    const preview = spacePalette(before)('new-one');
    expect(spacePalette([...before, at('new-one', '2026-01-05')])('new-one')).toEqual(preview);
  });
});

describe('spaceColorStyle', () => {
  it('hands the colour to the CSS, and nothing for no space', () => {
    expect(spaceColorStyle('billing-api')).toEqual({ '--space-color': spaceColor('billing-api').hex });
    expect(spaceColorStyle(null)).toBeUndefined();
    expect(spaceColorStyle('  ')).toBeUndefined();
    const colorOf = () => SPACE_COLORS[0];
    expect(spaceColorStyle('x', colorOf)).toEqual({ '--space-color': SPACE_COLORS[0].hex });
  });
});
