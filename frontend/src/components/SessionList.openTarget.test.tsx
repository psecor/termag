// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { FOCUS_PANE_EVENT, type FocusPaneDetail, type WorkspaceTarget } from '../utils/workspaceTarget';

const projects = [{ id: 'p1', workstreams: [{ name: 'main' }, { name: 'feat' }] }];
vi.mock('../contexts/ProjectContext', () => ({
  useProjects: () => ({ projects, setActiveProject: vi.fn(), setActiveWorkstream: vi.fn() }),
}));
vi.mock('./BoxPill', () => ({ BoxPill: () => null }));

const { useOpenTarget } = await import('./SessionList');

/** The focus event useOpenTarget dispatches for a target. */
async function focusFor(t: WorkspaceTarget): Promise<FocusPaneDetail | null> {
  let open: ((t: WorkspaceTarget) => void) | null = null;
  function Probe() { open = useOpenTarget(); return null; }
  const root = createRoot(document.createElement('div'));
  act(() => root.render(<Probe />));
  let got: FocusPaneDetail | null = null;
  const on = (e: Event) => { got = (e as CustomEvent<FocusPaneDetail>).detail; };
  window.addEventListener(FOCUS_PANE_EVENT, on);
  open!(t);
  await new Promise(r => setTimeout(r, 0));
  window.removeEventListener(FOCUS_PANE_EVENT, on);
  act(() => root.unmount());
  return got;
}

describe('useOpenTarget: which review pane (docs/parallel-reviews.md, Bugbot and Devin on #786)', () => {
  it('opens the review pane a target names', async () => {
    expect(await focusFor({ kind: 'pane', projectId: 'p1', workstream: 'feat', pane: 'review', session: 'u-p-feat-review-3' }))
      .toEqual({ projectId: 'p1', workstream: 'feat', pane: 'review', session: 'u-p-feat-review-3' });
  });
  it('names none when the workstream is gone and main opens instead, or no pane was named', async () => {
    expect(await focusFor({ kind: 'pane', projectId: 'p1', workstream: 'gone', pane: 'review', session: 'u-p-gone-review-2' }))
      .toEqual({ projectId: 'p1', workstream: 'main', pane: 'review' });
    expect(await focusFor({ kind: 'pane', projectId: 'p1', workstream: 'main', pane: 'review' })).toEqual({ projectId: 'p1', workstream: 'main', pane: 'review' });
  });
});
