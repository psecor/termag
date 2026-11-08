// @vitest-environment jsdom
// The sidebar's head and foot under the chrome refresh.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPEN_PALETTE_EVENT } from '../../utils/searchPalette';
import { ChatSidebar } from './ChatSidebar';
import { ChatChromeProvider, type ChatChrome } from './chatChrome';
import { DOCS_SITE_URL } from '../settings/settingsDocs';
import { accountInitials } from './SidebarChrome';
import { setFlagValues } from '../../flags';
import { MOBILE_OPT_OUT_KEY } from '../../mobile/redirect';

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { unixUsername: 'ada', displayName: 'Ada Lovelace', email: 'ada@example.com' } }),
}));
vi.mock('../../contexts/ProjectContext', () => ({ useProjects: () => ({ projects: [], statusMap: {} }), LAST_ACTIVE_PROJECT_KEY: 'k' }));
const noBoxes: never[] = [];
vi.mock('../../services/boxFeed', () => ({
  boxFeed: { subscribe: () => () => {}, getSnapshot: () => noBoxes },
}));
vi.mock('../../chat/useChatSpaces', () => ({
  useSharedChatSpaces: () => ({ loaded: true, current: true, spaces: [], index: new Map(), colorOf: () => '' }),
}));

let root: Root;
let host: HTMLDivElement;
let where = '';

function Where() {
  const { pathname, search } = useLocation();
  where = `${pathname}${search}`;
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  localStorage.clear();
  where = '';
  // React Aria escapes ids with CSS.escape, which jsdom lacks.
  const css = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
  if (!css?.escape) (globalThis as { CSS?: unknown }).CSS = { ...css, escape: (v: string) => v.replace(/[^\w-]/g, c => `\\${c}`) };
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setFlagValues({});
});

function show(chrome: Partial<ChatChrome>, at = '/chat') {
  const value: ChatChrome = { mode: 'docked', historyOpen: false, openHistory: () => {}, closeHistory: () => {}, ...chrome };
  act(() => root.render(
    <ChatChromeProvider value={value}><MemoryRouter initialEntries={[at]}><ChatSidebar /><Where /></MemoryRouter></ChatChromeProvider>,
  ));
}

const press = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); };

describe('accountInitials', () => {
  it('takes two initials from a name, two letters from one word, and the local part of an email', () => {
    expect(accountInitials('Ada Lovelace')).toBe('AL');
    expect(accountInitials('ada')).toBe('AD');
    expect(accountInitials('ada.lovelace@example.com')).toBe('AL');
    expect(accountInitials('')).toBe('?');
  });
});

