// @vitest-environment jsdom
// New session's project pill: loading, none yet, the list and its search,
// a pick, From a repository…, and + New project with its errors.
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProjectView } from '../../services/api';

const api = vi.hoisted(() => ({
  repos: vi.fn(), create: vi.fn(), update: vi.fn(), addRepo: vi.fn(),
  // New project's icon step: the picked repositories' icons, none here.
  iconCandidates: vi.fn(async () => ({ repos: [] })), setIcon: vi.fn(async () => ({ ok: true })), uploadIcon: vi.fn(),
}));
vi.mock('../../services/api', () => ({
  githubReposApi: { list: api.repos },
  userProjectsApi: {
    create: api.create, update: api.update, addRepo: api.addRepo,
    iconCandidates: api.iconCandidates, setIcon: api.setIcon, uploadIcon: api.uploadIcon,
  },
}));

import { ProjectPicker, type ProjectsState } from './ProjectPicker';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// React Aria escapes ids with CSS.escape, which jsdom lacks.
const css = globalThis as { CSS?: { escape?: (s: string) => string } };
css.CSS ??= {};
css.CSS.escape ??= (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);

const repo = (fullName: string) => ({ repoKey: fullName, name: fullName.split('/')[1], url: `https://github.com/${fullName}.git`, defaultBranch: 'main' });
const project = (id: string, name: string, repos: string[] = [], archived = false): UserProjectView => ({
  id, name, repos: repos.map(repo), archived, lastActiveAt: '2026-11-12T00:00:00Z', filesSpace: null, checkouts: [],
});
const PROJECTS = [
  project('up-1', 'termag', ['example-org/termag']),
  project('up-2', 'desk', ['example-org/termag', 'example-org/termag-desktop']),
  project('up-3', 'Scratch'),
  project('up-4', 'old', ['acme/old'], true),
];

let root: Root;
let host: HTMLDivElement;
let picked: string[];
let fromRepo: number;
let created: string[];
let outerSubmits: number;

function Harness({ state, initial = null, multiRepo = false }: { state: ProjectsState; initial?: UserProjectView | null; multiRepo?: boolean }) {
  const [selected, setSelected] = useState<UserProjectView | null>(initial);
  const [open, setOpen] = useState(false);
  // Inside a form, as New session's is: + New project's own submit must not reach it.
  return (
    <form onSubmit={e => { e.preventDefault(); outerSubmits++; }}>
      <ProjectPicker
        state={state}
        selected={selected}
        onSelect={p => { picked.push(p.id); setSelected(p); }}
        onFromRepository={() => { fromRepo++; }}
        onCreated={p => { created.push(p.id); setSelected(p); }}
        multiRepo={multiRepo}
        open={open}
        onOpenChange={setOpen}
      />
    </form>
  );
}

const render = (state: ProjectsState, initial: UserProjectView | null = null, multiRepo = false) =>
  act(async () => { root.render(<Harness state={state} initial={initial} multiRepo={multiRepo} />); });
const trigger = () => host.querySelector<HTMLButtonElement>('.chat-compose-repo-btn')!;
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); };
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const option = (label: string) => options().find(o => o.querySelector('[slot="label"]')?.textContent === label)!;
const labels = () => options().map(o => o.querySelector('[slot="label"]')?.textContent);
// The two ways to start, pinned under the list.
const action = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('.chat-project-actions button')].find(b => b.textContent?.startsWith(text))!;
const press = (el: Element, key: string, init: KeyboardEventInit = {}) => act(() => {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
});
const searchBox = () => document.querySelector<HTMLInputElement>('input[aria-label="Search projects"]')!;
const settle = () => act(async () => { await Promise.resolve(); });
const flushAll = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
// The repositories step.
const stepTitle = () => document.querySelector('.chat-repo-step-title')?.textContent;
const stepButton = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('.chat-repo-step button')].find(b => b.textContent?.startsWith(text))!;
const repoRows = () => [...document.querySelectorAll<HTMLElement>('.chat-repo-step-list [role="option"]')].map(o => o.textContent?.trim());
const repoRow = (text: string) => [...document.querySelectorAll<HTMLElement>('.chat-repo-step-list [role="option"]')].find(o => o.textContent?.trim() === text)!;
const chips = () => [...document.querySelectorAll('.chat-repo-step-chips [role="row"]')].map(r => r.textContent?.replace(/\s+$/, '').trim());

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  picked = [];
  fromRepo = 0;
  created = [];
  outerSubmits = 0;
  api.repos.mockReset().mockResolvedValue({
    status: 'ok',
    groups: [{ owner: 'acme', kind: 'org', status: 'ok', repos: [{ fullName: 'acme/web', defaultBranch: 'main' }, { fullName: 'acme/api', defaultBranch: 'trunk' }] }],
  });
  api.create.mockReset();
  api.update.mockReset();
  api.addRepo.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => { root.unmount(); });
  host.remove();
});

