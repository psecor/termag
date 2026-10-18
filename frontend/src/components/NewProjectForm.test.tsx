// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, Project } from '../types';
import { NewProjectForm } from './NewProjectForm';

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let boxes: Instance[] = [];
  let loaded = false;
  const emit = () => { for (const fn of listeners) fn(); };
  return {
    flags: {} as Record<string, boolean>,
    projects: [] as Project[],
    user: {
      id: 'u1', email: 'ada@example.com', displayName: 'Ada', unixUsername: 'ada',
      defaultAgentProvider: 'claude', dotfilesRepoUrl: null, theme: {},
    },
    feed: {
      subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
      getSnapshot: () => boxes,
      hasLoaded: () => loaded,
      reload: vi.fn(async () => { loaded = true; emit(); }),
      upsert(box: Instance) { boxes = [box, ...boxes.filter(b => b.id !== box.id)]; emit(); },
    },
    setBoxes(next: Instance[]) { boxes = next; loaded = true; emit(); },
    resetFeed() { boxes = []; loaded = false; listeners.clear(); },
    api: {
      listProjects: vi.fn(async () => [] as Project[]),
      templates: vi.fn(async () => [
        { id: 'webapp', label: 'webapp', repoUrl: 'https://github.com/example-org/webapp.git', blurb: 'The app' },
        { id: 'research', label: 'research', repoUrl: 'https://github.com/example-org/research.git', blurb: 'Notebooks' },
      ]),
      createProject: vi.fn(),
      createBox: vi.fn(),
      credentials: vi.fn(async (): Promise<{ github: { boxGate: 'off' | 'clear' | 'blocked' } }> => ({ github: { boxGate: 'off' } })),
      repos: vi.fn(async () => ({ status: 'ok', groups: [] })),
    },
  };
});

