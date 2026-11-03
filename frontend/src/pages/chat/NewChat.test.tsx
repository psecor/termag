// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewChat } from './NewChat';
import { ChatChromeProvider, type ChatChrome } from './chatChrome';

const boxes: Array<Record<string, unknown>> = [];
// The box feed's snapshot: `boxes` unless a test swaps in a new list, as a reload does.
const feed: { list: Array<Record<string, unknown>> } = { list: boxes };
const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  credentials: vi.fn(),
  list: vi.fn(),
  createBox: vi.fn(),
  startBox: vi.fn(async () => ({ ok: true, status: 'starting' })),
  sizes: vi.fn(async (): Promise<unknown> => ({ enabled: false, default: null, sizes: [] })),
  createProject: vi.fn(),
  createAutomation: vi.fn(),
  previewSchedule: vi.fn(),
  flags: {} as Record<string, unknown>,
  search: '',
  reloadProjects: vi.fn(async () => {}),
  upsert: vi.fn(),
  reloadBoxes: vi.fn(async () => {}),
  listSpaces: vi.fn(async () => ({ spaces: [] as Array<{ id: string; name: string; description: null; createdAt: string; usedBytes: number; quotaBytes: number; role: 'owner'; readOnly: boolean }> })),
  addSpaceBox: vi.fn(async () => ({})),
  openTab: vi.fn(),
  projects: [] as Array<Record<string, unknown>>,
  createWorkstream: vi.fn(),
  warmPool: vi.fn(async () => ({ warm: 0, warming: 0, target: 0 })),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useSearchParams: () => [new URLSearchParams(mocks.search)],
  useLocation: () => ({ pathname: '/chat/new', search: '', hash: '', state: null, key: 'visit' }),
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => <a href={to} {...rest}>{children}</a>,
}));
vi.mock('../../flags', async () => {
  const actual = await vi.importActual<typeof import('../../flags')>('../../flags');
  return { ...actual, useFlag: <T,>(key: string, fallback: T) => (key in mocks.flags ? mocks.flags[key] as T : fallback) };
});
vi.mock('../../contexts/ProjectContext', () => ({
  useProjects: () => ({ projects: mocks.projects, reloadProjects: mocks.reloadProjects }),
}));
vi.mock('../../services/boxFeed', () => ({
  boxFeed: {
    subscribe: () => () => {},
    getSnapshot: () => feed.list,
    upsert: mocks.upsert,
    reload: mocks.reloadBoxes,
  },
}));
vi.mock('../../services/api', () => ({
  credentialsApi: { get: mocks.credentials },
  githubReposApi: { list: mocks.list },
  instancesApi: { create: mocks.createBox, start: mocks.startBox, sizes: mocks.sizes },
  projectsApi: { create: mocks.createProject },
  workstreamsApi: { create: mocks.createWorkstream },
  automationsApi: { create: mocks.createAutomation, preview: mocks.previewSchedule },
  spacesApi: { list: mocks.listSpaces, create: vi.fn(), addBox: mocks.addSpaceBox },
  warmPoolApi: { get: mocks.warmPool },
}));
vi.mock('../../observability', () => ({ replaySessionId: async () => null }));
// No organisation's repositories start trusted on a deployment by default
// (COMPANY_GITHUB_OWNERS, empty by default): these tests list example-org and
// example-team, so the trusted path is exercised.
vi.mock('../../chat/simpleChat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../chat/simpleChat')>();
  return {
    ...actual,
    repoStartsTrusted: (url: string | null | undefined) =>
      !!url && /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)(example-org|example-team)\/[\w.-]+?(?:\.git)?\/?$/i.test(url.trim()),
  };
});
vi.mock('./simpleData', () => ({ useSimpleDataIfAny: () => ({ items: { open: mocks.openTab } }) }));
vi.mock('../../services/claimTiming', () => ({
  noteAddBoxClick: () => {},
  noteBoxClaimed: () => {},
  noteProjectCreated: () => {},
}));

const catalog = {
  status: 'ok',
  groups: [{
    owner: 'acme', kind: 'user', status: 'ok',
    repos: [{ fullName: 'acme/web', defaultBranch: 'main' }, { fullName: 'acme/api', defaultBranch: 'trunk' }],
  }],
};

let root: Root;
let container: HTMLDivElement;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found as HTMLButtonElement;
}

/** A repository's row in the picker's multi-select (multi-repo-projects-enabled). */
function repoRow(fullName: string): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(`[role="option"][data-repo="${fullName}"]`);
  if (!found) throw new Error(`Missing repository row: ${fullName}`);
  return found;
}

/** Opens the drawer's box dialog. */
async function openBoxDialog() {
  const trigger = document.querySelector('.chat-launch-trigger') as HTMLButtonElement;
  if (trigger.getAttribute('aria-expanded') !== 'true') await act(async () => { trigger.click(); });
}

const boxLabel = () => document.querySelector('.chat-launch-trigger-label')?.textContent;

const scheduleTrigger = () => document.querySelector('button.chat-schedule-trigger') as HTMLButtonElement | null;
const scheduleDialog = () => document.querySelector('.chat-schedule-dialog');

