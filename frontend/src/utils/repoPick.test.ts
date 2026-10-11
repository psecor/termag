import { describe, expect, it } from 'vitest';
import {
  catalogFromWire,
  createBody,
  degradedCatalog,
  githubRepoUrl,
  repoKey,
  repoPromptDue,
  sameRepoMatches,
  suggestedName,
  type RepoProjectRef,
} from './repoPick';

describe('repoKey', () => {
  it('folds https and ssh onto one owner/repo', () => {
    expect(repoKey('https://github.com/Example-Org/Webapp.git')).toBe('example-org/webapp');
  });
});

describe('githubRepoUrl', () => {
  it('builds the https clone url', () => {
    expect(githubRepoUrl('acme/widget')).toBe('https://github.com/acme/widget.git');
  });
});

describe('createBody', () => {
  it('sends no repository for an empty directory', () => {
    expect(createBody({ kind: 'empty' })).toEqual({ repoUrl: null });
  });

  it('sends the listed branch with the clone url', () => {
    expect(createBody({ kind: 'listed', fullName: 'acme/widget', defaultBranch: 'develop' })).toEqual({
      repoUrl: 'https://github.com/acme/widget.git',
      defaultBranch: 'develop',
    });
  });

  it('sends a starter without a branch', () => {
    expect(createBody({
      kind: 'starter',
      templateId: 'webapp',
      url: 'https://github.com/example-org/webapp.git',
    })).toEqual({
      repoUrl: 'https://github.com/example-org/webapp.git',
      defaultBranch: null,
    });
  });

  it('sends a pasted url without a branch', () => {
    expect(createBody({ kind: 'pasted', url: '  git@github.com:acme/widget.git  ' })).toEqual({
      repoUrl: 'git@github.com:acme/widget.git',
      defaultBranch: null,
    });
  });

  it('does not post a blank paste', () => {
    expect(createBody({ kind: 'pasted', url: '   ' })).toBe(null);
  });
});

const projects: RepoProjectRef[] = [
  { id: 'p1', name: 'widget', archived: false, instanceId: 'box-1', repoUrl: 'git@github.com:acme/widget.git' },
  { id: 'p2', name: 'widget-old', archived: true, instanceId: 'box-1', repoUrl: 'https://github.com/acme/widget.git' },
  { id: 'p3', name: 'widget-other', archived: false, instanceId: 'box-2', repoUrl: 'https://github.com/acme/widget.git' },
];

describe('sameRepoMatches', () => {
  it('returns the live project on this box with the same repository', () => {
    expect(sameRepoMatches(
      { kind: 'listed', fullName: 'acme/widget', defaultBranch: 'develop' },
      projects,
      'box-1',
    )).toEqual([
      { id: 'p1', name: 'widget', archived: false, instanceId: 'box-1', repoUrl: 'git@github.com:acme/widget.git' },
    ]);
  });

  it('returns nothing for an empty directory', () => {
    expect(sameRepoMatches({ kind: 'empty' }, projects, 'box-1')).toEqual([]);
  });

  it('returns nothing for a blank paste', () => {
    expect(sameRepoMatches({ kind: 'pasted', url: '  ' }, projects, 'box-1')).toEqual([]);
  });
});

describe('suggestedName', () => {
  it('is null for an empty directory', () => {
    expect(suggestedName({ kind: 'empty' })).toBe(null);
  });

  it('is null for a blank paste', () => {
    expect(suggestedName({ kind: 'pasted', url: ' ' })).toBe(null);
  });

  it('sanitises a listed repository basename', () => {
    expect(suggestedName({ kind: 'listed', fullName: 'acme/my.repo', defaultBranch: 'main' })).toBe('my-repo');
  });

  it('sanitises a pasted url the way the server names a project', () => {
    expect(suggestedName({ kind: 'pasted', url: 'git@github.com:o/my.repo.git' })).toBe('my-repo');
  });
});

describe('repoPromptDue', () => {
  it('is due for a managed box with no live project and no dismissal', () => {
    expect(repoPromptDue({ kind: 'ec2', dismissedAt: null, liveCount: 0 })).toBe(true);
  });

  it('is not due for a self-managed box', () => {
    expect(repoPromptDue({ kind: 'external', dismissedAt: null, liveCount: 0 })).toBe(false);
  });

  it('is not due after the owner dismisses it', () => {
    expect(repoPromptDue({ kind: 'ec2', dismissedAt: '2026-10-10T00:00:00.000Z', liveCount: 0 })).toBe(false);
  });

  it('is not due once a live project exists', () => {
    expect(repoPromptDue({ kind: 'ec2', dismissedAt: null, liveCount: 1 })).toBe(false);
  });
});

describe('catalogFromWire', () => {
  it('keeps repos on a rate limit and drops them for an app policy', () => {
    expect(catalogFromWire({
      status: 'ok',
      groups: [
        {
          owner: 'example-org',
          kind: 'org',
          status: 'rate-limited',
          retryAfter: null,
          repos: [{ fullName: 'example-org/webapp', defaultBranch: 'main' }],
        },
        {
          owner: 'example-labs',
          kind: 'org',
          status: 'app-policy',
          repos: [{ fullName: 'example-labs/secret', defaultBranch: 'main' }],
        },
      ],
    })).toEqual({
      ok: true,
      notice: null,
      groups: [
        {
          owner: 'example-org',
          kind: 'org',
          status: 'rate-limited',
          repos: [{ fullName: 'example-org/webapp', defaultBranch: 'main' }],
          text: 'GitHub rate-limited requests for example-org. Try again later.',
        },
        {
          owner: 'example-labs',
          kind: 'org',
          status: 'app-policy',
          repos: [],
          text: 'example-labs restricts OAuth apps; ask an org owner to approve GitHub CLI',
        },
      ],
    });
  });

  it('uses the SSO sentence and drops that group\'s repos', () => {
    expect(catalogFromWire({
      status: 'ok',
      groups: [{
        owner: 'example-org',
        kind: 'org',
        status: 'sso-required',
        ssoUrl: 'https://github.com/orgs/example-org/sso',
        repos: [{ fullName: 'example-org/webapp', defaultBranch: 'main' }],
      }],
    })).toEqual({
      ok: true,
      notice: null,
      groups: [{
        owner: 'example-org',
        kind: 'org',
        status: 'sso-required',
        repos: [],
        text: 'Authorize this token for example-org SSO',
        href: 'https://github.com/orgs/example-org/sso',
      }],
    });
  });

  it('replaces every group with the reconnect sentence', () => {
    expect(catalogFromWire({
      status: 'reconnect',
      reconnect: { code: 'unauthorized', sentence: 'Reconnect GitHub in Settings' },
      groups: [{
        owner: 'octocat',
        kind: 'user',
        status: 'ok',
        repos: [{ fullName: 'octocat/hello', defaultBranch: 'main' }],
      }],
    })).toEqual({
      ok: false,
      groups: [],
      notice: 'Reconnect GitHub in Settings',
    });
  });

  it('does not throw on a bad payload', () => {
    expect(catalogFromWire(null)).toEqual({
      ok: false,
      groups: [],
      notice: 'Could not load repositories. Starters and a pasted URL still work.',
    });
  });

  it('uses the same degraded catalog a failed fetch does', () => {
    expect(degradedCatalog()).toEqual({
      ok: false,
      groups: [],
      notice: 'Could not load repositories. Starters and a pasted URL still work.',
    });
  });
});
