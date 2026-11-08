// @vitest-environment jsdom
// ⌘K under the chrome refresh (ChatPalette.tsx), through ChatSearch as the sidebar mounts it.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxRow } from '../../mobile/inbox';
import { readRecentSearches, writeRecentSearches } from '../../mobile/recentSearches';
import type { PaletteAction } from '../../utils/searchPalette';
import { ChatSearch } from './ChatSearch';

const mocks = vi.hoisted(() => ({ refresh: true, unseen: new Set<string>() }));
vi.mock('../../observability', () => ({ trackEvent: () => {} }));
vi.mock('../../hooks/useRecents', () => ({ useRecents: () => ({ rows: [], loading: false, refresh: () => {} }) }));
vi.mock('../../services/api', () => ({ sessionsApi: { search: vi.fn() }, prsApi: { list: () => Promise.resolve({ connected: false }) } }));
vi.mock('./chatChrome', () => ({ useChatChrome: () => ({ refresh: mocks.refresh }) }));
vi.mock('./simpleData', () => ({
  useSimpleDataIfAny: () => ({ live: new Map(), setupOf: new Map(), unseen: mocks.unseen }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// React Aria's Modal reads a CSP nonce through CSS.escape, which jsdom lacks.
const css = globalThis as { CSS?: { escape?: (s: string) => string } };
css.CSS ??= {};
css.CSS.escape ??= (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);

function row(projectId: string, sessionTitle: string | null, status: InboxRow['status'] = 'idle'): InboxRow {
  return {
    key: `${projectId}|main`, projectId, projectName: projectId, workstream: 'main', sessionTitle, owner: 'me', shared: false,
    provider: 'claude', instanceId: 'box-a', kind: 'normal', pinned: false, status, waitingReason: null,
    updatedAt: new Date().toISOString(), message: null, contextTokens: null, rateLimited: null, review: null, ring: null, band: 'other',
  };
}
const ask: InboxRow = { ...row('js-core', null), key: 'js-core|ask-7f3', workstream: 'ask-7f3', askThreadId: '7f3', askTitle: 'Review the vault client' };
const rows = [row('webapp', 'Fix the flaky retry', 'working'), row('js-core', null), ask];
const boxNameOf = () => 'box-1';

let path = '';
function Probe() {
  const l = useLocation();
  path = `${l.pathname}${l.search}`;
  return null;
}

let container: HTMLDivElement;
let root: Root;
let actions: PaletteAction[] = [];
const render = () => act(() => root.render(
  <MemoryRouter initialEntries={['/chat']}><ChatSearch rows={rows} now={Date.now()} boxNameOf={boxNameOf} actions={actions} /><Probe /></MemoryRouter>,
));
beforeEach(() => {
  actions = [];
  mocks.refresh = true;
  mocks.unseen = new Set();
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  render();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const input = () => document.querySelector<HTMLInputElement>('.chat-palette input');
function type(text: string) {
  const el = input()!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
// Down and up: React Aria opens the highlighted item as Enter comes up.
const press = (key: string, init: KeyboardEventInit = {}) => act(() => {
  const at = input() ?? window;
  at.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  (input() ?? window).dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true, ...init }));
});
const open = async () => { await act(async () => { press('k', { metaKey: true }); await Promise.resolve(); }); };
const heads = () => [...document.querySelectorAll('.chat-palette-head')].map(h => h.firstChild?.textContent?.trim());
/** The names on the results of one kind: `r:` sessions, `q:` recent searches. */
const titles = (kind = 'r:') => [...document.querySelectorAll(`[data-key^="${kind}"] .chat-palette-title`)].map(t => t.textContent);
const highlighted = () => {
  const id = input()?.getAttribute('aria-activedescendant');
  return id ? document.getElementById(id)?.getAttribute('data-key') : null;
};

describe('ChatPalette', () => {
  it('opens on ⌘K as a LaunchPad dialog, with the field focused', async () => {
    await open();
    expect(document.querySelector('.lp-theme.chat-palette-layer [role="dialog"]')).not.toBeNull();
    expect(document.activeElement).toBe(input());
    expect(document.querySelector('.palette-input')).toBeNull();
  });

  it("calls a session by Claude's title, finds it by the title, and opens it on Enter", async () => {
    await open();
    type('flaky');
    expect(heads()).toContain('Sessions');
    expect(titles()).toEqual(['Fix the flaky retry']);
    expect(document.querySelector('.chat-palette-sub')?.textContent).toBe('webapp · Running');
    expect(document.querySelector('.chat-palette-item[data-status="working"] [role="progressbar"]')).not.toBeNull();
    expect(highlighted()).toBe('r:webapp|main');
    press('Enter');
    expect(path).toBe('/chat/p/webapp');
    expect(input()).toBeNull();
    expect(readRecentSearches(localStorage)).toEqual(['flaky']);
  });

  // In a browser React Aria leaves nothing highlighted after a paste, and the field's submit opens the first
  // result; jsdom keeps the highlight, so this holds the behaviour, whichever path takes the Enter.
  it('opens the first result on Enter after a paste', async () => {
    await open();
    const el = input()!;
    act(() => {
      el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertFromPaste', data: 'flaky', bubbles: true, cancelable: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, 'flaky');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(titles()).toEqual(['Fix the flaky retry']);
    press('Enter');
    expect(path).toBe('/chat/p/webapp');
    expect(input()).toBeNull();
  });

  it('finds an ask thread by its title', async () => {
    render();
    await open();
    type('vault client');
    expect(titles()).toEqual(['Review the vault client']);
  });

  it("marks a stop you haven't seen as the sidebar does", async () => {
    mocks.unseen = new Set(['js-core|main']);
    render();
    await open();
    type('js-core');
    const item = document.querySelector('[data-key="r:js-core|main"]');
    expect(item?.getAttribute('data-status')).toBe('unread');
    expect(item?.querySelector('.chat-palette-sub')?.textContent).toContain('unseen');
  });

  it('lists recent searches when empty, with the first highlighted, and Shift+Delete forgets one', async () => {
    writeRecentSearches(localStorage, ['flaky', 'core']);
    await open();
    expect(heads()).toEqual(['Recent searches']);
    expect(highlighted()).toBe('q:flaky');
    press('Delete', { shiftKey: true });
    expect(readRecentSearches(localStorage)).toEqual(['core']);
    expect(titles('q:')).toEqual(['core']);
    expect(input()).not.toBeNull();
  });

  it('turns from the recent lists to the results without losing its sections', async () => {
    writeRecentSearches(localStorage, ['flaky']);
    await open();
    type('core');
    expect(heads()).toContain('Sessions');
    expect(titles()).toContain('js-core');
    type('');
    expect(heads()).toEqual(['Recent searches']);
  });

  describe('commands', () => {
    const run = { newSession: vi.fn(), archive: vi.fn(), settings: vi.fn() };
    beforeEach(() => {
      Object.values(run).forEach(f => f.mockClear());
      actions = [
        { id: 'new-session', label: 'New session', icon: 'edit', keys: '⌘⇧O', suggested: true, run: run.newSession },
        { id: 'archive', label: 'Archive session', icon: 'archive-outline', detail: 'Wait for the turn to end', disabled: true, run: run.archive },
        { id: 'settings', label: 'Settings', icon: 'gear-outline', suggested: true, run: run.settings },
      ];
      render();
    });

    it('lists the suggested ones under Commands after the recents, with their keys', async () => {
      writeRecentSearches(localStorage, ['flaky']);
      await open();
      expect(heads()).toEqual(['Recent searches', 'Commands']);
      expect(titles('a:')).toEqual(['New session', 'Settings']);
      expect(document.querySelector('[data-key="a:new-session"] .chat-palette-keys')?.textContent).toBe('⌘⇧O');
      expect(highlighted()).toBe('q:flaky');
    });

    it('typing finds one first and Enter runs it, keeping no search', async () => {
      await open();
      type('set');
      expect(heads()[0]).toBe('Commands');
      expect(highlighted()).toBe('a:settings');
      press('Enter');
      expect(run.settings).toHaveBeenCalledTimes(1);
      expect(input()).toBeNull();
      expect(readRecentSearches(localStorage)).toEqual([]);
    });

    it("lists one that can't run now, dimmed with why, and never runs it", async () => {
      await open();
      type('arch');
      const row = document.querySelector('[data-key="a:archive"]');
      expect(row?.hasAttribute('data-disabled')).toBe(true);
      expect(row?.querySelector('.chat-palette-sub')?.textContent).toBe('Wait for the turn to end');
      press('Enter');
      expect(run.archive).not.toHaveBeenCalled();
    });
  });

  it("says less in the field on a phone's width, where the whole placeholder doesn't fit", async () => {
    // jsdom has no matchMedia: a phone's width matches the narrow query, and nothing else.
    const w = window as { matchMedia?: (q: string) => MediaQueryList };
    w.matchMedia = q => ({ matches: q === '(max-width: 767px)', addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList;
    try {
      await open();
      expect(input()?.placeholder).toBe('Search sessions, PRs, pane text');
    } finally {
      delete w.matchMedia;
    }
  });

  it('with the refresh off, is the palette it was', async () => {
    mocks.refresh = false;
    render();
    await open();
    expect(document.querySelector('.palette-input')).not.toBeNull();
    expect(document.querySelector('.chat-palette')).toBeNull();
  });
});
