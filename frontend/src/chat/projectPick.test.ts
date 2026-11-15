import { describe, expect, it } from 'vitest';
import type { Project } from '../types';
import type { UserProjectView } from '../services/api';
import {
  checkoutBaseName, defaultUserProject, nextCheckoutName, offeredProjects, projectCreateRepos, projectRowRepos, projectSelection, projectWorktreeTargets,
} from './projectPick';
import { newChatNames } from './newChat';

const repo = (fullName: string, defaultBranch: string | null = 'main') => ({
  repoKey: fullName.toLowerCase(), name: fullName.split('/')[1], url: `https://github.com/${fullName}.git`, defaultBranch,
});

function project(id: string, over: Partial<UserProjectView> = {}): UserProjectView {
  return { id, name: id, repos: [], archived: false, lastActiveAt: '2026-11-12T00:00:00Z', filesSpace: null, checkouts: [], ...over };
}

describe('defaultUserProject', () => {
  const list = [project('archived', { archived: true }), project('recent'), project('older')];

  it('is the most recently active offered project (the server lists them in that order)', () => {
    expect(defaultUserProject(list, null)?.id).toBe('recent');
    expect(offeredProjects(list).map(p => p.id)).toEqual(['recent', 'older']);
  });

  it('is the one ?project= names while it is offered, never an archived one', () => {
    expect(defaultUserProject(list, 'older')?.id).toBe('older');
    expect(defaultUserProject(list, 'archived')?.id).toBe('recent');
    expect(defaultUserProject(list, 'gone')?.id).toBe('recent');
  });

  it('is none with no projects', () => {
    expect(defaultUserProject([], null)).toBeNull();
    expect(defaultUserProject([project('a', { archived: true })], 'a')).toBeNull();
  });
});

describe('projectRowRepos', () => {
  it("names a project's repositories, says no repo for none, and stays quiet when the name already says it", () => {
    expect(projectRowRepos(project('termag experiments', { repos: [repo('example-org/termag')] }))).toBe('termag');
    expect(projectRowRepos(project('desk', { repos: [repo('example-org/termag'), repo('example-org/termag-desktop')] }))).toBe('termag · termag-desktop');
    expect(projectRowRepos(project('Scratch'))).toBe('no repo');
    expect(projectRowRepos(project('Termag', { repos: [repo('example-org/termag')] }))).toBe('');
    expect(projectRowRepos(project('termag', { repos: [repo('example-org/termag'), repo('example-org/docs')] }))).toBe('termag · docs');
  });
});

describe('projectSelection', () => {
  it('is the first repository as the pick, with its default branch, and the rest ticked after it', () => {
    expect(projectSelection(project('p', { repos: [repo('Acme/web'), repo('acme/api', 'trunk')] }))).toEqual({
      pick: { kind: 'listed', fullName: 'Acme/web', defaultBranch: 'main' },
      more: [{ kind: 'listed', fullName: 'acme/api', defaultBranch: 'trunk' }],
    });
  });

  it('is the URL when the default branch is not known, so no empty branch is sent', () => {
    expect(projectSelection(project('p', { repos: [repo('acme/web', null), repo('acme/api', null)] }))).toEqual({
      pick: { kind: 'pasted', url: 'https://github.com/acme/web.git' },
      more: [{ kind: 'listed', fullName: 'acme/api', defaultBranch: '' }],
    });
  });

  it('is the empty pick for a project with no repository', () => {
    expect(projectSelection(project('Scratch'))).toEqual({ pick: { kind: 'empty' }, more: [] });
  });
});

