// @vitest-environment jsdom
// The side panel's agent and ask tabs draw the Agent calls in their transcript
// as subagent rows, as the chat does, behind chat-nested-agents-enabled.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolItem } from '../../chat/toolRuns';
import type { SubagentView } from '../../chat/subagents';
import type { AskView } from '../../chat/asks';

const mocks = vi.hoisted(() => ({ on: true, subagent: vi.fn(), history: vi.fn() }));
vi.mock('../../flags', async importOriginal => {
  const actual = await importOriginal<typeof import('../../flags')>();
  return { ...actual, useFlag: <T,>(key: string, fallback: T) => (key === 'chat-nested-agents-enabled' || key === 'chat-subagents-enabled' ? mocks.on as T : fallback) };
});
vi.mock('../../services/api', () => ({ chatApi: { subagent: mocks.subagent, history: mocks.history } }));

import { AgentTab, tabSubagents } from './AgentTab';
import { fromHistory } from '../../chat/sdkChat';
import { AskTab } from './AskTab';
import { subagentStore } from '../../chat/subagentStore';
import { askStore, askTabId } from '../../chat/askStore';

const chat = 'p1|main';
const project = { id: 'p1', name: 'sample', workstreams: [{ id: 'w1', name: 'main' }], workflows: [] } as never;
const NAMES = ['Candidate A', 'Candidate B', 'Candidate C', 'Candidate D'];
// Four launched at once, each in the background, as one assistant message.
const fourAgents = [
  { type: 'user', message: { role: 'user', content: 'Try four candidates' } },
  { type: 'assistant', message: { role: 'assistant', content: NAMES.map((d, i) => ({ type: 'tool_use', id: `c${i}`, name: 'Agent', input: { description: d, prompt: 'go', run_in_background: true } })) } },
];
const parentCall: ToolItem = { kind: 'tool', key: 'tool:p', id: 'p', name: 'Agent', input: { description: 'Planner' }, inputJson: '', result: null, isError: false, done: false };
const parent: SubagentView = {
  id: 'p', call: parentCall, description: 'Planner', agentType: null, prompt: 'Try four candidates', background: true, status: 'running', step: null,
  tokens: null, toolUses: null, durationMs: null, model: null, report: null, agentId: 'a1', items: [], nested: { items: [], running: true },
};

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  root = createRoot(host);
  mocks.on = true;
  mocks.subagent.mockReset(); mocks.history.mockReset();
});
afterEach(() => { act(() => root.unmount()); subagentStore.publish(chat, null); askStore.publish(chat, null); });

const rows = () => [...host.querySelectorAll('.agent-call')];
const rowNames = () => rows().map(r => r.querySelector('.sdk-tool-intent')?.textContent);
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };
function Where() { const l = useLocation(); return <span className="where">{l.pathname}</span>; }

describe('an agent tab', () => {
  const render = async (openAgent = vi.fn()) => {
    mocks.subagent.mockResolvedValue({ agentId: 'a1', entries: fourAgents });
    subagentStore.publish(chat, [parent]);
    await act(async () => { root.render(<AgentTab project={project} workstream="main" agent={{ chat, id: 'p', title: 'Planner' }} openAgent={openAgent} />); });
    await flush();
    return openAgent;
  };

  it('shows each subagent its subagent started at once as a row of its own, running', async () => {
    await render();
    expect(rowNames()).toEqual(NAMES);
    expect(rows().map(r => r.getAttribute('data-status'))).toEqual(['running', 'running', 'running', 'running']);
    expect(host.textContent).not.toContain('running in background');
  });

  it('opens the tab of one that streamed, and can\'t open one the chat has no record of', async () => {
    const items = [{ ...parentCall, key: 'tool:c0', id: 'c0', input: { description: 'Candidate A', run_in_background: true } }];
    subagentStore.publish(chat, [{ ...parent, nested: { items, running: true } }]);
    mocks.subagent.mockResolvedValue({ agentId: 'a1', entries: fourAgents });
    const openAgent = vi.fn();
    await act(async () => { root.render(<AgentTab project={project} workstream="main" agent={{ chat, id: 'p', title: 'Planner' }} openAgent={openAgent} />); });
    await flush();
    const heads = host.querySelectorAll<HTMLButtonElement>('.agent-call-head');
    expect([...heads].map(h => h.disabled)).toEqual([false, true, true, true]);
    act(() => heads[0].click());
    expect(openAgent).toHaveBeenCalledWith({ chat, id: 'c0', title: 'Candidate A' });
  });

  it('draws them as plain tool cards with nested agents off', async () => {
    mocks.on = false;
    await render();
    expect(rows()).toHaveLength(0);
    expect(host.textContent).toContain('Candidate D');
  });
});

describe('tabSubagents', () => {
  it('takes the file\'s end for one that streamed without its result', () => {
    const items = [{ ...parentCall, key: 'tool:c0', id: 'c0', input: { description: 'Candidate A' } }];
    const file = fromHistory([...fourAgents, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c0', content: 'Picked A.' }] } }]);
    const { list, live } = tabSubagents({ ...parent, status: 'done', nested: { items, running: false } }, file);
    expect(list.find(v => v.id === 'c0')?.status).toBe('done');
    expect([...live]).toEqual(['c0']);
  });

  it('takes the file\'s end for one still running in what streamed', () => {
    const items = [{ ...parentCall, key: 'tool:c0', id: 'c0', input: { description: 'Candidate A' } }];
    const file = fromHistory([...fourAgents, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c0', content: 'Picked A.' }] } }]);
    const { list } = tabSubagents({ ...parent, status: 'running', nested: { items, running: true } }, file);
    expect(list.find(v => v.id === 'c0')?.status).toBe('done');
    expect(list.find(v => v.id === 'c1')?.status).toBe('running');
  });
});

describe('an ask tab', () => {
  const T1 = 'cmvtr5x6r0i0lafsfuclk9ed5';
  const view: AskView = {
    thread: T1, title: 'Pick a candidate', target: 'box-1/sample', chat: { projectId: 'p9', workstream: `ask-${T1}` },
    state: 'working', turns: 1, error: null, startedAt: new Date().toISOString(), completedAt: null,
    waiting: 'nobody', noWait: true, reply: 'pending', notice: 'none', prs: [], known: true,
  };

  it('shows the subagents its session started as rows, each opening that session', async () => {
    mocks.history.mockResolvedValue({ sessionId: 's1', running: true, entries: fourAgents });
    askStore.publish(chat, new Map([[T1, view]]));
    await act(async () => {
      root.render(<MemoryRouter initialEntries={['/start']}><Routes><Route path="*" element={<><Where /><AskTab project={project} workstream="main" agent={{ chat, id: askTabId(T1), title: view.title }} /></>} /></Routes></MemoryRouter>);
    });
    await flush();
    expect(rowNames()).toEqual(NAMES);
    act(() => host.querySelectorAll<HTMLButtonElement>('.agent-call-head')[2].click());
    expect(host.querySelector('.where')?.textContent).toContain('p9');
  });
});