describe('the sidebar chrome under the refresh', () => {
  it('keeps the old head and foot with the refresh off', () => {
    show({});
    expect(host.querySelector('.chat-new')?.getAttribute('aria-label')).toBe('New session');
    expect([...host.querySelectorAll('.chat-foot-link')].map(l => l.textContent)).toEqual(['Lab', 'Environments', 'How it works', 'Settings']);
    const docs = host.querySelector('a.chat-docs-link')!;
    expect(docs.getAttribute('href')).toBe(DOCS_SITE_URL);
    expect(docs.getAttribute('target')).toBe('_blank');
    expect(docs.getAttribute('rel')).toContain('noopener');
    expect(host.querySelector('.chat-new-row, .chat-account, .chat-search-button')).toBeNull();
  });

  it('draws the brand, New session as a row with its shortcut, and Search', () => {
    show({ refresh: true });
    expect(host.querySelector('.chat-brand svg')).not.toBeNull();
    const docs = host.querySelector('.chat-sidebar-head a.chat-docs-link')!;
    expect(docs.textContent).toBe('How it works');
    expect(docs.getAttribute('href')).toBe(DOCS_SITE_URL);
    expect(docs.getAttribute('target')).toBe('_blank');
    const row = host.querySelector('a.chat-new-row')!;
    expect(row.getAttribute('aria-label')).toBe('New session');
    expect(row.getAttribute('href')).toBe('/chat/new');
    expect(row.querySelector('kbd')?.textContent).toBeTruthy();
    expect(host.querySelector('.chat-new')).toBeNull();
    // The palette's own trigger stays mounted (⌘K), beside the refresh's Search.
    expect(host.querySelector('.chat-search .search-trigger')).not.toBeNull();
    expect(host.querySelector('.chat-search-button')?.textContent).toContain('Search');
  });

  it('opens the palette from Search', async () => {
    show({ refresh: true });
    const opened = vi.fn();
    window.addEventListener(OPEN_PALETTE_EVENT, opened);
    await press(host.querySelector('.chat-search-button')!);
    window.removeEventListener(OPEN_PALETTE_EVENT, opened);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('puts the account at the foot, with a menu to Lab, Settings and How it works', async () => {
    show({ refresh: true }, '/chat/p/p1?ws=feat');
    const account = host.querySelector('.chat-account')!;
    expect(account.textContent).toContain('Ada Lovelace');
    expect(account.textContent).toContain('ada@example.com');
    expect(host.querySelector('.chat-foot-link')).toBeNull();
    expect(host.querySelector('a.chat-settings-button')?.getAttribute('aria-label')).toBe('Settings');

    await press(account);
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    expect(items.map(i => i.querySelector('[slot="label"]')?.textContent)).toEqual(['Open Lab', 'Environments', 'Settings', 'How it works']);
    expect(document.querySelector('.chat-menu-popover')?.classList.contains('lp-theme')).toBe(true);
    const open = vi.fn();
    vi.stubGlobal('open', open);
    await press(items[3]);
    expect(open).toHaveBeenCalledWith(DOCS_SITE_URL, '_blank', 'noopener,noreferrer');
    vi.unstubAllGlobals();

    await press(account);
    await press(document.querySelectorAll('[role="menuitem"]')[0]);
    expect(where).toBe('/?project=p1&ws=feat');
  });

  it('goes to Settings from the menu', async () => {
    show({ refresh: true });
    await press(host.querySelector('.chat-account')!);
    await press([...document.querySelectorAll('[role="menuitem"]')][2]);
    expect(where).toBe('/settings?from=chat');
  });

  it('drops Environments from the old foot and the account menu while environment-selection-enabled is off', async () => {
    setFlagValues({ 'environment-selection-enabled': false });
    show({});
    expect([...host.querySelectorAll('.chat-foot-link')].map(l => l.textContent)).toEqual(['Lab', 'How it works', 'Settings']);
    act(() => root.unmount());
    root = createRoot(host);
    show({ refresh: true });
    await press(host.querySelector('.chat-account')!);
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    expect(items.map(i => i.querySelector('[slot="label"]')?.textContent)).toEqual(['Open Lab', 'Settings', 'How it works']);
  });

  it('keeps Environments in both with environment-selection-enabled on', async () => {
    setFlagValues({ 'environment-selection-enabled': true });
    show({});
    expect([...host.querySelectorAll('.chat-foot-link')].map(l => l.textContent)).toContain('Environments');
  });

  it('goes to Environments from the menu', async () => {
    show({ refresh: true });
    await press(host.querySelector('.chat-account')!);
    await press([...document.querySelectorAll('[role="menuitem"]')][1]);
    expect(where).toBe('/chat/environments');
  });

  describe('on a phone', () => {
    beforeEach(() => {
      // MOBILE_MEDIA_QUERY matches; jsdom has no matchMedia of its own.
      vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('max-width: 767px') && q.includes('coarse') }));
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('leads the old foot with Phone view, at the open conversation', () => {
      show({}, '/chat/p/p1?ws=feat');
      const links = [...host.querySelectorAll('.chat-foot-link')];
      expect(links[0].textContent).toBe('Phone view');
      expect(links[0].getAttribute('href')).toBe('/m/p/p1?ws=feat');
    });

    it('clears a stored Lab opt-out when the old foot\'s Phone view is pressed', async () => {
      localStorage.setItem(MOBILE_OPT_OUT_KEY, '1');
      sessionStorage.setItem(MOBILE_OPT_OUT_KEY, '1');
      show({}, '/chat');
      await press(host.querySelector('.chat-foot-link')!);
      expect(localStorage.getItem(MOBILE_OPT_OUT_KEY)).toBeNull();
      expect(sessionStorage.getItem(MOBILE_OPT_OUT_KEY)).toBeNull();
      expect(where).toBe('/m');
    });

    it('puts Phone view first in the account menu, and goes there', async () => {
      show({ refresh: true }, '/chat');
      await press(host.querySelector('.chat-account')!);
      const items = [...document.querySelectorAll('[role="menuitem"]')];
      expect(items[0].querySelector('[slot="label"]')?.textContent).toBe('Phone view');
      localStorage.setItem(MOBILE_OPT_OUT_KEY, '1');
      await press(items[0]);
      expect(where).toBe('/m');
      expect(localStorage.getItem(MOBILE_OPT_OUT_KEY)).toBeNull();
    });
  });

  it('offers no Phone view off a phone', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    show({ refresh: true });
    await press(host.querySelector('.chat-account')!);
    expect([...document.querySelectorAll('[role="menuitem"]')].map(i => i.querySelector('[slot="label"]')?.textContent)).not.toContain('Phone view');
    vi.unstubAllGlobals();
  });
});
