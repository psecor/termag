// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolItem } from '../../chat/toolRuns';
import type { SubagentView } from '../../chat/subagents';
import type { AskView, ChatAskThread } from '../../chat/asks';
import { applyEvent, emptyChat } from '../../chat/sdkChat';
import { AgentsCardSection, type SubagentsUi } from './Subagents';
import { AsksDrawer, AsksCardSection, type AsksUi } from './Asks';
import { useSessionAgents } from '../../chat/useSessionAgents';
import { nestedSubagents } from '../../chat/sessionAgents';

const mocks = vi.hoisted(() => ({ on: true, history: vi.fn(), asks: vi.fn(), paneSubagents: vi.fn() }));
vi.mock('../../flags', async importOriginal => {
  const actual = await importOriginal<typeof import('../../flags')>();
  return { ...actual, useFlag: <T,>(key: string, fallback: T) => (key === 'chat-nested-agents-enabled' ? mocks.on as T : fallback) };
});
vi.mock('../../services/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return { ...actual, chatApi: { ...actual.chatApi, history: mocks.history, asks: mocks.asks, paneSubagents: mocks.paneSubagents } };
});

const call = (id: string, description: string) => ({ type: 'tool_use', id, name: 'Agent', input: { description, prompt: 'go', subagent_type: 'general-purpose' } });

const outerCall: ToolItem = { kind: 'tool', key: 'tool:outer', id: 'outer', name: 'Agent', input: { description: 'Outer' }, inputJson: '', result: null, isError: false, done: false };
const nestedState = [
  { type: 'turn-start', text: 'go' },
  { type: 'assistant', message: { id: 'm1', content: [call('outer', 'Outer')] } },
  { type: 'assistant', parent_tool_use_id: 'outer', message: { id: 's1', content: [{ type: 'tool_use', id: 'inner', name: 'Agent', input: { description: 'Inner', prompt: 'go' } }] } },
].reduce(applyEvent, emptyChat);
const outer: SubagentView = {
  id: 'outer', call: outerCall, description: 'Outer', agentType: null, prompt: null, background: false, status: 'running', step: null,
  tokens: null, toolUses: null, durationMs: null, model: null, report: null, agentId: null,
  items: nestedState.subagents!.outer.chat.items, nested: { items: nestedState.subagents!.outer.chat.items, subagents: nestedState.subagents!.outer.chat.subagents, running: true },
};

const ask = (over: Partial<AskView> = {}): AskView => ({
  thread: 't1', title: 'FWR U2 round completion', target: 'box/p', chat: { projectId: 'p4', workstream: 'ask-t1' }, state: 'working', turns: 1, error: null,
  startedAt: new Date().toISOString(), completedAt: null, waiting: 'nobody', noWait: true, reply: 'pending', notice: 'none', prs: [], known: true, ...over,
});
const asksUi = (views: AskView[], open = vi.fn()): AsksUi => ({ calls: new Map(), byCall: new Map(), views: new Map(views.map(v => [v.thread, v])), open, shownThread: null, agent: 'Claude' });
const childThread: ChatAskThread = {
  id: 't2', title: 'Review the plan', target: 'box/p', chat: { projectId: 'p4', workstream: 'ask-t2' }, prs: [], createdAt: '2026-11-06T00:00:00Z',
  messages: [{ id: 'm2', hop: 2, status: 'working', queued: false, error: null, reply: 'pending', notice: 'none', supersededBy: null, publish: null, createdAt: '2026-11-06T00:00:00Z', startedAt: '2026-11-06T00:00:00Z', completedAt: null }],
};

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  root = createRoot(host);
  mocks.on = true;
  mocks.history.mockReset(); mocks.asks.mockReset(); mocks.paneSubagents.mockReset();
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });

const names = () => [...host.querySelectorAll('.agent-row-name')].map(e => e.textContent);
const nestedNames = () => [...host.querySelectorAll('.agent-row-children .agent-row-name')].map(e => e.textContent);
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };

describe('a subagent\'s own subagents in view', () => {
  const ui: SubagentsUi = { byId: new Map([['outer', outer]]), open: vi.fn(), shownId: null };

  it('sit under it, indented, and open their own tab', () => {
    const open = vi.fn();
    act(() => root.render(<AgentsCardSection list={[outer]} ui={{ ...ui, open }} />));
    expect(names()).toEqual(['Outer', 'Inner']);
    expect(nestedNames()).toEqual(['Inner']);
    act(() => host.querySelectorAll<HTMLButtonElement>('.agent-row-children .agent-row')[0].click());
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'inner' }));
  });

  it('are not shown with nested agents off', () => {
    mocks.on = false;
    act(() => root.render(<AgentsCardSection list={[outer]} ui={ui} />));
    expect(names()).toEqual(['Outer']);
  });
});

