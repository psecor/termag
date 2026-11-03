// @vitest-environment jsdom
// `termag-compose:` links (chat/markdownParse.ts composeLinkText): parsed to
// their own node, rendered as a button only where a composer takes them.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ComposeLinkContext, Markdown } from './Markdown';
import { COMPOSE_MAX, composeLinkText, parseInline } from './markdownParse';
import { filledDraft } from './fileChat';

describe('composeLinkText', () => {
  it('reads the percent-encoded text of a termag-compose: destination, any case', () => {
    expect(composeLinkText('termag-compose:mark%20%23761%20ready')).toBe('mark #761 ready');
    expect(composeLinkText('TERMAG-COMPOSE:merge #748')).toBe('merge #748');
    expect(composeLinkText('termag-compose:100%')).toBe('100%');
  });

  it('is null for every other destination', () => {
    for (const d of ['https://example.com', '?compose=x', 'javascript:alert(1)', 'termag:compose', 'compose:x']) expect(composeLinkText(d)).toBeNull();
  });

  it('keeps only text: no line breaks or control characters, no hidden or reordering characters, capped', () => {
    expect(composeLinkText('termag-compose:mark%0A%0Dready%09now%00%1B[31m')).toBe('mark ready now [31m');
    // Zero-width and bidi overrides could hide words or show them in another order.
    expect(composeLinkText('termag-compose:merge%E2%80%AE%20847#%E2%80%8B%EF%BB%BF')).toBe('merge 847#');
    expect(composeLinkText(`termag-compose:${'a'.repeat(COMPOSE_MAX + 50)}`)).toHaveLength(COMPOSE_MAX);
    expect(composeLinkText('termag-compose:%20%E2%80%8B%20')).toBe('');
    // HTML is just text: the renderer never interprets it.
    expect(composeLinkText('termag-compose:%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E')).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('parsing compose links', () => {
  it('is a compose node with its label, written plain or in angle brackets', () => {
    expect(parseInline('[mark ready](termag-compose:mark%20%23761%20ready)')).toEqual([
      { t: 'compose', text: 'mark #761 ready', c: [{ t: 'text', v: 'mark ready' }] },
    ]);
    expect(parseInline('[**merge**](<termag-compose:merge #748>)')).toEqual([
      { t: 'compose', text: 'merge #748', c: [{ t: 'b', c: [{ t: 'text', v: 'merge' }] }] },
    ]);
  });

  it('is its label as text when empty, as an image, or inside another link', () => {
    expect(parseInline('[x](termag-compose:%20)')).toEqual([{ t: 'text', v: 'x' }]);
    expect(parseInline('![x](termag-compose:merge)')).toEqual([{ t: 'text', v: 'x' }]);
    expect(parseInline('[a [b](termag-compose:merge) c](https://a.dev)')[0]).toMatchObject({ t: 'a', href: 'https://a.dev' });
  });
});

describe('filledDraft', () => {
  it('fills an empty box, or replaces what the last link put there', () => {
    expect(filledDraft('', null, 'mark #761 ready')).toEqual({ draft: 'mark #761 ready', replaced: true });
    expect(filledDraft('  \n', null, 'merge #748')).toEqual({ draft: 'merge #748', replaced: true });
    expect(filledDraft('mark #761 ready', 'mark #761 ready', 'merge #748')).toEqual({ draft: 'merge #748', replaced: true });
  });

  it('keeps what the person typed, and adds the text on a new line', () => {
    expect(filledDraft('after the demo:', null, 'merge #748')).toEqual({ draft: 'after the demo:\nmerge #748', replaced: false });
    expect(filledDraft('mark #761 ready please', 'mark #761 ready', 'merge #748').draft).toBe('mark #761 ready please\nmerge #748');
  });
});

describe('rendering compose links', () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  const md = '| PR | Do it |\n|----|----|\n| #761 | [mark ready](termag-compose:mark%20%23761%20ready) |';

  it('is plain text without a composer: no link, no button, nothing to click', () => {
    act(() => root.render(<Markdown text={md} />));
    expect(host.querySelector('a, button')).toBeNull();
    expect(host.querySelector('td:last-child')?.textContent).toBe('mark ready');
  });

  it('is a button that hands its text to the composer, and goes nowhere', () => {
    const filled: string[] = [];
    act(() => root.render(<ComposeLinkContext.Provider value={t => filled.push(t)}><Markdown text={md} /></ComposeLinkContext.Provider>));
    expect(host.querySelector('a')).toBeNull();
    const button = host.querySelector<HTMLButtonElement>('button.md-compose')!;
    expect(button.type).toBe('button');
    expect(button.textContent).toBe('mark ready');
    expect(button.title).toBe('Put “mark #761 ready” in the message box');
    act(() => button.click());
    expect(filled).toEqual(['mark #761 ready']);
  });
});