describe('ProjectPicker', () => {
  it('reads Loading projects… and is disabled while the projects load', async () => {
    await render({ kind: 'loading' });
    expect(trigger().textContent).toBe('Loading projects…');
    expect(trigger().disabled).toBe(true);
  });

  it('names the project picked', async () => {
    await render({ kind: 'ready', projects: PROJECTS }, PROJECTS[1]);
    expect(trigger().textContent).toBe('desk');
    expect(trigger().getAttribute('aria-label')).toBe('Project: desk');
  });

  it('lists your projects one line each, repositories at the right, never an archived one, with the two ways to start pinned under them', async () => {
    await render({ kind: 'ready', projects: PROJECTS }, PROJECTS[0]);
    await click(trigger());
    expect(labels()).toEqual(['termag', 'desk', 'Scratch']);
    expect(option('desk').querySelector('[slot="description"]')?.textContent).toBe('termag · termag-desktop');
    expect(option('Scratch').querySelector('[slot="description"]')?.textContent).toBe('no repo');
    // Named after its one repository: nothing repeats it.
    expect(option('termag').querySelector('[slot="description"]')).toBeNull();
    expect(option('termag').getAttribute('aria-selected')).toBe('true');
    expect(option('termag').hasAttribute('data-selected')).toBe(true);
    expect(document.querySelector('.chat-project-head')).toBeNull();
    expect(action('From a repository…').textContent).toMatch(/R$/);
    expect(action('+ New project').textContent).toMatch(/N$/);
    // Outside the list's scroll, so always in view.
    expect(document.querySelector('.chat-project-list .chat-project-actions')).toBeNull();
    expect(document.querySelector('.chat-project-popover')?.classList.contains('lp-theme')).toBe(true);
  });

  it('picks a project and closes', async () => {
    await render({ kind: 'ready', projects: PROJECTS }, PROJECTS[0]);
    await click(trigger());
    await click(option('Scratch'));
    expect(picked).toEqual(['up-3']);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(trigger().textContent).toBe('Scratch');
  });

  it('closes without a change when the project already picked is picked again', async () => {
    await render({ kind: 'ready', projects: PROJECTS }, PROJECTS[0]);
    await click(trigger());
    await click(option('termag'));
    expect(picked).toEqual([]);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(trigger().textContent).toBe('termag');
  });

  it('searches names and repositories, and offers + New project “…” and From owner/repo for a new name', async () => {
    await render({ kind: 'ready', projects: PROJECTS }, PROJECTS[0]);
    await click(trigger());
    await flushAll();
    const search = searchBox();
    type(search, 'desktop');
    expect(labels()).toEqual(['desk']);
    type(search, 'Release notes');
    expect(labels()).toEqual(['+ New project “Release notes”']);
    expect(option('+ New project “Release notes”').querySelector('[slot="description"]')?.textContent).toMatch(/^↵ create · (⌥|Alt\+)↵ repositories$/);
    type(search, 'web');
    expect(labels()).toEqual(['+ New project “web”', 'From acme/web']);
  });

  it('makes a new name\'s project on ↵ and picks it, with no repository and no box touched', async () => {
    api.create.mockResolvedValue(project('up-new', 'Quarterly plan'));
    await render({ kind: 'ready', projects: PROJECTS }, PROJECTS[0]);
    await click(trigger());
    type(searchBox(), 'scr');
    await settle();
    await press(searchBox(), 'Enter');
    expect(picked).toEqual(['up-3']);
    await click(trigger());
    type(searchBox(), ' Quarterly plan ');
    await settle();
    await press(searchBox(), 'Enter');
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.create).toHaveBeenCalledWith({ name: 'Quarterly plan', repos: [] });
    expect(created).toEqual(['up-new']);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('makes a project from a repository the name matches in one go, an ssh URL as pasted', async () => {
    api.create.mockResolvedValueOnce(project('up-web', 'web', ['acme/web'])).mockResolvedValueOnce(project('up-p', 'private'));
    await render({ kind: 'ready', projects: PROJECTS }, PROJECTS[0]);
    await click(trigger());
    await flushAll();
    type(searchBox(), 'web');
    await click(option('From acme/web'));
    expect(api.create).toHaveBeenLastCalledWith({ name: 'web', repos: [{ url: 'https://github.com/acme/web.git', defaultBranch: 'main' }] });
    await click(trigger());
    type(searchBox(), 'git@github.com:acme/private.git');
    expect(labels()).toEqual(['From acme/private']);
    await click(option('From acme/private'));
    expect(api.create).toHaveBeenLastCalledWith({ name: 'private', repos: [{ url: 'git@github.com:acme/private.git' }] });
    expect(created).toEqual(['up-web', 'up-p']);
  });

  it('leaves ↵ on a highlighted From owner/repo row to that row', async () => {
    api.create.mockResolvedValue(project('up-web', 'web', ['acme/web']));
    await render({ kind: 'ready', projects: PROJECTS }, PROJECTS[0]);
    await click(trigger());
    await flushAll();
    type(searchBox(), 'web');
    await settle();
    for (let i = 0; i < 3 && !document.getElementById(searchBox().getAttribute('aria-activedescendant') ?? '')?.textContent?.startsWith('From'); i++) {
      await press(searchBox(), 'ArrowDown');
    }
    expect(document.getElementById(searchBox().getAttribute('aria-activedescendant') ?? '')?.textContent).toMatch(/^From acme\/web/);
    await press(searchBox(), 'Enter');
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.create).toHaveBeenCalledWith({ name: 'web', repos: [{ url: 'https://github.com/acme/web.git', defaultBranch: 'main' }] });
  });

  it('offers From owner/repo under Strict Mode, which mounts the menu twice', async () => {
    await act(async () => {
      root.render(<React.StrictMode><Harness state={{ kind: 'ready', projects: PROJECTS }} initial={PROJECTS[0]} /></React.StrictMode>);
    });
    await click(trigger());
    await flushAll();
    type(searchBox(), 'web');
    expect(labels()).toContain('From acme/web');
  });

  it('reads the repositories again on reopening when the menu closed before they came', async () => {
    let answer: (v: unknown) => void = () => {};
    api.repos.mockReset().mockImplementationOnce(() => new Promise(r => { answer = r; }));
    await render({ kind: 'ready', projects: PROJECTS }, PROJECTS[0]);
    await click(trigger());
    await click(trigger());
    await act(async () => { answer({ status: 'ok', groups: [{ owner: 'acme', kind: 'org', status: 'ok', repos: [{ fullName: 'acme/web', defaultBranch: 'main' }] }] }); });
    await click(trigger());
    type(searchBox(), 'web');
    expect(labels()).toContain('From acme/web');
  });

  it('says a name is taken as it is typed: ↵ picks that project, and no + New project is offered', async () => {
    await render({ kind: 'ready', projects: PROJECTS }, PROJECTS[1]);
    await click(trigger());
    type(searchBox(), 'TERMAG');
    expect(labels()).toEqual(['termag', 'desk']);
    expect(option('termag').querySelector('[slot="description"]')?.textContent).toBe('yours already · ↵ picks it');
    // No From example-org/termag either: a project named termag would be refused.
    expect(labels().some(l => l?.startsWith('From '))).toBe(false);
    await press(searchBox(), 'Enter');
    expect(picked).toEqual(['up-1']);
    expect(api.create).not.toHaveBeenCalled();
  });

  it('offers Unarchive for a name an archived project holds, and ↵ brings it back and picks it', async () => {
    api.update.mockResolvedValue(project('up-4', 'old', ['acme/old']));
    await render({ kind: 'ready', projects: PROJECTS }, PROJECTS[0]);
    await click(trigger());
    type(searchBox(), 'Old');
    expect(labels()).toEqual(['Unarchive “old”']);
    await press(searchBox(), 'Enter');
    expect(api.update).toHaveBeenCalledWith('up-4', { archived: false });
    expect(created).toEqual(['up-4']);
  });

  it('says on the row why a create failed, keeps the name, and ↵ tries again', async () => {
    api.create
      .mockRejectedValueOnce({ response: { status: 503, data: { error: 'Could not read your projects; try again' } } })
      .mockResolvedValueOnce(project('up-new', 'notes'));
    await render({ kind: 'ready', projects: PROJECTS }, PROJECTS[0]);
    await click(trigger());
    type(searchBox(), 'notes');
    await press(searchBox(), 'Enter');
    expect(option('+ New project “notes”').querySelector('[slot="description"]')?.textContent).toBe('Could not read your projects; try again. ↵ to try again');
    expect(option('+ New project “notes”').hasAttribute('data-failed')).toBe(true);
    await press(searchBox(), 'Enter');
    expect(api.create).toHaveBeenCalledTimes(2);
    expect(created).toEqual(['up-new']);
  });

  it('keeps the draft when the menu closes, by Esc or otherwise', async () => {
    await render({ kind: 'ready', projects: PROJECTS }, PROJECTS[0]);
    await click(trigger());
    type(searchBox(), 'Draft name');
    await press(searchBox(), 'Escape');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    await click(trigger());
    expect(searchBox().value).toBe('Draft name');
    // Into the repositories step, a repository picked, then closed from the trigger: it all comes back.
    await press(searchBox(), 'Enter', { altKey: true });
    await flushAll();
    await click(repoRow('acme/web'));
    await click(trigger());
    await click(trigger());
    expect(stepTitle()).toBe('New project “Draft name”');
    expect(chips()).toEqual(['web']);
  });

  it('leaves ↵ on a pinned button to that button, even after a search that matches nothing', async () => {
    await render({ kind: 'ready', projects: PROJECTS }, PROJECTS[0]);
    await click(trigger());
    type(searchBox(), 'nothing like it');
    const button = action('From a repository…');
    await act(async () => {
      button.focus();
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      button.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(fromRepo).toBe(1);
    expect(api.create).not.toHaveBeenCalled();
  });

  it('hands From a repository… to the parent', async () => {
    await render({ kind: 'ready', projects: PROJECTS }, PROJECTS[0]);
    await click(trigger());
    await click(action('From a repository…'));
    expect(fromRepo).toBe(1);
    expect(picked).toEqual([]);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('takes ⌥N, ⌥↵ and ⌥R from the search, by the key held (⌥ changes what a Mac types)', async () => {
    await render({ kind: 'ready', projects: PROJECTS }, PROJECTS[0]);
    await click(trigger());
    type(searchBox(), 'notes');
    await press(searchBox(), '˜', { code: 'KeyN', altKey: true });
    expect(stepTitle()).toBe('New project “notes”');
    await click(stepButton('← Back'));
    expect(searchBox().value).toBe('notes');
    await press(searchBox(), 'Enter', { altKey: true });
    expect(stepTitle()).toBe('New project “notes”');
    await press(document.querySelector('input[aria-label="Search repositories"]')!, 'Escape');
    expect(searchBox().value).toBe('notes');
    await press(searchBox(), '®', { code: 'KeyR', altKey: true });
    expect(fromRepo).toBe(1);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('reads Pick a project with none, and its menu still has From a repository… and + New project', async () => {
    await render({ kind: 'ready', projects: [project('a', 'gone', [], true)] });
    expect(trigger().textContent).toBe('Pick a project');
    expect(trigger().hasAttribute('data-empty')).toBe(true);
    await click(trigger());
    expect(labels()).toEqual([]);
    expect(action('From a repository…')).toBeDefined();
    expect(action('+ New project')).toBeDefined();
  });
});

describe("+ New project's repositories step", () => {
  async function openStep(name = 'Release notes', multiRepo = true) {
    await render({ kind: 'ready', projects: PROJECTS }, PROJECTS[0], multiRepo);
    await click(trigger());
    type(searchBox(), name);
    await press(searchBox(), 'Enter', { altKey: true });
    await flushAll();
  }

  it('takes the whole popover: Back with the name, one search, one-line rows, and Create pinned', async () => {
    await openStep();
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('New project');
    expect(stepTitle()).toBe('New project “Release notes”');
    expect(stepButton('← Back')).toBeDefined();
    expect(document.querySelectorAll('input[aria-label="Search repositories"]')).toHaveLength(1);
    expect(repoRows()).toEqual(['acme/web', 'acme/api']);
    expect(stepButton('Create “Release notes”')).toBeDefined();
    expect(document.querySelector('.chat-repo-step-list .chat-repo-step-actions')).toBeNull();
    // No form crammed in: no name field, and nothing scrolls inside the list.
    expect(document.querySelector('.chat-new-project-name')).toBeNull();
    expect(document.querySelectorAll('.chat-repo-step-list .chat-compose-menu')).toHaveLength(0);
  });

  it('picks several in order as chips, and ↵ on an empty search makes the project with them', async () => {
    api.create.mockResolvedValue(project('up-new', 'Release notes', ['acme/api', 'acme/web']));
    await openStep();
    await click(repoRow('acme/api'));
    await click(repoRow('acme/web'));
    expect(chips()).toEqual(['api', 'web']);
    expect(document.querySelector('.chat-repo-step-note')?.textContent).toBe('2 repositories · Esc back');
    await press(document.querySelector('input[aria-label="Search repositories"]')!, 'Enter');
    expect(api.create).toHaveBeenCalledWith({
      name: 'Release notes',
      repos: [{ url: 'https://github.com/acme/api.git', defaultBranch: 'trunk' }, { url: 'https://github.com/acme/web.git', defaultBranch: 'main' }],
    });
    expect(created).toEqual(['up-new']);
  });

  it('takes one at a time with multi-repo projects off', async () => {
    await openStep('solo', false);
    await click(repoRow('acme/api'));
    await click(repoRow('acme/web'));
    expect(chips()).toEqual(['web']);
  });

  it('gives a pasted URL or owner/name its own row', async () => {
    await openStep();
    type(document.querySelector<HTMLInputElement>('input[aria-label="Search repositories"]')!, 'octo/thing');
    expect(repoRows()).toEqual(['Add octo/thing']);
    await click(repoRow('Add octo/thing'));
    expect(chips()).toEqual(['thing']);
  });

  it('drops a repository from its chip', async () => {
    await openStep();
    await click(repoRow('acme/api'));
    await click(document.querySelector('.chat-repo-step-chips [slot="remove"]')!);
    expect(chips()).toEqual([]);
  });

  it('says a failed create over the action, keeps the picks, and Create tries again', async () => {
    api.create
      .mockRejectedValueOnce({ response: { status: 400, data: { error: 'acme/web and octo/web would both be checked out as web: pick one', code: 'user_project_invalid', field: 'repos' } } })
      .mockResolvedValueOnce(project('up-new', 'Release notes'));
    await openStep();
    await click(repoRow('acme/web'));
    await click(stepButton('Create “Release notes”'));
    expect(document.querySelector('.chat-repo-step-error')?.textContent).toBe('acme/web and octo/web would both be checked out as web: pick one. ↵ to try again');
    expect(chips()).toEqual(['web']);
    await click(stepButton('Create “Release notes”'));
    expect(created).toEqual(['up-new']);
  });
});

describe('Add a repository to a project', () => {
  it('is offered on the project picked, with multi-repo projects on, and adds one repository in the same step', async () => {
    api.addRepo.mockResolvedValue(project('up-1', 'termag', ['example-org/termag', 'acme/web']));
    await render({ kind: 'ready', projects: PROJECTS }, PROJECTS[0], true);
    await click(trigger());
    expect(labels()).toContain('Add a repository to termag…');
    await click(option('Add a repository to termag…'));
    await flushAll();
    expect(stepTitle()).toBe('Add a repository to termag');
    await click(stepButton('Add to termag'));
    expect(document.querySelector('.chat-repo-step-error')?.textContent).toBe('Pick a repository to add');
    await click(repoRow('acme/web'));
    await click(stepButton('Add to termag'));
    expect(api.addRepo).toHaveBeenCalledWith('up-1', { url: 'https://github.com/acme/web.git', defaultBranch: 'main' });
    expect(created).toEqual(['up-1']);
    expect(outerSubmits).toBe(0);
  });

  it('is disabled at 8 repositories, saying why', async () => {
    const full = project('up-9', 'big', Array.from({ length: 8 }, (_, i) => `o/r${i}`));
    await render({ kind: 'ready', projects: [full] }, full, true);
    await click(trigger());
    const row = option('Add a repository to big…');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.querySelector('[slot="description"]')?.textContent).toBe('8 is the most a project holds');
  });

  it('is not offered for a project with a repository while multi-repo projects are off, but is for a no-repo one', async () => {
    await render({ kind: 'ready', projects: PROJECTS }, PROJECTS[0], false);
    await click(trigger());
    expect(labels().some(l => l?.startsWith('Add a repository'))).toBe(false);
    await click(option('Scratch'));
    await click(trigger());
    expect(labels()).toContain('Add a repository to Scratch…');
  });

  it('says why a repository was refused, and Add tries again', async () => {
    api.addRepo
      .mockRejectedValueOnce({ response: { status: 409, data: { error: 'The project already has acme/web', code: 'user_project_repo_exists' } } })
      .mockResolvedValueOnce(project('up-1', 'termag', ['example-org/termag', 'acme/web']));
    await render({ kind: 'ready', projects: PROJECTS }, PROJECTS[0], true);
    await click(trigger());
    await click(option('Add a repository to termag…'));
    await flushAll();
    await click(repoRow('acme/web'));
    await click(stepButton('Add to termag'));
    expect(document.querySelector('.chat-repo-step-error')?.textContent).toBe('The project already has acme/web. ↵ to try again');
    await click(stepButton('Add to termag'));
    expect(api.addRepo).toHaveBeenCalledTimes(2);
    expect(created).toEqual(['up-1']);
  });
});
