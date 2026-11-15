// @vitest-environment jsdom
// The side panel's Pull request tab under the chrome refresh (PrTab.tsx).
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';

const mocks = vi.hoisted(() => ({ rows: [] as unknown[], list: vi.fn(), overview: null as unknown, overviews: {} as Record<string, unknown>, reads: vi.fn(), merge: null as null | (() => unknown) }));
vi.mock('../../services/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    prsApi: {
      ...actual.prsApi,
      list: mocks.list,
      overview: async (repo: string, number: number) => { mocks.reads(repo, number); if (overviewFails) throw new Error('502'); return mocks.overviews[`${repo}#${number}`] ?? mocks.overview; },
      merge: async () => { mocks.merge?.(); return { merged: true, sha: 'abc', autoMerge: false, message: null }; },
    },
  };
});

import { PrTab } from './PrTab';
import { askStore } from '../../chat/askStore';
import type { AskView } from '../../chat/asks';

const project = { id: 'p1', name: 'webapp' } as unknown as Project;
const row = {
  kind: 'pr', lane: 'mine', repo: 'example-org/webapp', number: 42, title: 'Fix the flaky retry', url: 'https://github.com/x', author: 'ada',
  headRefName: 'fix-retry', baseRefName: 'main', at: '2026-10-27T00:00:00Z', badges: [], failingChecks: [], pendingChecks: [], waitingOn: [],
  blockedBy: null, mergedAt: null, mergeCommit: null, deploy: null, workstream: { projectId: 'p1', workstream: 'main' }, requestedAt: null, reviewTarget: null,
};
const overview = {
  repo: 'example-org/webapp', number: 42, title: 'Fix the flaky retry', url: 'https://github.com/x', author: 'ada', viewer: 'ada', state: 'OPEN',
  isDraft: false, body: 'Backs off with jitter.', createdAt: null, updatedAt: '', headRefName: 'fix-retry', baseRefName: 'main', reviewDecision: null,
  mergeable: 'MERGEABLE', checkRollup: null, checks: [{ name: 'frontend', state: 'passed' }, { name: 'Cursor Bugbot', state: 'pending' }],
  requestedReviewers: ['grace'], additions: 3, deletions: 1, changedFiles: 1, files: [{ path: 'retry.ts', additions: 3, deletions: 1, changeType: 'MODIFIED' }],
  filesTruncated: false, reviews: [], viewerReview: null, viewerCanReview: false, mergeStateStatus: 'BLOCKED', autoMerge: false, nodeId: null, headSha: null,
  autoMergeMethod: null, mergeSettings: { methods: [], defaultMethod: null, autoMergeAllowed: false }, viewerCanMerge: false,
  failedSuites: { runs: [], other: [] }, requestedUsers: [], requestedTeams: [],
};

const ask = (thread: string, number: number, repo = 'example-org/webapp') => ({
  thread, title: `Ask ${thread}`, prs: [{ key: `${repo}#${number}`, url: `https://github.com/${repo}/pull/${number}`, number, branch: null }],
} as AskView);
const publish = (...asks: AskView[]) => askStore.publish('p1|main', new Map(asks.map(a => [a.thread, a])));

let root: Root;
let host: HTMLDivElement;
let overviewFails = false;

const gateDetail = (name: string) => [...host.querySelectorAll('.ctx-gates li')]
  .find(li => li.querySelector('.ctx-gate-name')!.firstChild!.textContent === name)?.querySelector('.ctx-gate-detail')?.textContent;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  mocks.rows = [];
  mocks.list.mockReset().mockImplementation(async () => ({ connected: true, lanes: [{ id: 'mine', label: 'Mine', rows: mocks.rows }] }));
  mocks.overview = overview;
  mocks.overviews = {};
  mocks.reads.mockClear();
  overviewFails = false;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  askStore.publish('p1|main', null);
});

async function render() {
  await act(async () => root.render(<PrTab project={project} workstream="main" />));
  await act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); });
}