function Where() { const l = useLocation(); return <span className="where">{l.pathname + l.search}</span>; }

describe('what an ask\'s own session runs', () => {
  beforeEach(() => {
    mocks.history.mockImplementation((_p: string, ws: string) => Promise.resolve(ws === 'ask-t1' ? {
      sessionId: null, running: false,
      entries: [
        { type: 'user', uuid: 'u1', message: { role: 'user', content: 'build' } },
        { type: 'assistant', message: { id: 'm1', content: [call('f', 'FLASH candidate build U2'), call('k', 'KIMI candidate build U2')] } },
        { type: 'user', message: { role: 'user', content: [{ tool_use_id: 'k', type: 'tool_result', content: [{ type: 'text', text: 'done\nagentId: akimi' }] }] } },
      ],
    } : { sessionId: null, running: false, entries: [] }));
    mocks.asks.mockImplementation((_p: string, ws: string) => Promise.resolve({ threads: ws === 'ask-t1' ? [childThread] : [] }));
  });

  it('sits under its row: its subagents, then the asks it sent, and a row opens that session', async () => {
    act(() => root.render(
      <MemoryRouter initialEntries={['/chat/x']}>
        <Routes><Route path="*" element={<><AsksCardSection list={[ask()]} ui={asksUi([ask()])} /><Where /></>} /></Routes>
      </MemoryRouter>,
    ));
    await flush();
    expect(mocks.history).toHaveBeenCalledWith('p4', 'ask-t1');
    expect(mocks.asks).toHaveBeenCalledWith('p4', 'ask-t1', []);
    expect(names()).toEqual(['FWR U2 round completion', 'FLASH candidate build U2', 'KIMI candidate build U2', 'Review the plan']);
    // The nested ask's own session is read for what it runs, too.
    expect(mocks.history).toHaveBeenCalledWith('p4', 'ask-t2');
    act(() => host.querySelectorAll<HTMLButtonElement>('.agent-row-children .ask-row')[0].click());
    expect(host.querySelector('.where')?.textContent).toContain('ask-t2');
  });

  it('keeps what it read when a later read fails, and tries again', async () => {
    vi.useFakeTimers();
    act(() => root.render(<MemoryRouter><AsksCardSection list={[ask()]} ui={asksUi([ask()])} /></MemoryRouter>));
    await flush();
    expect(names()).toContain('FLASH candidate build U2');
    mocks.history.mockRejectedValue(new Error('box away'));
    mocks.asks.mockRejectedValue(new Error('box away'));
    await act(async () => { vi.advanceTimersByTime(5000); });
    await flush();
    expect(names()).toContain('FLASH candidate build U2');
    expect(names()).toContain('Review the plan');
    const calls = mocks.history.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(5000); });
    await flush();
    expect(mocks.history.mock.calls.length).toBeGreaterThan(calls);
  });

  it('reads nothing with nested agents off', async () => {
    mocks.on = false;
    act(() => root.render(<MemoryRouter><AsksDrawer list={[ask()]} ui={asksUi([ask()])} /></MemoryRouter>));
    await flush();
    expect(mocks.history).not.toHaveBeenCalled();
  });
});

