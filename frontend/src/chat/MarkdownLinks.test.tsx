// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Markdown, MarkdownLinkContext } from './Markdown';

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function click(a: HTMLAnchorElement, init: MouseEventInit = {}): boolean {
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
  a.dispatchEvent(ev);
  return ev.defaultPrevented;
}

describe('Markdown links', () => {
  it('asks the context on a plain click and opens in place when it says so', () => {
    const asked: string[] = [];
    const open = (href: string) => { asked.push(href); return href.includes('/files/'); };
    act(() => root.render(
      <MarkdownLinkContext.Provider value={open}>
        <Markdown text={'[plan](https://h.dev/termag/files/notes/plan.md) and https://example.com'} />
      </MarkdownLinkContext.Provider>,
    ));
    const [file, other] = [...host.querySelectorAll('a')];
    expect(click(file)).toBe(true);
    expect(click(other)).toBe(false);
    expect(click(file, { metaKey: true })).toBe(false);
    expect(asked).toEqual(['https://h.dev/termag/files/notes/plan.md', 'https://example.com']);
  });

  it('opens every link in a new tab without the context', () => {
    act(() => root.render(<Markdown text={'[plan](https://h.dev/termag/files/notes/plan.md)'} />));
    const a = host.querySelector('a')!;
    expect(a.getAttribute('target')).toBe('_blank');
    expect(click(a)).toBe(false);
  });
});
