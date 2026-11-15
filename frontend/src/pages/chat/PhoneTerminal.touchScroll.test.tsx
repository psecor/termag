// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalHandle } from '../../components/Terminal';
import { TMUX_WHEEL_LINES } from '../../utils/touchScroll';

vi.mock('../../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));

/** The mocked pane's scroll state, and what a drag asked of it. */
const pane = vi.hoisted(() => ({
  target: 'wheel' as 'select' | 'wheel' | 'buffer',
  lineHeight: 20,
  scrolled: [] as number[],
  wheels: [] as { count: number; x: number; y: number }[],
  /** touchmoves that reached xterm's own element. */
  xtermMoves: 0,
}));

vi.mock('../../components/Terminal', async () => {
  const { useEffect, useRef } = await vi.importActual<typeof import('react')>('react');
  return {
    Terminal: (p: { onReady?: (h: TerminalHandle | null) => void }) => {
      const el = useRef<HTMLDivElement>(null);
      useEffect(() => {
        const count = () => { pane.xtermMoves++; };
        el.current!.addEventListener('touchmove', count);
        p.onReady?.({
          send: () => {},
          focus: () => {},
          isFocused: () => false,
          appCursor: () => false,
          scrollTarget: () => pane.target,
          lineHeight: () => pane.lineHeight,
          scrollLines: n => { pane.scrolled.push(n); },
          wheel: (count, x, y) => { pane.wheels.push({ count, x, y }); },
        });
        return () => p.onReady?.(null);
      }, []);
      return <div className="xterm" data-testid="terminal" ref={el}><div className="xterm-rows"><div data-testid="row">row</div></div></div>;
    },
  };
});

import { PhoneTerminal } from './TerminalKeyBar';

let root: Root;
let host: HTMLElement;
let clock = 0;
let frames: FrameRequestCallback[] = [];

const stubPointer = (coarse: boolean) => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({ matches: coarse && q === '(pointer: coarse)', media: q, addEventListener() {}, removeEventListener() {} }),
  });
};

const render = () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<PhoneTerminal sessionName="ada-sample-ctrl" projectId="p1" workstream="main" />));
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(pane, { target: 'wheel', lineHeight: 20, scrolled: [], wheels: [], xtermMoves: 0 });
  clock = 0;
  frames = [];
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', () => { frames = []; });
  stubPointer(true);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A row of xterm's, which is what a finger lands on. */
const row = () => host.querySelector<HTMLElement>('[data-testid="row"]')!;

/** A touch event on xterm's element, as a phone sends it (jsdom has no Touch). */
const touch = (type: string, points: { x: number; y: number }[], on: HTMLElement = row()) => {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  const list = points.map(p => ({ clientX: p.x, clientY: p.y }));
  Object.defineProperty(ev, 'touches', { value: type === 'touchend' ? [] : list });
  act(() => { on.dispatchEvent(ev); });
  return ev;
};

/** A drag from (x, y0) to (x, y1) in 10 px steps, 10 ms apart; resolves to the moves' events. */
const drag = (x: number, y0: number, y1: number, opts: { lift?: boolean } = {}) => {
  touch('touchstart', [{ x, y: y0 }]);
  const moves: Event[] = [];
  const step = y1 > y0 ? 10 : -10;
  for (let y = y0 + step; step > 0 ? y <= y1 : y >= y1; y += step) {
    clock += 10;
    moves.push(touch('touchmove', [{ x, y }]));
  }
  if (opts.lift !== false) touch('touchend', []);
  return moves;
};

