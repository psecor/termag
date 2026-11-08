// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRepoView } from '../../utils/projectRepos';
import type { Project } from '../../types';

const mocks = vi.hoisted(() => ({ repos: vi.fn(), addRepo: vi.fn(), retryClone: vi.fn(), list: vi.fn(), reloadProjects: vi.fn() }));
const flag = vi.hoisted(() => ({ multiRepo: true }));
vi.mock('../../services/api', () => ({
  projectsApi: { repos: mocks.repos, addRepo: mocks.addRepo, retryClone: mocks.retryClone },
  githubReposApi: { list: mocks.list },
}));
vi.mock('../../contexts/ProjectContext', () => ({ useProjects: () => ({ reloadProjects: mocks.reloadProjects }) }));
vi.mock('../../flags', async () => {
  const actual = await vi.importActual<typeof import('../../flags')>('../../flags');
  return { ...actual, useFlag: <T,>(key: string, fallback: T) => (key === 'multi-repo-projects-enabled' ? flag.multiRepo as T : fallback) };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SessionRepoPill } = await import('./SessionRepoPill');
const { REPOS_POLL_MS } = await import('../../hooks/useProjectRepos');

const CATALOG = {
  status: 'ok',
  groups: [{ owner: 'acme', kind: 'org', status: 'ok', repos: [
    { fullName: 'acme/api', defaultBranch: 'main' },
    { fullName: 'acme/docs', defaultBranch: 'main' },
    { fullName: 'acme/web', defaultBranch: 'main' },
  ] }],
};
const row = (name: string, position: number, over: Partial<ProjectRepoView> = {}): ProjectRepoView => ({
  name, url: `https://github.com/acme/${name}.git`, defaultBranch: 'main', setupStatus: 'ready', setupError: null, position, ...over,
});
const shop = { id: 'p1', name: 'shop', layout: 'workspace', role: 'owner' } as Project;

let root: Root;
let el: HTMLDivElement;
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const pill = () => el.querySelector<HTMLButtonElement>('.chat-compose-repo-btn');
const option = (fullName: string) => el.querySelector<HTMLElement>(`[role="option"][data-repo="${fullName}"]`);
const click = async (b: HTMLElement | null | undefined) => { await act(async () => { b!.click(); }); await flush(); };

async function show(project: Project = shop) {
  await act(async () => root.render(<SessionRepoPill project={project} />));
  await flush();
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.list.mockResolvedValue(CATALOG);
  mocks.repos.mockResolvedValue({ repos: [row('web', 0), row('api', 1)] });
  flag.multiRepo = true;
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); vi.useRealTimers(); });

describe('the repo pill over a started session', () => {
  it('is not there with the flag off, on a single-repository project, or for a collaborator', async () => {
    flag.multiRepo = false;
    await show();
    expect(pill()).toBeNull();
    flag.multiRepo = true;
    await show({ ...shop, layout: 'repo' });
    expect(pill()).toBeNull();
    await show({ ...shop, role: 'collaborator' });
    expect(pill()).toBeNull();
    expect(mocks.repos).not.toHaveBeenCalled();
  });

  it('names the project\'s repositories, ticked and locked, the others open to add', async () => {
    await show();
    expect(pill()!.textContent).toBe('acme/web + api');
    await click(pill());
    for (const name of ['acme/web', 'acme/api']) {
      expect(option(name)!.getAttribute('aria-selected')).toBe('true');
      expect(option(name)!.getAttribute('aria-disabled')).toBe('true');
    }
    expect(option('acme/docs')!.getAttribute('aria-selected')).toBe('false');
    expect(option('acme/docs')!.getAttribute('aria-disabled')).toBeNull();
    expect(el.textContent).toContain('start a new session or project');
    expect(el.querySelector('.chat-compose-paste')).toBeNull();
  });

  it('adds a ticked repository, shows its clone, and reloads the projects once it is in', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    mocks.addRepo.mockResolvedValue({ repo: row('docs', 2, { setupStatus: 'pending' }) });
    await show();
    await click(pill());
    await click(option('acme/docs'));
    expect(mocks.addRepo).toHaveBeenCalledWith('p1', { url: 'https://github.com/acme/docs.git' });
    expect(pill()!.textContent).toBe('acme/web + api + docscloning…');
    expect(option('acme/docs')!.getAttribute('aria-disabled')).toBe('true');
    expect(option('acme/docs')!.textContent).toContain('Waiting to clone');

    mocks.repos.mockResolvedValue({ repos: [row('web', 0), row('api', 1), row('docs', 2)] });
    await act(async () => { vi.advanceTimersByTime(REPOS_POLL_MS); });
    await flush();
    expect(pill()!.textContent).toBe('acme/web + api + docs');
    expect(option('acme/docs')!.textContent).toBe('acme/docs');
    expect(mocks.reloadProjects).toHaveBeenCalledTimes(1);
  });

  it('shows a failed clone on its row and the pill, and retries it', async () => {
    mocks.repos.mockResolvedValue({ repos: [row('web', 0), row('docs', 1, { setupStatus: 'failed', setupError: 'repository not found' })] });
    mocks.retryClone.mockResolvedValue({ setupStatus: 'ready' });
    await show();
    expect(pill()!.textContent).toBe('acme/web + docsfailed');
    await click(pill());
    expect(option('acme/docs')!.textContent).toContain('Failed: repository not found');
    await click([...el.querySelectorAll('button')].find(b => b.textContent === 'Retry'));
    expect(mocks.retryClone).toHaveBeenCalledWith('p1');
  });

  it('says why an add was refused', async () => {
    mocks.addRepo.mockRejectedValue({ response: { status: 400, data: { error: 'a project holds at most 8 repositories' } } });
    await show();
    await click(pill());
    await click(option('acme/docs'));
    expect(el.querySelector('[role="alert"]')!.textContent).toBe('a project holds at most 8 repositories');
    expect(option('acme/docs')!.getAttribute('aria-selected')).toBe('false');
  });
});
