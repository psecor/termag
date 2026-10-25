// A space's colour in the simple UI: the swatch beside its name in the
// sidebar's group head, the stripe down its group, the space picker and the
// session header's chip. Derived, not stored: each name hashes to a preferred
// colour, and among the user's spaces, oldest first, a space whose colour is
// taken gets the next free one (spacePalette). So a space keeps its colour
// across reloads and devices, a new space never repaints an older one, two
// of a user's first nine spaces never share a colour, and a new space shows
// the colour it will get while its name is typed. Two people who share a
// space see the same colour unless one of them has a clash the other lacks.
//
// Every colour is a mid-tone with at least 3:1 contrast (WCAG 1.4.11, for
// graphics) against every surface it sits on, dark (App.css --bg-*) and
// light (white, #f6f8fa), so the same swatch reads in either theme. Text
// beside a swatch stays the theme's text colour; the swatch never carries text.
// Red is left out: it is the fault colour.
import type { CSSProperties } from 'react';

export interface SpaceColor { key: string; hex: string }

export const SPACE_COLORS: readonly SpaceColor[] = [
  { key: 'blue', hex: '#3086e8' },
  { key: 'teal', hex: '#1a9691' },
  { key: 'green', hex: '#2c9850' },
  { key: 'lime', hex: '#659325' },
  { key: 'amber', hex: '#af7e0e' },
  { key: 'orange', hex: '#db6212' },
  { key: 'pink', hex: '#e04f98' },
  { key: 'purple', hex: '#b366d9' },
  { key: 'indigo', hex: '#8279e7' },
];

/** FNV-1a, 32-bit: stable across browsers and releases, unlike anything seeded. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function preferred(name: string): number {
  return hash(name) % SPACE_COLORS.length;
}

/** From `start` round the palette, the first colour used the fewest times. */
function leastUsed(start: number, uses: readonly number[]): number {
  const fewest = Math.min(...uses);
  for (let i = 0; i < uses.length; i++) {
    const at = (start + i) % uses.length;
    if (uses[at] === fewest) return at;
  }
  return start;
}

export type SpaceColorOf = (name: string) => SpaceColor;

/** A space's colour by its name alone, for when the user's spaces are not known. */
export const spaceColor: SpaceColorOf = name => SPACE_COLORS[preferred(name.trim())];

/**
 * The colours of the user's spaces, oldest first (then by name), each its
 * preferred colour unless an older space has it. A name not in `spaces` (a
 * new space being named) gets the colour it would get as the newest.
 */
export function spacePalette(spaces: ReadonlyArray<{ name: string; createdAt?: string | null }>): SpaceColorOf {
  const ordered = [...spaces].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.name.localeCompare(b.name));
  const uses = SPACE_COLORS.map(() => 0);
  const assigned = new Map<string, SpaceColor>();
  for (const { name } of ordered) {
    if (assigned.has(name)) continue;
    const at = leastUsed(preferred(name), uses);
    uses[at]++;
    assigned.set(name, SPACE_COLORS[at]);
  }
  return name => {
    const n = name.trim();
    return assigned.get(n) ?? SPACE_COLORS[leastUsed(preferred(n), uses)];
  };
}

/** The inline style that hands a space's colour to the CSS (`--space-color`), or none for no space. */
export function spaceColorStyle(name: string | null | undefined, colorOf: SpaceColorOf = spaceColor): CSSProperties | undefined {
  const n = name?.trim();
  return n ? ({ '--space-color': colorOf(n).hex } as CSSProperties) : undefined;
}
