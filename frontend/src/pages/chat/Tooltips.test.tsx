// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Tooltips } from './Tooltips';

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

async function render(titles: boolean) {
  await act(async () => root.render(
    <div className="chat-root">
      <span className="state" title="Asked you a question">Asked you a question</span>
      <button type="button" className="tipped" data-tip="Refresh">↻</button>
      <Tooltips titles={titles} />
    </div>,
  ));
}
const hover = (sel: string) => act(() => {
  host.querySelector(sel)!.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
  vi.advanceTimersByTime(500);
});
const bubble = () => document.querySelector('.chat-tip')?.textContent ?? null;

describe('Tooltips', () => {
  it('leaves every title to the browser without titles, as on main, and still shows data-tip', async () => {
    await render(false);
    hover('.state');
    expect(bubble()).toBeNull();
    expect(host.querySelector('.state')!.getAttribute('title')).toBe('Asked you a question');
    hover('.tipped');
    expect(bubble()).toBe('Refresh');
  });

  it('moves a title to its bubble with titles', async () => {
    await render(true);
    hover('.state');
    expect(bubble()).toBe('Asked you a question');
    expect(host.querySelector('.state')!.hasAttribute('title')).toBe(false);
  });

  it('keeps a bubble up while the chat streams beside it, and drops it when its own list scrolls', async () => {
    await act(async () => root.render(
      <div className="chat-root">
        <ul className="sidebar"><li><button type="button" className="tipped" data-tip="Options for notes">⋮</button></li></ul>
        <div className="chat-transcript"><p>step 1</p></div>
        <Tooltips titles />
      </div>,
    ));
    hover('.tipped');
    expect(bubble()).toBe('Options for notes');
    // New output: the transcript grows and follows it down.
    const transcript = host.querySelector('.chat-transcript')!;
    for (let i = 2; i < 6; i++) {
      act(() => {
        transcript.append(Object.assign(document.createElement('p'), { textContent: `step ${i}` }));
        transcript.dispatchEvent(new Event('scroll'));
      });
    }
    expect(bubble()).toBe('Options for notes');
    act(() => { host.querySelector('.sidebar')!.dispatchEvent(new Event('scroll')); });
    expect(bubble()).toBeNull();
  });
});