/** Opens the drawer's schedule dialog and picks a choice; On a schedule waits for Done unless asked. */
async function pickSchedule(choice: 'No schedule' | 'On a schedule' = 'On a schedule', done = true) {
  if (!scheduleDialog()) await act(async () => { scheduleTrigger()!.click(); });
  const radio = [...scheduleDialog()!.querySelectorAll('[role="radio"]')].find(r => r.textContent?.startsWith(choice)) as HTMLButtonElement;
  await act(async () => { radio.click(); });
  if (done && scheduleDialog()) {
    const close = [...scheduleDialog()!.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Done') as HTMLButtonElement;
    await act(async () => { close.click(); });
  }
}

async function render() {
  await act(async () => { root.render(<NewChat />); });
}

beforeEach(() => {
  localStorage.clear();
  mocks.navigate.mockReset();
  mocks.openTab.mockReset();
  mocks.credentials.mockReset();
  mocks.list.mockReset();
  mocks.listSpaces.mockReset();
  mocks.addSpaceBox.mockReset();
  mocks.createBox.mockReset();
  mocks.startBox.mockClear();
  boxes.length = 0;
  feed.list = boxes;
  mocks.projects.length = 0;
  mocks.createWorkstream.mockReset();
  mocks.createProject.mockReset();
  mocks.createAutomation.mockReset();
  mocks.previewSchedule.mockReset();
  for (const key of Object.keys(mocks.flags)) delete mocks.flags[key];
  mocks.search = '';
  mocks.credentials.mockResolvedValue({ github: { boxGate: 'clear' } });
  mocks.list.mockResolvedValue(catalog);
  mocks.listSpaces.mockResolvedValue({ spaces: [] });
  mocks.addSpaceBox.mockResolvedValue({});
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

describe('NewChat box size (box-default-size)', () => {
  const OPTIONS = {
    enabled: true, default: 'large', defaultSize: 'large',
    sizes: [
      { size: 'small', vcpus: 2, memoryGiB: 8, instanceType: 'm8g.large' },
      { size: 'medium', vcpus: 4, memoryGiB: 16, instanceType: 'm8g.xlarge' },
      { size: 'large', vcpus: 8, memoryGiB: 32, instanceType: 'm8g.2xlarge' },
    ],
  };

  async function typePrompt() {
    mocks.createBox.mockResolvedValue({ claimed: false, instance: { id: 'box-1', name: 'web' } });
    mocks.createProject.mockResolvedValue({ id: 'proj-1' });
    const input = document.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'fix the login');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  /** Picks `repo` in the repository picker, opening it from whatever it shows now. */
  async function chooseRepo(repo: string, current = 'Choose a repository') {
    await act(async () => { buttonByText(current).click(); });
    await flush();
    await act(async () => { buttonByText(repo).click(); });
    await flush();
  }
  async function send() {
    const button = document.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    await act(async () => { button.click(); });
    await flush();
  }
  async function startOnNewBox() {
    await typePrompt();
    await chooseRepo('acme/web');
    await send();
  }
  const sizeTrigger = () => document.querySelector('.chat-launch-new-size .box-size-select-button') as HTMLButtonElement;
  const sizeShown = () => sizeTrigger().textContent?.replace(/\s+/g, ' ').trim();
  async function pickSize(index: number) {
    // React Aria escapes ids with CSS.escape, which jsdom lacks (as RepoPicker.test.tsx).
    const css = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
    if (!css?.escape) (globalThis as { CSS?: unknown }).CSS = { ...css, escape: (v: string) => v.replace(/[^\w-]/g, c => `\\${c}`) };
    await act(async () => { sizeTrigger().click(); });
    const options = [...document.querySelectorAll('.box-size-select-popover [role="option"]')] as HTMLElement[];
    await act(async () => { options[index].click(); });
    return options.map(o => o.textContent);
  }

  it('offers a size dropdown under the new box\'s name, the owner\'s default (Large) preselected, and launches at the size picked', async () => {
    mocks.sizes.mockResolvedValue(OPTIONS);
    await render();
    await flush();
    await typePrompt();
    await chooseRepo('acme/web');
    await act(async () => { (document.querySelector('.chat-launch-trigger') as HTMLButtonElement).click(); });
    await vi.waitFor(() => expect(sizeTrigger()).not.toBeNull());
    expect(sizeShown()).toBe('Large · 8 vCPU, 32 GB RAM');
    expect(await pickSize(0)).toEqual(['Small · 2 vCPU, 8 GB RAM', 'Medium · 4 vCPU, 16 GB RAM', 'Large · 8 vCPU, 32 GB RAM']);
    expect(sizeShown()).toBe('Small · 2 vCPU, 8 GB RAM');
    await send();
    expect(mocks.createBox).toHaveBeenCalledWith(expect.any(String), 'ec2', expect.objectContaining({ size: 'small' }));
    mocks.sizes.mockResolvedValue({ enabled: false, default: null, sizes: [] });
  });

  it('drops a size picked for one repository when the repository changes, so the new one\'s environment.json sizes the box (Bugbot, #883)', async () => {
    mocks.sizes.mockResolvedValue(OPTIONS);
    await render();
    await flush();
    await typePrompt();
    await chooseRepo('acme/web');
    await act(async () => { (document.querySelector('.chat-launch-trigger') as HTMLButtonElement).click(); });
    await vi.waitFor(() => expect(sizeTrigger()).not.toBeNull());
    await pickSize(0);
    expect(sizeShown()).toBe('Small · 2 vCPU, 8 GB RAM');
    await chooseRepo('acme/api', 'acme/web');
    await vi.waitFor(() => expect(mocks.sizes).toHaveBeenLastCalledWith(expect.stringContaining('acme/api')));
    expect(sizeShown()).toBe('Large · 8 vCPU, 32 GB RAM');
    await send();
    expect(mocks.createBox).toHaveBeenCalledWith(expect.any(String), 'ec2', expect.objectContaining({ size: undefined, repo: expect.stringContaining('acme/api') }));
    mocks.sizes.mockResolvedValue({ enabled: false, default: null, sizes: [] });
  });

  it('sends no size when nothing is picked, with the repository, so the server sizes it as the preselection says', async () => {
    mocks.sizes.mockResolvedValue(OPTIONS);
    await render();
    await flush();
    await startOnNewBox();
    expect(mocks.createBox).toHaveBeenCalledWith(expect.any(String), 'ec2', expect.objectContaining({ size: undefined, repo: expect.stringContaining('acme/web') }));
    mocks.sizes.mockResolvedValue({ enabled: false, default: null, sizes: [] });
  });

  it('asks the server again for the repository picked, whose .termag/environment.json sets the preselection', async () => {
    mocks.sizes.mockResolvedValue(OPTIONS);
    await render();
    await flush();
    expect(mocks.sizes).toHaveBeenLastCalledWith(null);
    await act(async () => { buttonByText('Choose a repository').click(); });
    await flush();
    await act(async () => { buttonByText('acme/web').click(); });
    await vi.waitFor(() => expect(mocks.sizes).toHaveBeenLastCalledWith(expect.stringContaining('acme/web')));
    mocks.sizes.mockResolvedValue({ enabled: false, default: null, sizes: [] });
  });

  it('shows no picker while sizes are off', async () => {
    await render();
    await flush();
    await act(async () => { (document.querySelector('.chat-launch-trigger') as HTMLButtonElement).click(); });
    expect(document.querySelector('.chat-launch-new')).not.toBeNull();
    expect(document.querySelector('.box-size-select')).toBeNull();
  });
});

describe('NewChat box disk', () => {
  const DISK = { minGiB: 50, maxGiB: 300, defaultGiB: 120, diskGiB: 120 };
  const OFF = { enabled: false, default: null, sizes: [] };
  const diskInput = () => document.querySelector('.chat-launch-new-disk input') as HTMLInputElement | null;
  async function openDrawer() {
    const input = document.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'fix the login');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { buttonByText('Choose a repository').click(); });
    await flush();
    await act(async () => { buttonByText('acme/web').click(); });
    await flush();
    await act(async () => { (document.querySelector('.chat-launch-trigger') as HTMLButtonElement).click(); });
    await vi.waitFor(() => expect(diskInput()).not.toBeNull());
  }
  async function typeDisk(value: string) {
    const el = diskInput()!;
    await act(async () => {
      el.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // LaunchPad's NumberField commits on blur.
    await act(async () => { el.blur(); });
  }
  async function send() {
    mocks.createBox.mockResolvedValue({ claimed: false, instance: { id: 'box-1', name: 'web' } });
    mocks.createProject.mockResolvedValue({ id: 'proj-1' });
    const button = document.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    await act(async () => { button.click(); });
    await flush();
  }
  afterEach(() => { delete mocks.flags['warm-pool-enabled']; mocks.sizes.mockResolvedValue(OFF); mocks.warmPool.mockResolvedValue({ warm: 0, warming: 0, target: 0 }); });

  it('shows the new box\'s disk, 120 GB, with sizes off too, and launches with the disk typed', async () => {
    mocks.sizes.mockResolvedValue({ ...OFF, disk: DISK });
    await render();
    await flush();
    await openDrawer();
    expect(document.querySelector('.box-size-select')).toBeNull();
    expect(diskInput()!.value).toBe('120');
    expect(document.querySelector('.chat-launch-new-disk')!.textContent).toContain('GB, 50–300');
    await typeDisk('200');
    expect(diskInput()!.value).toBe('200');
    await send();
    expect(mocks.createBox).toHaveBeenCalledWith(expect.any(String), 'ec2', expect.objectContaining({ diskGiB: 200 }));
  });

  it('preselects the repository\'s diskGiB and sends nothing for it, so the server decides', async () => {
    mocks.sizes.mockResolvedValue({ ...OFF, disk: { ...DISK, diskGiB: 250 } });
    await render();
    await flush();
    await openDrawer();
    expect(diskInput()!.value).toBe('250');
    await send();
    expect(mocks.createBox).toHaveBeenCalledWith(expect.any(String), 'ec2', expect.objectContaining({ diskGiB: undefined }));
  });

  it('keeps a disk typed out of range inside it', async () => {
    mocks.sizes.mockResolvedValue({ ...OFF, disk: DISK });
    await render();
    await flush();
    await openDrawer();
    await typeDisk('500');
    expect(diskInput()!.value).toBe('300');
  });

  it('says another disk launches a new box while a warm one is ready', async () => {
    mocks.flags = { ...mocks.flags, 'warm-pool-enabled': true };
    mocks.warmPool.mockResolvedValue({ warm: 1, warming: 0, target: 1 });
    mocks.sizes.mockResolvedValue({ ...OFF, disk: DISK });
    await render();
    await flush();
    await openDrawer();
    expect(document.querySelector('.box-disk-input-note')).toBeNull();
    await typeDisk('200');
    expect(document.querySelector('.box-disk-input-note')?.textContent).toBe('A 200 GB disk means launching a new box, a few minutes; the ready ones have 120 GB.');
  });

  it('shows no disk field for an orchestrator from before disks', async () => {
    await render();
    await flush();
    await act(async () => { (document.querySelector('.chat-launch-trigger') as HTMLButtonElement).click(); });
    expect(document.querySelector('.chat-launch-new')).not.toBeNull();
    expect(diskInput()).toBeNull();
  });
});

describe('NewChat composer', () => {
  it('starts a chat from a chosen repository and Claude model', async () => {
    let resolveList: (value: unknown) => void = () => {};
    mocks.list.mockReturnValue(new Promise(resolve => { resolveList = resolve; }));
    mocks.createBox.mockResolvedValue({ claimed: false, instance: { id: 'box-1', name: 'web' } });
    mocks.createProject.mockResolvedValue({ id: 'proj-1' });
    await render();

    await act(async () => { buttonByText('Choose a repository').click(); });
    expect(document.body.textContent).toContain('Loading repositories…');
    await act(async () => { resolveList(catalog); });
    expect(document.body.textContent).toContain('acme/web');

    await act(async () => { buttonByText('acme/web').click(); });
    expect(buttonByText('acme/web').getAttribute('aria-expanded')).toBe('false');

    await act(async () => { buttonByText('Sonnet 5.5').click(); });
    expect(document.body.textContent).toContain('Opus 5.5');
    await act(async () => { buttonByText('Opus 5.5').click(); });

    const input = document.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'fix the login');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const send = document.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    await act(async () => { send.click(); });
    await flush();

    // The repository rides along for its default size; no size picked.
    expect(mocks.createBox).toHaveBeenCalledWith('web', 'ec2', { size: undefined, repo: 'https://github.com/acme/web.git' });
    expect(mocks.createProject).toHaveBeenCalledWith({
      name: 'web',
      instanceId: 'box-1',
      initialAgent: { enabled: true, provider: 'claude-chat' },
      replaySessionId: null,
      repoUrl: 'https://github.com/acme/web.git',
      defaultBranch: 'main',
      claudeModel: 'opus',
      chatTrusted: false,
    });
    expect(mocks.navigate).toHaveBeenCalledWith('/chat/p/proj-1', undefined);
    expect(document.querySelector('.chat-new-space')).toBeNull();
    // No space: no tab is opened ahead of the route.
    expect(mocks.openTab).not.toHaveBeenCalled();
  });

  it('offers no multi-select while multi-repo-projects-enabled is off', async () => {
    await render();
    await act(async () => { buttonByText('Choose a repository').click(); });
    await flush();
    expect(document.body.textContent).toContain('acme/web');
    expect(document.querySelector('[role="listbox"]')!.hasAttribute('aria-multiselectable')).toBe(false);
    expect(document.querySelector('[data-lp-indicator="checkbox"]')).toBeNull();
  });

  it('starts a multi-repo project from two ticked repositories with multi-repo-projects-enabled', async () => {
    mocks.flags['multi-repo-projects-enabled'] = true;
    mocks.createBox.mockResolvedValue({ claimed: false, instance: { id: 'box-1', name: 'web' } });
    mocks.createProject.mockResolvedValue({ id: 'proj-1' });
    await render();
    await act(async () => { buttonByText('Choose a repository').click(); });
    await flush();
    await act(async () => { repoRow('acme/web').click(); });
    await act(async () => { repoRow('acme/api').click(); });
    // A row click keeps the menu open; the pill names both.
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    expect(repoRow('acme/web').getAttribute('aria-selected')).toBe('true');
    expect(repoRow('acme/api').getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('.chat-compose-repo-name')?.textContent).toBe('acme/web + api');

    const input = document.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'wire the api into the web app');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (document.querySelector('button[type="submit"]') as HTMLButtonElement).click(); });
    await flush();

    expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({
      name: 'web',
      instanceId: 'box-1',
      repos: [
        { url: 'https://github.com/acme/web.git', defaultBranch: 'main' },
        { url: 'https://github.com/acme/api.git', defaultBranch: 'trunk' },
      ],
    }));
    expect(mocks.createProject.mock.calls[0][0]).not.toHaveProperty('repoUrl');
  });

  it('sizes a new box for a multi-repo project by every ticked repository, not the first alone (Bugbot, #883)', async () => {
    mocks.flags['multi-repo-projects-enabled'] = true;
    mocks.createBox.mockResolvedValue({ claimed: false, instance: { id: 'box-1', name: 'web' } });
    mocks.createProject.mockResolvedValue({ id: 'proj-1' });
    await render();
    await act(async () => { buttonByText('Choose a repository').click(); });
    await flush();
    await act(async () => { repoRow('acme/web').click(); });
    await act(async () => { repoRow('acme/api').click(); });
    const both = ['https://github.com/acme/web.git', 'https://github.com/acme/api.git'];
    // The picker's preselection asks for both: the server takes the largest of their environment.json sizes.
    await vi.waitFor(() => expect(mocks.sizes).toHaveBeenLastCalledWith(both));
    const input = document.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'wire the api into the web app');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (document.querySelector('button[type="submit"]') as HTMLButtonElement).click(); });
    await flush();
    expect(mocks.createBox).toHaveBeenCalledWith(expect.any(String), 'ec2', expect.objectContaining({ repo: both }));
  });

  it('keeps Full access remembered for one repository to that one, not to every repository ticked with it', async () => {
    mocks.flags['multi-repo-projects-enabled'] = true;
    localStorage.setItem('termag-chat-permissions', JSON.stringify({ 'acme/web': 'full' }));
    mocks.createBox.mockResolvedValue({ claimed: false, instance: { id: 'box-1', name: 'web' } });
    mocks.createProject.mockResolvedValue({ id: 'proj-1' });
    await render();
    await act(async () => { buttonByText('Choose a repository').click(); });
    await flush();
    await act(async () => { repoRow('acme/web').click(); });
    await act(async () => { repoRow('acme/api').click(); });
    const input = document.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'wire them');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (document.querySelector('button[type="submit"]') as HTMLButtonElement).click(); });
    await flush();
    expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({ chatTrusted: false, repos: expect.any(Array) }));
    expect(JSON.parse(localStorage.getItem('termag-chat-permissions')!)).toEqual({ 'acme/web': 'full' });
  });

  it('starts an ordinary project from one chosen repository with multi-repo-projects-enabled, after an outside click closes the menu', async () => {
    mocks.flags['multi-repo-projects-enabled'] = true;
    mocks.createBox.mockResolvedValue({ claimed: false, instance: { id: 'box-1', name: 'web' } });
    mocks.createProject.mockResolvedValue({ id: 'proj-1' });
    await render();
    await act(async () => { buttonByText('Choose a repository').click(); });
    await flush();
    await act(async () => { repoRow('acme/api').click(); });
    await act(async () => { repoRow('acme/web').click(); });
    await act(async () => { repoRow('acme/api').click(); });
    expect(document.querySelector('.chat-compose-repo-name')?.textContent).toBe('acme/web');
    await act(async () => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    expect(document.querySelector('[role="listbox"]')).toBeNull();

    const input = document.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'fix the login');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (document.querySelector('button[type="submit"]') as HTMLButtonElement).click(); });
    await flush();
    expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({
      name: 'web',
      repoUrl: 'https://github.com/acme/web.git',
      defaultBranch: 'main',
    }));
    expect(mocks.createProject.mock.calls[0][0]).not.toHaveProperty('repos');
  });

  it('opens with the cursor in the message', async () => {
    await render();
    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement).toBe(document.querySelector('textarea.chat-compose-input'));
  });

  it('offers an effort beside the model with chat-effort-enabled, and hands it to the new session\'s first message', async () => {
    mocks.flags['chat-effort-enabled'] = true;
    mocks.createBox.mockResolvedValue({ claimed: false, instance: { id: 'box-1', name: 'web' } });
    mocks.createProject.mockResolvedValue({ id: 'proj-1' });
    await render();
    await act(async () => { buttonByText('Choose a repository').click(); });
    await act(async () => { buttonByText('acme/web').click(); });

    await act(async () => { buttonByText('Sonnet 5.5').click(); });
    const range = document.querySelector('.chat-effort input[type="range"]') as HTMLInputElement;
    expect(range).not.toBeNull();
    await act(async () => { buttonByText('Opus 5.5').click(); });
    await act(async () => { buttonByText('Opus 5.5').click(); });
    const slider = document.querySelector('.chat-effort input[type="range"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, '3');
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(buttonByText('Opus 5.5 · Extra high')).toBeTruthy();
    // Picked, not started yet: the next New session opens on them already.
    expect(JSON.parse(localStorage.getItem('termag-chat-last-pick') ?? '{}')).toEqual({ model: 'opus', effort: 'xhigh' });

    const input = document.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'think hard');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (document.querySelector('button[type="submit"]') as HTMLButtonElement).click(); });
    await flush();
    expect(localStorage.getItem('termag.chatEffort.proj-1|main')).toBe('xhigh');
    expect(JSON.parse(localStorage.getItem('termag-chat-last-start') ?? '{}').effort).toBe('xhigh');
  });

  it('offers no effort without chat-effort-enabled', async () => {
    await render();
    await act(async () => { buttonByText('Sonnet 5.5').click(); });
    expect(document.querySelector('[role="listbox"][aria-label="Model"]')).not.toBeNull();
    expect(document.querySelector('.chat-effort')).toBeNull();
  });

  it('opens on the model and effort last picked, even when no session started with them', async () => {
    mocks.flags['chat-effort-enabled'] = true;
    localStorage.setItem('termag-chat-last-start', JSON.stringify({ pick: null, space: null, model: 'haiku', effort: 'low' }));
    localStorage.setItem('termag-chat-last-pick', JSON.stringify({ model: 'sonnet', effort: 'max' }));
    await render();
    expect(buttonByText('Sonnet 5.5 · Max')).toBeTruthy();
  });

  it('falls back to the last start\'s model and effort when nothing was picked since', async () => {
    mocks.flags['chat-effort-enabled'] = true;
    localStorage.setItem('termag-chat-last-start', JSON.stringify({ pick: null, space: null, model: 'haiku', effort: 'low' }));
    await render();
    expect(buttonByText('Haiku 4.5 · Low')).toBeTruthy();
  });

  it('hides Send while the message is empty, and shows no "say what Claude should do" hint', async () => {
    mocks.createBox.mockResolvedValue({ claimed: false, instance: { id: 'box-1', name: 'web' } });
    mocks.createProject.mockResolvedValue({ id: 'proj-1' });
    await render();
    await act(async () => { await Promise.resolve(); });

    await act(async () => { buttonByText('Choose a repository').click(); });
    await act(async () => { buttonByText('acme/web').click(); });

    expect(document.querySelector('button[type="submit"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/say what claude should do/i);

    const input = document.querySelector('textarea')!;
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await flush();
    expect(mocks.createProject).not.toHaveBeenCalled();

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'fix the build');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const send = document.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(send).not.toBeNull();
    expect(send.disabled).toBe(false);
  });

  it('offers only New box, and launches one, while chat-existing-box-enabled is off', async () => {
    boxes.push({ id: 'b1', name: 'dev', kind: 'ec2', status: 'ready', createdAt: '', projects: [] });
    mocks.createBox.mockResolvedValue({ claimed: false, instance: { id: 'box-1', name: 'web' } });
    mocks.createProject.mockResolvedValue({ id: 'proj-1' });
    await render();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { buttonByText('Choose a repository').click(); });
    await act(async () => { buttonByText('acme/web').click(); });

    await openBoxDialog();
    expect([...document.querySelectorAll('.chat-launch-box')].map(b => b.querySelector('.chat-launch-box-name')?.textContent)).toEqual(['New box']);
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Your boxes');

    const input = document.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'fix the build');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (document.querySelector('button[type="submit"]') as HTMLButtonElement).click(); });
    await flush();
    expect(mocks.createBox).toHaveBeenCalledTimes(1);
    expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'box-1' }));
  });

  it('keeps a chosen box that drops out of the list, and never launches a new box for it', async () => {
    mocks.flags['chat-existing-box-enabled'] = true;
    boxes.push({ id: 'b1', name: 'dev', kind: 'ec2', status: 'ready', createdAt: '' });
    mocks.createProject.mockResolvedValue({ id: 'proj-1' });
    await render();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { buttonByText('Choose a repository').click(); });
    await act(async () => { buttonByText('acme/web').click(); });
    await openBoxDialog();
    const dev = [...document.querySelectorAll('.chat-launch-box')].find(b => b.textContent?.startsWith('dev')) as HTMLButtonElement;
    await act(async () => { dev.click(); });
    await act(async () => { (document.querySelector('.chat-launch-dialog-actions button') as HTMLButtonElement).click(); });

    // The box list reloads without it (a backend restart, say); typing renders again.
    feed.list = [];
    const input = document.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'fix the build');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(boxLabel()).toBe('dev');
    expect((document.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toContain("dev isn't available right now");
    await act(async () => { (document.querySelector('form') as HTMLFormElement).requestSubmit(); });
    expect(mocks.createBox).not.toHaveBeenCalled();
    expect(mocks.createProject).not.toHaveBeenCalled();

    // It comes back: Send goes to it.
    feed.list = [{ id: 'b1', name: 'dev', kind: 'ec2', status: 'ready', createdAt: '' }];
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'fix the build now');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect((document.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { (document.querySelector('button[type="submit"]') as HTMLButtonElement).click(); });
    await flush();
    expect(mocks.createBox).not.toHaveBeenCalled();
    expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'b1' }));
  });

  it('keeps the session name editable after a launched box\'s start was refused, and retries on that box', async () => {
    mocks.flags['chat-existing-box-enabled'] = true;
    boxes.push({ id: 'b1', name: 'dev', kind: 'ec2', status: 'ready', createdAt: '' });
    mocks.createBox.mockResolvedValue({ claimed: false, instance: { id: 'box-1', name: 'web' } });
    mocks.createProject
      .mockRejectedValueOnce({ response: { status: 409, data: { error: 'Project name already exists' } } })
      .mockResolvedValueOnce({ id: 'proj-1' });
    await render();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { buttonByText('Choose a repository').click(); });
    await act(async () => { buttonByText('acme/web').click(); });
    const input = document.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'fix the build');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (document.querySelector('button[type="submit"]') as HTMLButtonElement).click(); });
    await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Project name already exists');

    // The drawer still opens; the box is fixed, the session name is not.
    const trigger = document.querySelector('.chat-launch-trigger') as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
    await openBoxDialog();
    for (const card of document.querySelectorAll('.chat-launch-box')) expect((card as HTMLButtonElement).disabled).toBe(true);
    const field = [...document.querySelectorAll('.chat-launch-dialog label')].find(l => l.textContent?.startsWith('Session name'))!.querySelector('input')!;
    expect(field.disabled).toBe(false);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'web-2');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (document.querySelector('.chat-launch-dialog-actions button') as HTMLButtonElement).click(); });
    await act(async () => { (document.querySelector('button[type="submit"]') as HTMLButtonElement).click(); });
    await flush();
    expect(mocks.createBox).toHaveBeenCalledTimes(1);
    expect(mocks.createProject).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'web-2', instanceId: 'box-1' }));
  });

  it('starts on one of your boxes from the drawer instead of launching a new one', async () => {
    mocks.flags['chat-existing-box-enabled'] = true;
    boxes.push({ id: 'b1', name: 'dev', kind: 'ec2', status: 'ready', createdAt: '', projects: [{ id: 'p0', name: 'other' }] });
    mocks.createProject.mockResolvedValue({ id: 'proj-1' });
    await render();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { buttonByText('Choose a repository').click(); });
    await act(async () => { buttonByText('acme/web').click(); });

    expect(boxLabel()).toBe('New box');
    await openBoxDialog();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Where this session runs');
    // New box's name field sits inside the New box choice while it is picked.
    expect(document.querySelector('.chat-launch-new input[aria-label="Box name"]')).not.toBeNull();
    const dev = [...document.querySelectorAll('.chat-launch-box')].find(b => b.textContent?.startsWith('dev')) as HTMLButtonElement;
    expect(dev.textContent).toContain('Running · 1 session');
    await act(async () => { dev.click(); });
    expect(dev.getAttribute('aria-checked')).toBe('true');
    expect(boxLabel()).toBe('dev');
    // A box name only means something for a new box.
    expect(document.querySelector('input[aria-label="Box name"]')).toBeNull();

    const input = document.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'fix the build');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (document.querySelector('button[type="submit"]') as HTMLButtonElement).click(); });
    await flush();
    expect(mocks.createBox).not.toHaveBeenCalled();
    expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'b1', repoUrl: 'https://github.com/acme/web.git' }));
  });

  it('wakes an asleep box when it is picked, and waits for it to be up', async () => {
    mocks.flags['chat-existing-box-enabled'] = true;
    boxes.push({ id: 'b2', name: 'big', kind: 'ec2', ec2InstanceId: 'i-big', status: 'hibernated', createdAt: '' });
    await render();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { buttonByText('Choose a repository').click(); });
    await act(async () => { buttonByText('acme/web').click(); });
    await openBoxDialog();
    const big = [...document.querySelectorAll('.chat-launch-box')].find(b => b.textContent?.startsWith('big')) as HTMLButtonElement;
    expect(big.textContent).toContain('Hibernated · wakes when you pick it');
    await act(async () => { big.click(); });
    await flush();
    expect(mocks.startBox).toHaveBeenCalledWith('b2');
    // Marked starting at once, so the feed keeps polling it even if the reload fails.
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'b2', status: 'starting' }));
    expect(mocks.reloadBoxes).toHaveBeenCalled();

    const input = document.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'fix the build');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect((document.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toContain('Waiting for big to wake up');
  });

  it('says a refused wake did not happen, and tries again when the box is picked again', async () => {
    mocks.flags['chat-existing-box-enabled'] = true;
    boxes.push({ id: 'b2', name: 'big', kind: 'ec2', ec2InstanceId: 'i-big', status: 'stopped', createdAt: '' });
    mocks.startBox.mockRejectedValueOnce({ response: { data: { error: 'The box is still stopping' } } });
    await render();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { buttonByText('Choose a repository').click(); });
    await act(async () => { buttonByText('acme/web').click(); });
    await openBoxDialog();
    const big = () => [...document.querySelectorAll('.chat-launch-box')].find(b => b.textContent?.startsWith('big')) as HTMLButtonElement;
    await act(async () => { big().click(); });
    await flush();
    const input = document.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'fix the build');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect((document.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toContain("big didn't wake up: pick it again to retry, or pick another box");
    expect(document.body.textContent).not.toContain('Waiting for big to wake up');
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('The box is still stopping');

    await act(async () => { big().click(); });
    await flush();
    expect(mocks.startBox).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain('Waiting for big to wake up');
  });

  it('never wakes, or offers, an asleep box the start route cannot take', async () => {
    mocks.flags['chat-existing-box-enabled'] = true;
    boxes.push({ id: 'b3', name: 'ext', kind: 'external', status: 'stopped', createdAt: '' });
    await render();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { buttonByText('Choose a repository').click(); });
    await act(async () => { buttonByText('acme/web').click(); });
    await openBoxDialog();
    expect([...document.querySelectorAll('.chat-launch-box-name')].map(b => b.textContent)).toEqual(['New box']);
    expect(mocks.startBox).not.toHaveBeenCalled();
  });

  it('picks a space from a dialog in the drawer, like the box', async () => {
    mocks.flags['spaces-enabled'] = true;
    mocks.listSpaces.mockResolvedValue({
      spaces: [{ id: '1', name: 'notes', description: null, createdAt: '', usedBytes: 0, quotaBytes: 1, role: 'owner', readOnly: false }],
    });
    mocks.createBox.mockResolvedValue({ claimed: false, instance: { id: 'box-1', name: 'web' } });
    mocks.createProject.mockResolvedValue({ id: 'proj-1' });
    await render();
    await flush();

    // The space lives in the drawer under the composer, beside the box.
    expect(document.querySelector('.chat-launch-ask .chat-new-space')).toBeNull();
    expect(document.querySelector('.chat-launch-strip .chat-new-space')).not.toBeNull();
    const space = buttonByText('No space');
    expect(space.className).toContain('chat-launch-trigger');
    expect(space.getAttribute('aria-haspopup')).toBe('dialog');
    expect(document.querySelector('select')).toBeNull();
    expect(document.body.textContent).not.toContain('shared file store');
    expect(buttonByText('Sonnet 5.5')).toBeTruthy();

    await act(async () => { buttonByText('Choose a repository').click(); });
    expect(buttonByText('Choose a repository').getAttribute('aria-expanded')).toBe('true');
    await act(async () => { space.click(); });
    expect(buttonByText('Choose a repository').getAttribute('aria-expanded')).toBe('false');
    expect(document.body.textContent).toContain("This session's box");
    const notes = [...document.querySelectorAll('.chat-space-dialog [role="radio"]')].find(o => o.textContent === 'notes') as HTMLButtonElement;
    await act(async () => { notes.click(); });
    expect(buttonByText('notes').getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.chat-space-dialog')).toBeNull();

    await act(async () => { buttonByText('notes').click(); });
    expect(document.querySelector('[aria-label="Spaces"]')).not.toBeNull();
    await act(async () => { (document.querySelector('.chat-space-dialog .chat-launch-dialog-actions button') as HTMLButtonElement).click(); });
    expect(document.querySelector('[aria-label="Spaces"]')).toBeNull();
    await act(async () => { buttonByText('Sonnet 5.5').click(); });
    expect(document.body.textContent).toContain('Sonnet 5.5');

    await act(async () => { buttonByText('Choose a repository').click(); });
    await act(async () => { buttonByText('acme/web').click(); });
    // A repository outside the company orgs starts Read only, on the permission pill.
    expect(document.querySelector('.chat-permission-btn')?.getAttribute('aria-label')).toBe('Permissions: Read only');
    const input = document.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'fix the login');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (document.querySelector('button[type="submit"]') as HTMLButtonElement).click(); });
    await flush();

    expect(mocks.addSpaceBox).toHaveBeenCalledWith('notes', 'box-1');
    expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({
      repoUrl: 'https://github.com/acme/web.git',
      claudeModel: 'sonnet',
      chatTrusted: false,
      // The chat belongs to the space it started in, for good: its group, chip and memory (plan-outbox #38).
      chatSpace: 'notes',
    }));
    expect(mocks.openTab).toHaveBeenCalledWith({ kind: 'chat', projectId: 'proj-1', workstream: 'main' }, null);
  });

  it('sends the default Sonnet model and a pasted URL when the list has failed', async () => {
    mocks.list.mockRejectedValue(new Error('down'));
    mocks.createBox.mockResolvedValue({ claimed: true, instance: { id: 'box-2', name: 'other' } });
    mocks.createProject.mockResolvedValue({ id: 'proj-2' });
    await render();
    await act(async () => { await Promise.resolve(); });

    await act(async () => { buttonByText('Choose a repository').click(); });
    expect(document.body.textContent).toContain('Could not load repositories');
    const url = document.querySelector('input[aria-label="Repository URL"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(url, 'https://github.com/acme/other');
      url.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const input = document.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'look at the readme');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (document.querySelector('button[type="submit"]') as HTMLButtonElement).click(); });
    await flush();

    expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({
      repoUrl: 'https://github.com/acme/other',
      defaultBranch: null,
      claudeModel: 'sonnet',
      chatTrusted: false,
      initialAgent: { enabled: true, provider: 'claude-chat' },
    }));
  });

  it('shows an empty repository list and a failed start', async () => {
    mocks.list.mockResolvedValue({ status: 'ok', groups: [] });
    mocks.createBox.mockRejectedValue({ response: { data: { error: 'No box AMI found' } } });
    await render();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { buttonByText('Choose a repository').click(); });
    expect(document.body.textContent).toContain('No repositories on this account');

    const url = document.querySelector('input[aria-label="Repository URL"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(url, 'git@github.com:acme/web.git');
      url.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const input = document.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'hello');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (document.querySelector('button[type="submit"]') as HTMLButtonElement).click(); });
    await flush();
    expect(document.body.textContent).toContain('No box AMI found');
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it('does not start a chat when Enter is pressed in the repository search or URL', async () => {
    mocks.createBox.mockResolvedValue({ claimed: false, instance: { id: 'box-1', name: 'web' } });
    mocks.createProject.mockResolvedValue({ id: 'proj-1' });
    await render();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { buttonByText('Choose a repository').click(); });
    await act(async () => { buttonByText('acme/web').click(); });
    const message = document.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(message, 'fix the login');
      message.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { buttonByText('acme/web').click(); });

    const search = document.querySelector('input[aria-label="Search repositories"]') as HTMLInputElement;
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    await act(async () => { search.dispatchEvent(enter); });
    expect(enter.defaultPrevented).toBe(true);

    const url = document.querySelector('input[aria-label="Repository URL"]') as HTMLInputElement;
    const urlEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    await act(async () => { url.dispatchEvent(urlEnter); });
    expect(urlEnter.defaultPrevented).toBe(true);
    expect(mocks.createBox).not.toHaveBeenCalled();
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it('sends the chosen Claude model when the chat is a scheduled automation', async () => {
    mocks.flags['automations-enabled'] = true;
    mocks.previewSchedule.mockResolvedValue({
      normalised: '0 9 * * 1-5', timezone: 'UTC', next: ['2026-10-22T09:00:00.000Z'],
      minGapMinutes: 1440, tooFrequent: null, keepsBoxUpMinutesPerDay: null,
    });
    mocks.createBox.mockResolvedValue({ claimed: false, instance: { id: 'box-1', name: 'web' } });
    mocks.createAutomation.mockResolvedValue({ project: { id: 'auto-1' } });
    await render();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { buttonByText('Choose a repository').click(); });
    await act(async () => { buttonByText('acme/web').click(); });
    await act(async () => { buttonByText('Sonnet 5.5').click(); });
    await act(async () => { buttonByText('Haiku 4.5').click(); });
    await pickSchedule();
    const message = document.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(message, 'triage the inbox');
      message.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
    const send = document.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    await act(async () => { send.click(); });
    await flush();
    expect(mocks.createProject).not.toHaveBeenCalled();
    expect(mocks.createAutomation).toHaveBeenCalledWith(expect.objectContaining({
      repoUrl: 'https://github.com/acme/web.git',
      claudeModel: 'haiku',
      prompt: 'triage the inbox',
    }));
    expect(mocks.navigate).toHaveBeenCalledWith('/automations/auto-1');
  });

  it('starts on On a schedule with ?schedule=1, and follows the URL when it changes on the mounted page', async () => {
    mocks.flags['automations-enabled'] = true;
    mocks.previewSchedule.mockResolvedValue({
      normalised: '0 9 * * 1-5', timezone: 'UTC', next: ['2026-10-22T09:00:00.000Z'],
      minGapMinutes: 1440, tooFrequent: null, keepsBoxUpMinutesPerDay: null,
    });
    mocks.search = 'schedule=1';
    await render();
    expect(scheduleTrigger()!.textContent).not.toContain('No schedule');
    expect((document.querySelector('button[type="submit"]') as HTMLButtonElement | null)?.textContent ?? '').not.toBe('Send');
    // New session from the sidebar: the same route, without the query.
    mocks.search = '';
    await render();
    expect(scheduleTrigger()!.textContent).toContain('No schedule');
    mocks.search = 'schedule=1';
    await render();
    expect(scheduleTrigger()!.textContent).not.toContain('No schedule');
  });

  it('opens a new automation on its simple-UI page with simple-ui-automations-enabled', async () => {
    mocks.flags['automations-enabled'] = true;
    mocks.flags['simple-ui-automations-enabled'] = true;
    mocks.previewSchedule.mockResolvedValue({
      normalised: '0 9 * * 1-5', timezone: 'UTC', next: ['2026-10-22T09:00:00.000Z'],
      minGapMinutes: 1440, tooFrequent: null, keepsBoxUpMinutesPerDay: null,
    });
    mocks.createBox.mockResolvedValue({ claimed: false, instance: { id: 'box-1', name: 'web' } });
    mocks.createAutomation.mockResolvedValue({ project: { id: 'auto-1' } });
    mocks.search = 'schedule=1';
    await render();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { buttonByText('Choose a repository').click(); });
    await act(async () => { buttonByText('acme/web').click(); });
    const message = document.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(message, 'triage the inbox');
      message.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
    await act(async () => { (document.querySelector('button[type="submit"]') as HTMLButtonElement).click(); });
    await flush();
    expect(mocks.createAutomation).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'triage the inbox' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/chat/automations/auto-1');
  });

  it('makes the space picked the automation\'s with simple-ui-automations-enabled, so it is listed there', async () => {
    mocks.flags['automations-enabled'] = true;
    mocks.flags['simple-ui-automations-enabled'] = true;
    mocks.flags['spaces-enabled'] = true;
    mocks.listSpaces.mockResolvedValue({
      spaces: [{ id: '1', name: 'notes', description: null, createdAt: '', usedBytes: 0, quotaBytes: 1, role: 'owner', readOnly: false }],
    });
    mocks.previewSchedule.mockResolvedValue({
      normalised: '0 9 * * 1-5', timezone: 'UTC', next: ['2026-10-22T09:00:00.000Z'],
      minGapMinutes: 1440, tooFrequent: null, keepsBoxUpMinutesPerDay: null,
    });
    mocks.createBox.mockResolvedValue({ claimed: false, instance: { id: 'box-1', name: 'web' } });
    mocks.createAutomation.mockResolvedValue({ project: { id: 'auto-1' } });
    // A space's head menu: New automation.
    mocks.search = 'schedule=1&space=notes';
    await render();
    await flush();
    expect(buttonByText('notes')).toBeTruthy();
    await act(async () => { buttonByText('Choose a repository').click(); });
    await act(async () => { buttonByText('acme/web').click(); });
    const message = document.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(message, 'triage the inbox');
      message.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
    await act(async () => { (document.querySelector('button[type="submit"]') as HTMLButtonElement).click(); });
    await flush();
    expect(mocks.createAutomation).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'triage the inbox', spaceName: 'notes' }));
  });
});

