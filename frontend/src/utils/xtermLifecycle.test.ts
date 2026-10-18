// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Terminal } from 'xterm';
import { guardViewportAfterDispose, hasLayoutSize } from './xtermLifecycle';

// jsdom has no matchMedia; xterm's DPR monitor asks for one on open().
beforeEach(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

type ViewportShape = { syncScrollArea: () => void; _innerRefresh: () => void };
const viewportOf = (term: Terminal) =>
  (term as unknown as { _core: { viewport: ViewportShape } })._core.viewport;

function openTerminal(): Terminal {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const term = new Terminal();
  term.open(el);
  return term;
}

describe('guardViewportAfterDispose', () => {
  const fakeTimers = () =>
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] });

  it('reproduces the production crash without the guard', () => {
    fakeTimers();
    const term = openTerminal();
    // A live sync (what every write/scroll does) records the buffer length, so
    // the setTimeout(syncScrollArea) that open() queued goes on to read the
    // renderer's dimensions when it fires, which is after the dispose.
    viewportOf(term).syncScrollArea();
    term.dispose();
    expect(() => vi.runAllTimers()).toThrow(/reading 'dimensions'/);
  });

  it('turns post-dispose viewport refreshes into no-ops', () => {
    const term = openTerminal();
    guardViewportAfterDispose(term);
    const viewport = viewportOf(term);
    viewport.syncScrollArea();
    term.dispose();
    expect(() => viewport.syncScrollArea()).not.toThrow();
    expect(() => viewport._innerRefresh()).not.toThrow();
  });

  it('lets the timers xterm queued before dispose fire harmlessly', () => {
    fakeTimers();
    const term = openTerminal();
    guardViewportAfterDispose(term);
    // Same sequence as the repro above, plus a reset's queued frame.
    viewportOf(term).syncScrollArea();
    term.reset();
    term.dispose();
    expect(() => vi.runAllTimers()).not.toThrow();
  });

  it('leaves a live terminal refreshing normally', () => {
    const term = openTerminal();
    const viewport = viewportOf(term);
    const before = viewport.syncScrollArea;
    guardViewportAfterDispose(term);
    expect(viewport.syncScrollArea).not.toBe(before);
    expect(() => viewport.syncScrollArea()).not.toThrow();
    term.dispose();
  });

  it('is a no-op on a terminal that was never opened', () => {
    const term = new Terminal();
    expect(() => guardViewportAfterDispose(term)).not.toThrow();
    term.dispose();
  });
});

describe('hasLayoutSize', () => {
  const sized = (w: number, h: number) => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'clientWidth', { value: w });
    Object.defineProperty(el, 'clientHeight', { value: h });
    return el;
  };
  it('is false while either side is zero', () => {
    expect(hasLayoutSize(sized(0, 0))).toBe(false);
    expect(hasLayoutSize(sized(800, 0))).toBe(false);
    expect(hasLayoutSize(sized(0, 600))).toBe(false);
  });
  it('is true once the container is laid out', () => {
    expect(hasLayoutSize(sized(800, 600))).toBe(true);
  });
});
