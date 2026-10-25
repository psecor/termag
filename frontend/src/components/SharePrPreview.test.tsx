// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  api: { createLink: vi.fn(), revoke: vi.fn() },
}));
vi.mock('../flags', () => ({
  FLAGS: { previewShare: 'browser-pane-preview-share-enabled', prLinkShares: 'browser-pane-pr-link-shares-enabled' },
  useFlag: (key: string, fallback: boolean) => (key in mocks.flags ? mocks.flags[key] : fallback),
}));
vi.mock('../services/api', () => ({
  previewSharesApi: mocks.api,
  previewShareLink: (id: string, _at: string | null, linkPath?: string | null) => `https://termag.test/termag${linkPath ?? `/p/${id}`}`,
}));
vi.mock('../utils/prPipeline', () => ({ apiErrorText: (err: any, fallback: string) => err?.response?.data?.error ?? fallback }));

import { SharePrPreview } from './SharePrPreview';
import type { PrRow } from '../services/api';

const TOKEN = 'f'.repeat(32);
const row = (over: Partial<PrRow> = {}): PrRow => ({
  kind: 'pr', lane: 'needs_approval', repo: 'example-org/webapp', number: 42, title: 'x', url: 'https://github.com/example-org/webapp/pull/42',
  author: 'olive', headRefName: 'feat/x', baseRefName: 'main', at: null, badges: [], failingChecks: [], pendingChecks: [], waitingOn: [],
  blockedBy: null, mergedAt: null, mergeCommit: null, deploy: null, requestedAt: null, reviewTarget: null,
  workstream: { projectId: 'p1', projectName: 'webapp', workstream: 'feature-x' }, ...over,
});
const made = (over: Record<string, unknown> = {}) => ({
  id: 'clink00000000001', link: `https://termag.test/termag/p/${TOKEN}`, linkPath: `/p/${TOKEN}`, expiresAt: '', existing: false,
  pr: { repo: 'example-org/webapp', number: 42, url: '' }, comment: { state: 'posted', url: null }, ...over,
});

let root: Root;
let el: HTMLDivElement;
const writeText = vi.fn(async () => {});
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const button = (text: string) => [...el.querySelectorAll('button')].find(b => b.textContent === text);
function mount(r: PrRow) {
  act(() => root.render(<SharePrPreview row={r} />));
}

beforeEach(() => {
  mocks.flags = { 'browser-pane-preview-share-enabled': true, 'browser-pane-pr-link-shares-enabled': true };
  mocks.api.createLink.mockReset();
  mocks.api.revoke.mockReset();
  writeText.mockClear();
  Object.assign(navigator, { clipboard: { writeText } });
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); });

describe('Share preview in the PR overlay', () => {
  it('is offered only on an open PR of the viewer\'s own with a workstream, with both flags on', () => {
    mount(row());
    expect(button('Share preview')).toBeDefined();
    for (const r of [row({ lane: 'needs_my_review' }), row({ lane: 'merged' }), row({ workstream: null }), row({ kind: 'branch' }), row({ lane: 'checks', badges: ['draft'] })]) {
      mount(r);
      expect(button('Share preview'), r.lane).toBeUndefined();
    }
    mocks.flags['browser-pane-pr-link-shares-enabled'] = false;
    mount(row());
    expect(button('Share preview')).toBeUndefined();
  });

  it('shares the PR, copies its link, says it is on the PR, and can stop it', async () => {
    mocks.api.createLink.mockResolvedValue(made());
    mount(row());
    await act(async () => { button('Share preview')!.click(); });
    await flush();
    expect(mocks.api.createLink).toHaveBeenCalledWith('p1', { workstream: 'feature-x', repo: 'example-org/webapp', number: 42 });
    expect(writeText).toHaveBeenCalledWith(`https://termag.test/termag/p/${TOKEN}`);
    expect(el.textContent).toContain('Shared. Its link is posted on the PR and copied.');
    mocks.api.revoke.mockResolvedValue({ ok: true });
    await act(async () => { button('Stop sharing')!.click(); });
    await flush();
    expect(mocks.api.revoke).toHaveBeenCalledWith('p1', 'clink00000000001');
    expect(el.textContent).toContain('Stopped sharing');
    expect(button('Share preview')).toBeDefined();
  });

  it('says when it was shared already, and when the comment could not be posted', async () => {
    mocks.api.createLink.mockResolvedValueOnce(made({ existing: true, comment: { state: 'kept' } }));
    mount(row());
    await act(async () => { button('Share preview')!.click(); });
    await flush();
    expect(el.textContent).toContain('Already shared. Its link is on the PR and copied.');
    act(() => root.unmount());
    root = createRoot(el);
    mocks.api.createLink.mockResolvedValueOnce(made({ comment: { state: 'failed', error: 'Your GitHub token can\'t comment.' } }));
    mount(row());
    await act(async () => { button('Share preview')!.click(); });
    await flush();
    expect(el.textContent).toContain('Shared. Link copied. Your GitHub token can\'t comment.');
  });

  it('shows the server\'s reason for a PR it will not share', async () => {
    mocks.api.createLink.mockRejectedValue({ response: { data: { error: 'That pull request is a draft.' } } });
    mount(row());
    await act(async () => { button('Share preview')!.click(); });
    await flush();
    expect(el.querySelector('[role=alert]')?.textContent).toBe('That pull request is a draft.');
  });
});
