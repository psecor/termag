import { describe, expect, it } from 'vitest';
import { selectionLabel, selectionRepos, suggestRepoName, toggleRepo, workspaceReposBody, type ListedPick } from './multiRepo';

describe('suggestRepoName', () => {
  it('takes the repository part of a GitHub URL, without dots', () => {
    expect(suggestRepoName('https://github.com/acme/api.git')).toBe('api');
    expect(suggestRepoName('git@github.com:acme/web.app.git')).toBe('web-app');
    expect(suggestRepoName('nonsense')).toBe('repo');
  });
});

describe('workspaceReposBody', () => {
  const primary = { repoUrl: 'https://github.com/acme/api.git', defaultBranch: 'main' };

  it('is null without a filled extra row, so the create is unchanged', () => {
    expect(workspaceReposBody(primary, [])).toBeNull();
    expect(workspaceReposBody(primary, [{ url: '  ', name: '' }])).toBeNull();
  });

  it('lists the primary first, then the extras with their names', () => {
    expect(workspaceReposBody(primary, [{ url: 'https://github.com/acme/web', name: 'frontend' }])).toEqual([
      { url: 'https://github.com/acme/api.git', defaultBranch: 'main' },
      { url: 'https://github.com/acme/web', name: 'frontend' },
    ]);
  });

  it('needs two repositories when the primary pick is empty', () => {
    expect(workspaceReposBody({ repoUrl: null }, [{ url: 'https://github.com/acme/web', name: '' }])).toBeNull();
    expect(workspaceReposBody({ repoUrl: null }, [
      { url: 'https://github.com/acme/web', name: '' },
      { url: 'https://github.com/acme/api', name: '' },
    ])).toHaveLength(2);
  });
});

describe('the simple UI picker with more than one repository ticked', () => {
  const api: ListedPick = { kind: 'listed', fullName: 'acme/api', defaultBranch: 'main' };
  const web: ListedPick = { kind: 'listed', fullName: 'acme/web', defaultBranch: 'trunk' };
  const docs: ListedPick = { kind: 'listed', fullName: 'other/docs', defaultBranch: 'main' };
  const none = { pick: { kind: 'empty' } as const, more: [] };

  it('counts a ticked repository that is the pasted first one once', () => {
    const pasted = { kind: 'pasted', url: 'git@github.com:ACME/web.git' } as const;
    expect(selectionRepos({ pick: pasted, more: [web] })).toBeNull();
    expect(selectionRepos({ pick: pasted, more: [web, api] })).toEqual([
      { url: 'git@github.com:ACME/web.git' },
      { url: 'https://github.com/acme/api.git', defaultBranch: 'main' },
    ]);
  });

  it('makes the first tick the pick and later ticks the others', () => {
    const one = toggleRepo(none, api);
    expect(one).toEqual({ pick: api, more: [] });
    const two = toggleRepo(one, web);
    expect(two).toEqual({ pick: api, more: [web] });
  });

  it('unticks either kind, promoting the next repository when the pick goes', () => {
    const three = { pick: api, more: [web, docs] };
    expect(toggleRepo(three, web)).toEqual({ pick: api, more: [docs] });
    expect(toggleRepo(three, api)).toEqual({ pick: web, more: [docs] });
    expect(toggleRepo({ pick: api, more: [] }, api)).toEqual(none);
  });

  it('stops at the most a project holds', () => {
    const full = { pick: api, more: [web] };
    expect(toggleRepo(full, docs, 2)).toBe(full);
    expect(toggleRepo(full, web, 2)).toEqual({ pick: api, more: [] });
  });

  it('checks the limit for a first tick too, when other rows hold every slot', () => {
    expect(toggleRepo(none, api, 0)).toBe(none);
    const starter = { pick: { kind: 'starter', templateId: 'research', url: 'https://github.com/acme/research.git' } as const, more: [] };
    expect(toggleRepo(starter, api, 0)).toBe(starter);
    expect(toggleRepo(starter, api, 1)).toEqual({ pick: api, more: [] });
  });

  it('creates with repos only for two or more, each on its default branch', () => {
    expect(selectionRepos({ pick: api, more: [] })).toBeNull();
    expect(selectionRepos({ pick: api, more: [web] })).toEqual([
      { url: 'https://github.com/acme/api.git', defaultBranch: 'main' },
      { url: 'https://github.com/acme/web.git', defaultBranch: 'trunk' },
    ]);
  });

  it('replaces a paste field left blank, as it replaces a starter', () => {
    const blank = { pick: { kind: 'pasted', url: '  ' } as const, more: [] };
    expect(toggleRepo(blank, api)).toEqual({ pick: api, more: [] });
    const starter = { pick: { kind: 'starter', templateId: 'research', url: 'https://github.com/acme/research.git' } as const, more: [] };
    expect(toggleRepo(starter, api)).toEqual({ pick: api, more: [] });
  });

  it('lists the classic dialog\'s typed rows after the ticked ones', () => {
    const typed = [{ url: 'https://github.com/elsewhere/tool', name: 'tool' }, { url: ' ', name: '' }];
    expect(selectionRepos({ pick: api, more: [web] }, typed)).toEqual([
      { url: 'https://github.com/acme/api.git', defaultBranch: 'main' },
      { url: 'https://github.com/acme/web.git', defaultBranch: 'trunk' },
      { url: 'https://github.com/elsewhere/tool', name: 'tool' },
    ]);
    expect(selectionRepos({ pick: api, more: [] }, typed)).toHaveLength(2);
    expect(selectionRepos({ pick: api, more: [] }, [{ url: '', name: '' }])).toBeNull();
  });

  it('names the others short when they share the first one\'s owner', () => {
    expect(selectionLabel('acme/api', [])).toBe('acme/api');
    expect(selectionLabel('acme/api', [web, docs])).toBe('acme/api + web + other/docs');
    expect(selectionLabel('acme/api', [web, docs, { ...web, fullName: 'acme/cli' }])).toBe('acme/api + web + other/docs + 1 more');
  });
});