vi.mock('../flags', () => ({
  FLAGS: { repoFirstPicker: 'repo-first-picker-enabled', warmPool: 'warm-pool-enabled' },
  useFlag: (key: string, fallback: boolean) => (key in mocks.flags ? mocks.flags[key] : fallback),
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock('../contexts/ProjectContext', () => ({
  useProjects: () => ({ projects: mocks.projects, reloadProjects: vi.fn(), setActiveProject: vi.fn() }),
}));
vi.mock('../services/boxFeed', () => ({ boxFeed: mocks.feed }));
vi.mock('../services/claimTiming', () => ({
  noteAddBoxClick: vi.fn(), noteBoxClaimed: vi.fn(), notePickerMounted: vi.fn(),
  notePickerSubmitted: vi.fn(), noteProjectCreated: vi.fn(),
}));
vi.mock('../observability', () => ({ replaySessionId: async () => null }));
vi.mock('../services/api', () => ({
  projectsApi: {
    list: mocks.api.listProjects,
    templates: mocks.api.templates,
    create: mocks.api.createProject,
  },
  instancesApi: { list: vi.fn(), create: mocks.api.createBox },
  credentialsApi: { get: mocks.api.credentials },
  githubReposApi: { list: mocks.api.repos },
  warmPoolApi: { get: vi.fn(async () => ({ warm: 0, warming: 0, target: 0 })) },
}));

function makeBox(over: Partial<Instance> & Pick<Instance, 'id' | 'name'>): Instance {
  return {
    kind: 'ec2', status: 'ready', createdAt: '2026-10-01T00:00:00.000Z', ...over,
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.flags = { 'repo-first-picker-enabled': true };
  mocks.projects = [];
  mocks.resetFeed();
  mocks.setBoxes([makeBox({ id: 'box-1', name: 'box-1' })]);
  mocks.api.credentials.mockResolvedValue({ github: { boxGate: 'off' } });
  mocks.api.createBox.mockImplementation(async (boxName: string) => ({
    instance: makeBox({ id: 'created', name: boxName, status: 'provisioning' }),
    claimed: false,
  }));
  mocks.api.createProject.mockImplementation(async (data: { name: string; instanceId: string | null }) => ({
    id: 'p-new', name: data.name, archived: false, instanceId: data.instanceId,
    workflows: [], workstreams: [],
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function settle() {
  for (let i = 0; i < 15; i++) await act(async () => { await Promise.resolve(); });
}

async function renderForm(props: Partial<React.ComponentProps<typeof NewProjectForm>> = {}) {
  const onCreated = props.onCreated ?? vi.fn(async () => {});
  await act(async () => {
    root.render(
      <MemoryRouter>
        <NewProjectForm submitLabel="Create and open" {...props} onCreated={onCreated} />
      </MemoryRouter>,
    );
  });
  await settle();
  return onCreated;
}

function field(id: string): HTMLInputElement | HTMLSelectElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as HTMLInputElement | HTMLSelectElement;
}

function submitButton(): HTMLButtonElement {
  const button = document.querySelector('button[type="submit"]');
  if (!(button instanceof HTMLButtonElement)) throw new Error('missing submit');
  return button;
}

async function clickSubmit() {
  await act(async () => { submitButton().click(); });
  await settle();
}

describe('simplified new project form', () => {
  it('opens on the repository list with the other choices collapsed', async () => {
    await renderForm();
    const details = document.querySelector('details.npf-advanced');
    expect(details).toBeTruthy();
    expect((details as HTMLDetailsElement).open).toBe(false);
    expect(field('npf-repo-search').closest('details')).toBeNull();
    expect(field('npf-name').closest('details')).toBe(details);
    expect(field('npf-paste').closest('details')).toBe(details);
    expect(field('npf-provider').closest('details')).toBe(details);
    expect(field('npf-box').closest('details')).toBe(details);
    const empty = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('fresh directory'));
    const starter = [...document.querySelectorAll('button')].find(b => b.textContent?.startsWith('webapp'));
    expect(empty?.closest('details')).toBeNull();
    expect(starter?.closest('details')).toBeNull();
    expect(document.body.textContent).toContain('Advanced settings');
    expect(field('npf-box').value).toBe('__new__');
    expect(field('npf-box-name').value).toBe(field('npf-name').value);
    expect(field('npf-name').value).toMatch(/^proj-/);
  });

  it('creates a new box named after the project and does not reuse the ready box', async () => {
    const onCreated = await renderForm();
    const projectName = field('npf-name').value;
    expect(submitButton().disabled).toBe(false);
    await clickSubmit();
    expect(mocks.api.createBox).toHaveBeenCalledTimes(1);
    expect(mocks.api.createBox).toHaveBeenCalledWith(projectName, 'ec2');
    expect(mocks.api.createProject).toHaveBeenCalledWith(expect.objectContaining({
      name: projectName,
      instanceId: 'created',
      initialAgent: { enabled: true, provider: 'claude' },
      repoUrl: null,
    }));
    expect(onCreated).toHaveBeenCalled();
  });

  it('uses an existing box chosen in Advanced and does not provision one', async () => {
    await renderForm();
    await act(async () => { document.querySelector('summary')!.click(); });
    const box = field('npf-box') as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(box, 'box-1');
      box.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await clickSubmit();
    expect(mocks.api.createBox).not.toHaveBeenCalled();
    expect(mocks.api.createProject).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'box-1' }));
  });

  it('keeps an initial box and does not provision another', async () => {
    await renderForm({ initialBoxId: 'box-1' });
    expect(field('npf-box').value).toBe('box-1');
    await clickSubmit();
    expect(mocks.api.createBox).not.toHaveBeenCalled();
    expect(mocks.api.createProject).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'box-1' }));
  });

  it('shows a taken box name and does not launch under another name', async () => {
    await renderForm();
    const name = field('npf-name') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'box-1');
      name.dispatchEvent(new Event('input', { bubbles: true }));
      name.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(document.body.textContent).toContain('A box named "box-1" already exists');
    expect((document.querySelector('details') as HTMLDetailsElement).open).toBe(true);
    expect(submitButton().disabled).toBe(true);
    await clickSubmit();
    expect(mocks.api.createBox).not.toHaveBeenCalled();
  });

  it('shows the GitHub gate on the collapsed form', async () => {
    mocks.api.credentials.mockResolvedValue({ github: { boxGate: 'blocked' } });
    await renderForm();
    const details = document.querySelector('details.npf-advanced') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.textContent).not.toContain('Connect GitHub');
    expect(document.body.textContent).toContain('Connect GitHub in Settings to add a box');
    expect(submitButton().disabled).toBe(true);
    expect(submitButton().title).toBe('Connect GitHub in Settings to add a box');
    await clickSubmit();
    expect(mocks.api.createBox).not.toHaveBeenCalled();
  });

  it('does not provision a second box when the project create is refused', async () => {
    mocks.api.createProject.mockRejectedValueOnce({ response: { data: { error: 'nope' } } });
    await renderForm();
    await clickSubmit();
    expect(mocks.api.createBox).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('nope');
    await clickSubmit();
    expect(mocks.api.createBox).toHaveBeenCalledTimes(1);
    expect(mocks.api.createProject).toHaveBeenCalledTimes(2);
    expect(mocks.api.createProject.mock.calls[1][0]).toEqual(expect.objectContaining({ instanceId: 'created' }));
  });

  it('keeps the flag-off form on the ready box', async () => {
    mocks.flags = {};
    await renderForm();
    expect(document.querySelector('details.npf-advanced')).toBeNull();
    expect(field('npf-start')).toBeTruthy();
    expect(field('npf-box').value).toBe('box-1');
    expect(document.getElementById('npf-box-name')).toBeNull();
    await clickSubmit();
    expect(mocks.api.createBox).not.toHaveBeenCalled();
    expect(mocks.api.createProject).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'box-1' }));
  });
});
