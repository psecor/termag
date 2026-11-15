// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { retip, Tooltips } from './Tooltips';

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

async function render() {
  await act(async () => root.render(
    <div className="chat-root">
      <span className="state" title="Asked you a question">Asked you a question</span>
      <button type="button" className="tipped" data-tip="Refresh">↻</button>
      <Tooltips />
    </div>,
  ));
}
const hover = (sel: string) => act(() => {
  host.querySelector(sel)!.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
  vi.advanceTimersByTime(500);
});
const bubble = () => document.querySelector('.chat-tip')?.textContent ?? null;

describe('Tooltips', () => {
  // Devin on #1877: New session's box picker is a dialog portalled out of .chat-root, so its rows' data-tip never showed.
  it("shows a data-tip in a portalled container that opts in with data-tips, and nothing else outside .chat-root", async () => {
    await act(async () => root.render(
      <>
        <div className="chat-root"><Tooltips /></div>
        <div data-tips=""><span className="row" data-tip="Asleep · wakes when you start">dev-01</span><span className="titled" title="Plain">x</span></div>
        <div><span className="stray" data-tip="No">y</span></div>
      </>,
    ));
    hover('.row');
    expect(bubble()).toBe('Asleep · wakes when you start');
    // Over the dialog's backdrop (chat.css .chat-tip[data-over]); the page's own bubbles aren't marked.
    expect(document.querySelector('.chat-tip')!.hasAttribute('data-over')).toBe(true);
    hover('.titled');
    expect(bubble()).toBeNull();
    expect(host.querySelector('.titled')!.getAttribute('title')).toBe('Plain');
    hover('.stray');
    expect(bubble()).toBeNull();
  });

  it('moves a title to its bubble', async () => {
    await render();
    hover('.state');
    expect(bubble()).toBe('Asked you a question');
    expect(host.querySelector('.state')!.hasAttribute('title')).toBe(false);
  });

  it('shows a pressed button\'s new tip at once (Link copied), and puts the old one back only on a bubble still up', async () => {
    await render();
    hover('.tipped');
    const button = host.querySelector<HTMLElement>('.tipped')!;
    // The press hides the bubble; what it did changes the tip.
    act(() => { button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    expect(bubble()).toBeNull();
    button.setAttribute('data-tip', 'Link copied');
    act(() => retip(button));
    expect(bubble()).toBe('Link copied');
    button.setAttribute('data-tip', 'Refresh');
    act(() => retip(button, true));
    expect(bubble()).toBe('Refresh');
    // Gone already: going back doesn't pop one up.
    act(() => { document.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    button.setAttribute('data-tip', 'Link copied');
    act(() => retip(button, true));
    expect(bubble()).toBeNull();
  });

  it('takes a retipped bubble down when its element leaves the page', async () => {
    await render();
    const button = host.querySelector<HTMLElement>('.tipped')!;
    button.setAttribute('data-tip', 'Link copied');
    act(() => retip(button));
    expect(bubble()).toBe('Link copied');
    act(() => { button.remove(); retip(button, true); });
    expect(bubble()).toBeNull();
  });

  it('keeps a bubble up while the chat streams beside it, and drops it when its own list scrolls', async () => {
    await act(async () => root.render(
      <div className="chat-root">
        <ul className="sidebar"><li><button type="button" className="tipped" data-tip="Options for notes">⋮</button></li></ul>
        <div className="chat-transcript"><p>step 1</p></div>
        <Tooltips />
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
