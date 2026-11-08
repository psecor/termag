import { describe, expect, it } from 'vitest';
import { inProject, repoFullName, repoPicks, reposSettling, reposState, repoStatusText, type ProjectRepoView } from './projectRepos';

const repo = (name: string, url: string, over: Partial<ProjectRepoView> = {}): ProjectRepoView => ({
  name, url, defaultBranch: 'main', setupStatus: 'ready', setupError: null, position: 0, ...over,
});
const web = repo('web', 'https://github.com/Acme/web.git');
const api = repo('api', 'git@github.com:acme/api.git', { position: 1, defaultBranch: null });

describe('repoFullName', () => {
  it('is owner/name as the URL spells it, for HTTPS and SSH', () => {
    expect(repoFullName('https://github.com/Acme/web.git')).toBe('Acme/web');
    expect(repoFullName('git@github.com:acme/api.git')).toBe('acme/api');
    expect(repoFullName('https://github.com/acme/docs/')).toBe('acme/docs');
  });
});

describe('repoPicks', () => {
  it('lists the project\'s repositories as picks, by position', () => {
    expect(repoPicks([api, web])).toEqual([
      { kind: 'listed', fullName: 'Acme/web', defaultBranch: 'main' },
      { kind: 'listed', fullName: 'acme/api', defaultBranch: '' },
    ]);
  });
});

describe('inProject', () => {
  it('matches a listed repository however either is spelled', () => {
    expect(inProject([web, api], 'acme/WEB')).toBe(true);
    expect(inProject([web, api], 'acme/docs')).toBe(false);
  });
});

describe('reposSettling / reposState', () => {
  it('is cloning while one is pending or cloning, then failed if one failed', () => {
    expect(reposSettling([web, api])).toBe(false);
    expect(reposState([web, api])).toBeNull();
    expect(reposState([web, { ...api, setupStatus: 'pending' }])).toBe('cloning');
    expect(reposState([web, { ...api, setupStatus: 'cloning' }, { ...api, setupStatus: 'failed' }])).toBe('cloning');
    expect(reposSettling([web, { ...api, setupStatus: 'failed' }])).toBe(false);
    expect(reposState([web, { ...api, setupStatus: 'failed' }])).toBe('failed');
  });
});

describe('repoStatusText', () => {
  it('says nothing once ready, else where the clone is', () => {
    expect(repoStatusText(web)).toBeNull();
    expect(repoStatusText({ ...web, setupStatus: 'cloning' })).toBe('Cloning, then adding it to each workstream…');
    expect(repoStatusText({ ...web, setupStatus: 'failed', setupError: 'no worktree of it in fix: boom' })).toBe('Failed: no worktree of it in fix: boom');
  });
});