describe('New chat defaults', () => {
  async function typeAndSend(text: string) {
    const input = document.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (document.querySelector('button[type="submit"]') as HTMLButtonElement).click(); });
    await flush();
  }

  it('a session started in No space is recorded as No space for good, and opens no tab ahead of the route (plan-outbox #38)', async () => {
    mocks.flags['spaces-enabled'] = true;
    mocks.listSpaces.mockResolvedValue({
      spaces: [{ id: '1', name: 'notes', description: null, createdAt: '', usedBytes: 0, quotaBytes: 1, role: 'owner', readOnly: false }],
    });
    mocks.createBox.mockResolvedValue({ claimed: false, instance: { id: 'box-1', name: 'web' } });
    mocks.createProject.mockResolvedValue({ id: 'proj-1' });
    await render();
    await flush();
    expect(buttonByText('No space')).toBeTruthy();
    await act(async () => { buttonByText('Choose a repository').click(); });
    await act(async () => { buttonByText('acme/web').click(); });
    const input = document.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'hello');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (document.querySelector('button[type="submit"]') as HTMLButtonElement).click(); });
    await flush();
    expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({ chatSpace: null }));
    expect(mocks.openTab).not.toHaveBeenCalled();
  });

  it('remembers a picked repository and space before the session starts', async () => {
    mocks.flags['spaces-enabled'] = true;
    mocks.listSpaces.mockResolvedValue({
      spaces: [{ id: '1', name: 'notes', description: null, createdAt: '', usedBytes: 0, quotaBytes: 1, role: 'owner', readOnly: false }],
    });
    await render();
    await flush();
    await act(async () => { buttonByText('Choose a repository').click(); });
    await act(async () => { buttonByText('acme/api').click(); });
    await act(async () => { buttonByText('No space').click(); });
    const notes = [...document.querySelectorAll('.chat-space-dialog [role="radio"]')].find(o => o.textContent === 'notes') as HTMLButtonElement;
    await act(async () => { notes.click(); });
    expect(mocks.createProject).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('termag-chat-last-start')!)).toMatchObject({
      pick: { kind: 'listed', fullName: 'acme/api', defaultBranch: 'trunk' }, space: 'notes',
    });
  });

  it('remembers a pasted URL only once it reads as a repository', async () => {
    await render();
    await flush();
    await act(async () => { buttonByText('Choose a repository').click(); });
    const url = document.querySelector('input[aria-label="Repository URL"]') as HTMLInputElement;
    const type = (text: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(url, text);
      url.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await type('https://github.com/acme');
    expect(localStorage.getItem('termag-chat-last-start')).toBeNull();
    await type('https://github.com/acme/other');
    expect(JSON.parse(localStorage.getItem('termag-chat-last-start')!)).toMatchObject({
      pick: { kind: 'pasted', url: 'https://github.com/acme/other' },
    });
  });

  it('opens on the repository, space and model the last session started with', async () => {
    mocks.flags['spaces-enabled'] = true;
    mocks.listSpaces.mockResolvedValue({
      spaces: [{ id: '1', name: 'notes', description: null, createdAt: '', usedBytes: 0, quotaBytes: 1, role: 'owner', readOnly: false }],
    });
    mocks.createBox.mockResolvedValue({ claimed: false, instance: { id: 'box-1', name: 'api' } });
    mocks.createProject.mockResolvedValue({ id: 'proj-1' });
    await render();
    await flush();

    expect(buttonByText('Choose a repository')).toBeTruthy();
    expect(buttonByText('No space')).toBeTruthy();
    await act(async () => { buttonByText('Choose a repository').click(); });
    await act(async () => { buttonByText('acme/api').click(); });
    await act(async () => { buttonByText('No space').click(); });
    const notes = [...document.querySelectorAll('.chat-space-dialog [role="radio"]')].find(o => o.textContent === 'notes') as HTMLButtonElement;
    await act(async () => { notes.click(); });
    await act(async () => { buttonByText('Sonnet 5.5').click(); });
    await act(async () => { buttonByText('Opus 5.5').click(); });
    await typeAndSend('fix the login');
    expect(mocks.createProject).toHaveBeenCalledTimes(1);

    act(() => { root.unmount(); });
    root = createRoot(container);
    mocks.createProject.mockClear();
    mocks.addSpaceBox.mockClear();
    await render();
    await flush();

    expect(buttonByText('acme/api')).toBeTruthy();
    // The drawer's strip shows the box and the remembered space.
    expect(boxLabel()).toBe('New box');
    expect(buttonByText('notes')).toBeTruthy();
    expect(buttonByText('Opus 5.5')).toBeTruthy();
    await typeAndSend('add a test');
    expect(mocks.addSpaceBox).toHaveBeenCalledWith('notes', 'box-1');
    expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({
      repoUrl: 'https://github.com/acme/api.git',
      defaultBranch: 'trunk',
      claudeModel: 'opus',
    }));
  });

  it('keeps the picked repository through a start that failed, as it was picked', async () => {
    mocks.createBox.mockResolvedValue({ claimed: false, instance: { id: 'box-1', name: 'web' } });
    mocks.createProject.mockRejectedValue({ response: { data: { error: 'nope' } } });
    await render();
    await act(async () => { buttonByText('Choose a repository').click(); });
    await act(async () => { buttonByText('acme/web').click(); });
    await typeAndSend('fix the login');
    expect(document.body.textContent).toContain('nope');

    act(() => { root.unmount(); });
    root = createRoot(container);
    await render();
    expect(buttonByText('acme/web')).toBeTruthy();
  });

  it('opens on a remembered pasted URL with the URL field filled in', async () => {
    localStorage.setItem('termag-chat-last-start', JSON.stringify({ pick: { kind: 'pasted', url: 'https://github.com/acme/other' }, space: null }));
    await render();
    await act(async () => { buttonByText(document.querySelector('.chat-compose-repo-name')!.textContent!.trim()).click(); });
    expect((document.querySelector('input[aria-label="Repository URL"]') as HTMLInputElement).value).toBe('https://github.com/acme/other');
  });
});

