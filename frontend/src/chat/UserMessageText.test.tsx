// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UserMessageText } from './UserMessageText';
import { fileChatMessage, splitViewingLine } from './fileChat';

describe('splitViewingLine', () => {
  it('splits off the line a space file\'s composer adds', () => {
    expect(splitViewingLine('mark 755 ready\n\n(viewing improve-termag:pr-outbox.md)')).toEqual({ body: 'mark 755 ready', viewing: '(viewing improve-termag:pr-outbox.md)' });
    expect(splitViewingLine('(viewing improve-termag:demos/a b.mp4)')).toEqual({ body: '', viewing: '(viewing improve-termag:demos/a b.mp4)' });
  });

  it('leaves every other message whole', () => {
    for (const t of ['mark 755 ready', 'see (viewing x:y) above', 'two\n(viewing x:y)', '(viewing nothing)']) expect(splitViewingLine(t)).toEqual({ body: t, viewing: null });
  });

  it('is what fileChatMessage writes, once only and with or without text', () => {
    const m = fileChatMessage('merge it', 'sp', 'a/b.md');
    expect(fileChatMessage(m, 'sp', 'a/b.md')).toBe(m);
    expect(fileChatMessage('', 'sp', 'a/b.md')).toBe('(viewing sp:a/b.md)');
    expect(splitViewingLine(m)).toEqual({ body: 'merge it', viewing: '(viewing sp:a/b.md)' });
  });
});

describe('UserMessageText', () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it('draws the viewing line apart and quieter, the typed text as it was', () => {
    act(() => root.render(<div className="sdk-user-bubble"><UserMessageText text={'mark 755 ready\n\n(viewing improve-termag:pr-outbox.md)'} /></div>));
    expect(host.querySelector('.sdk-user-context')?.textContent).toBe('(viewing improve-termag:pr-outbox.md)');
    expect(host.textContent).toBe('mark 755 ready\n(viewing improve-termag:pr-outbox.md)');
    act(() => root.render(<div className="sdk-user-bubble"><UserMessageText text="just text" /></div>));
    expect(host.querySelector('.sdk-user-context')).toBeNull();
    expect(host.textContent).toBe('just text');
  });
});
