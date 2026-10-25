import { describe, expect, it, vi } from 'vitest';

vi.mock('../agentRegistry', () => ({ sendForProject: vi.fn() }));
vi.mock('../../slack/app', () => ({ getSlackApp: vi.fn(() => null) }));
vi.mock('../briefing/slack', () => ({ slackEscape: (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'), webBase: () => null,
  sessionLink: (base: string | null, projectId: string | null, ws: string | null) => (base && projectId ? `${base}/?project=${encodeURIComponent(projectId)}${ws && ws !== 'main' ? `&ws=${encodeURIComponent(ws)}` : ''}` : null),
}));

import { branchSummaryFrom, changesLabel, githubRepoOf, reportText, reportablePrUrl } from './report';

describe('branchSummaryFrom', () => {
  it('reads commits, pushed and dirty from git-branch-state', () => {
    expect(branchSummaryFrom({ aheadOfBase: 3, upstream: 'origin/automation/x', ahead: 0, dirty: false })).toEqual({ commitsAhead: 3, pushed: true, dirty: false });
    expect(branchSummaryFrom({ aheadOfBase: 2, upstream: null, dirty: true })).toEqual({ commitsAhead: 2, pushed: false, dirty: true });
    expect(branchSummaryFrom({ aheadOfBase: 1, upstream: 'origin/x', ahead: 1, dirty: false })).toEqual({ commitsAhead: 1, pushed: false, dirty: false });
    // A gone remote-tracking ref: the agent reports ahead 0 with abKnown false, which is not pushed.
    expect(branchSummaryFrom({ aheadOfBase: 2, upstream: 'origin/x', ahead: 0, abKnown: false, dirty: false })).toEqual({ commitsAhead: 2, pushed: null, dirty: false });
    expect(branchSummaryFrom({ aheadOfBase: 2, upstream: 'origin/x', ahead: 0, abKnown: true, dirty: false })).toEqual({ commitsAhead: 2, pushed: true, dirty: false });
    expect(branchSummaryFrom(null)).toEqual({ commitsAhead: null, pushed: null, dirty: null });
    expect(branchSummaryFrom({ aheadOfBase: 'x' })).toEqual({ commitsAhead: null, pushed: null, dirty: null });
  });
});

describe('changesLabel', () => {
  it('says what the run left', () => {
    expect(changesLabel({ commitsAhead: 0, pushed: null, dirty: false })).toBe('no changes');
    expect(changesLabel({ commitsAhead: 1, pushed: true, dirty: false })).toBe('1 commit, pushed');
    expect(changesLabel({ commitsAhead: 3, pushed: false, dirty: true })).toBe('3 commits, not pushed, uncommitted changes');
    expect(changesLabel({ commitsAhead: null, pushed: null, dirty: true })).toBe('uncommitted changes');
    expect(changesLabel({ commitsAhead: null, pushed: null, dirty: null })).toBe('unknown');
  });
});

describe('reportText', () => {
  it('writes the Slack message with the state, the changes, the PR, the summary and the links', () => {
    const text = reportText({
      projectId: 'p1', projectName: 'triage', repoUrl: 'https://github.com/acme/r.git',
      run: { state: 'done', reason: null, summary: 'Commented on 3 issues <ok>', prUrl: 'https://github.com/acme/r/pull/9', scheduledFor: new Date(), costUsd: 0.42, workstream: 'run-20261020-0900' },
      occurrenceLabel: 'Tue 20 Oct 2026 09:00 UTC', changes: { commitsAhead: 2, pushed: true, dirty: false }, base: 'https://t.example/termag',
    });
    expect(text).toContain('✅ ⏱ *triage* run Tue 20 Oct 2026 09:00 UTC → *done*');
    expect(text).toContain('2 commits, pushed · <https://github.com/acme/r/pull/9|PR> · $0.42');
    expect(text).toContain('> Commented on 3 issues &lt;ok&gt;');
    // The workspace deep link, which opens the run with or without the simple UI.
    expect(text).toContain('<https://t.example/termag/?project=p1&ws=run-20261020-0900|the run>');
    expect(text).not.toContain('/chat/p/');
  });

  it('names the failure reason and skips links without a base', () => {
    const text = reportText({
      projectId: 'p1', projectName: 'triage', repoUrl: null,
      run: { state: 'failed', reason: 'timeout', summary: null, prUrl: null, scheduledFor: new Date(), costUsd: null, workstream: 'run-x' },
      occurrenceLabel: 'x', changes: { commitsAhead: null, pushed: null, dirty: null }, base: null,
    });
    expect(text.startsWith('❌ ⏱ *triage* run x → *failed* (timeout)')).toBe(true);
    expect(text).not.toContain('|the run');
  });

  it('links a PR only in the project\'s own repository, and withholds a secret-shaped summary', () => {
    const base = {
      projectId: 'p1', projectName: 'triage', repoUrl: 'git@github.com:Acme/r.git', occurrenceLabel: 'x',
      changes: { commitsAhead: 1, pushed: true, dirty: false }, base: null,
    };
    const run = { state: 'done', reason: null, scheduledFor: new Date(), costUsd: null, workstream: 'run-x' };
    expect(reportText({ ...base, run: { ...run, summary: 'ok', prUrl: 'https://github.com/acme/r/pull/9' } })).toContain('<https://github.com/acme/r/pull/9|PR>');
    expect(reportText({ ...base, run: { ...run, summary: 'ok', prUrl: 'https://github.com/other/repo/pull/9' } })).not.toContain('|PR>');
    expect(reportText({ ...base, repoUrl: null, run: { ...run, summary: 'ok', prUrl: 'https://github.com/acme/r/pull/9' } })).not.toContain('|PR>');
    const leaked = reportText({ ...base, run: { ...run, summary: 'pushed with ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD', prUrl: null } });
    expect(leaked).not.toContain('ghp_');
    expect(leaked).toContain('[summary withheld: it looked like it contained a GitHub token]');
  });
});

describe('githubRepoOf / reportablePrUrl', () => {
  it('reads owner/repo from https, ssh and git@ URLs and nothing else', () => {
    expect(githubRepoOf('https://github.com/Acme/Repo.git')).toBe('acme/repo');
    expect(githubRepoOf('git@github.com:acme/repo.git')).toBe('acme/repo');
    expect(githubRepoOf('https://github.com/acme/repo/pull/12')).toBe('acme/repo');
    expect(githubRepoOf('https://gitlab.com/acme/repo')).toBeNull();
    expect(githubRepoOf(null)).toBeNull();
    expect(reportablePrUrl('https://github.com/acme/repo/pull/12', 'https://github.com/acme/repo')).toBe('https://github.com/acme/repo/pull/12');
    expect(reportablePrUrl('https://github.com/acme/repo/pull/12?x=1', 'https://github.com/acme/repo')).toBeNull();
    expect(reportablePrUrl('https://github.com/acme/repo/pull/12', 'https://github.com/acme/other')).toBeNull();
  });
});