describe('New chat trust default', () => {
  const orgCatalog = {
    status: 'ok',
    groups: [
      {
        owner: 'acme', kind: 'user', status: 'ok',
        repos: [{ fullName: 'acme/web', defaultBranch: 'main' }],
      },
      {
        owner: 'example-org', kind: 'org', status: 'ok',
        repos: [{ fullName: 'example-org/webapp', defaultBranch: 'main' }],
      },
      {
        owner: 'example-team', kind: 'org', status: 'ok',
        repos: [{ fullName: 'example-team/termag', defaultBranch: 'main' }],
      },
    ],
  };

  /** The permission pill's choice: 'read' (Read only) or 'full' (Full access). */
  function permission(): string | null {
    return document.querySelector('.chat-permission-btn')?.getAttribute('data-choice') ?? null;
  }

  async function choosePermission(label: 'Read only' | 'Full access') {
    const pill = document.querySelector('.chat-permission-btn') as HTMLButtonElement;
    if (pill.getAttribute('aria-expanded') !== 'true') await act(async () => { pill.click(); });
    const option = [...document.querySelectorAll('.chat-permission-option')].find(o => o.textContent?.startsWith(label)) as HTMLButtonElement;
    await act(async () => { option.click(); });
  }

  async function typeMessage(text: string) {
    const input = document.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function openRepoMenu() {
    const trigger = document.querySelector('button.chat-compose-repo-btn') as HTMLButtonElement;
    if (trigger.getAttribute('aria-expanded') !== 'true') {
      await act(async () => { trigger.click(); });
    }
  }

  async function pasteUrl(url: string) {
    await openRepoMenu();
    const field = document.querySelector('input[aria-label="Repository URL"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, url);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  beforeEach(() => {
    mocks.list.mockResolvedValue(orgCatalog);
  });

  it('creates a listed company-org repository trusted', async () => {
    mocks.createBox.mockResolvedValue({ claimed: false, instance: { id: 'box-1', name: 'webapp' } });
    mocks.createProject.mockResolvedValue({ id: 'proj-1' });
    await render();
    await act(async () => { await Promise.resolve(); });

    await openRepoMenu();
    await act(async () => { buttonByText('example-org/webapp').click(); });
    // A company-org repository starts on Full access, and there is no trust checkbox any more.
    expect(permission()).toBe('full');
    expect(document.querySelector('label.chat-new-trust')).toBeNull();

    await typeMessage('fix the flag');
    await act(async () => { (document.querySelector('button[type="submit"]') as HTMLButtonElement).click(); });
    await flush();
    expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({
      repoUrl: 'https://github.com/example-org/webapp.git',
      chatTrusted: true,
    }));
  });

  it('keeps a company-org repository read-only for that session when Read only is picked', async () => {
    mocks.createBox.mockResolvedValue({ claimed: false, instance: { id: 'box-1', name: 'webapp' } });
    mocks.createProject.mockResolvedValue({ id: 'proj-1' });
    await render();
    await act(async () => { await Promise.resolve(); });

    await openRepoMenu();
    await act(async () => { buttonByText('example-org/webapp').click(); });
    await choosePermission('Read only');
    expect(permission()).toBe('read');

    await typeMessage('just read it');
    await act(async () => { (document.querySelector('button[type="submit"]') as HTMLButtonElement).click(); });
    await flush();
    expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({
      repoUrl: 'https://github.com/example-org/webapp.git',
      chatTrusted: false,
    }));
  });

  it('starts a pasted company-org URL on Full access and every other repository on Read only', async () => {
    await render();
    await act(async () => { await Promise.resolve(); });

    await pasteUrl('https://github.com/example-org/webapp');
    expect(permission()).toBe('full');
    await pasteUrl('git@github.com:example-team/termag.git');
    expect(permission()).toBe('full');
    await pasteUrl('https://github.com/acme/other');
    expect(permission()).toBe('read');

    await openRepoMenu();
    await act(async () => { buttonByText('acme/web').click(); });
    expect(permission()).toBe('read');
    await openRepoMenu();
    await act(async () => { buttonByText('example-team/termag').click(); });
    expect(permission()).toBe('full');
  });

  it('names the permission choice on the pill beside its icon, Read only and Full access alike', async () => {
    await render();
    await act(async () => { await Promise.resolve(); });
    const pill = () => document.querySelector('.chat-permission-btn') as HTMLButtonElement;
    await pasteUrl('https://github.com/example-org/webapp');
    expect(pill().textContent).toBe('Full access');
    await pasteUrl('https://github.com/acme/other');
    expect(pill().textContent).toBe('Read only');
    expect(pill().querySelector('svg')).not.toBeNull();
    expect(pill().getAttribute('aria-label')).toBe('Permissions: Read only');
    await act(async () => { pill().click(); });
    const options = [...document.querySelectorAll('.chat-permission-option')].map(o => o.textContent);
    expect(options[0]).toMatch(/^Read only/);
    expect(options[1]).toMatch(/^Full access/);
  });

  it('keeps each repository on its own choice when the repository changes', async () => {
    await render();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { buttonByText('Choose a repository').click(); });
    await act(async () => { buttonByText('example-org/webapp').click(); });
    await choosePermission('Read only');
    expect(permission()).toBe('read');

    await act(async () => { buttonByText('example-org/webapp').click(); });
    await act(async () => { buttonByText('acme/web').click(); });
    expect(permission()).toBe('read');
    await choosePermission('Full access');
    expect(permission()).toBe('full');

    await act(async () => { buttonByText('acme/web').click(); });
    await act(async () => { buttonByText('example-org/webapp').click(); });
    // webapp was set to Read only above, and opens on it again.
    expect(permission()).toBe('read');
  });

  it('opens on the permission last picked for a repository, and only for that repository', async () => {
    await render();
    await act(async () => { await Promise.resolve(); });
    await openRepoMenu();
    await act(async () => { buttonByText('acme/web').click(); });
    expect(permission()).toBe('read');
    await choosePermission('Full access');

    act(() => { root.unmount(); });
    root = createRoot(container);
    await render();
    await act(async () => { await Promise.resolve(); });
    await openRepoMenu();
    await act(async () => { buttonByText('acme/web').click(); });
    expect(permission()).toBe('full');
    // Another repository keeps its own default: Full access did not become global.
    await openRepoMenu();
    await act(async () => { buttonByText('example-org/webapp').click(); });
    expect(permission()).toBe('full');
    await choosePermission('Read only');
    await openRepoMenu();
    await act(async () => { buttonByText('acme/web').click(); });
    expect(permission()).toBe('full');
  });

  describe('Act as an orchestrator', () => {
    function toggle(): HTMLButtonElement | null {
      return document.querySelector('button.chat-orchestrator-btn');
    }

    async function send(text: string) {
      await typeMessage(text);
      await act(async () => { (document.querySelector('button[type="submit"]') as HTMLButtonElement).click(); });
      await flush();
    }

    beforeEach(() => {
      localStorage.clear();
      mocks.createBox.mockResolvedValue({ claimed: false, instance: { id: 'box-1', name: 'webapp' } });
      mocks.createProject.mockResolvedValue({ id: 'proj-1' });
    });

    it('sits in the bar beside the permissions, off, and changes nothing when left so', async () => {
      await render();
      await openRepoMenu();
      await act(async () => { buttonByText('example-org/webapp').click(); });
      const t = toggle()!;
      expect(t.closest('.chat-compose-pills')).not.toBeNull();
      expect(document.querySelector('.chat-new-orchestrator')).toBeNull();
      expect(t.getAttribute('role')).toBe('switch');
      expect(t.getAttribute('aria-checked')).toBe('false');
      expect(t.textContent).toBe('Orchestrator');
      expect(t.querySelector('.chat-switch')).not.toBeNull();

      await send('fix the flag');
      expect(mocks.createProject.mock.calls[0][0]).not.toHaveProperty('chatOrchestrator');
      expect(localStorage.getItem('termag-chat-queued:proj-1')).toBe('fix the flag');
    });

    it('asks for an orchestrator chat when switched on, and leaves the first message as typed', async () => {
      await render();
      await openRepoMenu();
      await act(async () => { buttonByText('example-org/webapp').click(); });
      await act(async () => { toggle()!.click(); });
      expect(toggle()!.getAttribute('aria-checked')).toBe('true');

      await send('ship the release');
      expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({ chatTrusted: true, chatOrchestrator: true }));
      expect(localStorage.getItem('termag-chat-queued:proj-1')).toBe('ship the release');
    });

    it('turns off, says why, and grants nothing while the session is Read only', async () => {
      await render();
      await openRepoMenu();
      await act(async () => { buttonByText('example-org/webapp').click(); });
      await act(async () => { toggle()!.click(); });
      await choosePermission('Read only');
      expect(toggle()!.getAttribute('aria-disabled')).toBe('true');
      expect(toggle()!.getAttribute('aria-checked')).toBe('false');
      expect(toggle()!.textContent).toBe('Orchestrator');
      // The reason is in its instant tooltip, on a mouse hover (jsdom has no PointerEvent).
      const hover = new MouseEvent('pointerover', { bubbles: true, relatedTarget: document.body });
      Object.defineProperty(hover, 'pointerType', { value: 'mouse' });
      await act(async () => { toggle()!.dispatchEvent(hover); });
      expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Needs Full access');
      await act(async () => { toggle()!.click(); });
      expect(toggle()!.getAttribute('aria-checked')).toBe('false');
      expect(permission()).toBe('read');

      await send('just read it');
      expect(mocks.createProject.mock.calls[0][0]).not.toHaveProperty('chatOrchestrator');
    });

    it('is not offered for a scheduled automation', async () => {
      mocks.flags['automations-enabled'] = true;
      await render();
      await openRepoMenu();
      await act(async () => { buttonByText('example-org/webapp').click(); });
      expect(toggle()).not.toBeNull();
      await pickSchedule();
      expect(toggle()).toBeNull();
    });
  });
});

