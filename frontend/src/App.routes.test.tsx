// @vitest-environment jsdom
// Renders the real App (every provider, gate and lazy page) at each top-level
// route, with the network answered in memory: which page each URL lands on,
// the redirects between them, and that rendering logs no React error. It
// backs dependency upgrades (React, react-router) that change how routes
// render and resolve.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // xterm probes a canvas when it is imported, and jsdom has none.
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});

const net = vi.hoisted(() => ({ routes: new Map<string, unknown>() }));

// Every request from services/api.ts goes through axios' default adapter, set
// here before that module creates its instance. A path with no answer is a
// 404, which each page already shows as its own error state.
vi.mock('axios', async (importOriginal) => {
  const mod = await importOriginal<typeof import('axios')>();
  mod.default.defaults.adapter = async (config) => {
    const path = (config.url ?? '').split('?')[0];
    const found = net.routes.has(path);
    const response = {
      // A promise is an answer still on its way (a list that is loading).
      data: found ? await net.routes.get(path) : { error: 'not found' },
      status: found ? 200 : 404,
      statusText: found ? 'OK' : 'Not Found',
      headers: {},
      config,
      request: {},
    };
    if (!found) throw new mod.AxiosError('not found', 'ERR_BAD_REQUEST', config, {}, response as never);
    return response as never;
  };
  return mod;
});

import App from './App';
import { setFlagValues } from './flags';

const USER = {
  id: 'user-1',
  email: 'e2e@termag.local',
  displayName: 'E2E',
  unixUsername: 'e2e',
  defaultAgentProvider: 'claude',
  dotfilesRepoUrl: null,
  theme: { version: 1, background: { mode: 'solid', color: '#0d1117' }, sidebarActivity: false, sidebarMetaTerm: false },
  role: 'admin',
  needsOnboarding: false,
};

const SIMPLE_UI: Record<string, boolean> = {};

// Every socket URL the app dialled, in order.
let dialled: string[] = [];
class FakeSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = 0;
  onopen = null; onmessage = null; onclose = null; onerror = null;
  constructor(readonly url: string) { dialled.push(url); }
  send() {}
  close() { this.readyState = 3; }
  addEventListener() {}
  removeEventListener() {}
}

let where = '';
// Every path and query the router showed, in order.
let visited: string[] = [];
function Location() {
  const { pathname, search } = useLocation();
  where = pathname;
  if (visited[visited.length - 1] !== `${pathname}${search}`) visited.push(`${pathname}${search}`);
  return null;
}

// The router's navigate, for a test that moves around in the app.
let go: NavigateFunction = () => { throw new Error('not rendered'); };
function Navigator() {
  go = useNavigate();
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement;
let errors: string[] = [];

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: false, media, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }));
  localStorage.clear();
  sessionStorage.clear();
  net.routes.clear();
  net.routes.set('/auth/me', USER);
  // Flags are the e2e stack's
  // overrides. The provider reads the bootstrap once per page, so a test that
  // changes a flag sets the overrides directly as well.
  net.routes.set('/api/example-org/bootstrap', { clientSideId: null, context: null, bootstrap: null, overrides: SIMPLE_UI });
  setFlagValues(SIMPLE_UI);
  net.routes.set('/api/projects', []);
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  container = document.createElement('div');
  document.body.appendChild(container);
  where = '';
  visited = [];
  dialled = [];
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function tick() {
  await act(async () => { await new Promise(r => setTimeout(r, 10)); });
}

/**
 * Renders the app at `path` and waits until `landed` holds, then lets the first reads settle.
 * `from`: the page was loaded there and navigated in the app to `path` (its location key isn't the first's).
 */
async function open(path: string, landed: () => boolean, what: string, from?: string) {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={from ? [from, path] : [path]} initialIndex={from ? 1 : 0}>
        <App />
        <Location />
        <Navigator />
      </MemoryRouter>,
    );
  });
  // Well inside the test timeout, so a page that never lands fails here and
  // leaves no act() running into the next test.
  for (let i = 0; i < 300 && !landed(); i++) await tick();
  if (!landed()) throw new Error(`${path} never showed ${what}; at ${where}: ${container.textContent?.slice(0, 200)}`);
  for (let i = 0; i < 5; i++) await tick();
}

