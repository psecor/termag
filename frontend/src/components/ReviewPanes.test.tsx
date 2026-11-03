// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewPane } from '../utils/reviewPanes';

// The review docks and the Review button with several panes.
const api = vi.hoisted(() => ({ guess: vi.fn(), start: vi.fn(), stop: vi.fn(), seen: vi.fn() }));
vi.mock('../services/api', () => ({ reviewApi: api }));
vi.mock('./Terminal', () => ({
  Terminal: ({ sessionName, onFocus }: { sessionName: string; onFocus?: () => void }) =>
    <div data-testid="terminal" onClick={onFocus}>{sessionName}</div>,
}));

const { ReviewDock } = await import('./ReviewDock');
const { ReviewButton } = await import('./ReviewButton');

const T = 'https://github.com/example-org/termag/pull/';
const pane = (slot: number, pr: number, over: Partial<ReviewPane> = {}): ReviewPane => ({
  state: 'reviewing', pr, url: `${T}${pr}`, at: '2026-10-27T00:00:00Z', doneAt: null, seenAt: null,
  session: slot === 1 ? 'ada-termag-review' : `ada-termag-review-${slot}`, slot, ...over,
});

let root: Root | null = null;
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  api.seen.mockResolvedValue({ ok: true });
  api.stop.mockResolvedValue({ ok: true });
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
const button = (text: string | RegExp) => [...document.querySelectorAll('button')].find(b => (typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? '')));

describe('ReviewDock', () => {
  const dock = (p: ReviewPane, over: Partial<React.ComponentProps<typeof ReviewDock>> = {}) => (
    <ReviewDock projectId="p1" instanceId="box1" workstream="main" sessionName={p.session}
      status={{ alive: true, state: p.state, pr: p.pr, url: p.url, reviewer: null }} review={p}
      expanded={false} onToggle={vi.fn()} onStop={vi.fn()} {...over} />
  );
  it('names its PR with the repository, so panes on two repositories tell apart', () => {
    render(dock(pane(2, 28576, { url: 'https://github.com/example-org/terraform/pull/28576' })));
    expect(host.querySelector('.review-dock-pr')?.textContent).toBe('terraform#28576');
  });
  it('attaches its own session and marks that pane seen when its finished review is read', () => {
    render(dock(pane(3, 648, { state: 'done', doneAt: '2026-10-27T00:00:00Z' }), { expanded: true }));
    const term = host.querySelector<HTMLElement>('[data-testid="terminal"]')!;
    expect(term.textContent).toBe('ada-termag-review-3');
    act(() => term.click());
    expect(api.seen).toHaveBeenCalledWith('p1', 'main', 'ada-termag-review-3');
  });
  it('offers Collapse all only when asked to', () => {
    const onCollapseAll = vi.fn();
    render(<>{dock(pane(1, 646), { onCollapseAll })}{dock(pane(2, 647))}</>);
    expect([...host.querySelectorAll('button')].filter(b => b.textContent === 'Collapse all')).toHaveLength(1);
    act(() => button('Collapse all')!.click());
    expect(onCollapseAll).toHaveBeenCalled();
  });
});

describe('ReviewButton', () => {
  beforeEach(() => {
    api.guess.mockResolvedValue({ guess: { number: 700, source: 'gh', url: `${T}700` }, branch: 'b', ghError: null, repo: 'example-org/termag', repoKnown: true });
    api.start.mockResolvedValue({ ok: true, session: 'ada-termag-review-3', slot: 3, replaced: false, pr: 700, url: `${T}700`, startedAt: 'x' });
  });
  async function open(panes: ReviewPane[], parallel: boolean, onStarted = vi.fn()) {
    render(<ReviewButton projectId="p1" workstream="main" panes={panes} parallel={parallel} onStarted={onStarted} />);
    await act(async () => { (host.querySelector('.review-fab') as HTMLButtonElement).click(); });
    await act(async () => {});
    return onStarted;
  }
  const note = () => document.querySelector('.review-dialog-note')?.textContent ?? '';

  it('says it adds a pane beside the running ones, and hands the new pane\'s slot on', async () => {
    const onStarted = await open([pane(1, 646), pane(2, 647)], true);
    expect(note()).toContain('Adds a review pane beside the 2 running (3 of 8).');
    await act(async () => { button('Review PR #700')!.click(); });
    expect(onStarted).toHaveBeenCalledWith(expect.objectContaining({ session: 'ada-termag-review-3', slot: 3, pr: 700 }));
  });
  it('says it restarts the PR\'s own pane', async () => {
    await open([pane(1, 700), pane(2, 647)], true);
    expect(note()).toContain('Restarts the review of termag#700; the other 1 keeps running.');
  });
  it('with all 8 in use, says so and will not start', async () => {
    await open([1, 2, 3, 4, 5, 6, 7, 8].map(n => pane(n, 100 + n)), true);
    expect(note()).toContain('All 8 review panes are in use');
    expect(button('Review PR #700')?.disabled).toBe(true);
  });
  it('with the flag off, says the running review is replaced', async () => {
    await open([pane(1, 646)], false);
    expect(note()).toContain('The running review (termag#646) is replaced.');
  });
});
