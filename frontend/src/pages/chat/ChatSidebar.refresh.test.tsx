// @vitest-environment jsdom
// The sidebar under the chrome refresh.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIDEBAR_DEFAULT, SIDEBAR_WIDTH_KEY } from '../../chat/sidebarWidth';
import { ChatSidebar } from './ChatSidebar';
import { ChatChromeProvider, type ChatChrome } from './chatChrome';

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { unixUsername: 'ada' } }) }));
vi.mock('../../contexts/ProjectContext', () => ({ useProjects: () => ({ projects: [], statusMap: {} }) }));
const noBoxes: never[] = [];
vi.mock('../../services/boxFeed', () => ({
  boxFeed: { subscribe: () => () => {}, getSnapshot: () => noBoxes },
}));
vi.mock('../../chat/useChatSpaces', () => ({
  useSharedChatSpaces: () => ({ enabled: false, loaded: true, current: true, spaces: [], index: new Map(), colorOf: () => '' }),
}));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  localStorage.clear();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function show(chrome: Partial<ChatChrome>) {
  const value: ChatChrome = { mode: 'docked', historyOpen: false, openHistory: () => {}, closeHistory: () => {}, ...chrome };
  act(() => root.render(<ChatChromeProvider value={value}><MemoryRouter><ChatSidebar /></MemoryRouter></ChatChromeProvider>));
}

const nav = () => host.querySelector('nav')!;
const handle = () => host.querySelector<HTMLElement>('.chat-sidebar-resize');
const key = (el: HTMLElement, k: string, shiftKey = false) =>
  act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true })); });

describe('ChatSidebar under the chrome refresh', () => {
  it('has no handle and no width of its own with the refresh off', () => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, '400');
    show({});
    expect(handle()).toBeNull();
    expect(nav().style.width).toBe('');
  });

  it('is resizable only while docked', () => {
    show({ refresh: true, mode: 'drawer', historyOpen: true });
    expect(handle()).toBeNull();
    expect(nav().style.width).toBe('');
    show({ refresh: true, mode: 'page' });
    expect(handle()).toBeNull();
  });

  it('opens at the kept width, and the keyboard resizes it and keeps the result', () => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, '300');
    show({ refresh: true });
    const h = handle()!;
    expect(nav().style.width).toBe('300px');
    expect(h.getAttribute('role')).toBe('separator');
    expect(h.getAttribute('aria-valuenow')).toBe('300');
    expect(h.getAttribute('aria-controls')).toBe('chat-conversations');
    key(h, 'ArrowRight');
    expect(nav().style.width).toBe('316px');
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe('316');
    key(h, 'ArrowLeft', true);
    expect(nav().style.width).toBe('268px');
    key(h, 'Enter');
    expect(nav().style.width).toBe(`${SIDEBAR_DEFAULT}px`);
  });

  it('resets to the default on a double-click', () => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, '400');
    show({ refresh: true });
    act(() => { handle()!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(nav().style.width).toBe(`${SIDEBAR_DEFAULT}px`);
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe(String(SIDEBAR_DEFAULT));
  });
});
