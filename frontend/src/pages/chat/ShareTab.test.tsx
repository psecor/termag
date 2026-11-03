// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrPipelineResponse, PrRow } from '../../services/api';

const mocks = vi.hoisted(() => ({
  flags: {} as Record<string, boolean | number>,
  shares: { list: vi.fn(), settings: vi.fn(), createLink: vi.fn(), revoke: vi.fn(), create: vi.fn(), stackCheck: vi.fn() },
  prs: { list: vi.fn() },
}));
vi.mock('../../flags', async () => {
  const actual = await vi.importActual<typeof import('../../flags')>('../../flags');
  return { ...actual, useFlag: (key: string, fallback: unknown) => (key in mocks.flags ? mocks.flags[key] : fallback) };
});
vi.mock('../../services/api', () => ({
  previewSharesApi: mocks.shares,
  prsApi: mocks.prs,
  usersApi: { search: vi.fn(async () => []) },
  previewShareLink: (id: string) => `https://termag.test/termag/p/${id}`,
}));

import { ShareTab, workstreamPrs } from './ShareTab';

const row = (over: Partial<PrRow> = {}): PrRow => ({
  kind: 'pr', lane: 'needs_approval', repo: 'example-org/webapp', number: 42, title: 'Retro sidebar', url: 'https://github.com/example-org/webapp/pull/42',
  author: 'olive', headRefName: 'feat/x', baseRefName: 'main', at: null, badges: [], failingChecks: [], pendingChecks: [], waitingOn: [],
  blockedBy: null, mergedAt: null, mergeCommit: null, deploy: null, requestedAt: null, reviewTarget: null,
  workstream: { projectId: 'p1', projectName: 'webapp', workstream: 'feature-x' }, ...over,
});
const pipeline = (rows: PrRow[]): PrPipelineResponse => ({ connected: true, lanes: [{ id: 'needs_approval', label: 'Needs approval', rows }] } as unknown as PrPipelineResponse);

let root: Root;
let el: HTMLDivElement;
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.flags = { 'browser-pane-preview-share-enabled': true, 'browser-pane-pr-link-shares-enabled': true };
  mocks.shares.list.mockReset().mockResolvedValue([]);
  mocks.shares.stackCheck.mockReset().mockResolvedValue({ checked: false });
  mocks.shares.settings.mockReset().mockResolvedValue({ prLinksEnabled: false, pathFilter: [], reviewerAccountHint: null });
  mocks.shares.createLink.mockReset();
  mocks.shares.create.mockReset();
  mocks.shares.revoke.mockReset().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
  mocks.prs.list.mockReset().mockResolvedValue(pipeline([]));
  localStorage.clear();
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); });

describe('workstreamPrs', () => {
  it('keeps the open PRs of this workstream that Share preview is offered on, once each', () => {
    const rows = [
      row(),
      row({ number: 43, workstream: { projectId: 'p1', projectName: 'webapp', workstream: 'main' } }),
      row({ number: 44, workstream: { projectId: 'p2', projectName: 'other', workstream: 'feature-x' } }),
      row({ number: 45, lane: 'merged' as PrRow['lane'] }),
      row({ kind: 'branch', number: null }),
      row({ number: 46, workstream: null }),
    ];
    const res = { connected: true, lanes: [{ id: 'needs_approval', label: '', rows }, { id: 'checks', label: '', rows: [row()] }] } as unknown as PrPipelineResponse;
    expect(workstreamPrs(res, 'p1', 'feature-x').map(r => r.number)).toEqual([42]);
    expect(workstreamPrs({ connected: false } as unknown as PrPipelineResponse, 'p1', 'feature-x')).toEqual([]);
  });
});

