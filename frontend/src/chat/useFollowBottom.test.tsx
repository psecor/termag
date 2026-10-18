// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useFollowBottom } from './useFollowBottom';

type Latest = ReturnType<typeof useFollowBottom>;
const latest: { current: Latest | null } = { current: null };

function Harness({ content, chat }: { content: string; chat: string }) {
  const follow = useFollowBottom(content, chat);
  latest.current = follow;
  return <div ref={follow.scroller} onScroll={follow.onScroll}>{content}</div>;
}

let root: Root;
let host: HTMLDivElement;

// jsdom has no layout: give the scroller a fixed geometry.
function scroller(): HTMLDivElement {
  const el = latest.current!.scroller.current!;
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 1000 });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: 100 });
  return el;
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  root = createRoot(host);
});

afterEach(() => { act(() => root.unmount()); });

describe('useFollowBottom', () => {
  it('flags unseen output after the reader scrolls up, and starts the next chat at the bottom', () => {
    act(() => root.render(<Harness content="a1" chat="A" />));
    const el = scroller();
    el.scrollTop = 0;
    act(() => { el.dispatchEvent(new Event('scroll')); });
    act(() => root.render(<Harness content="a2" chat="A" />));
    expect(latest.current!.unseen).toBe(true);
    expect(el.scrollTop).toBe(0);

    act(() => root.render(<Harness content="b1" chat="B" />));
    expect(latest.current!.unseen).toBe(false);
    expect(el.scrollTop).toBe(1000);
  });

  it('keeps following while the reader is at the bottom', () => {
    act(() => root.render(<Harness content="a1" chat="A" />));
    const el = scroller();
    el.scrollTop = 900;
    act(() => { el.dispatchEvent(new Event('scroll')); });
    act(() => root.render(<Harness content="a2" chat="A" />));
    expect(latest.current!.unseen).toBe(false);
    expect(el.scrollTop).toBe(1000);
  });
});