describe('New chat schedule', () => {
  const preview = {
    normalised: '0 9 * * 1-5', timezone: 'UTC', next: ['2026-10-27T09:00:00.000Z'],
    minGapMinutes: 1440, tooFrequent: null, keepsBoxUpMinutesPerDay: null,
  };

  async function chooseRepo(fullName: string) {
    await act(async () => { (document.querySelector('button.chat-compose-repo-btn') as HTMLButtonElement).click(); });
    await act(async () => { buttonByText(fullName).click(); });
  }

  async function typeMessage(text: string) {
    const input = document.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  /** Past the schedule check's 300 ms wait. */
  async function settle() {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
  }

  async function send() {
    await act(async () => { (document.querySelector('button[type="submit"]') as HTMLButtonElement).click(); });
    await flush();
  }

  beforeEach(() => {
    mocks.flags['automations-enabled'] = true;
    mocks.previewSchedule.mockResolvedValue(preview);
    mocks.createBox.mockResolvedValue({ claimed: false, instance: { id: 'box-1', name: 'web' } });
    mocks.createAutomation.mockResolvedValue({ project: { id: 'auto-1' } });
    mocks.list.mockResolvedValue({
      status: 'ok',
      groups: [
        { owner: 'acme', kind: 'user', status: 'ok', repos: [{ fullName: 'acme/web', defaultBranch: 'main' }] },
        { owner: 'example-org', kind: 'org', status: 'ok', repos: [{ fullName: 'example-org/webapp', defaultBranch: 'main' }] },
      ],
    });
  });

  it('is a trigger in the drawer beside the box and the space, and only with automations-enabled', async () => {
    await render();
    const trigger = scheduleTrigger()!;
    expect(trigger.closest('.chat-launch-strip')).not.toBeNull();
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.textContent).toBe('No schedule');
    // The old checkbox under the launcher is gone.
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();

    act(() => { root.unmount(); });
    root = createRoot(container);
    mocks.flags['automations-enabled'] = false;
    await render();
    expect(scheduleTrigger()).toBeNull();
  });

  it('opens the fields inside On a schedule, without the prompt or a permissions select, and names the schedule after Done', async () => {
    await render();
    await chooseRepo('acme/web');
    await pickSchedule('On a schedule', false);
    const dialog = scheduleDialog()!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.querySelector('.chat-launch-new[data-checked] select#nc-af-preset')).not.toBeNull();
    expect(dialog.querySelector('#nc-af-prompt')).toBeNull();
    expect(dialog.querySelector('#nc-af-tier')).toBeNull();
    // Read only on the pill: the read tier's line, and no PR on a change.
    expect(dialog.textContent).toContain('Read-only: Claude can read the repository');
    expect(dialog.textContent).not.toContain('open a draft PR');

    const preset = dialog.querySelector('select#nc-af-preset') as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(preset, 'hourly');
      preset.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => { buttonByText('Done').click(); });
    expect(scheduleDialog()).toBeNull();
    expect(scheduleTrigger()!.textContent).toBe('Every hour');
    expect(document.querySelector('textarea')!.getAttribute('placeholder')).toContain('What each run should do');
  });

  it('goes back to one session on No schedule, which closes the dialog', async () => {
    mocks.createProject.mockResolvedValue({ id: 'proj-1' });
    await render();
    await chooseRepo('acme/web');
    await pickSchedule();
    expect(scheduleTrigger()!.textContent).toBe('Weekdays at 09:00');
    await pickSchedule('No schedule');
    expect(scheduleDialog()).toBeNull();
    expect(scheduleTrigger()!.textContent).toBe('No schedule');

    await typeMessage('fix the build');
    await send();
    expect(mocks.createAutomation).not.toHaveBeenCalled();
    expect(mocks.createProject).toHaveBeenCalled();
  });

  it('keeps checking the schedule once Done has closed the dialog', async () => {
    await render();
    await chooseRepo('acme/web');
    // Done before the check has had its 300 ms.
    await pickSchedule();
    expect(mocks.previewSchedule).not.toHaveBeenCalled();
    await typeMessage('triage the inbox');
    await settle();
    expect(mocks.previewSchedule).toHaveBeenCalledWith(expect.objectContaining({ schedule: '0 9 * * 1-5' }));
    const submit = document.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    await send();
    expect(mocks.createAutomation).toHaveBeenCalledWith(expect.objectContaining({ schedule: '0 9 * * 1-5', prompt: 'triage the inbox' }));
  });

  it('holds Send and marks the trigger when the server refuses the schedule', async () => {
    mocks.previewSchedule.mockResolvedValue({ ...preview, minGapMinutes: 5, tooFrequent: 15 });
    await render();
    await chooseRepo('acme/web');
    await pickSchedule();
    await typeMessage('triage the inbox');
    await settle();
    expect(scheduleTrigger()!.getAttribute('aria-invalid')).toBe('true');
    expect((document.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('#chat-new-why')?.textContent).toBe('Pick a schedule the runs can keep, and say what each run should do');
  });

  it('takes its tier from the permission pill', async () => {
    await render();
    await chooseRepo('example-org/webapp');
    await pickSchedule('On a schedule', false);
    // Full access on the pill: the full tier's warning and PR on a change.
    expect(scheduleDialog()!.textContent).toContain('Claude runs with every tool in auto mode');
    expect(scheduleDialog()!.textContent).toContain('open a draft PR');
    await act(async () => { buttonByText('Done').click(); });
    await typeMessage('triage the inbox');
    await settle();
    await send();
    expect(mocks.createAutomation).toHaveBeenCalledWith(expect.objectContaining({ tier: 'full' }));
  });

  it('runs read only when the pill says Read only', async () => {
    await render();
    await chooseRepo('acme/web');
    await pickSchedule();
    await typeMessage('triage the inbox');
    await settle();
    await send();
    expect(mocks.createAutomation).toHaveBeenCalledWith(expect.objectContaining({ tier: 'read' }));
  });
});

