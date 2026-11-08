// @vitest-environment jsdom
// The agent tab for a pane chat's subagent: its transcript is read through the
// pane route, and it has no "Show in chat", as the pane has no row for it.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ subagent: vi.fn(), paneSubagent: vi.fn(), paneSession: vi.fn() }));
vi.mock('../../services/api', () => ({ chatApi: { subagent: api.subagent, paneSubagent: api.paneSubagent, paneSession: api.paneSession } }));

import { AgentTab } from './AgentTab';
import { subagentStore } from '../../chat/subagentStore';
import { paneAlongsideViews, paneSessionId, paneSubagentViews } from '../../chat/paneSubagents';

const chat = 'p1|main';
const project = { id: 'p1', name: 'sample', workstreams: [{ id: 'w1', name: 'main' }], workflows: [] } as never;
const [view] = paneSubagentViews([{
  agentId: 'ac9afc6661520867b', toolUseId: 'toolu_01', agentType: 'Explore', description: 'Find flaky tests', background: true, model: 'sonnet',
  finished: true, startedAt: '2026-11-05T16:41:00.000Z', updatedAt: '2026-11-05T16:42:30.000Z', prompt: 'Find the flaky tests', report: 'Two are flaky.',
}], true);

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  root = createRoot(host);
  vi.clearAllMocks();
  api.paneSubagent.mockResolvedValue({
    agentId: 'ac9afc6661520867b',
    entries: [
      { type: 'user', message: { role: 'user', content: 'Find the flaky tests' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Reading the CI history.' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Two are flaky.' }] } },
    ],
  });
});
afterEach(() => { act(() => root.unmount()); subagentStore.publish(chat, null); });

describe('the agent tab for a pane chat\'s subagent', () => {
  it('reads its transcript through the pane route, and has no Show in chat', async () => {
    subagentStore.publish(chat, [view]);
    await act(async () => { root.render(<AgentTab project={project} workstream="main" agent={{ chat, id: view.id, title: view.description }} />); });
    expect(api.paneSubagent).toHaveBeenCalledWith('p1', 'main', 'ac9afc6661520867b');
    expect(api.subagent).not.toHaveBeenCalled();
    expect(host.querySelector('.agent-panel-jump')).toBeNull();
    expect(host.querySelector('.agent-panel-title')?.textContent).toBe('Find flaky tests');
    expect(host.textContent).toContain('Reading the CI history.');
    expect(host.querySelector('.agent-result')?.textContent).toContain('Two are flaky.');
  });
});

describe('the tab of a session running alongside a pane chat\'s Claude', () => {
  const SID = '564dbd9a-9a7e-4a8e-834c-9f371ae79f76';
  const [side] = paneAlongsideViews([{ sessionId: SID, startedAt: Date.now() - 60_000, updatedAt: null, title: 'Review the README' }]);

  it('reads that session\'s own transcript, its first message kept', async () => {
    api.paneSession.mockResolvedValue({ sessionId: SID, entries: [
      { type: 'user', message: { role: 'user', content: 'Review the README' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Step 3 is stale.' }] } },
    ] });
    subagentStore.publish(chat, [side]);
    await act(async () => { root.render(<AgentTab project={project} workstream="main" agent={{ chat, id: side.id, title: side.description }} />); });
    expect(api.paneSession).toHaveBeenCalledWith('p1', 'main', SID);
    expect(api.paneSubagent).not.toHaveBeenCalled();
    expect(host.querySelector('.agent-panel-jump')).toBeNull();
    expect(host.querySelector('.agent-brief')).toBeNull();
    expect(host.textContent).toContain('Running alongside');
    expect(host.textContent).toContain('Review the README');
    expect(host.textContent).toContain('Step 3 is stale.');
  });

  it('says a session with nothing written yet has nothing to show, in words of its own', async () => {
    api.paneSession.mockRejectedValue({ response: { data: { code: 'session-missing' } } });
    subagentStore.publish(chat, [side]);
    await act(async () => { root.render(<AgentTab project={project} workstream="main" agent={{ chat, id: side.id, title: side.description }} />); });
    expect(host.querySelector('.agent-panel-note')?.textContent).toBe('This session has nothing written down yet.');
  });

  it('says so once the session is no longer running alongside', async () => {
    subagentStore.publish(chat, []);
    await act(async () => { root.render(<AgentTab project={project} workstream="main" agent={{ chat, id: paneSessionId(SID), title: 'Review the README' }} />); });
    expect(host.textContent).toContain('This session is no longer running alongside.');
  });
});