const runFrames = (n: number) => {
  for (let i = 0; i < n && frames.length; i++) {
    const cb = frames.shift()!;
    clock += 16;
    act(() => cb(clock));
  }
};

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('PhoneTerminal touch scrolling', () => {
  it('with tmux mouse on, a drag down sends wheel-ups at the finger, one per five lines', () => {
    render();
    // 200 px down = 10 lines of 20 px = 2 wheel reports of 5 lines.
    const moves = drag(60, 100, 300, { lift: false });
    expect(sum(pane.wheels.map(w => w.count))).toBe(-10 / TMUX_WHEEL_LINES);
    expect(pane.wheels.every(w => w.x === 60 && w.y === 100)).toBe(true);
    expect(pane.scrolled).toEqual([]);
    // Claimed moves are cancelled, so the page doesn't pan, and xterm never scrolls them again.
    expect(moves.slice(-1)[0].defaultPrevented).toBe(true);
    expect(pane.xtermMoves).toBe(0);
  });

  it('keeps scrolling after a redraw replaces the row the finger started on', () => {
    // xterm's DOM renderer swaps its row elements when tmux redraws; the
    // touch's events still go to the old, detached row, and reach no ancestor.
    render();
    const old = row();
    touch('touchstart', [{ x: 60, y: 100 }], old);
    act(() => { old.remove(); });
    for (let y = 110; y <= 300; y += 10) { clock += 10; touch('touchmove', [{ x: 60, y }], old); }
    expect(sum(pane.wheels.map(w => w.count))).toBe(-2);
    for (let y = 310; y <= 500; y += 10) { clock += 10; touch('touchmove', [{ x: 60, y }], old); }
    expect(sum(pane.wheels.map(w => w.count))).toBe(-4);
    touch('touchend', [], old);
    // The listeners went with the touch: a stray move later does nothing.
    touch('touchmove', [{ x: 60, y: 900 }], old);
    expect(sum(pane.wheels.map(w => w.count))).toBe(-4);
  });

  it('a drag up sends wheel-downs', () => {
    render();
    drag(60, 300, 100, { lift: false });
    expect(sum(pane.wheels.map(w => w.count))).toBe(2);
  });

  it('without mouse reports, a drag scrolls xterm\'s own buffer a line at a time', () => {
    pane.target = 'buffer';
    render();
    drag(60, 100, 300, { lift: false });
    expect(sum(pane.scrolled)).toBe(-10);
    expect(pane.wheels).toEqual([]);
  });

  it('a tap is never claimed, so tapping still focuses the pane', () => {
    render();
    touch('touchstart', [{ x: 60, y: 100 }]);
    const move = touch('touchmove', [{ x: 62, y: 104 }]);
    touch('touchend', []);
    expect(move.defaultPrevented).toBe(false);
    expect(pane.xtermMoves).toBe(1);
    expect(pane.wheels).toEqual([]);
    expect(frames).toEqual([]);
  });

  it('a sideways drag is left alone', () => {
    render();
    touch('touchstart', [{ x: 60, y: 100 }]);
    const move = touch('touchmove', [{ x: 120, y: 110 }]);
    expect(move.defaultPrevented).toBe(false);
    expect(pane.wheels).toEqual([]);
  });

  it('in select mode the drag is xterm\'s, so selecting stays opt-in', () => {
    pane.target = 'select';
    render();
    const moves = drag(60, 100, 300);
    expect(moves.some(m => m.defaultPrevented)).toBe(false);
    expect(pane.xtermMoves).toBe(moves.length);
    expect(pane.wheels).toEqual([]);
    expect(pane.scrolled).toEqual([]);
  });

  it('two fingers are not a scroll', () => {
    render();
    touch('touchstart', [{ x: 60, y: 100 }, { x: 160, y: 100 }]);
    const move = touch('touchmove', [{ x: 60, y: 200 }, { x: 160, y: 200 }]);
    expect(move.defaultPrevented).toBe(false);
    expect(pane.wheels).toEqual([]);
  });

  it('a quick release flings on, slows down and stops', () => {
    pane.target = 'buffer';
    render();
    drag(60, 100, 300); // 1 px/ms at release
    const dragged = sum(pane.scrolled);
    expect(frames.length).toBe(1);
    runFrames(500);
    expect(frames).toEqual([]);
    expect(sum(pane.scrolled)).toBeLessThan(dragged - 5);
  });

  it('touching again stops a fling', () => {
    pane.target = 'buffer';
    render();
    drag(60, 100, 300);
    runFrames(2);
    touch('touchstart', [{ x: 60, y: 100 }]);
    expect(frames).toEqual([]);
  });

  it('a finger that rested before lifting doesn\'t fling', () => {
    pane.target = 'buffer';
    render();
    drag(60, 100, 300, { lift: false });
    clock += 300;
    touch('touchend', []);
    expect(frames).toEqual([]);
  });

  it('a fine pointer (a desktop at a phone width) is unchanged', () => {
    stubPointer(false);
    render();
    const moves = drag(60, 100, 300);
    expect(moves.some(m => m.defaultPrevented)).toBe(false);
    expect(pane.wheels).toEqual([]);
    expect(pane.xtermMoves).toBe(moves.length);
    expect(host.querySelector('[data-touch-scroll]')).toBeNull();
  });

  it('marks the pane for touch-action on a touch screen', () => {
    render();
    expect(host.querySelector('.chat-term-phone-pane')!.hasAttribute('data-touch-scroll')).toBe(true);
  });
});
