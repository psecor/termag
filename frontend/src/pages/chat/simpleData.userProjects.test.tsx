// @vitest-environment jsdom
// The page's read of the person's projects:
// only under user-projects-enabled, again on a projects push, and, when the flag
// turns on while the page is open, the project list too (it was read with the flag off).
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';
import { PROJECTS_PUSH_EVENT } from '../../utils/workspacePush';
import { SimpleDataProvider, useSimpleData, type SimpleData } from './simpleData';

const mocks = vi.hoisted(() => ({
  on: false,
  projects: [] as Project[],
  reloadProjects: vi.fn(async () => {}),
  list: vi.fn(async (): Promise<unknown> => []),
}));

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', unixUsername: 'ada' } }) }));
vi.mock('../../contexts/ProjectContext', () => ({
  useProjects: () => ({ projects: mocks.projects, projectsLoaded: true, statusMap: {}, reloadProjects: mocks.reloadProjects }),
  LAST_ACTIVE_PROJECT_KEY: 'k',
}));
vi.mock('../../chat/useChatSpaces', () => ({
  useSharedChatSpaces: () => ({ loaded: true, current: true, spaces: [], index: new Map(), colorOf: () => '#888' }),
}));
vi.mock('../../services/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    spawnsApi: { ...actual.spawnsApi, parents: async () => ({ links: [] }) },
    userProjectsApi: { ...actual.userProjectsApi, list: mocks.list },
  };
});
vi.mock('../../flags', async () => {
  const actual = await vi.importActual<typeof import('../../flags')>('../../flags');
  return { ...actual, useFlag: <T,>(key: string, fallback: T) => (key === 'user-projects-enabled' ? mocks.on as T : fallback) };
});

const checkout = (id: string, userProjectId: string | null) =>
  ({ id, name: id, instanceId: 'box-1', archived: false, userProjectId, workflows: [], workstreams: [] }) as unknown as Project;
const view = (id: string, name: string, archived = false) => ({ id, name, archived, repos: [], lastActiveAt: '2026-11-12T12:00:00Z', filesSpace: null, checkouts: [] });

let root: Root;
let host: HTMLDivElement;
let data: SimpleData | null = null;
function Probe() { data = useSimpleData(); return null; }
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const show = () => act(() => root.render(<MemoryRouter initialEntries={['/chat']}><SimpleDataProvider><Probe /></SimpleDataProvider></MemoryRouter>));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  vi.clearAllMocks();
  mocks.on = false;
  mocks.projects = [checkout('c1', 'up-1'), checkout('c2', 'up-old'), checkout('c3', null)];
  mocks.list.mockResolvedValue([view('up-1', 'Termag web'), view('up-old', 'Put away', true)]);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  data = null;
});

describe('SimpleDataProvider: the person\'s projects', () => {
  it('reads nothing with the flag off', async () => {
    show();
    await flush();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(data!.userProjects.list).toBeNull();
    expect(data!.userProjects.settled).toBe(false);
    expect(data!.userProjectOf('c1')).toBeNull();
  });

  it("reads them with the flag on, names a checkout's live project, and reads again on a projects push", async () => {
    mocks.on = true;
    show();
    await flush();
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(data!.userProjectOf('c1')).toEqual({ id: 'up-1', name: 'Termag web' });
    // An archived project's checkout, and one with none, have no project to show.
    expect(data!.userProjectOf('c2')).toBeNull();
    expect(data!.userProjectOf('c3')).toBeNull();
    // On at load: the project list ProjectContext read already carries userProjectId.
    expect(mocks.reloadProjects).not.toHaveBeenCalled();
    await act(async () => { window.dispatchEvent(new Event(PROJECTS_PUSH_EVENT)); });
    await flush();
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('reads the project list again when the flag turns on while the page is open', async () => {
    show();
    await flush();
    mocks.on = true;
    show();
    await flush();
    expect(mocks.reloadProjects).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("keeps the last list and says the read failed, but takes the server's flag off as nothing to show", async () => {
    mocks.on = true;
    show();
    await flush();
    mocks.list.mockRejectedValueOnce(new Error('down'));
    await act(async () => { await data!.userProjects.reload(); });
    expect(data!.userProjects.failed).toBe(true);
    expect(data!.userProjects.list).toHaveLength(2);
    mocks.list.mockRejectedValueOnce({ response: { status: 404, data: { code: 'user_projects_disabled' } } });
    await act(async () => { await data!.userProjects.reload(); });
    expect(data!.userProjects).toMatchObject({ list: null, failed: false, settled: true });
  });
});
