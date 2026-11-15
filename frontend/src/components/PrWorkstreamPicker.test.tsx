// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrCheckout, PrRow } from '../services/api';
import type { Instance, Project } from '../types';
import { PrWorkstreamPicker } from './PrWorkstreamPicker';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  newWorkstream: vi.fn(),
  getBox: vi.fn(),
  startBox: vi.fn(),
  reloadBoxes: vi.fn(async () => {}),
  boxes: [] as Instance[],
  listeners: new Set<() => void>(),
}));
vi.mock('../services/api', () => ({
  prsApi: { link: vi.fn(), unlink: vi.fn(), newWorkstream: mocks.newWorkstream },
  projectsApi: { list: mocks.list },
  instancesApi: { get: mocks.getBox, start: mocks.startBox },
}));
vi.mock('../services/boxFeed', () => ({
  boxFeed: {
    subscribe: (fn: () => void) => { mocks.listeners.add(fn); return () => { mocks.listeners.delete(fn); }; },
    getSnapshot: () => mocks.boxes,
    reload: mocks.reloadBoxes,
  },
}));
vi.mock('../contexts/ProjectContext', () => ({
  useProjects: () => ({ reloadProjects: vi.fn(async () => {}), setActiveWorkstream: vi.fn() }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout: the picker keeps its highlighted row in view.
Element.prototype.scrollIntoView = () => {};

const project = (id: string, name: string, instanceId: string | null = null) => ({
  id, name, archived: false, kind: 'normal', role: 'owner', instanceId,
  lastActiveAt: '2026-10-24T00:00:00Z',
  workstreams: [{ name: 'main', archived: false, lastActiveAt: '2026-10-24T00:00:00Z' }],
}) as unknown as Project;

const box = (status: Instance['status']) => ({
  id: 'box-1', name: 'dev01', kind: 'ec2', status, createdAt: '2026-10-01T00:00:00.000Z',
}) as Instance;

const row = {
  kind: 'pr', lane: 'team_review', repo: 'example-org/terraform', number: 28576, headRefName: 'termag-agent-tunnel-bypass',
  workstream: null, linkedBy: null,
} as unknown as PrRow;

const TERRAFORM: PrCheckout[] = [{ projectId: 'p2', workstream: 'main', repo: 'example-org/terraform' }];

let root: Root | null = null;
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.boxes = [];
  mocks.listeners.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  mocks.list.mockResolvedValue([project('p1', 'termag'), project('p2', 'terraform', 'box-1')]);
  mocks.newWorkstream.mockResolvedValue({ id: 'w1', name: 'ws', branch: 'b' });
  mocks.startBox.mockResolvedValue({ ok: true, status: 'starting' });
  // The picker reads the box before deciding, then polls it while it comes up.
  mocks.getBox.mockResolvedValue(box('ready'));
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

async function openNewForm(checkouts: PrCheckout[], onError: (msg: string) => void = () => {}) {
  root = createRoot(host);
  await act(async () => {
    root!.render(<MemoryRouter><PrWorkstreamPicker row={row} checkouts={checkouts} onChanged={() => {}} onError={onError} /></MemoryRouter>);
  });
  await act(async () => { host.querySelector<HTMLButtonElement>('.prs-ws-pick button')!.click(); });
  await act(async () => { host.querySelector<HTMLButtonElement>('.prs-ws-new')!.click(); });
}

describe('New workstream for a PR', () => {
  it('warns when no project is known to be a checkout of the PR\'s repository', async () => {
    await openNewForm([{ projectId: 'p1', workstream: 'main', repo: 'example-org/termag' }]);
    expect(host.querySelector('[role="note"]')?.textContent)
      .toBe('No checkout of example-org/terraform known: pick a project on example-org/terraform, or make one (or un-archive it) first.');
  });
  it('offers only the checkout of the repository, without a warning, once one is known', async () => {
    await openNewForm([
      { projectId: 'p1', workstream: 'main', repo: 'example-org/termag' },
      { projectId: 'p2', workstream: 'main', repo: 'example-org/terraform' },
    ]);
    expect(host.querySelector('[role="note"]')).toBeNull();
    expect(host.querySelector('.prs-ws-scope')?.textContent).toBe('in terraform');
  });

  it('starts a stopped box and waits for its agent before making the workstream', async () => {
    mocks.boxes = [box('stopped')];
    mocks.getBox.mockResolvedValueOnce(box('stopped')).mockResolvedValue(box('ready'));
    vi.useFakeTimers();
    try {
      await openNewForm(TERRAFORM);
      await act(async () => { host.querySelector<HTMLButtonElement>('.prs-ws-actions .btn-primary')!.click(); });
      // The form says what the box is doing while it waits.
      expect(host.textContent).toContain('Starting dev01… the workstream is created once its agent connects.');
      // The picker waits 3 s between polls for the box's agent to connect.
      await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
    } finally {
      vi.useRealTimers();
    }
    expect(mocks.startBox).toHaveBeenCalledWith('box-1', expect.any(Number));
    expect(mocks.getBox).toHaveBeenCalledWith('box-1', expect.any(Number));
    expect(mocks.newWorkstream).toHaveBeenCalledWith('example-org/terraform', 28576, 'p2', expect.any(String), expect.any(String));
    expect(mocks.startBox.mock.invocationCallOrder[0]).toBeLessThan(mocks.newWorkstream.mock.invocationCallOrder[0]);
  });

  it('does not make the workstream on a box that can never come up', async () => {
    mocks.boxes = [box('failed')];
    mocks.getBox.mockResolvedValue(box('failed'));
    const onError = vi.fn();
    await openNewForm(TERRAFORM, onError);
    await act(async () => { host.querySelector<HTMLButtonElement>('.prs-ws-actions .btn-primary')!.click(); });
    expect(onError).toHaveBeenCalledWith('dev01 is failed; a workstream cannot be made on it.');
    expect(mocks.startBox).not.toHaveBeenCalled();
    expect(mocks.newWorkstream).not.toHaveBeenCalled();
  });

  it('makes the workstream without waiting on a box that is already ready', async () => {
    mocks.boxes = [box('ready')];
    await openNewForm(TERRAFORM);
    await act(async () => { host.querySelector<HTMLButtonElement>('.prs-ws-actions .btn-primary')!.click(); });
    expect(mocks.startBox).not.toHaveBeenCalled();
    expect(mocks.newWorkstream).toHaveBeenCalled();
  });

  it('starts a box the feed still calls ready but that was stopped elsewhere', async () => {
    // The feed stops polling once every box settles: its "ready" can be old.
    mocks.boxes = [box('ready')];
    mocks.getBox.mockResolvedValueOnce(box('stopped')).mockResolvedValue(box('ready'));
    vi.useFakeTimers();
    try {
      await openNewForm(TERRAFORM);
      await act(async () => { host.querySelector<HTMLButtonElement>('.prs-ws-actions .btn-primary')!.click(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
    } finally {
      vi.useRealTimers();
    }
    expect(mocks.startBox).toHaveBeenCalledWith('box-1', expect.any(Number));
    expect(mocks.newWorkstream).toHaveBeenCalled();
  });

  it('does not start a box the feed still calls stopped but that is up', async () => {
    mocks.boxes = [box('stopped')];
    mocks.getBox.mockResolvedValue(box('ready'));
    await openNewForm(TERRAFORM);
    await act(async () => { host.querySelector<HTMLButtonElement>('.prs-ws-actions .btn-primary')!.click(); });
    expect(mocks.startBox).not.toHaveBeenCalled();
    expect(mocks.newWorkstream).toHaveBeenCalled();
  });

  it('never starts an external box, whose agent comes back with its machine', async () => {
    mocks.boxes = [{ ...box('stopped'), kind: 'external' }];
    await openNewForm(TERRAFORM);
    await act(async () => { host.querySelector<HTMLButtonElement>('.prs-ws-actions .btn-primary')!.click(); });
    expect(mocks.startBox).not.toHaveBeenCalled();
    expect(mocks.newWorkstream).toHaveBeenCalled();
  });

  it('falls back to the cached row when the box cannot be read before deciding', async () => {
    mocks.boxes = [box('stopped')];
    mocks.getBox
      .mockRejectedValueOnce(new Error('502'))
      .mockResolvedValueOnce(box('ready'));
    vi.useFakeTimers();
    try {
      await openNewForm(TERRAFORM);
      await act(async () => { host.querySelector<HTMLButtonElement>('.prs-ws-actions .btn-primary')!.click(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
    } finally {
      vi.useRealTimers();
    }
    expect(mocks.startBox).toHaveBeenCalledWith('box-1', expect.any(Number));
    expect(mocks.newWorkstream).toHaveBeenCalled();
  });

  it('goes straight to the create when the project\'s box is not one of the caller\'s', async () => {
    mocks.list.mockResolvedValue([project('p1', 'termag'), project('p2', 'terraform', 'box-other')]);
    await openNewForm(TERRAFORM);
    await act(async () => { host.querySelector<HTMLButtonElement>('.prs-ws-actions .btn-primary')!.click(); });
    expect(mocks.startBox).not.toHaveBeenCalled();
    expect(mocks.getBox).not.toHaveBeenCalled();
    expect(mocks.newWorkstream).toHaveBeenCalled();
  });
});
