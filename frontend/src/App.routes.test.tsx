// @vitest-environment jsdom
// Renders the real App (every provider, gate and lazy page) at each top-level
// route, with the network answered in memory: which page each URL lands on,
// the redirects between them, and that rendering logs no React error. It
// backs dependency upgrades (React, react-router) that change how routes
// render and resolve.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
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
      data: found ? net.routes.get(path) : { error: 'not found' },
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

const SIMPLE_UI = { 'simple-ui-enabled': true };

class FakeSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = 0;
  onopen = null; onmessage = null; onclose = null; onerror = null;
  constructor(readonly url: string) {}
  send() {}
  close() { this.readyState = 3; }
  addEventListener() {}
  removeEventListener() {}
}

let where = '';
function Location() {
  where = useLocation().pathname;
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

/** Renders the app at `path` and waits until `landed` holds, then lets the first reads settle. */
async function open(path: string, landed: () => boolean, what: string) {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <App />
        <Location />
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

  it('without simple-ui-enabled, /chat goes to the workspace', async () => {
    net.routes.set('/api/example-org/bootstrap', { clientSideId: null, context: null, bootstrap: null, overrides: {} });
    setFlagValues({});
    await open('/chat', () => where === '/' && has('.app-layout')(), 'the workspace');
    expect(errors).toEqual([]);
  });

  it('a user who never finished setup goes to /welcome', async () => {
    net.routes.set('/auth/me', { ...USER, needsOnboarding: true });
    await open('/', () => where === '/welcome', '/welcome');
    expect(errors).toEqual([]);
  });
});
