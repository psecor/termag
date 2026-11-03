// @vitest-environment jsdom
// The chrome refresh's context card (SessionContextCard.tsx), on real data from mocked feeds.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';

const mocks = vi.hoisted(() => ({ rows: [] as unknown[], overview: null as unknown, boxes: [] as unknown[], flags: {} as Record<string, unknown>, changes: null as unknown, asked: [] as unknown[] }));
vi.mock('../../services/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    prsApi: {
      ...actual.prsApi,
      list: async () => ({ connected: true, lanes: [{ id: 'mine', label: 'Mine', rows: mocks.rows }] }),
      overview: async () => { if (mocks.overview instanceof Error) throw mocks.overview; return mocks.overview; },
    },
    workstreamsApi: {
      ...actual.workstreamsApi,
      changes: async (...args: unknown[]) => { mocks.asked.push(args); return mocks.changes; },
    },
  };
});
vi.mock('../../flags', async () => {
  const actual = await vi.importActual<typeof import('../../flags')>('../../flags');
  return { ...actual, useFlag: <T,>(key: string, fallback: T) => (key in mocks.flags ? mocks.flags[key] as T : fallback) };
});
vi.mock('../../services/boxFeed', () => ({ boxFeed: { subscribe: () => () => {}, getSnapshot: () => mocks.boxes } }));
vi.mock('../../chat/useChatSpaces', () => ({
  useSharedChatSpaces: () => ({ enabled: true, loaded: true, current: true, spaces: [{ id: 's-notes', name: 'notes' }], index: new Map([['box-1', ['notes']]]), colorOf: () => '#888888' }),
}));

import { SessionContextCard } from './SessionContextCard';
import { chatEvents } from '../../chat/chatEvents';
import { PRS_CHANGED_EVENT } from '../../utils/prPipeline';

const project = {
  id: 'p1', name: 'webapp', instanceId: 'box-1', role: 'owner', ownerUsername: 'ada', repoUrl: 'https://github.com/example-org/webapp.git',
  workstreams: [{ name: 'main', branch: 'fix-retry' }],
} as unknown as Project;
const row = {
  kind: 'pr', lane: 'mine', repo: 'example-org/webapp', number: 42, title: 'Fix the flaky retry', url: null, author: 'ada', headRefName: 'fix-retry',
  baseRefName: 'main', at: null, badges: [], failingChecks: [], pendingChecks: [], waitingOn: [], blockedBy: null, mergedAt: null, mergeCommit: null,
  deploy: null, workstream: { projectId: 'p1', workstream: 'main' }, requestedAt: null, reviewTarget: null,
};
const overview = {
  state: 'OPEN', title: 'Fix the flaky retry', checks: [{ name: 'frontend', state: 'passed' }], reviewDecision: 'APPROVED', reviews: [],
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', requestedReviewers: [], additions: 14, deletions: 3, changedFiles: 2,
  files: [{ path: 'src/retry.ts', additions: 12, deletions: 3, changeType: 'MODIFIED' }, { path: 'src/retry.test.ts', additions: 2, deletions: 0, changeType: 'ADDED' }],
};

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  mocks.rows = [];
  mocks.overview = overview;
  mocks.boxes = [{ id: 'box-1', name: 'box-2', status: 'ready' }];
  mocks.flags = {};
  mocks.changes = null;
  mocks.asked = [];
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render(onOpenPr?: () => void) {
  await act(async () => root.render(<SessionContextCard project={project} workstream="main" onOpenPr={onOpenPr} />));
  await act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); });
}

const rows = () => [...host.querySelectorAll('.ctx-row')].map(r => r.textContent);