describe('reading another session\'s agents again', () => {
  it('gives a subagent\'s own subagent\'s new status, though nothing else about it changed', async () => {
    vi.useFakeTimers();
    const started = [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'build' } },
      { type: 'assistant', message: { id: 'm1', content: [call('outer', 'Outer')] } },
      { type: 'assistant', parent_tool_use_id: 'outer', message: { id: 's1', content: [call('inner', 'Inner')] } },
      { type: 'system', subtype: 'task_started', task_id: 'ainner', tool_use_id: 'inner', description: 'Inner', task_type: 'local_agent', is_backgrounded: false },
    ];
    const ended = [...started, { type: 'user', parent_tool_use_id: 'outer', message: { role: 'user', content: [{ tool_use_id: 'inner', type: 'tool_result', content: [{ type: 'text', text: 'done' }] }] } }];
    mocks.history.mockResolvedValue({ sessionId: null, running: true, entries: started });
    mocks.asks.mockResolvedValue({ threads: [] });
    let seen: SubagentView[] = [];
    function Probe() { seen = useSessionAgents('p', 'main', 'claude-chat', true, true)?.subagents ?? []; return null; }
    const inner = () => nestedSubagents(seen[0]).map(v => v.status);
    act(() => root.render(<Probe />));
    await flush();
    const outerBefore = seen.map(v => v.status);
    expect(inner()).not.toEqual(['done']);
    mocks.history.mockResolvedValue({ sessionId: null, running: true, entries: ended });
    await act(async () => { vi.advanceTimersByTime(5000); });
    await flush();
    expect(seen.map(v => v.status)).toEqual(outerBefore);
    expect(inner()).toEqual(['done']);
  });

  it('keeps a pane chat\'s subagents when its box says it can\'t read them', async () => {
    vi.useFakeTimers();
    const sub = { agentId: 'a1', toolUseId: 't1', agentType: null, description: 'Pane helper', background: false, model: null, finished: false, startedAt: null, updatedAt: null, prompt: null, report: null };
    mocks.paneSubagents.mockResolvedValue({ available: true, running: true, session: { sessionId: 's', startedAt: null }, subagents: [sub], alongside: [] });
    mocks.asks.mockResolvedValue({ threads: [] });
    let seen: string[] | null = null;
    function Probe() { seen = useSessionAgents('p', 'main', 'claude', false, true)?.subagents.map(v => v.description) ?? null; return null; }
    act(() => root.render(<Probe />));
    await flush();
    expect(seen).toEqual(['Pane helper']);
    mocks.paneSubagents.mockResolvedValue({ available: false, reason: 'offline' });
    await act(async () => { vi.advanceTimersByTime(5000); });
    await flush();
    expect(seen).toEqual(['Pane helper']);
    const calls = mocks.paneSubagents.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(5000); });
    await flush();
    expect(mocks.paneSubagents.mock.calls.length).toBeGreaterThan(calls);
  });

  it('keeps what loaded when the session stops working and its next read fails', async () => {
    vi.useFakeTimers();
    const sub = { agentId: 'a1', toolUseId: 't1', agentType: null, description: 'Pane helper', background: false, model: null, finished: false, startedAt: null, updatedAt: null, prompt: null, report: null };
    mocks.paneSubagents.mockResolvedValue({ available: true, running: true, session: { sessionId: 's', startedAt: null }, subagents: [sub], alongside: [] });
    mocks.asks.mockResolvedValue({ threads: [] });
    let seen: string[] | null = null;
    function Probe({ working }: { working: boolean }) { seen = useSessionAgents('p', 'main', 'claude', working, true)?.subagents.map(v => v.description) ?? null; return null; }
    act(() => root.render(<Probe working />));
    await flush();
    expect(seen).toEqual(['Pane helper']);
    mocks.paneSubagents.mockResolvedValue({ available: false, reason: 'offline' });
    act(() => root.render(<Probe working={false} />));
    await flush();
    expect(seen).toEqual(['Pane helper']);
  });

  it('drops a pane chat\'s subagents when the session moves to a chat runner and that read fails', async () => {
    vi.useFakeTimers();
    const sub = { agentId: 'a1', toolUseId: 't1', agentType: null, description: 'Pane helper', background: false, model: null, finished: false, startedAt: null, updatedAt: null, prompt: null, report: null };
    mocks.paneSubagents.mockResolvedValue({ available: true, running: true, session: { sessionId: 's', startedAt: null }, subagents: [sub], alongside: [] });
    mocks.history.mockRejectedValue(new Error('offline'));
    mocks.asks.mockResolvedValue({ threads: [] });
    let seen: string[] | null = null;
    function Probe({ provider }: { provider: string }) { seen = useSessionAgents('p', 'main', provider, false, true)?.subagents.map(v => v.description) ?? null; return null; }
    act(() => root.render(<Probe provider="claude" />));
    await flush();
    expect(seen).toEqual(['Pane helper']);
    act(() => root.render(<Probe provider="claude-chat" />));
    await flush();
    expect(seen).toEqual([]);
  });

  it('drops one chat runner\'s subagents when the session moves to another and that read fails', async () => {
    vi.useFakeTimers();
    mocks.history.mockResolvedValue({ sessionId: null, running: false, entries: [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'build' } },
      { type: 'assistant', message: { id: 'm1', content: [call('outer', 'Outer')] } },
    ] });
    mocks.asks.mockResolvedValue({ threads: [] });
    let seen: string[] | null = null;
    function Probe({ provider }: { provider: string }) { seen = useSessionAgents('p', 'main', provider, false, true)?.subagents.map(v => v.description) ?? null; return null; }
    act(() => root.render(<Probe provider="claude-chat" />));
    await flush();
    expect(seen).toEqual(['Outer']);
    mocks.history.mockRejectedValue(new Error('offline'));
    act(() => root.render(<Probe provider="pi-chat" />));
    await flush();
    expect(seen).toEqual([]);
  });
});