describe('checkoutBaseName', () => {
  it("is the first repository's name, as New session names a checkout today", () => {
    expect(checkoutBaseName(project('termag + termag-desktop', { repos: [repo('example-org/termag'), repo('example-org/termag-desktop')] }))).toBe('termag');
  });

  it("is a no-repo project's name made a directory name, else scratch", () => {
    expect(checkoutBaseName(project('My scratch: ideas!'))).toBe('my-scratch-ideas');
    expect(checkoutBaseName(project('MetaTerm'))).toBe('metaterm');
    expect(checkoutBaseName(project('✨✨'))).toBe('scratch');
  });

  it('makes a valid checkout name of any project name, unique among the checkouts and never a reserved one', () => {
    const names = (p: UserProjectView, taken: string[]) => newChatNames(checkoutBaseName(p), [...taken, 'metaterm'], []).projectName;
    expect(names(project('termag + termag-desktop', { repos: [repo('example-org/termag'), repo('example-org/termag-desktop')] }), ['termag'])).toBe('termag-2');
    expect(names(project('MetaTerm'), [])).toBe('metaterm-2');
    expect(names(project('p', { repos: [repo('acme/metaterm')] }), [])).toBe('metaterm-2');
    expect(names(project('Scratch'), ['scratch', 'Scratch-2'])).toBe('scratch-3');
    for (const n of [names(project('a + b / c'), []), names(project('termag + termag-desktop'), [])]) expect(n).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});

describe('nextCheckoutName', () => {
  it('is the next suffix past the one that came back taken, skipping live and reserved names', () => {
    expect(nextCheckoutName('termag', 'termag', [])).toBe('termag-2');
    expect(nextCheckoutName('termag', 'termag-3', [])).toBe('termag-4');
    expect(nextCheckoutName('termag', 'termag', ['termag-2', 'TERMAG-3'])).toBe('termag-4');
    expect(nextCheckoutName('metaterm', 'metaterm-2', [])).toBe('metaterm-3');
    expect(nextCheckoutName('a.b', 'a.b-9', [])).toBe('a.b-10');
  });
});

describe('projectWorktreeTargets', () => {
  const sdk = { workflows: [{ id: 'w', type: 'agent', provider: 'claude-chat', workstreamName: 'main' }], workstreams: [{ id: 'ws', name: 'main', branch: 'main' }] };
  const checkout = (id: string, over: Partial<Project> = {}): Project => ({
    id, name: id, archived: false, instanceId: 'box-1', userProjectId: 'up', repoKeys: ['acme/web'], kind: 'normal', role: 'owner',
    lastActiveAt: '2026-11-12T00:00:00Z', ...sdk, ...over,
  } as unknown as Project);
  const up = project('up', { repos: [repo('acme/web')] });

  it("is the project's own chat checkouts on that box, newest first", () => {
    const list = [
      checkout('old', { lastActiveAt: '2026-11-01T00:00:00Z' }),
      checkout('new', { lastActiveAt: '2026-11-11T00:00:00Z' }),
      checkout('other-project', { userProjectId: 'up-2' }),
      checkout('other-box', { instanceId: 'box-2' }),
      checkout('archived', { archived: true }),
      checkout('shared', { role: 'collaborator' }),
      checkout('automation', { kind: 'automation' }),
    ];
    expect(projectWorktreeTargets(up, list, 'box-1').map(p => p.id)).toEqual(['new', 'old']);
  });

  it('never offers a checkout missing a repository the project has since gained; one with an extra still counts', () => {
    const grown = project('up', { repos: [repo('acme/web'), repo('acme/api')] });
    const list = [checkout('before'), checkout('after', { repoKeys: ['acme/api', 'acme/web', 'acme/docs'], layout: 'workspace' })];
    expect(projectWorktreeTargets(grown, list, 'box-1').map(p => p.id)).toEqual(['after']);
  });

  it('never offers a checkout still being set up, or one whose setup failed', () => {
    const list = [checkout('cloning', { setupStatus: 'cloning' }), checkout('pending', { setupStatus: 'pending' }), checkout('failed', { setupStatus: 'failed' }), checkout('none', { setupStatus: 'none' }), checkout('ready', { setupStatus: 'ready' })];
    expect(projectWorktreeTargets(up, list, 'box-1').map(p => p.id).sort()).toEqual(['none', 'ready']);
  });

  it('is nothing for a new box or a project with no repository', () => {
    expect(projectWorktreeTargets(up, [checkout('a')], null)).toEqual([]);
    expect(projectWorktreeTargets(project('up'), [checkout('a', { repoKeys: [] })], 'box-1')).toEqual([]);
  });
});

describe('projectCreateRepos', () => {
  it("sends the project's repositories exactly as it keeps them, an ssh URL included", () => {
    const ssh = { repoKey: 'acme/private', name: 'private', url: 'git@github.com:acme/private.git', defaultBranch: 'main' };
    expect(projectCreateRepos(project('p', { repos: [ssh] }))).toEqual({ repoUrl: 'git@github.com:acme/private.git', defaultBranch: 'main' });
    expect(projectCreateRepos(project('p', { repos: [ssh, repo('acme/web', null)] }))).toEqual({
      repos: [{ url: 'git@github.com:acme/private.git', defaultBranch: 'main' }, { url: 'https://github.com/acme/web.git' }],
    });
    expect(projectCreateRepos(project('p'))).toBeNull();
  });
});
