// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRepoView } from '../utils/projectRepos';

const mocks = vi.hoisted(() => ({ repos: vi.fn(), addRepo: vi.fn(), retryClone: vi.fn(), templates: vi.fn(), list: vi.fn() }));
vi.mock('../services/api', () => ({
  projectsApi: { repos: mocks.repos, addRepo: mocks.addRepo, retryClone: mocks.retryClone, templates: mocks.templates },
  githubReposApi: { list: mocks.list },
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { AddRepoDialog } = await import('./AddRepoDialog');

const CATALOG = {
  status: 'ok',
  groups: [{ owner: 'acme', kind: 'org', status: 'ok', repos: [
    { fullName: 'acme/api', defaultBranch: 'main' },
    { fullName: 'acme/docs', defaultBranch: 'main' },
    { fullName: 'acme/site', defaultBranch: 'main' },
    { fullName: 'Acme/Web', defaultBranch: 'main' },
  ] }],
};
const row = (name: string, position: number, over: Partial<ProjectRepoView> = {}): ProjectRepoView => ({
  name, url: `https://github.com/acme/${name}.git`, defaultBranch: 'main', setupStatus: 'ready', setupError: null, position, ...over,
});

let root: Root;
let el: HTMLDivElement;
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const button = (label: string) => [...document.querySelectorAll('button')].find(b => b.textContent === label) as HTMLButtonElement | undefined;
const click = async (b: HTMLElement | undefined) => { await act(async () => { b!.click(); }); await flush(); };

async function open() {
  await act(async () => root.render(<AddRepoDialog project={{ id: 'p1', name: 'shop' }} onClose={() => {}} onChanged={() => {}} />));
  await flush();
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.templates.mockResolvedValue([{ id: 't1', label: 'Starter', blurb: 'x', repoUrl: 'https://github.com/acme/starter' }]);
  mocks.list.mockResolvedValue(CATALOG);
  mocks.repos.mockResolvedValue({ repos: [row('web', 0), row('api', 1)] });
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); });

describe('the classic Add repository dialog', () => {
  it('lists repositories only, the project\'s ticked and locked', async () => {
    await open();
    expect(button('Starter — x')).toBeUndefined();
    expect([...document.querySelectorAll('button')].some(b => b.textContent?.startsWith('empty:'))).toBe(false);
    expect(document.getElementById('npf-paste')).toBeNull();
    for (const name of ['acme/api', 'Acme/Web']) {
      expect(button(name)!.disabled).toBe(true);
      expect(button(name)!.getAttribute('aria-pressed')).toBe('true');
    }
    expect(button('acme/docs')!.disabled).toBe(false);
    expect(button('Add')!.disabled).toBe(true);
  });

  it('adds the newly ticked ones, then shows each clone', async () => {
    mocks.addRepo
      .mockResolvedValueOnce({ repo: row('docs', 2, { setupStatus: 'pending' }) })
      .mockResolvedValueOnce({ repo: row('site', 3, { setupStatus: 'pending' }) });
    await open();
    await click(button('acme/docs'));
    await click(button('acme/site'));
    await click(button('Add 2 repositories'));
    expect(mocks.addRepo.mock.calls).toEqual([
      ['p1', { url: 'https://github.com/acme/docs.git' }],
      ['p1', { url: 'https://github.com/acme/site.git' }],
    ]);
    const lines = [...document.querySelectorAll('.ard-repos li')].map(li => li.textContent);
    expect(lines).toEqual(['webready', 'apiready', 'docsWaiting to clone', 'siteWaiting to clone']);
    expect(button('Add')!.disabled).toBe(true);
  });

  it('keeps a refused one ticked with the reason, and retries a failed clone', async () => {
    mocks.repos.mockResolvedValue({ repos: [row('web', 0), row('api', 1, { setupStatus: 'failed', setupError: 'repository not found' })] });
    mocks.addRepo.mockRejectedValue({ response: { status: 400, data: { error: 'a project holds at most 8 repositories' } } });
    await open();
    await click(button('acme/docs'));
    await click(button('Add'));
    expect(document.querySelector('[role="alert"]')!.textContent).toBe('a project holds at most 8 repositories');
    expect(button('acme/docs')!.getAttribute('aria-pressed')).toBe('true');
    expect(document.body.textContent).toContain('Failed: repository not found');
    mocks.retryClone.mockResolvedValue({ setupStatus: 'cloning' });
    await click(button('Retry'));
    expect(mocks.retryClone).toHaveBeenCalledWith('p1');
  });
});
