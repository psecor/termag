// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatChromeProvider, ChatHistoryButton, SidePanelButton, type ChatChrome } from './chatChrome';

function chrome(over: Partial<ChatChrome> = {}): ChatChrome {
  return {
    mode: 'docked',
    historyOpen: false,
    openHistory: () => {},
    closeHistory: () => {},
    ...over,
  };
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('ChatHistoryButton', () => {
  it('is absent while the list is docked or is the page', () => {
    act(() => root.render(<ChatChromeProvider value={chrome({ mode: 'docked' })}><ChatHistoryButton /></ChatChromeProvider>));
    expect(host.querySelector('.chat-history-btn')).toBeNull();
    act(() => root.render(<ChatChromeProvider value={chrome({ mode: 'page' })}><ChatHistoryButton /></ChatChromeProvider>));
    expect(host.querySelector('.chat-history-btn')).toBeNull();
  });

  it('opens the drawer from a conversation', () => {
    let opened = 0;
    act(() => root.render(
      <ChatChromeProvider value={chrome({ mode: 'drawer', openHistory: () => { opened += 1; } })}>
        <ChatHistoryButton />
      </ChatChromeProvider>,
    ));
    const button = host.querySelector('button');
    expect(button?.textContent).toBe('Sessions');
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    act(() => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(opened).toBe(1);
  });
});

describe('SidePanelButton', () => {
  it('is absent where the side panel is off', () => {
    act(() => root.render(<ChatChromeProvider value={chrome()}><SidePanelButton /></ChatChromeProvider>));
    expect(host.querySelector('.chat-side-toggle')).toBeNull();
  });

  it('toggles the panel and says whether it is open', () => {
    let toggled = 0;
    act(() => root.render(
      <ChatChromeProvider value={chrome({ sidePanel: { open: true, toggle: () => { toggled += 1; } } })}>
        <SidePanelButton />
      </ChatChromeProvider>,
    ));
    const button = host.querySelector('button');
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    expect(button?.getAttribute('aria-controls')).toBe('chat-side-panel');
    act(() => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(toggled).toBe(1);
  });
});
