// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DailyDecor, TOUCH_ANY_QUERY, clampOpacity } from './DailyDecor';
import { SPRITE_MESSAGE } from './spriteFrame';
import { MAX_DECOR_OPACITY } from './types';

let root: Root;
let el: HTMLDivElement;
const frame = () => el.querySelector('iframe');
const source = 'export default { create: () => ({ draw() {} }) };';
const fromFrame = (data: unknown, src: unknown = frame()!.contentWindow) =>
  act(() => { window.dispatchEvent(new MessageEvent('message', { data, source: src as Window })); });

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); vi.restoreAllMocks(); });

describe('DailyDecor', () => {
  it('runs the sprite in a sandboxed frame with scripts only, takes no clicks and is hidden from screen readers', () => {
    act(() => root.render(<DailyDecor source={source} />));
    const f = frame()!;
    expect(f.getAttribute('sandbox')).toBe('allow-scripts');
    expect(f.getAttribute('srcdoc')).toContain('window.__dailySprite');
    expect(f.style.pointerEvents).toBe('none');
    expect(f.getAttribute('aria-hidden')).toBe('true');
    expect(f.tabIndex).toBe(-1);
    expect(f.style.opacity).toBe('0');
  });

  it("shows the frame at the sprite's opacity once it is ready, capped", () => {
    act(() => root.render(<DailyDecor source={source} />));
    fromFrame({ source: SPRITE_MESSAGE, type: 'ready', opacity: 1 });
    expect(Number(frame()!.style.opacity)).toBe(MAX_DECOR_OPACITY);
    expect(clampOpacity(null)).toBe(0.6);
    expect(clampOpacity(-1)).toBe(0);
  });

  it('removes the frame when the sprite stops, and ignores messages from any other window', () => {
    act(() => root.render(<DailyDecor source={source} />));
    fromFrame({ source: SPRITE_MESSAGE, type: 'stopped', why: 'x' }, window);
    expect(frame()).not.toBeNull();
    fromFrame({ source: SPRITE_MESSAGE, type: 'stopped', why: 'draw threw' });
    expect(frame()).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/sprite stopped: draw threw/));
  });

  it('draws no frame on a touch screen, where it would stop iOS scrolling the page under it, and follows a pointer change', () => {
    let coarse = true;
    const listeners = new Set<(e: MediaQueryListEvent) => void>();
    vi.stubGlobal('matchMedia', (query: string) => ({
      get matches() { return query === TOUCH_ANY_QUERY && coarse; },
      media: query,
      addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => { if (query === TOUCH_ANY_QUERY) listeners.add(fn); },
      removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.delete(fn),
    }));
    try {
      act(() => root.render(<DailyDecor source={source} />));
      expect(frame()).toBeNull();
      coarse = false;
      act(() => listeners.forEach(fn => fn({ matches: false } as MediaQueryListEvent)));
      expect(frame()).not.toBeNull();
      coarse = true;
      act(() => listeners.forEach(fn => fn({ matches: true } as MediaQueryListEvent)));
      expect(frame()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