const has = (selector: string) => () => container.querySelector(selector) != null;
const heading = (text: string) => () => [...container.querySelectorAll('h1')].some(h => h.textContent?.trim() === text);
const currentTab = () => container.querySelector('.admin-tabs [aria-current="page"]')?.textContent?.trim();

describe('top-level routes', { timeout: 10_000 }, () => {
  it('/ opens the workspace', async () => {
    await open('/', has('.app-layout'), 'the workspace layout');
    expect(where).toBe('/');
    expect(errors).toEqual([]);
  });

  it('/chat opens the simple UI', async () => {
    await open('/chat', has('.chat-root .chat-home'), 'the simple UI home');
    expect(where).toBe('/chat');
    expect(errors).toEqual([]);
  });

  it('the simple UI carries no chrome refresh with its flag off, and loads no icon sprite', async () => {
    await open('/chat', has('.chat-root .chat-home'), 'the simple UI home');
    const chatRoot = container.querySelector('.chat-root')!;
    expect(chatRoot.className).toBe('chat-root');
    expect(chatRoot.hasAttribute('data-chrome')).toBe(false);
    expect(document.getElementById('lp-icons-sprite')).toBeNull();
    expect(document.body.hasAttribute('data-chrome')).toBe(false);
    expect(errors).toEqual([]);
  });

  it('with simple-ui-chrome-refresh-enabled on, the refresh is scoped to .chat-root, never <body>', async () => {
    const flags = { ...SIMPLE_UI, 'simple-ui-chrome-refresh-enabled': true };
    net.routes.set('/api/example-org/bootstrap', { clientSideId: null, context: null, bootstrap: null, overrides: flags });
    setFlagValues(flags);
    await open('/chat', has('.chat-root[data-chrome="refresh"].lp-theme .chat-home'), 'the refreshed simple UI home');
    for (const el of [document.documentElement, document.body]) {
      expect(el.hasAttribute('data-chrome')).toBe(false);
      expect(el.hasAttribute('data-theme')).toBe(false);
      expect(el.classList.contains('lp-theme')).toBe(false);
    }
    expect(errors).toEqual([]);
  });

  for (const refresh of [false, true]) {
    it(`a notice from notice-banner sits at the top of the main pane, beside the sidebar (chrome refresh ${refresh ? 'on' : 'off'})`, async () => {
      const notice = { id: 'example-2026-11-13', tone: 'warning', message: 'Run `echo hi`.', link: { label: 'Details', url: 'https://example.com/x' } };
      const flags = { ...SIMPLE_UI, 'simple-ui-chrome-refresh-enabled': refresh, 'notice-banner': notice };
      net.routes.set('/api/example-org/bootstrap', { clientSideId: null, context: null, bootstrap: null, overrides: flags });
      setFlagValues(flags);
      await open('/chat', has('.chat-root .chat-pane > .chat-pane-notice [role="alert"]'), 'the notice banner');
      const pane = container.querySelector('.chat-root > .chat-pane')!;
      expect([...pane.children].map(c => c.className.split(' ')[0])).toEqual(['notice-slot', 'chat-main']);
      expect(pane.querySelector('.chat-sidebar')).toBeNull();
      expect(container.querySelector('.chat-root > .chat-sidebar')).not.toBeNull();
      expect(errors).toEqual([]);
    });
  }

  it('⌘⇧O / Ctrl+Shift+O in the simple UI opens New session', async () => {
    await open('/chat', has('.chat-root .chat-home'), 'the simple UI home');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', key: 'O', shiftKey: true, ctrlKey: true, bubbles: true }));
    });
    for (let i = 0; i < 300 && !(where === '/chat/new' && has('.chat-compose-box')()); i++) await tick();
    expect(where).toBe('/chat/new');
    // …with the cursor in its message, ready to type.
    expect(document.activeElement).toBe(container.querySelector('textarea.chat-compose-input'));
    expect(errors).toEqual([]);
  });

  it('/chat/new opens the new-session form', async () => {
    await open('/chat/new', has('.chat-root .chat-compose-box'), 'the new-session composer');
    expect(where).toBe('/chat/new');
    expect(errors).toEqual([]);
  });

  it('/m opens the phone client', async () => {
    await open('/m', has('.m-root'), 'the phone client');
    expect(where).toBe('/m');
    expect(errors).toEqual([]);
  });

  it('/admin opens Admin on Overview', async () => {
    await open('/admin', () => heading('Admin')() && currentTab() === 'Overview', 'Admin on Overview');
    expect(where).toBe('/admin');
    expect(errors).toEqual([]);
  });

  it('/admin/fleet opens the Fleet tab', async () => {
    await open('/admin/fleet', () => currentTab() === 'Fleet', 'the Fleet tab');
    expect(where).toBe('/admin/fleet');
    expect(errors).toEqual([]);
  });

  it('/dashboard opens the dashboard', async () => {
    await open('/dashboard', heading('Dashboard'), 'the dashboard');
    expect(where).toBe('/dashboard');
    expect(errors).toEqual([]);
  });

  it('/settings opens Settings', async () => {
    await open('/settings', heading('Settings'), 'Settings');
    expect(where).toBe('/settings');
    expect(errors).toEqual([]);
  });

  it('an unknown Admin path goes back to Overview', async () => {
    await open('/admin/no-such-tab', () => where === '/admin', '/admin');
    expect(currentTab()).toBe('Overview');
    expect(errors).toEqual([]);
  });

  it('an unknown simple UI path goes to /chat', async () => {
    await open('/chat/no-such-page', () => where === '/chat' && has('.chat-home')(), '/chat');
    expect(errors).toEqual([]);
  });

  it('an unknown phone path goes to /m', async () => {
    await open('/m/no-such-page', () => where === '/m' && has('.m-root')(), '/m');
    expect(errors).toEqual([]);
  });

  it('signed out, the workspace goes to the sign-in page', async () => {
    net.routes.delete('/auth/me');
    await open('/', () => where === '/login' && has('.login-page')(), 'the sign-in page');
    expect(errors).toEqual([]);
  });

  it('a signed-in page keeps onboarding-refresh-enabled for the sign-in page, and forgets it when it is off', async () => {
    const flags = { ...SIMPLE_UI, 'onboarding-refresh-enabled': true };
    net.routes.set('/api/example-org/bootstrap', { clientSideId: null, context: null, bootstrap: null, overrides: flags });
    setFlagValues(flags);
    await open('/settings', heading('Settings'), 'Settings');
    expect(localStorage.getItem('termag-onboarding-refresh')).toBe('1');
    act(() => root?.unmount());
    root = null;
    net.routes.set('/api/example-org/bootstrap', { clientSideId: null, context: null, bootstrap: null, overrides: SIMPLE_UI });
    setFlagValues(SIMPLE_UI);
    await open('/settings', heading('Settings'), 'Settings');
    expect(localStorage.getItem('termag-onboarding-refresh')).toBeNull();
    expect(errors).toEqual([]);
  });

  it('signed out with onboarding-refresh-enabled remembered, the sign-in page is the redrawn one', async () => {
    net.routes.delete('/auth/me');
    localStorage.setItem('termag-onboarding-refresh', '1');
    await open('/login?error=unauthorized', () => where === '/login' && has('.wel-login')(), 'the redrawn sign-in page');
    expect(document.body.textContent).toContain("This account doesn't have access to termag yet.");
    expect(has('.login-page')()).toBe(false);
    expect(errors).toEqual([]);
  });

  it('a share link its owner opened goes to the simple UI\'s side panel when that UI was last', async () => {
    const flags = { ...SIMPLE_UI };
    net.routes.set('/api/example-org/bootstrap', { clientSideId: null, context: null, bootstrap: null, overrides: flags });
    setFlagValues(flags);
    localStorage.setItem('termag-ui-mode', 'simple');
    const handoff = 'browser=open&browserShare=cshare0000000001&browserAt=%2Fprojects%2Fx';
    await open(`/?project=p1&ws=feature-x&${handoff}`, () => where === '/chat/p/p1' || where === '/chat', 'the simple UI');
    expect(visited).toContain(`/chat/p/p1?ws=feature-x&${handoff}`);
    expect(visited.some(v => v.startsWith('/?') && v !== `/?project=p1&ws=feature-x&${handoff}`)).toBe(false);
    expect(errors).toEqual([]);
  });

  it('a share link its owner opened dials the share from a side panel already open on Browser', async () => {
    const flags = { ...SIMPLE_UI };
    net.routes.set('/api/example-org/bootstrap', { clientSideId: null, context: null, bootstrap: null, overrides: flags });
    setFlagValues(flags);
    net.routes.set('/api/projects', [{
      id: 'p1', name: 'sample', archived: false, instanceId: null, setupStatus: null, role: 'owner', ownerUsername: 'e2e',
      workflows: [{ id: 'w1', type: 'agent', provider: 'claude', workstreamId: 'ws1' }], workstreams: [{ id: 'ws1', name: 'main' }],
    }]);
    localStorage.setItem('termag-ui-mode', 'simple');
    localStorage.setItem('termag-chat-side-panel-tabs', JSON.stringify([{ place: 'session:p1|main', tab: 'browser' }]));
    localStorage.setItem('termag-chat-side-panel-open', JSON.stringify(['session:p1|main']));
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const browserDials = () => dialled.filter(u => u.includes('/ws/browser?'));
    // The page's own URL, which the handoff is read from (the memory router leaves it alone).
    const link = '/?project=p1&ws=main&browser=open&browserShare=cshare0000000001&browserAt=%2Fprojects%2Fx';
    window.history.replaceState(null, '', `/termag${link}`);
    await open(link, () => browserDials().length > 0, 'a browser dial');
    expect(where).toBe('/chat/p/p1');
    const first = new URL(browserDials()[0]).searchParams;
    expect(first.get('projectId')).toBe('p1');
    expect(first.get('openShare')).toBe('cshare0000000001');
    expect(first.get('at')).toBe('/projects/x');
    expect(window.location.search).toBe('?project=p1&ws=main');
    window.history.replaceState(null, '', '/');
  });

  it('the simple UI\'s side panel is open or shut in each session as it was left there, and shut in one it never was opened in', async () => {
    net.routes.set('/api/projects', [{
      id: 'p1', name: 'sample', archived: false, instanceId: null, setupStatus: null, role: 'owner', ownerUsername: 'e2e',
      workflows: [{ id: 'w1', type: 'agent', provider: 'claude', workstreamId: 'ws1' }, { id: 'w2', type: 'agent', provider: 'claude', workstreamId: 'ws2' }],
      workstreams: [{ id: 'ws1', name: 'main' }, { id: 'ws2', name: 'feature-x' }],
    }]);
    localStorage.setItem('termag-ui-mode', 'simple');
    // From before: one record, open for every session. Its open (and its tab) are no longer read.
    localStorage.setItem('termag-chat-side-panel', JSON.stringify({ open: true, tab: 'browser', width: 480 }));
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const panel = () => container.querySelector('#chat-side-panel');
    const toggle = () => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB', ctrlKey: true, altKey: true, bubbles: true })); });
    const visit = async (to: string) => { await act(async () => { await go(to); }); await tick(); };
    await open('/chat/p/p1', has('.chat-root .chat-main'), 'the session');
    expect(panel()).toBeNull();
    toggle();
    expect(panel()).not.toBeNull();
    // Another session starts shut, and opening it there leaves the first as it was.
    await visit('/chat/p/p1?ws=feature-x');
    expect(panel()).toBeNull();
    toggle();
    toggle();
    expect(panel()).toBeNull();
    await visit('/chat/p/p1?ws=main');
    expect(panel()).not.toBeNull();
    // A page with no panel and back.
    await visit('/chat');
    await visit('/chat/p/p1');
    expect(panel()).not.toBeNull();
    expect(JSON.parse(localStorage.getItem('termag-chat-side-panel-open')!)).toEqual(['session:p1|main']);
    expect(errors).toEqual([]);
  });

  it('the simple UI\'s side panel shows the tab each session last showed, and Terminal in one that never picked one', async () => {
    net.routes.set('/api/projects', [{
      id: 'p1', name: 'sample', archived: false, instanceId: null, setupStatus: null, role: 'owner', ownerUsername: 'e2e',
      workflows: [{ id: 'w1', type: 'agent', provider: 'claude', workstreamId: 'ws1' }, { id: 'w2', type: 'agent', provider: 'claude', workstreamId: 'ws2' }],
      workstreams: [{ id: 'ws1', name: 'main' }, { id: 'ws2', name: 'feature-x' }],
    }]);
    localStorage.setItem('termag-ui-mode', 'simple');
    // From before: one tab for every session. It seeds no session's.
    localStorage.setItem('termag-chat-side-panel', JSON.stringify({ tab: 'browser', width: 480 }));
    localStorage.setItem('termag-chat-side-panel-open', JSON.stringify(['session:p1|main', 'session:p1|feature-x']));
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const selected = () => container.querySelector('#chat-side-panel [role="tab"][aria-selected="true"]')?.textContent ?? null;
    const pick = (name: string) => act(() => {
      [...container.querySelectorAll<HTMLElement>('#chat-side-panel [role="tab"]')].find(t => t.textContent === name)!.click();
    });
    const visit = async (to: string) => { await act(async () => { await go(to); }); await tick(); };
    await open('/chat/p/p1', has('#chat-side-panel'), 'the panel');
    expect(selected()).toBe('Terminal');
    pick('Browser');
    expect(selected()).toBe('Browser');
    // Another session keeps its own: Terminal, never picked there. Its pick leaves the first as it was.
    await visit('/chat/p/p1?ws=feature-x');
    expect(selected()).toBe('Terminal');
    pick('Share');
    await visit('/chat/p/p1?ws=main');
    expect(selected()).toBe('Browser');
    await visit('/chat/p/p1?ws=feature-x');
    expect(selected()).toBe('Share');
    // A page with no panel and back.
    await visit('/chat');
    await visit('/chat/p/p1');
    expect(selected()).toBe('Browser');
    expect(JSON.parse(localStorage.getItem('termag-chat-side-panel-tabs')!)).toEqual([
      { place: 'session:p1|main', tab: 'browser' }, { place: 'session:p1|feature-x', tab: 'share' },
    ]);
    expect(errors).toEqual([]);
  });

  it('a pick in the side panel\'s explorer keeps the panel open on the session it opens', async () => {
    const agent = (id: string, name: string) => ({
      id, name, archived: false, instanceId: null, setupStatus: null, role: 'owner', ownerUsername: 'e2e',
      workflows: [{ id: `w-${id}`, type: 'agent', provider: 'claude', workstreamId: `ws-${id}` }], workstreams: [{ id: `ws-${id}`, name: 'main' }],
    });
    net.routes.set('/api/projects', [agent('p1', 'first'), agent('p2', 'second'), agent('p3', 'third')]);
    localStorage.setItem('termag-ui-mode', 'simple');
    localStorage.setItem('termag-chat-side-panel-tabs', JSON.stringify([{ place: 'session:p1|main', tab: 'files' }]));
    localStorage.setItem('termag-chat-side-panel-open', JSON.stringify(['session:p1|main']));
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const row = (name: string) => [...container.querySelectorAll<HTMLElement>('#chat-side-panel .fx-row')].find(r => r.querySelector('.fx-name')?.textContent === name);
    await open('/chat/p/p1', has('#chat-side-panel'), 'the panel');
    for (let i = 0; i < 100 && !row('second'); i++) await tick();
    // The panel stays mounted through the pick, never shut for a render, so the explorer keeps its search and scroll.
    const before = container.querySelector('#chat-side-panel');
    let shut = false;
    const watch = new MutationObserver(() => { if (!container.contains(before)) shut = true; });
    watch.observe(container, { childList: true, subtree: true });
    await act(async () => { row('second')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); });
    for (let i = 0; i < 5 && where !== '/chat/p/p2'; i++) await tick();
    watch.disconnect();
    expect(where).toBe('/chat/p/p2');
    expect(shut).toBe(false);
    expect(container.querySelector('#chat-side-panel')).toBe(before);
    expect(JSON.parse(localStorage.getItem('termag-chat-side-panel-open')!)).toEqual(['session:p2|main', 'session:p1|main']);
    // On Files (Agents, for agents in no space), where the pick was made, and remembered so for the session it opened.
    expect(container.querySelector('#chat-side-panel [role="tab"][aria-selected="true"]')?.textContent).toBe('Agents');
    expect(JSON.parse(localStorage.getItem('termag-chat-side-panel-tabs')!)).toEqual([
      { place: 'session:p2|main', tab: 'files' }, { place: 'session:p1|main', tab: 'files' },
    ]);
    // Any other way to a session (the sidebar, a link) leaves it as it was: shut, here.
    await act(async () => { await go('/chat/p/p3'); });
    await tick();
    expect(where).toBe('/chat/p/p3');
    expect(container.querySelector('#chat-side-panel')).toBeNull();
    expect(JSON.parse(localStorage.getItem('termag-chat-side-panel-open')!)).toEqual(['session:p2|main', 'session:p1|main']);
    expect(errors).toEqual([]);
  });

  it('a share link its owner opened stays in the workspace when the full UI was last', async () => {
    const flags = { ...SIMPLE_UI };
    net.routes.set('/api/example-org/bootstrap', { clientSideId: null, context: null, bootstrap: null, overrides: flags });
    setFlagValues(flags);
    await open('/?project=p1&ws=main&browser=open&browserShare=cshare0000000001', has('.app-layout'), 'the workspace');
    expect(where).toBe('/');
    expect(visited.some(v => v.startsWith('/chat'))).toBe(false);
    expect(errors).toEqual([]);
  });

  describe('a phone landing (chat-phone-home-enabled)', () => {
    const PHONE_QUERIES = new Set(['(max-width: 767px) and (pointer: coarse)', '(pointer: coarse)']);
    function asPhone(more: string[] = []) {
      const matching = new Set([...PHONE_QUERIES, ...more]);
      vi.stubGlobal('matchMedia', (media: string) => ({
        matches: matching.has(media), media, onchange: null,
        addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
      }));
    }
    function phoneHome(on: boolean) {
      const flags = { ...SIMPLE_UI, 'chat-phone-home-enabled': on };
      net.routes.set('/api/example-org/bootstrap', { clientSideId: null, context: null, bootstrap: null, overrides: flags });
      setFlagValues(flags);
    }
    const project = (id: string, kind: 'normal' | 'metaterm' | 'automation', workstreams: string[]) => ({
      id, name: id, kind, archived: false, instanceId: null, setupStatus: null, role: 'owner', ownerUsername: 'e2e',
      workflows: [], workstreams: workstreams.map((name, i) => ({ id: `${id}-ws${i}`, name })),
    });
    const LIST = [project('p1', 'normal', ['main', 'feat']), project('mt', 'metaterm', ['main']), project('auto', 'automation', ['main', 'run-1'])];
    const onPhoneClient = () => where.startsWith('/m') && has('.m-root')();
    const inChat = () => where.startsWith('/chat') && has('.chat-root')();

    it('flag off: / goes to the phone client, as before', async () => {
      asPhone();
      phoneHome(false);
      await open('/', onPhoneClient, 'the phone client');
      expect(where).toBe('/m');
      expect(visited.some(v => v.startsWith('/chat'))).toBe(false);
      expect(errors).toEqual([]);
    });

    it('flag off: a link to a session goes to its phone conversation, as before', async () => {
      asPhone();
      phoneHome(false);
      net.routes.set('/api/projects', LIST);
      await open('/?project=p1&ws=feat', onPhoneClient, 'the phone conversation');
      expect(visited).toContain('/m/p/p1?ws=feat');
      expect(visited.some(v => v.startsWith('/chat'))).toBe(false);
    });

    it('flag on: / opens the chat', async () => {
      asPhone();
      phoneHome(true);
      await open('/', inChat, 'the chat');
      expect(where).toBe('/chat');
      expect(visited.some(v => v.startsWith('/m'))).toBe(false);
      expect(errors).toEqual([]);
    });

    // The project restore seeds ?project=<last> on / in the same commit as the
    // gate's redirect, which sent the page back to / under a gate that had
    // already decided: a blank page (App.landing.test.tsx).
    for (const on of [false, true]) {
      it(`flag ${on ? 'on' : 'off'}: / with a project remembered goes where / goes, not to a blank page`, async () => {
        asPhone();
        phoneHome(on);
        net.routes.set('/api/projects', LIST);
        localStorage.setItem('termag:lastActiveProject', 'p1');
        await open('/', on ? inChat : onPhoneClient, on ? 'the chat' : 'the phone client');
        expect(where).toBe(on ? '/chat' : '/m');
        expect(errors).toEqual([]);
      });
    }

    it('flag on: a link to a chat session shows Loading… while the list loads, then opens its chat', async () => {
      asPhone();
      phoneHome(true);
      let answer: (list: unknown) => void = () => {};
      net.routes.set('/api/projects', new Promise(resolve => { answer = resolve; }));
      await open('/?project=p1&ws=feat', () => container.textContent?.includes('Loading…') === true, 'Loading…');
      expect(where).toBe('/');
      await act(async () => { answer(LIST); });
      for (let i = 0; i < 300 && !inChat(); i++) await tick();
      expect(visited).toContain('/chat/p/p1?ws=feat');
      expect(visited.some(v => v.startsWith('/m'))).toBe(false);
    });

    it('flag on: an automation\'s run opens its chat; its main and MetaTerm stay on the phone client', async () => {
      asPhone();
      phoneHome(true);
      net.routes.set('/api/projects', LIST);
      await open('/?project=auto&ws=run-1', inChat, 'the run\'s chat');
      expect(visited).toContain('/chat/p/auto?ws=run-1');
      act(() => root?.unmount());
      visited = [];
      await open('/?project=auto&ws=main', onPhoneClient, 'the phone conversation');
      expect(visited).toContain('/m/p/auto');
      act(() => root?.unmount());
      visited = [];
      await open('/?project=mt', onPhoneClient, 'the phone conversation');
      expect(visited).toContain('/m/p/mt');
      expect(visited.some(v => v.startsWith('/chat'))).toBe(false);
    });

    it('flag on: a link the list can\'t be read for goes to the phone conversation', async () => {
      asPhone();
      phoneHome(true);
      net.routes.delete('/api/projects');
      await open('/?project=p1&ws=feat', onPhoneClient, 'the phone conversation');
      expect(visited).toContain('/m/p/p1?ws=feat');
      expect(visited.some(v => v.startsWith('/chat'))).toBe(false);
    });

    it('flag on: in-app navigation to Lab (the chat\'s Open Lab) still goes to the phone client', async () => {
      asPhone();
      phoneHome(true);
      net.routes.set('/api/projects', LIST);
      await open('/', onPhoneClient, 'the phone client', '/chat');
      expect(where).toBe('/m');
      act(() => root?.unmount());
      visited = [];
      await open('/?project=p1&ws=feat&lab=1', onPhoneClient, 'the phone conversation', '/chat/p/p1?ws=feat');
      expect(visited).toContain('/m/p/p1?ws=feat');
    });

    it('flag on: a phone that pressed Lab keeps the workspace', async () => {
      asPhone();
      phoneHome(true);
      localStorage.setItem('termag-mobile-opt-out', '1');
      await open('/', has('.app-layout'), 'the workspace');
      expect(where).toBe('/');
      expect(visited.some(v => v.startsWith('/chat') || v.startsWith('/m'))).toBe(false);
    });

    it('flag on: /m stays the phone client', async () => {
      asPhone();
      phoneHome(true);
      await open('/m', has('.m-root'), 'the phone client');
      expect(where).toBe('/m');
      expect(errors).toEqual([]);
    });

    it('flag on: a desktop keeps the workspace', async () => {
      phoneHome(true);
      await open('/', has('.app-layout'), 'the workspace');
      expect(where).toBe('/');
      expect(visited.some(v => v.startsWith('/chat') || v.startsWith('/m'))).toBe(false);
    });

    it('a phone tab at the app icon\'s start URL lands as a load of / does', async () => {
      asPhone();
      phoneHome(false);
      await open('/app', onPhoneClient, 'the phone client');
      expect(where).toBe('/m');
      act(() => root?.unmount());
      visited = [];
      phoneHome(true);
      await open('/app', inChat, 'the chat');
      expect(where).toBe('/chat');
      expect(visited.some(v => v.startsWith('/m'))).toBe(false);
    });

    describe("the chat does /m's notification upkeep on a phone under the flag", () => {
      // syncAttention's badge call stands for PhoneNotificationUpkeep being mounted.
      let clearAppBadge: ReturnType<typeof vi.fn>;
      beforeEach(() => {
        clearAppBadge = vi.fn(async () => {});
        Object.defineProperty(navigator, 'clearAppBadge', { value: clearAppBadge, configurable: true });
      });
      afterEach(() => { delete (navigator as { clearAppBadge?: unknown }).clearAppBadge; });

      it('on a phone with the flag on', async () => {
        asPhone();
        phoneHome(true);
        await open('/chat', inChat, 'the chat');
        expect(clearAppBadge).toHaveBeenCalled();
        expect(errors).toEqual([]);
      });

      it('not with the flag off, nor on a desktop', async () => {
        asPhone();
        phoneHome(false);
        await open('/chat', inChat, 'the chat');
        act(() => root?.unmount());
        root = null;
        vi.stubGlobal('matchMedia', (media: string) => ({
          matches: false, media, onchange: null,
          addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
        }));
        phoneHome(true);
        await open('/chat', inChat, 'the chat');
        expect(clearAppBadge).not.toHaveBeenCalled();
      });

      it("infers a tap in a Mac's installed Safari app under the flag, and not with it off", async () => {
        // Apple's WebKit, installed (infersTaps); the worker lookup stands for the inferred tap looking.
        const getRegistration = vi.fn(async () => undefined);
        Object.defineProperty(navigator, 'vendor', { value: 'Apple Computer, Inc.', configurable: true });
        Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
        Object.defineProperty(navigator, 'serviceWorker', { value: { getRegistration }, configurable: true });
        try {
          phoneHome(false);
          await open('/chat', inChat, 'the chat');
          expect(getRegistration).not.toHaveBeenCalled();
          act(() => root?.unmount());
          root = null;
          phoneHome(true);
          await open('/chat', inChat, 'the chat');
          expect(getRegistration).toHaveBeenCalled();
          // A desktop: none of the phone's badge upkeep.
          expect(clearAppBadge).not.toHaveBeenCalled();
        } finally {
          for (const key of ['vendor', 'standalone', 'serviceWorker']) delete (navigator as unknown as Record<string, unknown>)[key];
        }
      });
    });

    it('the installed app on a touch device opens /m, and the chat with the flag on', async () => {
      asPhone(['(display-mode: standalone)']);
      phoneHome(false);
      await open('/app', onPhoneClient, 'the phone client');
      expect(where).toBe('/m');
      act(() => root?.unmount());
      phoneHome(true);
      await open('/app', inChat, 'the chat');
      expect(where).toBe('/chat');
    });
  });

  it('a user who never finished setup goes to /welcome', async () => {
    net.routes.set('/auth/me', { ...USER, needsOnboarding: true });
    await open('/', () => where === '/welcome', '/welcome');
    expect(errors).toEqual([]);
  });
});