describe('the side panel\'s Share tab', () => {
  it('shares the workstream, with links at the page the Browser tab shows, and takes no focus', async () => {
    localStorage.setItem('termag.browserPane.url.p1/feature-x', 'http://localhost:3000/projects/x/flags?env=production');
    act(() => root.render(<ShareTab projectId="p1" workstream="feature-x" />));
    await flush();
    expect(el.textContent).toContain('Share the preview of feature-x');
    expect(el.textContent).toContain('Links open at /projects/x/flags?env=production');
    expect(mocks.shares.list).toHaveBeenCalledWith('p1');
    expect(document.activeElement).not.toBe(el.querySelector('input[type=email]'));
  });

  it('lists the workstream\'s own PRs with Share preview, and says where a PR is shared by hand', async () => {
    mocks.prs.list.mockResolvedValue(pipeline([row(), row({ number: 43, workstream: { projectId: 'p1', projectName: 'webapp', workstream: 'main' } })]));
    act(() => root.render(<ShareTab projectId="p1" workstream="feature-x" />));
    await flush();
    const prs = el.querySelector('[aria-label="This workstream\'s PRs"]')!;
    expect(prs.querySelectorAll('.chat-side-share-pr')).toHaveLength(1);
    expect(prs.textContent).toContain('webapp#42');
    expect([...prs.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Share preview']);
    expect(el.textContent).toContain('Share any PR by hand from this workstream\'s PRs above.');
  });

  it('says when the workstream has no PR to share, and lists none with PR link shares off', async () => {
    act(() => root.render(<ShareTab projectId="p1" workstream="feature-x" />));
    await flush();
    expect(el.textContent).toContain('No open PR of yours from this workstream.');
    act(() => root.unmount());
    root = createRoot(el);
    mocks.flags = { 'browser-pane-preview-share-enabled': true };
    mocks.prs.list.mockClear();
    act(() => root.render(<ShareTab projectId="p1" workstream="feature-x" />));
    await flush();
    expect(el.querySelector('[aria-label="This workstream\'s PRs"]')).toBeNull();
    expect(mocks.prs.list).not.toHaveBeenCalled();
  });

  it('lists a PR share made from its row, keeps the row through other list changes, and offers it again once the list stops it', async () => {
    const linkShare = {
      id: 'l1', workstream: 'feature-x', audience: 'link', pr: { repo: 'example-org/webapp', number: 42, url: 'https://github.com/example-org/webapp/pull/42' },
      grantee: null, viewers: [], linkPath: '/p/tok', recipe: { kind: 'webapp-dev-stack' }, expiresAt: new Date(Date.now() + 86400e3).toISOString(),
      revokedAt: null, endedAt: null, endedReason: null, lastOpenedAt: null, createdAt: new Date().toISOString(), liveViewers: 0, blockedOrigins: [],
    };
    mocks.prs.list.mockResolvedValue(pipeline([row()]));
    mocks.shares.createLink.mockResolvedValue({ id: 'l1', link: '', linkPath: '/p/tok', expiresAt: '', existing: false, pr: linkShare.pr, comment: { state: 'posted', url: null } });
    act(() => root.render(<ShareTab projectId="p1" workstream="feature-x" />));
    await flush();
    expect(el.textContent).toContain('Not shared with anyone yet.');
    mocks.shares.list.mockResolvedValue([linkShare]);
    const button = (text: string) => [...el.querySelectorAll('button')].find(b => b.textContent === text) as HTMLButtonElement;
    await act(async () => { button('Share preview').click(); await new Promise(r => setTimeout(r, 0)); });
    await flush();
    expect(mocks.shares.createLink).toHaveBeenCalledWith('p1', { workstream: 'feature-x', repo: 'example-org/webapp', number: 42 });
    expect(el.querySelectorAll('.share-dialog-row')).toHaveLength(1);
    expect(el.querySelector('.share-dialog-row')?.textContent).toContain('webapp#42');
    expect(button('Share preview')).toBeUndefined();

    // A person share made in the list leaves the PR's row as it is.
    mocks.shares.create.mockResolvedValue({ id: 'p1share', expiresAt: '', link: '/p/p1share', ttlHours: 24 });
    const email = el.querySelector('input[type=email]') as HTMLInputElement;
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(email, 'gus@x.test'); email.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { (el.querySelector('form') as HTMLFormElement).requestSubmit(); await new Promise(r => setTimeout(r, 0)); });
    await flush();
    expect(mocks.shares.create).toHaveBeenCalled();
    expect(button('Share preview')).toBeUndefined();
    expect(el.querySelector('.chat-side-share-pr')?.textContent).toContain('Copy link');

    mocks.shares.list.mockResolvedValue([]);
    await act(async () => { (el.querySelector('.share-dialog-row .btn-danger') as HTMLButtonElement).click(); await new Promise(r => setTimeout(r, 0)); });
    await flush();
    expect(mocks.shares.revoke).toHaveBeenCalledWith('p1', 'l1');
    expect(el.textContent).toContain('Not shared with anyone yet.');
    expect(button('Share preview')).toBeDefined();
  });
});
