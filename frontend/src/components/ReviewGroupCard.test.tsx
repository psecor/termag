// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrGroupMember, PrReviewGroup, PrRow } from '../services/api';
import { AddToGroup, ReviewGroupCard } from './ReviewGroupCard';

const api = vi.hoisted(() => ({
  createGroup: vi.fn(async () => ({ id: 'g9' })),
  updateGroup: vi.fn(async () => ({ ok: true })),
  setGroupMembers: vi.fn(async () => ({ ok: true })),
  deleteGroup: vi.fn(async () => undefined),
}));
vi.mock('../services/api', () => ({ prsApi: api }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-10-24T12:00:00Z');
const row = (repo: string, number: number, over: Partial<PrRow> = {}): PrRow => ({
  kind: 'pr', lane: 'needs_my_review', repo, number, title: `T${number}`, url: `https://github.com/${repo}/pull/${number}`, author: 'dev',
  headRefName: 'b', baseRefName: 'main', at: null, badges: [], failingChecks: [], checksFailed: false, pendingChecks: [], waitingOn: [],
  blockedBy: null, mergedAt: null, mergeCommit: null, deploy: null, workstream: null, requestedAt: null, reviewTarget: null, ...over,
});
const member = (repo: string, number: number, over: Partial<PrGroupMember> = {}): PrGroupMember => ({
  repo, number, note: null, title: `T${number}`, url: `https://github.com/${repo}/pull/${number}`, author: 'dev', state: 'open',
  yourReview: null, askedYou: true, checked: false, row: row(repo, number), inLane: true, ...over,
});
const BRIDGE: PrReviewGroup = {
  id: 'g1', name: 'Desktop bridge', closedAt: null, createdAt: '2026-10-24T00:00:00Z', done: false,
  members: [
    member('example-org/termag', 646, { checked: true, askedYou: false, yourReview: 'APPROVED' }),
    member('example-org/terraform', 28576, { askedYou: false, note: 'merge after 646 is deployed', row: row('example-org/terraform', 28576, { lane: 'team_review', askedYou: false }), inLane: false }),
    member('example-org/termag', 647),
  ],
};

let root: Root | null = null;
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

function render(el: React.ReactElement) {
  root = createRoot(host);
  act(() => root!.render(el));
}
const button = (text: string | RegExp) => [...host.querySelectorAll('button')].find(b => (typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? '')))!;
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); };
const type = async (el: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('ReviewGroupCard', () => {
  it('lists the members in order with what each waits on, the first not checked off marked next', () => {
    render(<ReviewGroupCard group={BRIDGE} viewer="me" now={NOW} selectedKey={null} knownRepos={[]} onPick={vi.fn()} onChanged={vi.fn()} onError={vi.fn()} />);
    expect(host.querySelector('.prg-head')?.textContent).toContain('3 PRs · 2 repos · 2 of 3 to review');
    const items = [...host.querySelectorAll('.prg-member')];
    expect(items.map(i => i.querySelector('.prso-label')?.textContent)).toEqual(['termag#646', 'terraform#28576', 'termag#647']);
    expect(items.map(i => i.querySelector('.prg-mark')?.textContent)).toEqual(['✓', '→', '']);
    expect(items[0].querySelector('.prg-status')?.textContent).toBe('approved by you');
    expect(items[1].querySelector('.prg-status')?.textContent).toBe('by dev · not asked of you · merge after 646 is deployed');
    expect(items[2].querySelector('.prg-status')?.textContent).toBe('needs your review');
  });
  it('picks a member\'s row, and Review next picks the first one not checked off', async () => {
    const onPick = vi.fn();
    render(<ReviewGroupCard group={BRIDGE} viewer="me" now={NOW} selectedKey={null} knownRepos={[]} onPick={onPick} onChanged={vi.fn()} onError={vi.fn()} />);
    await click(button('Review next'));
    expect(onPick).toHaveBeenLastCalledWith(BRIDGE.members[1].row);
    await click(host.querySelectorAll('.prg-member')[2]);
    expect(onPick).toHaveBeenLastCalledWith(BRIDGE.members[2].row);
  });
  it('folds a done group to one line with Close group', async () => {
    const done = { ...BRIDGE, done: true, members: BRIDGE.members.map(m => ({ ...m, checked: true })) };
    const onChanged = vi.fn();
    render(<ReviewGroupCard group={done} viewer="me" now={NOW} selectedKey={null} knownRepos={[]} onPick={vi.fn()} onChanged={onChanged} onError={vi.fn()} />);
    expect(host.querySelector('.prg-members')).toBeNull();
    expect(host.querySelector('.prg-toggle')?.textContent).toContain('✓ Desktop bridge');
    expect(button('Review next')).toBeUndefined();
    await click(button('Close group'));
    expect(api.updateGroup).toHaveBeenCalledWith('g1', { closed: true });
    expect(onChanged).toHaveBeenCalled();
  });
  it('folds once its last member is checked off, and unfolds when one asks again (Bugbot)', () => {
    const props = { viewer: 'me', now: NOW, selectedKey: null, knownRepos: [], onPick: vi.fn(), onChanged: vi.fn(), onError: vi.fn() };
    render(<ReviewGroupCard group={BRIDGE} {...props} />);
    expect(host.querySelector('.prg-members')).not.toBeNull();
    const done = { ...BRIDGE, done: true, members: BRIDGE.members.map(m => ({ ...m, checked: true })) };
    act(() => root!.render(<ReviewGroupCard group={done} {...props} />));
    expect(host.querySelector('.prg-members')).toBeNull();
    act(() => root!.render(<ReviewGroupCard group={BRIDGE} {...props} />));
    expect(host.querySelector('.prg-members')).not.toBeNull();
  });
  it('edits: reorders, keeps a note, adds a PR, and saves only what changed', async () => {
    const onChanged = vi.fn();
    render(<ReviewGroupCard group={BRIDGE} viewer="me" now={NOW} selectedKey={null} knownRepos={['example-org/termag']} onPick={vi.fn()} onChanged={onChanged} onError={vi.fn()} />);
    await click(button('Edit…'));
    await click(host.querySelector('[aria-label="Move termag#647 up"]')!);
    await type(host.querySelector('[aria-label="Note for termag#646"]') as HTMLInputElement, 'the contract');
    await type(host.querySelector('[aria-label="Add a pull request"]') as HTMLInputElement, 'termag#648');
    await click(button('Add'));
    await click(button('Save'));
    expect(api.updateGroup).not.toHaveBeenCalled();
    expect(api.setGroupMembers).toHaveBeenCalledWith('g1', [
      { repo: 'example-org/termag', number: 646, note: 'the contract' },
      { repo: 'example-org/termag', number: 647, note: null },
      { repo: 'example-org/terraform', number: 28576, note: 'merge after 646 is deployed' },
      { repo: 'example-org/termag', number: 648, note: null },
    ]);
    expect(onChanged).toHaveBeenCalled();
    expect(host.querySelector('.prg-card.is-editing')).toBeNull();
  });
  it('renames without rewriting the members, refuses a PR it cannot read, and deletes after a confirm', async () => {
    render(<ReviewGroupCard group={BRIDGE} viewer="me" now={NOW} selectedKey={null} knownRepos={[]} onPick={vi.fn()} onChanged={vi.fn()} onError={vi.fn()} />);
    await click(button('Edit…'));
    await type(host.querySelector('[aria-label="Group name"]') as HTMLInputElement, 'Desktop bridge (Oct)');
    await type(host.querySelector('[aria-label="Add a pull request"]') as HTMLInputElement, '646');
    await click(button('Add'));
    expect(host.textContent).toContain('Type owner/name#N, name#N or paste the PR\'s URL.');
    await type(host.querySelector('[aria-label="Add a pull request"]') as HTMLInputElement, 'example-org/termag#646');
    await click(button('Add'));
    expect(host.textContent).toContain('It is in the group already.');
    await click(button('Save'));
    expect(api.updateGroup).toHaveBeenCalledWith('g1', { name: 'Desktop bridge (Oct)' });
    expect(api.setGroupMembers).not.toHaveBeenCalled();

    await click(button('Edit…'));
    await click(button('Delete group…'));
    expect(api.deleteGroup).not.toHaveBeenCalled();
    await click(button('Delete'));
    expect(api.deleteGroup).toHaveBeenCalledWith('g1');
  });
  it('shows a save that failed and stays in the editor', async () => {
    api.setGroupMembers.mockRejectedValueOnce(Object.assign(new Error('x'), { response: { data: { error: 'GitHub has no pull request o/r#1 that you can see.' } } }));
    const onError = vi.fn();
    render(<ReviewGroupCard group={BRIDGE} viewer="me" now={NOW} selectedKey={null} knownRepos={[]} onPick={vi.fn()} onChanged={vi.fn()} onError={onError} />);
    await click(button('Edit…'));
    await type(host.querySelector('[aria-label="Add a pull request"]') as HTMLInputElement, 'o/r#1');
    await click(button('Add'));
    await click(button('Save'));
    expect(onError).toHaveBeenLastCalledWith('GitHub has no pull request o/r#1 that you can see.');
    expect(host.querySelector('.prg-card.is-editing')).not.toBeNull();
  });
});

describe('AddToGroup', () => {
  const other: PrReviewGroup = { ...BRIDGE, id: 'g2', name: 'Infra', members: [member('example-org/terraform', 28577)] };

  it('adds the shown PR at the end of a group, or starts a new one with it', async () => {
    const onChanged = vi.fn();
    render(<AddToGroup row={row('example-org/termag', 648)} groups={[BRIDGE, other]} onChanged={onChanged} onError={vi.fn()} />);
    await click(button('Add to group…'));
    await click(button(/^Add to Infra/));
    expect(api.setGroupMembers).toHaveBeenCalledWith('g2', [
      { repo: 'example-org/terraform', number: 28577, note: null },
      { repo: 'example-org/termag', number: 648, note: null },
    ]);
    await click(button('Add to group…'));
    await type(host.querySelector('[aria-label="New group name"]') as HTMLInputElement, ' Desktop app ');
    await click(button('New group'));
    expect(api.createGroup).toHaveBeenCalledWith('Desktop app', [{ repo: 'example-org/termag', number: 648, note: null }]);
    expect(onChanged).toHaveBeenCalledTimes(2);
  });
  it('says where a grouped PR is, moves it, or takes it out', async () => {
    render(<AddToGroup row={row('Example-Org/Terraform', 28576)} groups={[BRIDGE, other]} onChanged={vi.fn()} onError={vi.fn()} />);
    expect(button('In Desktop bridge 2/3')).toBeDefined();
    await click(button('In Desktop bridge 2/3'));
    await click(button('Take it out of Desktop bridge'));
    expect(api.setGroupMembers).toHaveBeenCalledWith('g1', [
      { repo: 'example-org/termag', number: 646, note: null },
      { repo: 'example-org/termag', number: 647, note: null },
    ]);
    await click(button('In Desktop bridge 2/3'));
    expect(button(/^Move to Infra/)).toBeDefined();
  });
});