describe('New chat on a phone', () => {
  function chrome(mode: ChatChrome['mode']): ChatChrome {
    return { mode, historyOpen: false, openHistory: () => { opened += 1; }, closeHistory: () => {} };
  }
  let opened = 0;

  beforeEach(() => { opened = 0; });

  async function show(mode: ChatChrome['mode'], gate: 'clear' | 'blocked' = 'clear') {
    mocks.credentials.mockResolvedValue({ github: { boxGate: gate } });
    await act(async () => { root.render(<ChatChromeProvider value={chrome(mode)}><NewChat /></ChatChromeProvider>); });
    await act(async () => { await Promise.resolve(); });
  }

  it('opens the conversation list without changing the composer', async () => {
    await show('drawer');
    const chats = buttonByText('Sessions');
    expect(chats.getAttribute('aria-controls')).toBe('chat-conversations');
    expect(chats.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { chats.click(); });
    expect(opened).toBe(1);
    expect(document.querySelector('textarea.chat-compose-input')).not.toBeNull();
    expect(buttonByText('Choose a repository')).toBeTruthy();
  });

  it('opens the list from the GitHub gate as well', async () => {
    await show('drawer', 'blocked');
    expect(document.body.textContent).toContain('Connect GitHub first');
    expect(document.body.textContent).toContain('Every session runs on its own box');
    await act(async () => { buttonByText('Sessions').click(); });
    expect(opened).toBe(1);
  });

  it('leaves the docked composer without a Sessions button', async () => {
    await show('docked');
    expect([...document.querySelectorAll('button')].some(b => b.textContent?.trim() === 'Sessions')).toBe(false);
    expect(document.querySelector('.chat-compose-box')).not.toBeNull();
    expect(document.querySelector('textarea.chat-compose-input')).not.toBeNull();
  });
});

