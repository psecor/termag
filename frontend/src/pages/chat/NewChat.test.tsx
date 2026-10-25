// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewChat } from './NewChat';
import { ChatChromeProvider, type ChatChrome } from './chatChrome';

const boxes: never[] = [];
const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  credentials: vi.fn(),
  list: vi.fn(),
  createBox: vi.fn(),
  createProject: vi.fn(),
  createAutomation: vi.fn(),
  previewSchedule: vi.fn(),
  flags: {} as Record<string, unknown>,
  reloadProjects: vi.fn(async () => {}),
  upsert: vi.fn(),
  reloadBoxes: vi.fn(async () => {}),
  listSpaces: vi.fn(async () => ({ spaces: [] as Array<{ id: string; name: string; description: null; createdAt: string; usedBytes: number; quotaBytes: number; role: 'owner'; readOnly: boolean }> })),
  addSpaceBox: vi.fn(async () => ({})),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useSearchParams: () => [new URLSearchParams()],
  useLocation: () => ({ pathname: '/chat/new', search: '', hash: '', state: null, key: 'visit' }),
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => <a href={to} {...rest}>{children}</a>,
}));
vi.mock('../../flags', async () => {
  const actual = await vi.importActual<typeof import('../../flags')>('../../flags');
  return { ...actual, useFlag: <T,>(key: string, fallback: T) => (key in mocks.flags ? mocks.flags[key] as T : fallback) };
});
vi.mock('../../contexts/ProjectContext', () => ({
  useProjects: () => ({ projects: [], reloadProjects: mocks.reloadProjects }),
}));
vi.mock('../../services/boxFeed', () => ({
  boxFeed: {
    subscribe: () => () => {},
    getSnapshot: () => boxes,
    upsert: mocks.upsert,
    reload: mocks.reloadBoxes,
  },
}));
vi.mock('../../services/api', () => ({
  credentialsApi: { get: mocks.credentials },
  githubReposApi: { list: mocks.list },
  instancesApi: { create: mocks.createBox },
  projectsApi: { create: mocks.createProject },
  automationsApi: { create: mocks.createAutomation, preview: mocks.previewSchedule },
  spacesApi: { list: mocks.listSpaces, create: vi.fn(), addBox: mocks.addSpaceBox },
}));
vi.mock('../../observability', () => ({ replaySessionId: async () => null }));
// A deployment that lists its own orgs as starting trusted (simpleChat.ts
// COMPANY_GITHUB_OWNERS, empty by default): these tests list example-org and
// example-team, so the trusted path is exercised.
vi.mock('../../chat/simpleChat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../chat/simpleChat')>();
  return {
    ...actual,
    repoStartsTrusted: (url: string | null | undefined) =>
      !!url && /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)(example-org|example-team)\/[\w.-]+?(?:\.git)?\/?$/i.test(url.trim()),
  };
});
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

async function render() {
  await act(async () => { root.render(<NewChat />); });
}

