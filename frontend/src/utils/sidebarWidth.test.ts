import { describe, expect, it } from 'vitest';
import { SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_KEY, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN, clampSidebarWidth, effectiveSidebarWidth, readSidebarWidth, writeSidebarWidth } from './sidebarWidth';

const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m }; };

describe('sidebar width', () => {
  it('clamps to the range and rounds; a non-number is the default', () => {
    expect(clampSidebarWidth(100)).toBe(SIDEBAR_WIDTH_MIN);
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_WIDTH_MAX);
    expect(clampSidebarWidth(300.6)).toBe(301);
    expect(clampSidebarWidth(NaN)).toBe(SIDEBAR_WIDTH_DEFAULT);
  });
  it('reads the stored width clamped, the default when absent, junk or without storage', () => {
    const s = memory();
    expect(readSidebarWidth(s)).toBe(SIDEBAR_WIDTH_DEFAULT);
    s.setItem(SIDEBAR_WIDTH_KEY, '320'); expect(readSidebarWidth(s)).toBe(320);
    s.setItem(SIDEBAR_WIDTH_KEY, '50'); expect(readSidebarWidth(s)).toBe(SIDEBAR_WIDTH_MIN);
    s.setItem(SIDEBAR_WIDTH_KEY, 'wide'); expect(readSidebarWidth(s)).toBe(SIDEBAR_WIDTH_DEFAULT);
    expect(readSidebarWidth(null)).toBe(SIDEBAR_WIDTH_DEFAULT);
  });
  it('caps the saved width so the terminals keep room on a narrow viewport, never below the minimum', () => {
    expect(effectiveSidebarWidth(480, 1600)).toBe(480);
    expect(effectiveSidebarWidth(480, 700)).toBe(380);
    expect(effectiveSidebarWidth(480, 400)).toBe(SIDEBAR_WIDTH_MIN);
    expect(effectiveSidebarWidth(200, 400)).toBe(SIDEBAR_WIDTH_MIN);
    expect(effectiveSidebarWidth(200, 1600)).toBe(200);
  });
  it('writes the clamped width and swallows a storage that throws', () => {
    const s = memory();
    writeSidebarWidth(s, 1000); expect(s.m.get(SIDEBAR_WIDTH_KEY)).toBe(String(SIDEBAR_WIDTH_MAX));
    expect(() => writeSidebarWidth({ getItem: () => null, setItem: () => { throw new Error('quota'); } }, 300)).not.toThrow();
  });
});
