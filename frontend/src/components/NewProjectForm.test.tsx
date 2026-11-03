// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, Project } from '../types';
import { NewProjectForm } from './NewProjectForm';
import { resetBackendChoicesForTests } from '../providers/useBackendChoices';

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let boxes: Instance[] = [];
  let loaded = false;
  let failing = false;
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
      isFailing: () => failing,
      reload: vi.fn(async () => { loaded = true; emit(); }),
      upsert(box: Instance) { boxes = [box, ...boxes.filter(b => b.id !== box.id)]; emit(); },
    },
    setBoxes(next: Instance[]) { boxes = next; loaded = true; emit(); },
    setFailing(next: boolean) { failing = next; emit(); },
    resetFeed() { boxes = []; loaded = false; failing = false; listeners.clear(); },
    api: {
      listProjects: vi.fn(async () => [] as Project[]),
      templates: vi.fn(async () => [
        { id: 'webapp', label: 'webapp', repoUrl: 'https://github.com/example-org/webapp.git', blurb: 'The app' },
        { id: 'research', label: 'research', repoUrl: 'https://github.com/example-org/research.git', blurb: 'Notebooks' },
      ]),
      createProject: vi.fn(),
      createBox: vi.fn(),
      sizes: vi.fn(async (): Promise<unknown> => ({ enabled: false, default: null, sizes: [] })),
      warmPool: vi.fn(async () => ({ warm: 0, warming: 0, target: 0 })),
      credentials: vi.fn(async (): Promise<{ github: { boxGate: 'off' | 'clear' | 'blocked' } }> => ({ github: { boxGate: 'off' } })),
      repos: vi.fn(async () => ({ status: 'ok', groups: [] as unknown[] })),
      models: vi.fn(async () => ({ providers: {} as Record<string, unknown> })),
    },
  };
});