describe('PrTab', () => {
  it('waits for the initial pipeline read so an ask PR does not flash before the parent PR', async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    mocks.list.mockImplementationOnce(async () => {
      await pending;
      return { connected: true, lanes: [{ id: 'mine', label: 'Mine', rows: [row] }] };
    });
    publish(ask('one', 43));
    await render();
    expect(host.textContent).toContain('Looking for its pull request');
    expect(host.querySelector('.pro-title')).toBeNull();
    expect(mocks.reads).not.toHaveBeenCalled();
    await act(async () => { finish(); await pending; });
    expect(host.querySelector('.pro-title')?.textContent).toContain('Fix the flaky retry');
    expect(host.querySelector('[aria-pressed="true"]')?.textContent).toContain('This session');
    expect(mocks.reads).not.toHaveBeenCalledWith('example-org/webapp', 43);
  });

  it('still reads an ask PR when the initial pipeline request fails', async () => {
    mocks.list.mockRejectedValueOnce(new Error('502'));
    publish(ask('one', 42));
    await render();
    expect(host.querySelector('.pr-panel-empty')).toBeNull();
    expect(host.querySelector('.pro-title')?.textContent).toContain('Fix the flaky retry');
    expect(mocks.reads).toHaveBeenCalledWith('example-org/webapp', 42);
  });

  it('reads an ask PR directly even when the parent and pipeline have no PR', async () => {
    publish(ask('one', 42));
    await render();
    expect(host.querySelector('.pr-panel-empty')).toBeNull();
    expect(host.querySelector('.pr-panel-source')?.textContent).toBe('From ask: Ask one');
    expect(host.querySelector('.pro-title')?.textContent).toContain('Fix the flaky retry');
    expect(mocks.reads).toHaveBeenCalledWith('example-org/webapp', 42);
    expect(gateDetail('Bugbot')).toBe('Running');
  });

  it('switches among the parent PR and ask PRs, preserving the selected PR when more asks arrive', async () => {
    mocks.rows = [row, { ...row, number: 43, title: 'Second PR', workstream: { projectId: 'ask-project', workstream: 'main' } }];
    mocks.overviews['example-org/webapp#43'] = { ...overview, number: 43, title: 'Second PR', body: 'The other change.', checks: [] };
    publish(ask('one', 43));
    await render();
    const picker = () => host.querySelector('[aria-label="Pull requests for this session"]')!;
    expect(picker().querySelectorAll('button')).toHaveLength(2);
    expect(host.querySelector('.pro-title')?.textContent).toContain('Fix the flaky retry');
    await act(async () => (picker().querySelectorAll('button')[1] as HTMLButtonElement).click());
    expect(host.querySelector('.pro-title')?.textContent).toContain('Second PR');
    expect(host.querySelector('.pro-body')?.textContent).toBe('The other change.');
    expect(gateDetail('Bugbot')).toBeUndefined();
    await act(async () => publish(ask('one', 43), ask('two', 44)));
    expect(picker().querySelectorAll('button')).toHaveLength(3);
    expect(host.querySelector('.pro-title')?.textContent).toContain('Second PR');
    expect(picker().querySelector('[aria-pressed="true"]')?.textContent).toContain('Ask one');
  });

  it('updates when an ask publishes a PR and never carries it into another workstream', async () => {
    await render();
    expect(host.querySelector('.pr-panel-empty')).not.toBeNull();
    await act(async () => publish(ask('one', 42)));
    expect(host.querySelector('.pro-title')?.textContent).toContain('Fix the flaky retry');
    await act(async () => root.render(<PrTab project={project} workstream="other" />));
    expect(host.querySelector('.pr-panel-empty')).not.toBeNull();
    expect(host.querySelector('.pro-title')).toBeNull();
  });

  it('says there is no pull request when the session has none', async () => {
    await render();
    expect(host.querySelector('.pr-panel-empty')?.textContent).toContain('No pull request yet');
  });

  it("shows the session's PR from the PR pipeline, its gates and the full UI's view of it", async () => {
    mocks.rows = [row];
    await render();
    expect(host.querySelector('.pr-panel-label')?.textContent).toContain('42');
    const gates = [...host.querySelectorAll('.ctx-gates li')].map(li => `${li.querySelector('.ctx-gate-name')!.firstChild!.textContent}: ${li.querySelector('.ctx-gate-detail')!.textContent}`);
    expect(gates).toEqual(['Checks: 1 check passed', 'Bugbot: Running', 'Review: Waiting on grace', 'Conflicts: None']);
    expect(host.querySelector('.pro-title')?.textContent).toContain('Fix the flaky retry');
    expect(host.querySelector('.pro-body')?.textContent).toBe('Backs off with jitter.');
  });

  it('shows no gates for a PR that is no longer open', async () => {
    mocks.rows = [row];
    mocks.overview = { ...overview, state: 'MERGED' };
    await render();
    expect(host.querySelector('.ctx-gates')).toBeNull();
    expect(host.querySelector('.pro-title')).not.toBeNull();
  });

  it('reads the PR again each time the list answers, so the gates and the view below follow GitHub', async () => {
    vi.useFakeTimers();
    try {
      mocks.rows = [row];
      await act(async () => root.render(<PrTab project={project} workstream="main" />));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(gateDetail('Bugbot')).toBe('Running');
      mocks.overview = { ...overview, checks: [{ name: 'frontend', state: 'passed' }, { name: 'Cursor Bugbot', state: 'passed' }], body: 'Backs off with jitter, capped.' };
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(gateDetail('Bugbot')).not.toBe('Running');
      expect(host.querySelector('.pro-body')?.textContent).toBe('Backs off with jitter, capped.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the PR and its gates when a re-read fails, with no error', async () => {
    vi.useFakeTimers();
    try {
      mocks.rows = [row];
      await act(async () => root.render(<PrTab project={project} workstream="main" />));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      overviewFails = true;
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(host.querySelector('.pro-body')?.textContent).toBe('Backs off with jitter.');
      expect(gateDetail('Bugbot')).toBe('Running');
      expect(host.querySelector('[role="alert"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads the PR again after a merge in the view below, so the gates go', async () => {
    mocks.rows = [row];
    mocks.overview = { ...overview, viewerCanMerge: true, mergeStateStatus: 'CLEAN', headSha: 'abc', mergeSettings: { methods: ['SQUASH'], defaultMethod: 'SQUASH', autoMergeAllowed: false } };
    mocks.merge = () => { mocks.overview = { ...(mocks.overview as object), state: 'MERGED' }; };
    await render();
    expect(host.querySelector('.ctx-gates')).not.toBeNull();
    const merge = [...host.querySelectorAll('button')].find(b => b.textContent === 'Squash and merge…');
    expect(merge).toBeTruthy();
    await act(async () => { merge!.click(); });
    const confirm = [...host.querySelectorAll('button')].find(b => b.textContent === 'Confirm merge');
    expect(confirm).toBeTruthy();
    await act(async () => { confirm!.click(); });
    await act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); });
    expect(host.querySelector('.ctx-gates')).toBeNull();
  });

  it('tells the rest of the page after a merge, so the PR pills and lists read again', async () => {
    mocks.rows = [row];
    mocks.overview = { ...overview, viewerCanMerge: true, mergeStateStatus: 'CLEAN', headSha: 'abc', mergeSettings: { methods: ['SQUASH'], defaultMethod: 'SQUASH', autoMergeAllowed: false } };
    mocks.merge = null;
    const heard = vi.fn();
    window.addEventListener('termag:prs-changed', heard);
    await render();
    await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent === 'Squash and merge…')!.click(); });
    await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent === 'Confirm merge')!.click(); });
    await act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); });
    window.removeEventListener('termag:prs-changed', heard);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
