import { describe, expect, it } from 'vitest';
import {
  clampSidebarWidth, readSidebarWidth, sidebarWidthForKey, writeSidebarWidth,
  SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, SIDEBAR_WIDTH_KEY,
} from './sidebarWidth';

function memory(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, map };
}

describe('sidebar width', () => {
  it('stays between the floor and the ceiling, in whole pixels', () => {
    expect(clampSidebarWidth(10)).toBe(SIDEBAR_MIN);
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX);
    expect(clampSidebarWidth(300.6)).toBe(301);
  });

  it('reads the kept width, clamped, and the default for nothing or garbage', () => {
    expect(readSidebarWidth(memory({ [SIDEBAR_WIDTH_KEY]: '320' }))).toBe(320);
    expect(readSidebarWidth(memory({ [SIDEBAR_WIDTH_KEY]: '5000' }))).toBe(SIDEBAR_MAX);
    expect(readSidebarWidth(memory({ [SIDEBAR_WIDTH_KEY]: 'wide' }))).toBe(SIDEBAR_DEFAULT);
    expect(readSidebarWidth(memory({ [SIDEBAR_WIDTH_KEY]: '0' }))).toBe(SIDEBAR_DEFAULT);
    expect(readSidebarWidth(memory())).toBe(SIDEBAR_DEFAULT);
    expect(readSidebarWidth(null)).toBe(SIDEBAR_DEFAULT);
    expect(readSidebarWidth({ getItem: () => { throw new Error('blocked'); } })).toBe(SIDEBAR_DEFAULT);
  });

  it('keeps a width, clamped, and shrugs off storage that refuses it', () => {
    const s = memory();
    writeSidebarWidth(s, 700);
    expect(s.map.get(SIDEBAR_WIDTH_KEY)).toBe(String(SIDEBAR_MAX));
    expect(() => writeSidebarWidth({ setItem: () => { throw new Error('full'); } }, 300)).not.toThrow();
  });

  it('steps with the arrow keys, further with Shift, and jumps with Home, End and Enter', () => {
    expect(sidebarWidthForKey(300, 'ArrowRight', false)).toBe(316);
    expect(sidebarWidthForKey(300, 'ArrowLeft', true)).toBe(252);
    expect(sidebarWidthForKey(SIDEBAR_MIN, 'ArrowLeft', false)).toBe(SIDEBAR_MIN);
    expect(sidebarWidthForKey(300, 'Home', false)).toBe(SIDEBAR_MIN);
    expect(sidebarWidthForKey(300, 'End', false)).toBe(SIDEBAR_MAX);
    expect(sidebarWidthForKey(300, 'Enter', false)).toBe(SIDEBAR_DEFAULT);
    expect(sidebarWidthForKey(300, 'a', false)).toBeNull();
  });
});
