// @vitest-environment jsdom
// usePaneSubagents reads a pane chat's subagents: on open, while its agent
// works or one runs, now and then while the box can't say, and never shows
// another chat's.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneSubagent, PaneSubagentsAnswer } from './paneSubagents';

const api = vi.hoisted(() => ({ paneSubagents: vi.fn() }));
vi.mock('../services/api', () => ({ chatApi: { paneSubagents: api.paneSubagents } }));

import { PANE_ALONGSIDE_POLL_MS, PANE_SUBAGENT_POLL_MS, PANE_SUBAGENT_RETRY_MS, usePaneSubagents } from './usePaneSubagents';

const sub = (finished: boolean): PaneSubagent => ({
  agentId: 'a1', toolUseId: 'toolu_01', agentType: null, description: 'Find flaky tests', background: false, model: null,
  finished, startedAt: '2026-11-05T16:41:00.000Z', updatedAt: '2026-11-05T16:41:30.000Z', prompt: null, report: null,
});
const answer = (subs: PaneSubagent[]): PaneSubagentsAnswer => ({ available: true, running: true, session: { sessionId: 's1', startedAt: 1 }, subagents: subs, alongside: [] });

let seen: ReturnType<typeof usePaneSubagents>[] = [];
function Probe({ working, project = 'p1', enabled = true }: { working: boolean; project?: string; enabled?: boolean }) {
  seen.push(usePaneSubagents(project, 'main', working, enabled));
  return null;
}

let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  api.paneSubagents.mockReset();
  seen = [];
  root = createRoot(document.createElement('div'));
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });

const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe('usePaneSubagents', () => {
  it('reads while the agent works, then once more when it stops, then once a minute', async () => {
    api.paneSubagents.mockResolvedValue(answer([sub(true)]));
    await act(async () => { root.render(<Probe working />); });
    await tick(PANE_SUBAGENT_POLL_MS * 2);
    expect(api.paneSubagents).toHaveBeenCalledTimes(3);
    expect(seen[seen.length - 1].views?.map(v => v.id)).toEqual(['toolu_01']);
    await act(async () => { root.render(<Probe working={false} />); });
    await tick(PANE_SUBAGENT_POLL_MS * 10);
    expect(api.paneSubagents).toHaveBeenCalledTimes(4);
    // Idle: a Claude started in another pane shows within a minute.
    await tick(PANE_SUBAGENT_RETRY_MS);
    expect(api.paneSubagents).toHaveBeenCalledTimes(5);
  });

  it('keeps reading while a subagent runs after the agent is idle', async () => {
    api.paneSubagents.mockResolvedValueOnce(answer([sub(false)])).mockResolvedValue(answer([sub(true)]));
    await act(async () => { root.render(<Probe working={false} />); });
    await tick(PANE_SUBAGENT_POLL_MS * 4);
    expect(api.paneSubagents).toHaveBeenCalledTimes(2);
    expect(seen[seen.length - 1].views?.[0].status).toBe('done');
  });

  it('degrades quietly: an agent to restart is none, read again now and then', async () => {
    api.paneSubagents.mockResolvedValue({ available: false, reason: 'outdated-agent' });
    await act(async () => { root.render(<Probe working={false} />); });
    await tick(0);
    expect(seen[seen.length - 1]).toEqual({ views: [], alongside: [], available: false });
    await tick(PANE_SUBAGENT_RETRY_MS);
    expect(api.paneSubagents).toHaveBeenCalledTimes(2);
  });

  it('is loading (null) until its first answer, and never shows another chat\'s', async () => {
    let answerP2: (v: PaneSubagentsAnswer) => void = () => {};
    api.paneSubagents.mockResolvedValueOnce(answer([sub(true)])).mockImplementationOnce(() => new Promise(r => { answerP2 = r; }));
    await act(async () => { root.render(<Probe working={false} />); });
    expect(seen[0].views).toBeNull();
    await tick(0);
    expect(seen[seen.length - 1].views?.length).toBe(1);
    await act(async () => { root.render(<Probe working={false} project="p2" />); });
    expect(seen[seen.length - 1].views).toBeNull();
    await act(async () => { answerP2(answer([])); });
    expect(seen[seen.length - 1].views).toEqual([]);
  });

  it('lists the sessions alongside, and keeps up with them every 15 s while idle', async () => {
    api.paneSubagents.mockResolvedValue({ ...answer([sub(true)]), alongside: [{ sessionId: '564dbd9a-9a7e-4a8e-834c-9f371ae79f76', startedAt: 1, updatedAt: null, title: 'Review the README' }] });
    await act(async () => { root.render(<Probe working={false} />); });
    await tick(0);
    expect(seen[seen.length - 1].alongside.map(v => v.description)).toEqual(['Review the README']);
    await tick(PANE_ALONGSIDE_POLL_MS * 2);
    expect(api.paneSubagents).toHaveBeenCalledTimes(3);
  });

  it('reads nothing while off', async () => {
    await act(async () => { root.render(<Probe working enabled={false} />); });
    await tick(PANE_SUBAGENT_POLL_MS * 3);
    expect(api.paneSubagents).not.toHaveBeenCalled();
    expect(seen[seen.length - 1].views).toEqual([]);
  });
});