beforeEach(() => {
  localStorage.clear();
  mocks.navigate.mockReset();
  mocks.credentials.mockReset();
  mocks.list.mockReset();
  mocks.listSpaces.mockReset();
  mocks.addSpaceBox.mockReset();
  mocks.createBox.mockReset();
  mocks.createProject.mockReset();
  mocks.createAutomation.mockReset();
  mocks.previewSchedule.mockReset();
  for (const key of Object.keys(mocks.flags)) delete mocks.flags[key];
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

    expect(mocks.createBox).toHaveBeenCalledWith('web', 'ec2');
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
  });

  it('opens with the cursor in the message', async () => {
    await render();
    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement).toBe(document.querySelector('textarea.chat-compose-input'));
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

  it('picks a space from the same kind of menu as the repository', async () => {
    mocks.flags['spaces-enabled'] = true;
    mocks.listSpaces.mockResolvedValue({
      spaces: [{ id: '1', name: 'notes', description: null, createdAt: '', usedBytes: 0, quotaBytes: 1, role: 'owner', readOnly: false }],
    });
    mocks.createBox.mockResolvedValue({ claimed: false, instance: { id: 'box-1', name: 'web' } });
    mocks.createProject.mockResolvedValue({ id: 'proj-1' });
    await render();
    await flush();

    const row = document.querySelector('.chat-compose-picks')!;
    const kids = [...row.children];
    expect(kids.map(el => el.className)).toEqual(['chat-compose-repo', 'chat-compose-repo chat-new-space']);
    const space = buttonByText('No space');
    expect(space.className).toContain('chat-compose-repo-btn');
    expect(space.getAttribute('aria-haspopup')).toBe('listbox');
    expect(document.querySelector('select')).toBeNull();
    expect(document.body.textContent).not.toContain('shared file store');
    expect(buttonByText('Sonnet 5.5')).toBeTruthy();

    await act(async () => { buttonByText('Choose a repository').click(); });
    expect(buttonByText('Choose a repository').getAttribute('aria-expanded')).toBe('true');
    await act(async () => { space.click(); });
    expect(buttonByText('Choose a repository').getAttribute('aria-expanded')).toBe('false');
    expect(document.body.textContent).toContain("This session's box");
    const notes = [...document.querySelectorAll('[role="option"]')].find(o => o.textContent === 'notes') as HTMLButtonElement;
    await act(async () => { notes.click(); });
    expect(buttonByText('notes').getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[role="listbox"]')).toBeNull();

    await act(async () => { buttonByText('notes').click(); });
    expect(document.querySelector('[aria-label="Spaces"]')).not.toBeNull();
    await act(async () => { buttonByText('Sonnet 5.5').click(); });
    expect(document.querySelector('[aria-label="Spaces"]')).toBeNull();
    expect(document.body.textContent).toContain('Sonnet 5.5');

    await act(async () => { buttonByText('Choose a repository').click(); });
    await act(async () => { buttonByText('acme/web').click(); });
    expect(document.body.textContent).toContain('I trust this repository');
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
    }));
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
    const schedule = [...document.querySelectorAll('label')].find(l => l.textContent?.includes('Run on a schedule'));
    await act(async () => { schedule?.querySelector('input')?.click(); });
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
    const notes = [...document.querySelectorAll('[role="option"]')].find(o => o.textContent === 'notes') as HTMLButtonElement;
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

  it('remembers nothing from a start that failed', async () => {
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
    expect(buttonByText('Choose a repository')).toBeTruthy();
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

  function trustLabel(): HTMLLabelElement {
    const label = [...document.querySelectorAll('label.chat-new-trust')].find(l => !l.classList.contains('chat-new-schedule'));
    if (!(label instanceof HTMLLabelElement)) throw new Error('missing trust checkbox');
    return label;
  }

  function trustInput(): HTMLInputElement {
    const input = trustLabel().querySelector('input');
    if (!(input instanceof HTMLInputElement)) throw new Error('missing trust checkbox');
    return input;
  }

  /** Whether the trust checkbox currently sits inside the Options disclosure. */
  function trustInsideOptions(): boolean {
    return !!trustLabel().closest('details.chat-new-options');
  }

  function openOptions() {
    const details = document.querySelector('details.chat-new-options') as HTMLDetailsElement;
    details.open = true;
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
    // The company-org checkbox is not inline; it only lives inside Options.
    expect(document.querySelectorAll('label.chat-new-trust').length).toBe(1);
    expect(trustInsideOptions()).toBe(true);
    openOptions();
    expect(trustInput().checked).toBe(true);
    expect(trustInput().closest('label')?.textContent).toContain('I trust this repository');

    await typeMessage('fix the flag');
    await act(async () => { (document.querySelector('button[type="submit"]') as HTMLButtonElement).click(); });
    await flush();
    expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({
      repoUrl: 'https://github.com/example-org/webapp.git',
      chatTrusted: true,
    }));
  });

  it('keeps an unchecked company-org repository read-only for that session', async () => {
    mocks.createBox.mockResolvedValue({ claimed: false, instance: { id: 'box-1', name: 'webapp' } });
    mocks.createProject.mockResolvedValue({ id: 'proj-1' });
    await render();
    await act(async () => { await Promise.resolve(); });

    await openRepoMenu();
    await act(async () => { buttonByText('example-org/webapp').click(); });
    openOptions();
    await act(async () => { trustInput().click(); });
    expect(trustInput().checked).toBe(false);

    await typeMessage('just read it');
    await act(async () => { (document.querySelector('button[type="submit"]') as HTMLButtonElement).click(); });
    await flush();
    expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({
      repoUrl: 'https://github.com/example-org/webapp.git',
      chatTrusted: false,
    }));
  });

  it('checks a pasted company-org URL and leaves every other repository unchecked', async () => {
    await render();
    await act(async () => { await Promise.resolve(); });

    await pasteUrl('https://github.com/example-org/webapp');
    expect(trustInsideOptions()).toBe(true);
    openOptions();
    expect(trustInput().checked).toBe(true);

    await pasteUrl('git@github.com:example-team/termag.git');
    expect(trustInsideOptions()).toBe(true);
    openOptions();
    expect(trustInput().checked).toBe(true);

    await pasteUrl('https://github.com/acme/other');
    expect(trustInsideOptions()).toBe(false);
    expect(trustInput().checked).toBe(false);

    await openRepoMenu();
    await act(async () => { buttonByText('acme/web').click(); });
    expect(trustInsideOptions()).toBe(false);
    expect(trustInput().checked).toBe(false);
    await openRepoMenu();
    await act(async () => { buttonByText('example-team/termag').click(); });
    expect(trustInsideOptions()).toBe(true);
    openOptions();
    expect(trustInput().checked).toBe(true);
  });

  it('shows the trust checkbox inline, outside Options, for a non-company repository', async () => {
    await render();
    await act(async () => { await Promise.resolve(); });

    await openRepoMenu();
    await act(async () => { buttonByText('acme/web').click(); });

    expect(document.querySelectorAll('label.chat-new-trust').length).toBe(1);
    expect(trustInsideOptions()).toBe(false);
    expect(trustInput().checked).toBe(false);
    // Options itself still has nothing trust-related inside it for this repo.
    expect(document.querySelector('details.chat-new-options .chat-new-trust')).toBeNull();
  });

  it('returns to the repository default after a manual tick when the repository changes', async () => {
    await render();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { buttonByText('Choose a repository').click(); });
    await act(async () => { buttonByText('example-org/webapp').click(); });
    await act(async () => { trustInput().click(); });
    expect(trustInput().checked).toBe(false);

    await act(async () => { buttonByText('example-org/webapp').click(); });
    await act(async () => { buttonByText('acme/web').click(); });
    expect(trustInput().checked).toBe(false);
    await act(async () => { trustInput().click(); });
    expect(trustInput().checked).toBe(true);

    await act(async () => { buttonByText('acme/web').click(); });
    await act(async () => { buttonByText('example-org/webapp').click(); });
    expect(trustInput().checked).toBe(true);
  });

  describe('Act as an orchestrator', () => {
    function orchestratorInput(): HTMLInputElement | null {
      return document.querySelector('label.chat-new-orchestrator input');
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

    it('sits inline, outside Options, unchecked, and changes nothing when left so', async () => {
      await render();
      await openRepoMenu();
      await act(async () => { buttonByText('example-org/webapp').click(); });
      const input = orchestratorInput()!;
      expect(input.closest('details')).toBeNull();
      expect(input.checked).toBe(false);
      expect(input.disabled).toBe(false);

      await send('fix the flag');
      expect(mocks.createProject.mock.calls[0][0]).not.toHaveProperty('chatOrchestrator');
      expect(localStorage.getItem('termag-chat-queued:proj-1')).toBe('fix the flag');
    });

    it('asks for an orchestrator chat when ticked, leaving the first message as typed', async () => {
      await render();
      await openRepoMenu();
      await act(async () => { buttonByText('example-org/webapp').click(); });
      await act(async () => { orchestratorInput()!.click(); });
      expect(orchestratorInput()!.checked).toBe(true);

      await send('ship the release');
      expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({ chatTrusted: true, chatOrchestrator: true }));
      expect(localStorage.getItem('termag-chat-queued:proj-1')).toBe('ship the release');
    });

    it('is disabled, and has no effect, while the trust box is unticked', async () => {
      await render();
      await openRepoMenu();
      await act(async () => { buttonByText('example-org/webapp').click(); });
      await act(async () => { orchestratorInput()!.click(); });
      openOptions();
      await act(async () => { trustInput().click(); });
      expect(orchestratorInput()!.disabled).toBe(true);
      expect(orchestratorInput()!.checked).toBe(false);
      expect(orchestratorInput()!.closest('label')?.textContent).toContain('Needs the trust box ticked (under Options)');

      await send('just read it');
      expect(mocks.createProject.mock.calls[0][0]).not.toHaveProperty('chatOrchestrator');
    });

    it('is not offered for a scheduled automation', async () => {
      mocks.flags['automations-enabled'] = true;
      await render();
      await openRepoMenu();
      await act(async () => { buttonByText('example-org/webapp').click(); });
      expect(orchestratorInput()).not.toBeNull();
      await act(async () => { (document.querySelector('label.chat-new-schedule input') as HTMLInputElement).click(); });
      expect(orchestratorInput()).toBeNull();
    });
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
    expect(document.body.textContent).toContain('Session name');
    expect(document.querySelector('textarea.chat-compose-input')).not.toBeNull();
  });
});
