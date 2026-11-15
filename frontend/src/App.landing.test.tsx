// @vitest-environment jsdom
// The real App loaded at the bare workspace URL, as an Okta tile launch opens
// it (/termag/), by someone whose choice is the chat and who has a project
// remembered from their last visit. SimpleUiReturnGate redirects to /chat, and
// in the same commit ProjectContext's restore seeds ?project=<last>, which
// resolves against `/` and puts the page back on the workspace URL. The gate
// decides once, so its <Navigate> never ran again: a blank page until a
// refresh. In its own file because the page's entry
// (chat/uiMode.ts pageEntry) is read once per module load, and the workspace
// tests in App.routes.test.tsx clear it.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // xterm probes a canvas when it is imported, and jsdom has none.
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});

const net = vi.hoisted(() => ({ routes: new Map<string, unknown>() }));

// Answers services/api.ts in memory, as App.routes.test.tsx does: a path with no answer is a 404.
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
import { LAST_ACTIVE_PROJECT_KEY } from './contexts/ProjectContext';
import { UI_MODE_KEY } from './chat/uiMode';

const USER = {
  id: 'user-1', email: 'e2e@termag.local', displayName: 'E2E', unixUsername: 'e2e',
  defaultAgentProvider: 'claude', dotfilesRepoUrl: null, role: 'admin', needsOnboarding: false,
  theme: { version: 1, background: { mode: 'solid', color: '#0d1117' }, sidebarActivity: false, sidebarMetaTerm: false },
};
const PROJECT = {
  id: 'p1', name: 'p1', kind: 'normal', archived: false, instanceId: null, setupStatus: null, role: 'owner', ownerUsername: 'e2e',
  workflows: [], workstreams: [{ id: 'p1-ws0', name: 'main' }],
};

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
// Every path and query the router showed, in order.
let visited: string[] = [];
function Location() {
  const { pathname, search } = useLocation();
  where = pathname;
  if (visited[visited.length - 1] !== `${pathname}${search}`) visited.push(`${pathname}${search}`);
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
  net.routes.set('/auth/me', USER);
  net.routes.set('/api/example-org/bootstrap', { clientSideId: null, context: null, bootstrap: null, overrides: {} });
  setFlagValues({});
  net.routes.set('/api/projects', [PROJECT]);
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  container = document.createElement('div');
  document.body.appendChild(container);
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

it('with the chat chosen and a project remembered, a load of / opens the chat, not a blank page', { timeout: 10_000 }, async () => {
  localStorage.setItem(UI_MODE_KEY, 'simple');
  localStorage.setItem(LAST_ACTIVE_PROJECT_KEY, 'p1');
  root = createRoot(container);
  await act(async () => {
    root!.render(<MemoryRouter initialEntries={['/']}><App /><Location /></MemoryRouter>);
  });
  const inChat = () => where === '/chat' && container.querySelector('.chat-root') != null;
  for (let i = 0; i < 300 && !inChat(); i++) await tick();
  expect(where).toBe('/chat');
  expect(container.querySelector('.chat-root')).not.toBeNull();
  expect(errors).toEqual([]);
});
