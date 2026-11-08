// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceView } from '../../services/api';
import type { AgentStatus, Project } from '../../types';
import { spaceColor } from '../../chat/spaceColors';
import { ChatSidebar } from './ChatSidebar';
import { ChatChromeProvider, type ChatChrome } from './chatChrome';

function space(name: string, role: SpaceView['role'], readOnly = false): SpaceView {
  return { id: `id-${name}`, name, description: null, createdAt: '', usedBytes: 0, quotaBytes: 1, role, readOnly };
}

function project(id: string, instanceId: string): Project {
  return {
    id, name: id, instanceId, archived: false, pinned: false, lastActiveAt: null,
    workflows: [{ type: 'agent' }], workstreams: [],
  } as unknown as Project;
}

const mocks = vi.hoisted(() => ({
  projects: [] as Project[],
  spaces: [] as SpaceView[],
  index: new Map<string, string[]>(),
  statusMap: {} as Record<string, AgentStatus>,
  links: [] as Array<{ projectId: string; workstream: string; parentProjectId: string; parentWorkstream: string }>,
  boxes: [] as Array<{ id: string; name: string }>,
}));

vi.mock('../../services/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  spawnsApi: { parents: async () => ({ links: mocks.links }) },
  automationsApi: { list: async () => [] },
}));
vi.mock('./OpenItems', () => ({ OpenItemsGroups: () => null }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { unixUsername: 'ada' } }) }));
vi.mock('../../contexts/ProjectContext', () => ({ useProjects: () => ({ projects: mocks.projects, statusMap: mocks.statusMap }) }));
vi.mock('../../services/boxFeed', () => ({
  boxFeed: { subscribe: () => () => {}, getSnapshot: () => mocks.boxes },
}));
vi.mock('../../chat/useChatSpaces', () => ({
  useSharedChatSpaces: () => ({ loaded: true, current: true, spaces: mocks.spaces, index: mocks.index, colorOf: spaceColor }),
}));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  root = createRoot(host);
  localStorage.clear();
  mocks.statusMap = {};
  mocks.links = [];
  mocks.boxes = [];
});

afterEach(() => {
  act(() => root.unmount());
});

describe('ChatSidebar', () => {
  it('names the list Sessions and offers a new one when none exist', () => {
    mocks.projects = [];
    mocks.spaces = [];
    mocks.index = new Map();
    act(() => root.render(<MemoryRouter><ChatSidebar /></MemoryRouter>));
    expect(host.querySelector('nav')?.getAttribute('aria-label')).toBe('Sessions');
    expect(host.querySelector('.chat-new')?.getAttribute('aria-label')).toBe('New session');
  });

  it('keeps a docked list in the tab order and drops a closed phone drawer', () => {
    mocks.projects = [project('a', 'box-a')];
    mocks.spaces = [];
    mocks.index = new Map();
    const chrome = (mode: ChatChrome['mode'], historyOpen: boolean): ChatChrome => ({
      mode, historyOpen, openHistory: () => {}, closeHistory: () => {},
    });
    act(() => root.render(
      <ChatChromeProvider value={chrome('docked', false)}><MemoryRouter><ChatSidebar /></MemoryRouter></ChatChromeProvider>,
    ));
    const nav = () => host.querySelector('nav')!;
    expect(nav().hasAttribute('inert')).toBe(false);
    expect(nav().getAttribute('aria-hidden')).toBeNull();

    act(() => root.render(
      <ChatChromeProvider value={chrome('drawer', false)}><MemoryRouter><ChatSidebar /></MemoryRouter></ChatChromeProvider>,
    ));
    expect(nav().hasAttribute('inert')).toBe(true);
    expect(nav().getAttribute('aria-hidden')).toBe('true');

    act(() => root.render(
      <ChatChromeProvider value={chrome('drawer', true)}><MemoryRouter><ChatSidebar /></MemoryRouter></ChatChromeProvider>,
    ));
    expect(nav().hasAttribute('inert')).toBe(false);
    expect(nav().getAttribute('aria-hidden')).toBeNull();
  });
});