vi.mock('../flags', () => ({
  FLAGS: { repoFirstPicker: 'repo-first-picker-enabled', warmPool: 'warm-pool-enabled', multiRepo: 'multi-repo-projects-enabled' },
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
  instancesApi: { list: vi.fn(), create: mocks.api.createBox, sizes: mocks.api.sizes },
  credentialsApi: { get: mocks.api.credentials },
  githubReposApi: { list: mocks.api.repos },
  warmPoolApi: { get: mocks.api.warmPool },
  providersApi: { models: mocks.api.models },
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
  mocks.api.models.mockResolvedValue({ providers: {} });
  mocks.api.repos.mockResolvedValue({ status: 'ok', groups: [] });
  mocks.api.sizes.mockResolvedValue({ enabled: false, default: null, sizes: [] });
  mocks.api.warmPool.mockResolvedValue({ warm: 0, warming: 0, target: 0 });
  resetBackendChoicesForTests();
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

function choose(id: string, value: string) {
  const el = field(id) as HTMLSelectElement;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

const KIMI = 'accounts/fireworks/models/kimi-k3';
const MENUS = {
  claude: [
    { id: null, label: 'Default', models: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }] },
    { id: 'fireworks', label: 'Fireworks', models: [{ id: KIMI, label: 'kimi-k3', context: 1048576 }] },
  ],
  pi: [{ id: null, label: 'Default', models: [] }, { id: 'fireworks', label: 'Fireworks', models: [{ id: KIMI, label: 'kimi-k3' }] }],
};
const options = (id: string) => [...(field(id) as HTMLSelectElement).options].map(o => o.textContent);

describe('new project form: inference and model', () => {
  it('offers neither field when the orchestrator offers no choice, and sends neither', async () => {
    await renderForm({ initialBoxId: 'box-1' });
    expect(document.getElementById('npf-backend')).toBeNull();
    expect(document.getElementById('npf-model')).toBeNull();
    await clickSubmit();
    expect(mocks.api.createProject).toHaveBeenCalledWith(expect.objectContaining({ initialAgent: { enabled: true, provider: 'claude' } }));
  });

  it('sends the picked backend and model, and an agent or backend change puts the model back to the default', async () => {
    mocks.api.models.mockResolvedValue({ providers: MENUS });
    await renderForm({ initialBoxId: 'box-1' });
    expect(options('npf-backend')).toEqual(['Default', 'Fireworks']);
    expect(options('npf-model')).toEqual(['Default', 'Opus', 'Sonnet']);
    await act(async () => { choose('npf-model', 'sonnet'); });
    await act(async () => { choose('npf-backend', 'fireworks'); });
    expect(options('npf-model')).toEqual(['Default', 'kimi-k3 · 1M context']);
    expect(field('npf-model').value).toBe('');
    await act(async () => { choose('npf-model', KIMI); });
    await clickSubmit();
    expect(mocks.api.createProject).toHaveBeenLastCalledWith(expect.objectContaining({
      initialAgent: { enabled: true, provider: 'claude', backend: 'fireworks', model: KIMI },
    }));

    await act(async () => { choose('npf-provider', 'cursor'); });
    expect(document.getElementById('npf-backend')).toBeNull();
    await act(async () => { choose('npf-provider', 'pi'); });
    expect(field('npf-backend').value).toBe('');
    expect(document.getElementById('npf-model')).toBeNull();
  });
});

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
    // No size picked (the picker is hidden while box-default-size is off): the server's default.
    expect(mocks.api.createBox).toHaveBeenCalledWith(projectName, 'ec2', { size: undefined, repo: null });
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

  it('defaults to the box of the current project and does not provision one', async () => {
    mocks.setBoxes([makeBox({ id: 'box-1', name: 'box-1' }), makeBox({ id: 'box-2', name: 'box-2' })]);
    await renderForm({ defaultBoxId: 'box-2' });
    expect(field('npf-box').value).toBe('box-2');
    expect(document.getElementById('npf-box-name')).toBeNull();
    await clickSubmit();
    expect(mocks.api.createBox).not.toHaveBeenCalled();
    expect(mocks.api.createProject).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'box-2' }));
  });

  it('starts a new box when the current project\'s box cannot take one', async () => {
    mocks.setBoxes([makeBox({ id: 'box-1', name: 'box-1', status: 'stopped' })]);
    await renderForm({ defaultBoxId: 'box-1' });
    expect(field('npf-box').value).toBe('__new__');
  });

  it('defaults to the current project\'s box while it boots, and creates on it', async () => {
    mocks.setBoxes([makeBox({ id: 'box-1', name: 'box-1', status: 'provisioning' })]);
    await renderForm({ defaultBoxId: 'box-1' });
    expect(field('npf-box').value).toBe('box-1');
    await clickSubmit();
    expect(mocks.api.createBox).not.toHaveBeenCalled();
    expect(mocks.api.createProject).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'box-1' }));
  });

  it('starts a new box when the current project\'s box is only starting, so Create stays open (Bugbot)', async () => {
    mocks.setBoxes([makeBox({ id: 'box-1', name: 'box-1', status: 'starting' })]);
    await renderForm({ defaultBoxId: 'box-1' });
    expect(field('npf-box').value).toBe('__new__');
  });

  it('keeps the select where it was when a feed poll changes the current project\'s box', async () => {
    mocks.setBoxes([makeBox({ id: 'box-1', name: 'box-1', status: 'provisioning' })]);
    await renderForm({ defaultBoxId: 'box-1' });
    expect(field('npf-box').value).toBe('box-1');
    await act(async () => { mocks.setBoxes([makeBox({ id: 'box-1', name: 'box-1', status: 'failed' })]); });
    await settle();
    expect(field('npf-box').value).toBe('box-1');
  });

  it('does not jump to the current project\'s box when it becomes ready after the form opened', async () => {
    mocks.setBoxes([makeBox({ id: 'box-1', name: 'box-1', status: 'stopped' })]);
    await renderForm({ defaultBoxId: 'box-1' });
    expect(field('npf-box').value).toBe('__new__');
    await act(async () => { mocks.setBoxes([makeBox({ id: 'box-1', name: 'box-1', status: 'ready' })]); });
    await settle();
    expect(field('npf-box').value).toBe('__new__');
  });

  it('still takes the current project\'s box when the first load failed and a later poll brings it (Bugbot)', async () => {
    mocks.resetFeed();
    mocks.feed.reload.mockImplementationOnce(async () => {}); // the real reload catches and resolves, loading nothing
    await renderForm({ defaultBoxId: 'box-1' });
    expect(document.body.textContent).toContain('Could not load your boxes');
    expect(field('npf-box').value).toBe('__new__');
    await act(async () => { mocks.setBoxes([makeBox({ id: 'box-1', name: 'box-1' })]); });
    await settle();
    expect(field('npf-box').value).toBe('box-1');
  });

  it('lets an initial box win over the current project\'s box', async () => {
    mocks.setBoxes([makeBox({ id: 'box-1', name: 'box-1' }), makeBox({ id: 'box-2', name: 'box-2' })]);
    await renderForm({ initialBoxId: 'box-1', defaultBoxId: 'box-2' });
    expect(field('npf-box').value).toBe('box-1');
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

  it('defaults the flag-off form to the current project\'s box too', async () => {
    mocks.flags = {};
    mocks.setBoxes([
      makeBox({ id: 'box-1', name: 'box-1', _count: { projects: 0 } }),
      makeBox({ id: 'box-2', name: 'box-2', _count: { projects: 5 } }),
    ]);
    await renderForm({ defaultBoxId: 'box-2' });
    expect(field('npf-box').value).toBe('box-2');
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

describe('new project form: a name an archived project holds on the box', () => {
  const refusal = {
    response: {
      status: 409,
      data: {
        error: 'An archived project named webapp is on this box',
        code: 'archived-name-taken',
        archived: { id: 'p-old', name: 'webapp', archivedAt: '2026-10-21T04:39:59.296Z', repoUrl: null, workstreams: 3 },
      },
    },
  };

  async function typeName(value: string) {
    const name = field('npf-name') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, value);
      name.dispatchEvent(new Event('input', { bubbles: true }));
      name.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
  }

  function button(label: string): HTMLButtonElement {
    const found = [...document.querySelectorAll('button')].find(b => b.textContent === label);
    if (!found) throw new Error(`missing button ${label}`);
    return found;
  }

  for (const [label, answer] of [['Un-archive it', 'unarchive'], ['Rename it aside and create', 'rename-aside']] as const) {
    it(`offers both ways out and sends ${answer} for "${label}"`, async () => {
      mocks.api.createProject.mockRejectedValueOnce(refusal);
      const onCreated = await renderForm({ initialBoxId: 'box-1' });
      await typeName('webapp');
      await clickSubmit();
      expect(mocks.api.createProject.mock.calls[0][0]).not.toHaveProperty('archivedName');
      expect(document.body.textContent).toContain('You archived a project named webapp on this box on 2026-10-21');
      expect(document.body.textContent).toContain('webapp-archived-2026-10-21');
      expect(document.body.textContent).toContain('with its 3 workstreams');
      await act(async () => { button(label).click(); });
      await settle();
      expect(mocks.api.createProject).toHaveBeenCalledTimes(2);
      expect(mocks.api.createProject.mock.calls[1][0]).toEqual(expect.objectContaining({ name: 'webapp', instanceId: 'box-1', archivedName: answer }));
      expect(onCreated).toHaveBeenCalled();
      expect(document.body.textContent).not.toContain('You archived a project');
    });
  }

  it('drops the offer when the name changes', async () => {
    mocks.api.createProject.mockRejectedValueOnce(refusal);
    await renderForm({ initialBoxId: 'box-1' });
    await typeName('webapp');
    await clickSubmit();
    expect(document.body.textContent).toContain('You archived a project');
    await typeName('webapp-2');
    expect(document.body.textContent).not.toContain('You archived a project');
  });
});

function typeInto(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('multi-repo projects (multi-repo-projects-enabled)', () => {
  const addButton = () => [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Add another repository'));

  it('offers nothing new with the flag off', async () => {
    mocks.flags = {};
    await renderForm({ initialBoxId: 'box-1' });
    expect(addButton()).toBeUndefined();
    await clickSubmit();
    expect(mocks.api.createProject).toHaveBeenCalledWith(expect.not.objectContaining({ repos: expect.anything() }));
  });

  async function fillPrimary() {
    mocks.flags = { 'multi-repo-projects-enabled': true };
    await renderForm({ initialBoxId: 'box-1' });
    await act(async () => { choose('npf-start', '__custom__'); });
    await act(async () => { typeInto(field('npf-url') as HTMLInputElement, 'https://github.com/acme/api'); });
    await act(async () => { addButton()!.click(); });
  }

  it('keeps a single-repo create while the extra row is blank', async () => {
    await fillPrimary();
    await clickSubmit();
    const body = mocks.api.createProject.mock.lastCall![0] as Record<string, unknown>;
    expect(body.repoUrl).toBe('https://github.com/acme/api');
    expect(body.repos).toBeUndefined();
  });

  it('sends repos instead of repoUrl once a second repository is filled in', async () => {
    await fillPrimary();
    const row = document.querySelector('input[aria-label="Repository 2 URL"]') as HTMLInputElement;
    await act(async () => { typeInto(row, 'https://github.com/acme/web'); });
    await clickSubmit();
    const body = mocks.api.createProject.mock.lastCall![0] as Record<string, unknown>;
    expect(body.repoUrl).toBeUndefined();
    expect(body.repos).toEqual([{ url: 'https://github.com/acme/api' }, { url: 'https://github.com/acme/web' }]);
  });
});

describe('the repository list as a multi-select (multi-repo-projects-enabled)', () => {
  const row = (text: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button.npf-repo')].find(b => b.textContent?.startsWith(text));
    if (!button) throw new Error(`missing row ${text}`);
    return button;
  };
  const selected = () => [...document.querySelectorAll('button.npf-repo.is-selected')].map(b => b.textContent);
  const click = async (text: string) => { await act(async () => { row(text).click(); }); };
  const lastBody = () => mocks.api.createProject.mock.lastCall![0] as Record<string, unknown>;

  async function renderList(multi = true) {
    mocks.flags = { 'repo-first-picker-enabled': true, ...(multi && { 'multi-repo-projects-enabled': true }) };
    mocks.api.repos.mockResolvedValue({
      status: 'ok',
      groups: [
        { owner: 'acme', kind: 'org', status: 'ok', repos: [{ fullName: 'acme/api', defaultBranch: 'main' }, { fullName: 'acme/web', defaultBranch: 'trunk' }] },
        { owner: 'example-org', kind: 'org', status: 'ok', repos: [{ fullName: 'example-org/webapp', defaultBranch: 'main' }] },
      ],
    });
    await renderForm({ initialBoxId: 'box-1' });
  }

  it('highlights every ticked row and creates a multi-repo project named after the first', async () => {
    await renderList();
    await click('acme/api');
    await click('acme/web');
    expect(selected()).toEqual(['acme/api', 'acme/web']);
    expect(row('acme/web').getAttribute('aria-pressed')).toBe('true');
    expect(field('npf-name').value).toBe('api');
    expect(document.body.textContent).toContain('2 repositories, each cloned into its own directory');
    await clickSubmit();
    expect(lastBody().repoUrl).toBeUndefined();
    expect(lastBody().repos).toEqual([
      { url: 'https://github.com/acme/api.git', defaultBranch: 'main' },
      { url: 'https://github.com/acme/web.git', defaultBranch: 'trunk' },
    ]);
  });

  it('sizes a new box for a multi-repo project by every ticked repository, not the first alone (Bugbot, #883)', async () => {
    mocks.flags = { 'repo-first-picker-enabled': true, 'multi-repo-projects-enabled': true };
    mocks.api.repos.mockResolvedValue({
      status: 'ok',
      groups: [{ owner: 'acme', kind: 'org', status: 'ok', repos: [{ fullName: 'acme/api', defaultBranch: 'main' }, { fullName: 'acme/web', defaultBranch: 'trunk' }] }],
    });
    await renderForm();
    expect(field('npf-box').value).toBe('__new__');
    await click('acme/api');
    await click('acme/web');
    await clickSubmit();
    expect(mocks.api.createBox).toHaveBeenCalledWith(expect.any(String), 'ec2', {
      size: undefined, repo: ['https://github.com/acme/api.git', 'https://github.com/acme/web.git'],
    });
  });

  it('unticks a row, the next one becoming the first, and a single tick is an ordinary project', async () => {
    await renderList();
    await click('acme/api');
    await click('acme/web');
    await click('acme/api');
    expect(selected()).toEqual(['acme/web']);
    expect(field('npf-name').value).toBe('web');
    await clickSubmit();
    expect(lastBody().repos).toBeUndefined();
    expect(lastBody().repoUrl).toBe('https://github.com/acme/web.git');
    await click('acme/web');
    expect(selected()).toEqual([expect.stringContaining('fresh directory')]);
  });

  it('ticks a listed starter with its row, and empty clears the selection', async () => {
    await renderList();
    await click('acme/api');
    await click('webapp');
    expect(selected()).toEqual([expect.stringMatching(/^webapp/), 'acme/api', 'example-org/webapp']);
    await click('example-org/webapp');
    expect(selected()).toEqual(['acme/api']);
    await click('empty');
    expect(selected()).toEqual([expect.stringContaining('fresh directory')]);
    expect(field('npf-name').value).toMatch(/^proj-/);
  });

  it('keeps an unlisted starter a single pick that a listed tick replaces, and a second click unpicks', async () => {
    await renderList();
    await click('research');
    expect(selected()).toEqual([expect.stringMatching(/^research/)]);
    await click('acme/api');
    expect(selected()).toEqual(['acme/api']);
    await click('research');
    await click('research');
    expect(selected()).toEqual([expect.stringContaining('fresh directory')]);
  });

  it('adds typed repositories after the ticked ones', async () => {
    await renderList();
    await click('acme/api');
    await click('acme/web');
    const add = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Add another repository'))!;
    await act(async () => { add.click(); });
    const typed = document.querySelector('input[aria-label="Repository 2 URL"]') as HTMLInputElement;
    await act(async () => { typeInto(typed, 'https://github.com/elsewhere/tool'); });
    await clickSubmit();
    expect(lastBody().repos).toEqual([
      { url: 'https://github.com/acme/api.git', defaultBranch: 'main' },
      { url: 'https://github.com/acme/web.git', defaultBranch: 'trunk' },
      { url: 'https://github.com/elsewhere/tool' },
    ]);
  });

  it('counts blank Add another repository rows toward the eight', async () => {
    await renderList();
    const add = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Add another repository'))!;
    for (let i = 0; i < 7; i++) await act(async () => { add().click(); });
    await click('acme/api');
    await click('acme/web');
    expect(selected()).toEqual(['acme/api']);
    expect(add().disabled).toBe(true);
    await click('acme/api');
    await act(async () => { add().click(); });
    await click('acme/web');
    expect(selected()).toEqual([expect.stringContaining('fresh directory')]);
  });

  it('picks one repository at a time with the flag off', async () => {
    await renderList(false);
    await click('acme/api');
    await click('acme/web');
    expect(selected()).toEqual(['acme/web']);
    expect(row('acme/web').hasAttribute('aria-pressed')).toBe(false);
    await click('acme/web');
    expect(selected()).toEqual(['acme/web']);
    await clickSubmit();
    expect(lastBody().repoUrl).toBe('https://github.com/acme/web.git');
    expect(lastBody().repos).toBeUndefined();
  });
});

describe('the new box\'s disk (GET /api/instances/sizes disk)', () => {
  const DISK = { minGiB: 50, maxGiB: 300, defaultGiB: 120, diskGiB: 120 };
  const typeDisk = (value: string) => {
    const el = field('npf-box-disk') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const newBox = async () => {
    await act(async () => { choose('npf-box', '__new__'); });
    await settle();
  };

  it('shows 120 with the range, sends nothing until typed, and the typed disk once it is', async () => {
    mocks.api.sizes.mockResolvedValue({ enabled: false, default: null, sizes: [], disk: DISK });
    await renderForm();
    await newBox();
    expect(field('npf-box-disk').value).toBe('120');
    expect(field('npf-box-disk').closest('.npf-field')?.textContent).toContain('50–300');
    await act(async () => { typeDisk('200'); });
    await clickSubmit();
    expect(mocks.api.createBox).toHaveBeenCalledWith(expect.any(String), 'ec2', expect.objectContaining({ diskGiB: 200 }));
  });

  it('preselects the repository\'s diskGiB, and sends nothing for it', async () => {
    mocks.api.sizes.mockResolvedValue({ enabled: false, default: null, sizes: [], disk: { ...DISK, diskGiB: 250 } });
    await renderForm();
    await newBox();
    expect(field('npf-box-disk').value).toBe('250');
    await clickSubmit();
    expect(mocks.api.createBox).toHaveBeenCalledWith(expect.any(String), 'ec2', expect.objectContaining({ diskGiB: undefined }));
  });

  it('names the range and holds the create for a disk out of it', async () => {
    mocks.api.sizes.mockResolvedValue({ enabled: false, default: null, sizes: [], disk: DISK });
    await renderForm();
    await newBox();
    await act(async () => { typeDisk('500'); });
    expect(document.body.textContent).toContain('A whole number of GB from 50 to 300');
    expect(submitButton().disabled).toBe(true);
  });

  it('says another disk launches a new box only while a ready one is waiting', async () => {
    mocks.flags = { 'repo-first-picker-enabled': true, 'warm-pool-enabled': true };
    mocks.api.warmPool.mockResolvedValue({ warm: 2, warming: 0, target: 2 });
    mocks.api.sizes.mockResolvedValue({ enabled: false, default: null, sizes: [], disk: DISK });
    await renderForm();
    await newBox();
    expect(document.body.textContent).toContain('ready now');
    await act(async () => { typeDisk('200'); });
    expect(document.body.textContent).toContain('A 200 GB disk means launching a new box, a few minutes; the ready ones have 120 GB.');
    expect(document.body.textContent).not.toContain('ready now');
  });

  it('shows no disk field for an orchestrator from before disks', async () => {
    await renderForm();
    await newBox();
    expect(document.getElementById('npf-box-disk')).toBeNull();
  });
});

describe('new project form: a box list that could not be refreshed', () => {
  it("says the list may be out of date when the mount reload failed after an earlier good one, and nothing once it answers", async () => {
    mocks.setFailing(true);
    await renderForm();
    expect(document.body.textContent).toContain('Could not refresh your boxes just now');
    expect(document.body.textContent).not.toContain('Could not load your boxes');

    await act(async () => { mocks.setFailing(false); });
    expect(document.body.textContent).not.toContain('Could not refresh your boxes');
  });
});