describe('New session as a worktree of a project already on the box', () => {
  const webapp = {
    id: 'p-gon', name: 'webapp', archived: false, instanceId: 'b1', kind: 'normal', role: 'owner',
    repoUrl: 'https://github.com/example-org/webapp.git', repoDefaultBranch: 'main',
    workstreams: [{ id: 'w-main', name: 'main' }, { id: 'w-fix', name: 'fix-the-flag' }],
    workflows: [{ id: 'wf1', type: 'agent', provider: 'claude-chat', workstreamId: 'w-main' }],
  };

  async function onDevWithWebapp(project: Record<string, unknown> = webapp) {
    mocks.list.mockResolvedValue({
      status: 'ok',
      groups: [
        { owner: 'acme', kind: 'user', status: 'ok', repos: [{ fullName: 'acme/web', defaultBranch: 'main' }] },
        { owner: 'example-org', kind: 'org', status: 'ok', repos: [{ fullName: 'example-org/webapp', defaultBranch: 'main' }] },
      ],
    });
    boxes.push({ id: 'b1', name: 'dev', kind: 'ec2', status: 'ready', createdAt: '', projects: [{ id: 'p-gon', name: 'webapp' }] });
    mocks.projects.push(project);
    await render();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { buttonByText('Choose a repository').click(); });
    await act(async () => { buttonByText('example-org/webapp').click(); });
  }

  const pill = () => document.querySelector('.chat-permission-btn');
  async function choosePermissionHere(label: 'Read only' | 'Full access') {
    const btn = pill() as HTMLButtonElement;
    if (btn.getAttribute('aria-expanded') !== 'true') await act(async () => { btn.click(); });
    const option = [...document.querySelectorAll('.chat-permission-option')].find(o => o.textContent?.startsWith(label)) as HTMLButtonElement;
    await act(async () => { option.click(); });
  }

  const checkout = () => document.querySelector('.chat-checkout-trigger') as HTMLButtonElement | null;

  beforeEach(() => {
    mocks.flags['chat-existing-box-enabled'] = true;
    mocks.flags['chat-worktree-sessions-enabled'] = true;
  });

  async function chooseBox(name: string) {
    await openBoxDialog();
    const box = [...document.querySelectorAll('.chat-launch-box')].find(b => b.textContent?.startsWith(name)) as HTMLButtonElement;
    await act(async () => { box.click(); });
    await act(async () => { (document.querySelector('.chat-launch-dialog-actions button') as HTMLButtonElement).click(); });
  }

  /** Picks the worktree and, if given, where it starts, then Done. */
  async function chooseWorktree(start?: 'origin/main' | "webapp's checkout") {
    await act(async () => { checkout()!.click(); });
    const option = [...document.querySelectorAll('.chat-checkout-dialog .chat-launch-box')].find(o => o.textContent?.startsWith('webapp')) as HTMLButtonElement;
    await act(async () => { option.click(); });
    // The dialog stays open on a worktree, for where it starts.
    expect(document.querySelector('.chat-checkout-dialog')).not.toBeNull();
    if (start) {
      const base = [...document.querySelectorAll('.chat-checkout-base-option')].find(o => o.textContent === start) as HTMLButtonElement;
      await act(async () => { base.click(); });
      expect(base.getAttribute('aria-checked')).toBe('true');
    }
    await act(async () => { (document.querySelector('.chat-checkout-dialog .chat-launch-dialog-actions button') as HTMLButtonElement).click(); });
  }

  it('offers no checkout choice while chat-worktree-sessions-enabled is off, and starts its own clone', async () => {
    mocks.flags['chat-worktree-sessions-enabled'] = false;
    mocks.createProject.mockResolvedValue({ id: 'proj-1' });
    await onDevWithWebapp();
    await chooseBox('dev');
    expect(checkout()).toBeNull();
    expect(document.querySelector('.chat-permission-btn')?.textContent).not.toBe('As webapp');
    await typeAndSendAll('Fix the flag toggle on Safari please');
    expect(mocks.createWorkstream).not.toHaveBeenCalled();
    expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'b1', repoUrl: 'https://github.com/example-org/webapp.git' }));
  });

  it('offers no checkout choice on a new box, and its own clone by default on a box with the repository', async () => {
    await onDevWithWebapp();
    expect(checkout()).toBeNull();
    await chooseBox('dev');
    expect(checkout()?.textContent).toBe('Own clone');
    // The heading's repository is the menu's trigger.
    await act(async () => { buttonByText('example-org/webapp').click(); });
    await act(async () => { buttonByText('acme/web').click(); });
    expect(checkout()).toBeNull();
  });

  it("starts a worktree from a fresh origin/main by default, queues the first message for its chat, and opens it", async () => {
    mocks.createWorkstream.mockImplementation(async (_pid: string, body: { name: string }) => ({ id: 'w-new', name: body.name }));
    await onDevWithWebapp();
    await chooseBox('dev');
    await chooseWorktree();
    expect(checkout()?.textContent).toBe('Worktree of webapp');
    // webapp is read-only (no trust tick), so its worktree is too, fetched or not; the orchestrator is a project's setting.
    expect(pill()?.textContent).toBe('As webapp');
    expect(document.querySelector('.chat-orchestrator-btn')).toBeNull();

    await typeAndSendAll('Fix the flag toggle on Safari please');
    expect(mocks.createProject).not.toHaveBeenCalled();
    expect(mocks.createWorkstream).toHaveBeenCalledWith('p-gon', {
      name: 'fix-the-flag-toggle-on', baseRef: 'origin/main', fetch: { remoteBranch: 'main', fullAccess: false },
    });
    expect(localStorage.getItem('termag-chat-queued:p-gon@fix-the-flag-toggle-on')).toBe('Fix the flag toggle on Safari please');
    // The worktree's own chat sends the first message, on the model and effort picked here (the default effort is no entry).
    expect(localStorage.getItem('termag.chatModel.p-gon|fix-the-flag-toggle-on')).toBe('sonnet');
    expect(localStorage.getItem('termag.chatEffort.p-gon|fix-the-flag-toggle-on')).toBeNull();
    expect(mocks.navigate).toHaveBeenCalledWith('/chat/p/p-gon?ws=fix-the-flag-toggle-on', undefined);
  });

  it('asks, as a fresh clone does, for a trusted project\'s worktree from a fresh fetch, on the choice remembered for the repository', async () => {
    mocks.createWorkstream.mockImplementation(async (_pid: string, body: { name: string }) => ({ id: 'w-new', name: body.name }));
    await onDevWithWebapp({ ...webapp, chatTrusted: true });
    await chooseBox('dev');
    await chooseWorktree();
    // New code nobody on the box has looked at: the permission pill, on Full access for a company repository.
    expect(pill()?.getAttribute('data-choice')).toBe('full');
    await typeAndSendAll('first try');
    expect(mocks.createWorkstream).toHaveBeenLastCalledWith('p-gon', {
      name: 'first-try', baseRef: 'origin/main', fetch: { remoteBranch: 'main', fullAccess: true },
    });
  });

  it("keeps a trusted project's fetched worktree Read only when that is the pick, and remembers it for the repository", async () => {
    mocks.createWorkstream.mockImplementation(async (_pid: string, body: { name: string }) => ({ id: 'w-new', name: body.name }));
    await onDevWithWebapp({ ...webapp, chatTrusted: true });
    await chooseBox('dev');
    await chooseWorktree();
    await choosePermissionHere('Read only');
    expect(JSON.parse(localStorage.getItem('termag-chat-permissions') ?? '{}')['example-org/webapp']).toBe('read');
    await typeAndSendAll('just look');
    expect(mocks.createWorkstream).toHaveBeenLastCalledWith('p-gon', {
      name: 'just-look', baseRef: 'origin/main', fetch: { remoteBranch: 'main', fullAccess: false },
    });
  });

  it("follows a trusted project's permissions, with no pill, for a worktree off its checkout", async () => {
    mocks.createWorkstream.mockImplementation(async (_pid: string, body: { name: string }) => ({ id: 'w-new', name: body.name }));
    await onDevWithWebapp({ ...webapp, chatTrusted: true });
    await chooseBox('dev');
    await chooseWorktree("webapp's checkout");
    expect(pill()?.textContent).toBe('As webapp');
    await typeAndSendAll('off the checkout');
    expect(mocks.createWorkstream).toHaveBeenLastCalledWith('p-gon', { name: 'off-the-checkout' });
  });

  it('hands the model and effort picked here to the worktree\'s own chat, with chat-effort-enabled', async () => {
    mocks.flags['chat-effort-enabled'] = true;
    localStorage.setItem('termag-chat-last-pick', JSON.stringify({ model: 'opus', effort: 'xhigh' }));
    mocks.createWorkstream.mockImplementation(async (_pid: string, body: { name: string }) => ({ id: 'w-new', name: body.name }));
    await onDevWithWebapp();
    await chooseBox('dev');
    await chooseWorktree();
    await typeAndSendAll('think hard');
    expect(localStorage.getItem('termag.chatModel.p-gon|think-hard')).toBe('opus');
    expect(localStorage.getItem('termag.chatEffort.p-gon|think-hard')).toBe('xhigh');
    expect(JSON.parse(localStorage.getItem('termag-chat-last-start') ?? '{}').effort).toBe('xhigh');
  });

  it("fetches the repository's real default when the project does not know it, and offers only the checkout when nothing does", async () => {
    mocks.createWorkstream.mockImplementation(async (_pid: string, body: { name: string }) => ({ id: 'w-new', name: body.name }));
    // A project made from a pasted URL keeps no default; the repository list says trunk.
    mocks.list.mockResolvedValue({
      status: 'ok',
      groups: [{ owner: 'example-org', kind: 'org', status: 'ok', repos: [{ fullName: 'example-org/webapp', defaultBranch: 'trunk' }] }],
    });
    boxes.push({ id: 'b1', name: 'dev', kind: 'ec2', status: 'ready', createdAt: '', projects: [{ id: 'p-gon', name: 'webapp' }] });
    mocks.projects.push({ ...webapp, repoDefaultBranch: null });
    await render();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { buttonByText('Choose a repository').click(); });
    await act(async () => { buttonByText('example-org/webapp').click(); });
    await chooseBox('dev');
    await act(async () => { checkout()!.click(); });
    const option = [...document.querySelectorAll('.chat-checkout-dialog .chat-launch-box')].find(o => o.textContent?.startsWith('webapp')) as HTMLButtonElement;
    await act(async () => { option.click(); });
    expect([...document.querySelectorAll('.chat-checkout-base-option')].map(o => o.textContent)).toEqual(['origin/trunk', "webapp's checkout"]);
    await act(async () => { (document.querySelector('.chat-checkout-dialog .chat-launch-dialog-actions button') as HTMLButtonElement).click(); });
    await typeAndSendAll('look at trunk');
    expect(mocks.createWorkstream).toHaveBeenCalledWith('p-gon', { name: 'look-at-trunk', baseRef: 'origin/trunk', fetch: { remoteBranch: 'trunk', fullAccess: false } });
  });

  it('offers only the checkout, and fetches nothing, when no default branch is known', async () => {
    mocks.createWorkstream.mockImplementation(async (_pid: string, body: { name: string }) => ({ id: 'w-new', name: body.name }));
    boxes.push({ id: 'b1', name: 'dev', kind: 'ec2', status: 'ready', createdAt: '', projects: [{ id: 'p-gon', name: 'webapp' }] });
    mocks.projects.push({ ...webapp, repoDefaultBranch: null });
    mocks.list.mockRejectedValue(new Error('down'));
    await render();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { buttonByText('Choose a repository').click(); });
    const url = document.querySelector('input[aria-label="Repository URL"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(url, 'https://github.com/example-org/webapp');
      url.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await chooseBox('dev');
    await act(async () => { checkout()!.click(); });
    const option = [...document.querySelectorAll('.chat-checkout-dialog .chat-launch-box')].find(o => o.textContent?.startsWith('webapp')) as HTMLButtonElement;
    await act(async () => { option.click(); });
    const bases = [...document.querySelectorAll('.chat-checkout-base-option')];
    expect(bases.map(o => o.textContent)).toEqual(["webapp's checkout"]);
    expect(bases[0].getAttribute('aria-checked')).toBe('true');
    await act(async () => { (document.querySelector('.chat-checkout-dialog .chat-launch-dialog-actions button') as HTMLButtonElement).click(); });
    await typeAndSendAll('look around');
    expect(mocks.createWorkstream).toHaveBeenCalledWith('p-gon', { name: 'look-around' });
  });

  it("counts no extra repository ticks for a worktree: its pick is the one repository's, and it starts one workstream", async () => {
    mocks.flags['multi-repo-projects-enabled'] = true;
    mocks.createWorkstream.mockImplementation(async (_pid: string, body: { name: string }) => ({ id: 'w-new', name: body.name }));
    mocks.list.mockResolvedValue({
      status: 'ok',
      groups: [
        { owner: 'acme', kind: 'user', status: 'ok', repos: [{ fullName: 'acme/web', defaultBranch: 'main' }] },
        { owner: 'example-org', kind: 'org', status: 'ok', repos: [{ fullName: 'example-org/webapp', defaultBranch: 'main' }] },
      ],
    });
    boxes.push({ id: 'b1', name: 'dev', kind: 'ec2', status: 'ready', createdAt: '', projects: [{ id: 'p-gon', name: 'webapp' }] });
    mocks.projects.push({ ...webapp, chatTrusted: true });
    await render();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { buttonByText('Choose a repository').click(); });
    await flush();
    // webapp first, then acme/web, which on its own would start Read only.
    await act(async () => { repoRow('example-org/webapp').click(); });
    await act(async () => { repoRow('acme/web').click(); });
    await act(async () => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    await chooseBox('dev');
    await chooseWorktree();
    expect(document.querySelector('.chat-compose-repo-name')?.textContent).toBe('example-org/webapp');
    expect(pill()?.getAttribute('data-choice')).toBe('full');
    await typeAndSendAll('one repo only');
    expect(mocks.createWorkstream).toHaveBeenLastCalledWith('p-gon', {
      name: 'one-repo-only', baseRef: 'origin/main', fetch: { remoteBranch: 'main', fullAccess: true },
    });
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it('takes a cleared session name for a worktree as the message\'s first words, not as a missing name', async () => {
    mocks.createWorkstream.mockImplementation(async (_pid: string, body: { name: string }) => ({ id: 'w-new', name: body.name }));
    await onDevWithWebapp();
    await chooseBox('dev');
    await chooseWorktree("webapp's checkout");
    await openBoxDialog();
    const field = [...document.querySelectorAll('.chat-launch-dialog label')].find(l => l.textContent?.startsWith('Session name'))!.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (document.querySelector('.chat-launch-dialog-actions button') as HTMLButtonElement).click(); });
    await typeAndSendAll('check the flag toggle');
    expect(mocks.createWorkstream).toHaveBeenCalledWith('p-gon', { name: 'check-the-flag-toggle' });
  });

  it("starts a worktree session in the space picked, as a clone's chat is (Bugbot)", async () => {
    mocks.flags['spaces-enabled'] = true;
    mocks.listSpaces.mockResolvedValue({
      spaces: [{ id: '1', name: 'notes', description: null, createdAt: '', usedBytes: 0, quotaBytes: 1, role: 'owner', readOnly: false }],
    });
    mocks.createWorkstream.mockImplementation(async (_pid: string, body: { name: string }) => ({ id: 'w-new', name: body.name }));
    await onDevWithWebapp();
    await flush();
    await chooseBox('dev');
    await chooseWorktree("webapp's checkout");
    await act(async () => { buttonByText('No space').click(); });
    const notes = [...document.querySelectorAll('.chat-space-dialog [role="radio"]')].find(o => o.textContent === 'notes') as HTMLButtonElement;
    await act(async () => { notes.click(); });
    await typeAndSendAll('take notes');
    expect(mocks.createWorkstream).toHaveBeenCalledWith('p-gon', { name: 'take-notes', chatSpace: 'notes' });
  });

  it('takes a typed worktree name with spaces and punctuation, as the workstream name it becomes', async () => {
    mocks.createWorkstream.mockImplementation(async (_pid: string, body: { name: string }) => ({ id: 'w-new', name: body.name }));
    await onDevWithWebapp();
    await chooseBox('dev');
    await chooseWorktree("webapp's checkout");
    await openBoxDialog();
    const field = [...document.querySelectorAll('.chat-launch-dialog label')].find(l => l.textContent?.startsWith('Session name'))!.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'Fix the login!');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(document.querySelector('.chat-launch-dialog .chat-new-error')).toBeNull();
    await act(async () => { (document.querySelector('.chat-launch-dialog-actions button') as HTMLButtonElement).click(); });
    await typeAndSendAll('go');
    expect(mocks.createWorkstream).toHaveBeenCalledWith('p-gon', { name: 'fix-the-login' });
  });

  it("starts from the project's checkout when asked, takes a typed name made unique, and says so when the branch-off fails", async () => {
    mocks.createWorkstream
      .mockRejectedValueOnce({ response: { data: { error: 'Box agent is not connected' } } })
      .mockImplementation(async (_pid: string, body: { name: string }) => ({ id: 'w-new', name: body.name }));
    await onDevWithWebapp();
    await chooseBox('dev');
    await chooseWorktree("webapp's checkout");
    await openBoxDialog();
    const field = [...document.querySelectorAll('.chat-launch-dialog label')].find(l => l.textContent?.startsWith('Session name'))!.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'fix-the-flag');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (document.querySelector('.chat-launch-dialog-actions button') as HTMLButtonElement).click(); });
    await typeAndSendAll('again');
    // Off the checkout, as Branch off… does: no fetch.
    expect(mocks.createWorkstream).toHaveBeenCalledWith('p-gon', { name: 'fix-the-flag-2' });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Box agent is not connected');
    expect(mocks.navigate).not.toHaveBeenCalled();
    await act(async () => { (document.querySelector('button[type="submit"]') as HTMLButtonElement).click(); });
    await flush();
    expect(mocks.navigate).toHaveBeenCalledWith('/chat/p/p-gon?ws=fix-the-flag-2', undefined);
  });
});

async function typeAndSendAll(text: string) {
  const input = document.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { (document.querySelector('button[type="submit"]') as HTMLButtonElement).click(); });
  await flush();
}
