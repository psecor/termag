// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRow } from '../../services/api';
import type { Project } from '../../types';
import { DashboardSearch } from './DashboardSearch';

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { unixUsername: 'psecor' } }) }));
vi.mock('../../observability', () => ({ trackEvent: () => {} }));
vi.mock('../../hooks/useRecents', () => ({ useRecents: () => ({ rows: [], loading: false, refresh: () => {} }) }));
vi.mock('../../services/api', () => ({ sessionsApi: { search: vi.fn() }, prsApi: { list: () => Promise.resolve({ connected: false }) } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const termag = {
  id: 'p1', name: 'termag', instanceId: 'box1', archived: false,
  workflows: [{ id: 'wf1', type: 'agent', provider: 'claude', server: 'x', projectId: 'p1' }],
  workstreams: [
    { id: 'ws1', projectId: 'p1', name: 'main', branch: 'main', archived: false, lastActiveAt: at(5), createdAt: at(600), updatedAt: at(5) },
    { id: 'ws2', projectId: 'p1', name: 'termag-tui', branch: 'termag-tui', archived: false, lastActiveAt: at(9), createdAt: at(600), updatedAt: at(9) },
  ],
} as unknown as Project;
const session = {
  projectId: 'p1', projectName: 'termag', owner: 'psecor', access: 'owner', workstream: 'termag-tui', role: 'agent',
  session: 'psecor-termag-termag-tui-agent', instanceId: 'box1', connected: true, alive: true, status: 'waiting', contextTokens: null,
  updatedAt: at(2), waitingReason: 'user_input', rateLimited: null, provider: 'claude', lastActiveAt: at(2),
} as SessionRow;

let path = '';
function Probe() {
  const l = useLocation();
  path = `${l.pathname}${l.search}`;
  return null;
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn(); // jsdom has no layout
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(
    <MemoryRouter initialEntries={['/dashboard']}><DashboardSearch sessions={[session]} projects={[termag]} now={Date.now()} /><Probe /></MemoryRouter>,
  ));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const input = () => document.querySelector<HTMLInputElement>('.palette-input');
function type(text: string) {
  const el = input()!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => { (input() ?? window).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init })); });

describe('DashboardSearch', () => {
  it('⌘K opens the palette over the dashboard, with the button beside it', async () => {
    expect(document.querySelector('.search-trigger')).not.toBeNull();
    await act(async () => { press('k', { metaKey: true }); await Promise.resolve(); });
    expect(input()).not.toBeNull();
  });

  it('finds sessions from the dashboard poll and opens one in the workspace', async () => {
    await act(async () => { press('k', { metaKey: true }); await Promise.resolve(); });
    type('tui');
    expect(document.querySelector('.palette-scroll')?.textContent).toContain('termag-tui');
    press('Enter');
    expect(path).toBe('/?project=p1&ws=termag-tui');
    expect(input()).toBeNull();
  });
});