describe('SessionContextCard', () => {
  it('shows where the session runs: the box and its state, the space, the repository and the branch', async () => {
    await render();
    expect(rows()).toEqual(['box-2Running', 'notes', 'example-org/webapp', 'fix-retry']);
  });

  it('says so when the session has no pull request, and lists no changes', async () => {
    await render();
    const empties = [...host.querySelectorAll('.ctx-empty')].map(e => e.textContent);
    expect(empties).toEqual(['Its pull request’s changes show here.', 'No pull request yet']);
  });

  it("lists the PR's changed files with their numstat, and the PR with its gates, which opens the panel's tab", async () => {
    mocks.rows = [row];
    const onOpenPr = vi.fn();
    await render(onOpenPr);
    expect(host.querySelector('.ctx-heading-aside')?.textContent).toContain('2 files');
    expect([...host.querySelectorAll('.ctx-files li')].map(li => `${li.querySelector('.ctx-file-kind')!.textContent} ${li.querySelector('.ctx-file-path')!.textContent} ${li.querySelector('.ctx-numstat')!.getAttribute('aria-label')}`))
      .toEqual(['M src/retry.ts 12 added, 3 removed', 'A src/retry.test.ts 2 added, 0 removed']);
    expect(host.querySelector('.ctx-pr-sub')?.textContent).toBe('#42 · 3 of 3 gates clear');
    expect(host.querySelectorAll('.ctx-gates li').length).toBe(3);
    await act(async () => { (host.querySelector('.ctx-pr') as HTMLElement).click(); });
    expect(onOpenPr).toHaveBeenCalledTimes(1);
  });

  it('marks a merged PR as merged, with no gates', async () => {
    mocks.rows = [row];
    mocks.overview = { ...overview, state: 'MERGED' };
    await render();
    expect(host.querySelector('.ctx-pr-sub')?.textContent).toBe('#42 · merged');
    expect(host.querySelector('.ctx-gates')).toBeNull();
    expect(host.querySelector('.ctx-pr-state')?.getAttribute('data-state')).toBe('merged');
  });

  it("says GitHub couldn't be read rather than reading for ever, and keeps the PR's row", async () => {
    mocks.rows = [row];
    mocks.overview = new Error('502');
    await render();
    expect(host.querySelector('.ctx-empty')?.textContent).toBe('Couldn’t read them from GitHub');
    expect(host.querySelector('.ctx-pr-sub')?.textContent).toBe('#42');
  });

  it('reads the overview again each time the list answers, so its gates follow GitHub', async () => {
    vi.useFakeTimers();
    try {
      mocks.rows = [row];
      mocks.overview = { ...overview, checks: [{ name: 'frontend', state: 'pending' }] };
      await act(async () => root.render(<SessionContextCard project={project} workstream="main" />));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(host.querySelector('.ctx-pr-sub')?.textContent).toBe('#42 · 2 of 3 gates clear');
      mocks.overview = overview;
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(host.querySelector('.ctx-pr-sub')?.textContent).toBe('#42 · 3 of 3 gates clear');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the last overview when a re-read fails', async () => {
    vi.useFakeTimers();
    try {
      mocks.rows = [row];
      await act(async () => root.render(<SessionContextCard project={project} workstream="main" />));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      mocks.overview = new Error('502');
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(host.querySelector('.ctx-pr-sub')?.textContent).toBe('#42 · 3 of 3 gates clear');
      expect(host.querySelectorAll('.ctx-files li').length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads the list and the overview again at once when a PR changes', async () => {
    await render();
    expect(host.querySelector('.ctx-pr-sub')).toBeNull();
    mocks.rows = [row];
    await act(async () => { window.dispatchEvent(new Event(PRS_CHANGED_EVENT)); });
    await act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); });
    expect(host.querySelector('.ctx-pr-sub')?.textContent).toBe('#42 · 3 of 3 gates clear');
  });

  describe('in-flight changes (simple-ui-inflight-changes-enabled)', () => {
    const inflight = {
      available: true, branch: 'fix-retry', upstream: 'origin/fix-retry', against: 'origin/fix-retry', commits: 1, truncated: false, partial: false, worktree: '.worktrees/fix-retry',
      uncommitted: [{ path: 'src/backoff.ts', status: 'M', additions: 4, deletions: 2 }, { path: 'notes.md', status: '?', additions: 3, deletions: 0 }],
      committed: [{ path: 'src/retry.ts', status: 'M', additions: 1, deletions: 1 }],
    };
    const groupText = () => [...host.querySelectorAll('.ctx-group')].map(g => ({
      label: g.querySelector('.ctx-subheading')!.firstChild!.textContent,
      files: [...g.querySelectorAll('.ctx-files li')].map(li => `${li.querySelector('.ctx-file-kind')!.textContent} ${li.querySelector('.ctx-file-path')!.textContent}`),
    }));

    it("lists what isn't committed and what isn't pushed above the PR's files, from the worktree on the PR's branch", async () => {
      mocks.flags = { 'simple-ui-inflight-changes-enabled': true };
      mocks.rows = [row];
      mocks.changes = inflight;
      await render();
      expect(mocks.asked).toEqual([['p1', 'main', 'fix-retry']]);
      expect(groupText()).toEqual([
        { label: 'Not committed', files: ['M src/backoff.ts', 'A notes.md'] },
        { label: 'Not pushed', files: ['M src/retry.ts'] },
      ]);
      expect(host.querySelector('.ctx-where')?.textContent).toBe('In .worktrees/fix-retry');
      expect([...host.querySelectorAll('.ctx-subheading')].map(h => h.firstChild!.textContent)).toContain('In the pull request');
      expect(host.querySelectorAll('.ctx-files').length).toBe(3);
    });

    it('lists them for a session with no PR yet, and says when nothing is in flight', async () => {
      mocks.flags = { 'simple-ui-inflight-changes-enabled': true };
      mocks.changes = { ...inflight, worktree: null, upstream: null, against: 'origin/main' };
      await render();
      expect(mocks.asked).toEqual([['p1', 'main', null]]);
      expect(groupText().map(g => g.label)).toEqual(['Not committed', 'Not pushed']);
      expect(host.querySelector('.ctx-where')).toBeNull();
      mocks.changes = { ...inflight, uncommitted: [], committed: [] };
      await act(async () => { chatEvents.publish({ type: 'chat', projectId: 'p1', workstream: 'main', turnId: 't1', event: { type: 'result' } }); });
      await act(async () => { await new Promise(r => setTimeout(r, 1600)); });
      expect(groupText()).toEqual([]);
      expect([...host.querySelectorAll('.ctx-empty')].map(e => e.textContent)[0]).toBe('No changes yet');
    });

    it("reads again a moment after one of the session's tool calls ends, not another session's", async () => {
      mocks.flags = { 'simple-ui-inflight-changes-enabled': true };
      mocks.changes = { ...inflight, committed: [] };
      await render();
      expect(groupText().map(g => g.files.length)).toEqual([2]);
      mocks.changes = { ...inflight, uncommitted: [...inflight.uncommitted, { path: 'src/new.ts', status: '?', additions: 9, deletions: 0 }], committed: [] };
      const toolDone = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't9', content: 'ok' }] } };
      await act(async () => { chatEvents.publish({ type: 'chat', projectId: 'p2', workstream: 'main', turnId: 't1', event: toolDone }); });
      await act(async () => { await new Promise(r => setTimeout(r, 1600)); });
      expect(mocks.asked.length).toBe(1);
      await act(async () => { chatEvents.publish({ type: 'chat', projectId: 'p1', workstream: 'main', turnId: 't1', event: toolDone }); });
      await act(async () => { await new Promise(r => setTimeout(r, 1600)); });
      expect(mocks.asked.length).toBe(2);
      expect(groupText().map(g => g.files.length)).toEqual([3]);
    });

    it('keeps the last list when a later read finds the box down', async () => {
      mocks.flags = { 'simple-ui-inflight-changes-enabled': true };
      mocks.changes = inflight;
      await render();
      expect(groupText().map(g => g.label)).toEqual(['Not committed', 'Not pushed']);
      mocks.changes = { available: false, reason: 'offline' };
      await act(async () => { chatEvents.publish({ type: 'chat', projectId: 'p1', workstream: 'main', turnId: 't1', event: { type: 'result' } }); });
      await act(async () => { await new Promise(r => setTimeout(r, 1600)); });
      expect(mocks.asked.length).toBe(2);
      expect(groupText().map(g => g.label)).toEqual(['Not committed', 'Not pushed']);
    });

    it("never shows, or keeps, the workstream checkout's list for the PR's branch once the session has a PR", async () => {
      mocks.flags = { 'simple-ui-inflight-changes-enabled': true };
      mocks.changes = inflight;
      await render();
      expect(mocks.asked).toEqual([['p1', 'main', null]]);
      expect(groupText().map(g => g.label)).toEqual(['Not committed', 'Not pushed']);
      // The session's PR shows up, and its branch's worktree can't be read.
      mocks.rows = [row];
      mocks.changes = { available: false, reason: 'unreadable' };
      await act(async () => { window.dispatchEvent(new Event(PRS_CHANGED_EVENT)); });
      await act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); });
      expect(mocks.asked[mocks.asked.length - 1]).toEqual(['p1', 'main', 'fix-retry']);
      expect(groupText()).toEqual([]);
    });

    it("says why a session with no PR lists nothing when its box can't say", async () => {
      mocks.flags = { 'simple-ui-inflight-changes-enabled': true };
      mocks.changes = { available: false, reason: 'outdated-agent' };
      await render();
      expect(host.querySelector('.ctx-section:nth-of-type(2) .ctx-empty')?.textContent).toBe('Its box can’t list changes until it updates');
    });

    it("says so when the box couldn't list the unpushed commits' files", async () => {
      mocks.flags = { 'simple-ui-inflight-changes-enabled': true };
      mocks.changes = { ...inflight, uncommitted: [], committed: [], commits: 2, partial: true };
      await render();
      const g = host.querySelector('.ctx-group[data-group="committed"]')!;
      expect(g.querySelector('.ctx-heading-aside')?.textContent).toBe('2 commits');
      expect(g.querySelector('.ctx-empty')?.textContent).toBe('Couldn’t list their files');
    });

    it("shows the PR's files alone when the box can't say, and asks nothing with the flag off", async () => {
      mocks.flags = { 'simple-ui-inflight-changes-enabled': true };
      mocks.rows = [row];
      mocks.changes = { available: false, reason: 'outdated-agent' };
      await render();
      expect(groupText()).toEqual([]);
      expect(host.querySelectorAll('.ctx-files').length).toBe(1);
      expect(host.querySelector('.ctx-subheading')).toBeNull();
      act(() => root.unmount());
      root = createRoot(host);
      mocks.flags = {};
      mocks.asked = [];
      await render();
      expect(mocks.asked).toEqual([]);
      expect(host.querySelectorAll('.ctx-files').length).toBe(1);
    });
  });

  it('names every box state, a coming-up box as Starting and a faulted one as Failed', async () => {
    mocks.boxes = [{ id: 'box-1', name: 'box-2', status: 'warm' }];
    await render();
    expect(host.querySelector('.ctx-pill')?.textContent).toBe('Starting');
    mocks.boxes = [{ id: 'box-1', name: 'box-2', status: 'failed' }];
    await render();
    expect(host.querySelector('.ctx-pill')?.textContent).toBe('Failed');
    expect(host.querySelector('.ctx-pill')?.getAttribute('data-status')).toBe('fail');
  });
});
