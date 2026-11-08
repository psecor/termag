// @vitest-environment jsdom
import React, { act, useRef } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useVisualViewport, viewportVarNames } from './useVisualViewport';

/** A stand-in for window.visualViewport that a test can shrink, as a keyboard does. */
class FakeViewport extends EventTarget {
  height = 844;
  offsetTop = 0;
  set(height: number, offsetTop = 0) {
    this.height = height;
    this.offsetTop = offsetTop;
    this.dispatchEvent(new Event('resize'));
    this.dispatchEvent(new Event('scroll'));
    flushFrames();
  }
}

function Surface({ prefix, enabled }: { prefix?: string; enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useVisualViewport(ref, prefix, enabled);
  return <div ref={ref} data-testid="surface" />;
}

let frames: FrameRequestCallback[] = [];
function flushFrames() {
  const run = frames;
  frames = [];
  for (const cb of run) cb(0);
}

let root: Root;
let host: HTMLElement;
let vv: FakeViewport;
const realVV = Object.getOwnPropertyDescriptor(window, 'visualViewport');
const realRaf = window.requestAnimationFrame;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vv = new FakeViewport();
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  // Frames run when the fake viewport changes (flushFrames), inside act().
  frames = [];
  window.requestAnimationFrame = (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.requestAnimationFrame = realRaf;
  if (realVV) Object.defineProperty(window, 'visualViewport', realVV);
  else delete (window as { visualViewport?: unknown }).visualViewport;
});

const surface = () => host.querySelector<HTMLElement>('[data-testid="surface"]')!;

describe('useVisualViewport', () => {
  it('names its variables by prefix', () => {
    expect(viewportVarNames('m')).toEqual({ height: '--m-vvh', top: '--m-vvtop' });
    expect(viewportVarNames('chat')).toEqual({ height: '--chat-vvh', top: '--chat-vvtop' });
  });

  it('keeps the phone client\'s --m- variables by default', () => {
    act(() => root.render(<Surface />));
    expect(surface().style.getPropertyValue('--m-vvh')).toBe('844px');
  });

  it('follows an iOS keyboard: the viewport shrinks and scrolls, innerHeight stays', () => {
    act(() => root.render(<Surface prefix="chat" />));
    const el = surface();
    expect(el.style.getPropertyValue('--chat-vvh')).toBe('844px');
    expect(el.style.getPropertyValue('--chat-vvtop')).toBe('0px');
    expect(el.dataset.keyboard).toBeUndefined();
    act(() => vv.set(480, 120));
    expect(el.style.getPropertyValue('--chat-vvh')).toBe('480px');
    expect(el.style.getPropertyValue('--chat-vvtop')).toBe('120px');
    expect(el.dataset.keyboard).toBe('');
    act(() => vv.set(844, 0));
    expect(el.dataset.keyboard).toBeUndefined();
  });

  it('does nothing while disabled, and clears what it set when turned off', () => {
    act(() => root.render(<Surface prefix="chat" enabled={false} />));
    const el = surface();
    act(() => vv.set(480, 120));
    expect(el.style.getPropertyValue('--chat-vvh')).toBe('');
    act(() => root.render(<Surface prefix="chat" enabled />));
    expect(el.style.getPropertyValue('--chat-vvh')).toBe('480px');
    expect(el.dataset.keyboard).toBe('');
    act(() => root.render(<Surface prefix="chat" enabled={false} />));
    expect(el.style.getPropertyValue('--chat-vvh')).toBe('');
    expect(el.style.getPropertyValue('--chat-vvtop')).toBe('');
    expect(el.dataset.keyboard).toBeUndefined();
  });
});
