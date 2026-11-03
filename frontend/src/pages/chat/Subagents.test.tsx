// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolItem } from '../../chat/toolRuns';
import type { SubagentView } from '../../chat/subagents';
import { ToolRun } from './ToolCards';
import { AgentsCardSection, AgentsDrawer, SubagentsContext, type SubagentsUi } from './Subagents';

const agentCall = (id: string, description: string, over: Partial<ToolItem> = {}): ToolItem => ({
  kind: 'tool', key: `tool:${id}`, id, name: 'Agent', input: { description, prompt: 'go', subagent_type: 'Explore' },
  inputJson: '', result: 'done', isError: false, done: true, ...over,
});
const bash: ToolItem = { kind: 'tool', key: 'tool:b', id: 'b', name: 'Bash', input: { command: 'ls' }, inputJson: '', result: 'ok', isError: false, done: true };
const view = (call: ToolItem, over: Partial<SubagentView> = {}): SubagentView => ({
  id: call.id, call, description: (call.input as { description: string }).description, agentType: 'Explore', prompt: 'go', background: false,
  status: 'done', step: null, tokens: 1200, toolUses: 2, durationMs: 4000, model: null, report: 'ok', agentId: `a${call.id}`, items: [],
  nested: { items: [], running: false }, ...over,
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); });

const rows = () => [...host.querySelectorAll('.agent-call')];

describe('an Agent call with subagents on', () => {
  const one = agentCall('1', 'Map the layout');
  const two = agentCall('2', 'Run the tests', { done: false, result: null });
  const ui = (open = vi.fn()): SubagentsUi => ({
    byId: new Map([[one.id, view(one)], [two.id, view(two, { status: 'running', durationMs: null })]]), open, shownId: '1',
  });

  it('is a row, shown with its run shut, saying where its subagent is', () => {
    act(() => root.render(<SubagentsContext.Provider value={ui()}><ToolRun runKey="run:1" tools={[one, two, bash]} /></SubagentsContext.Provider>));
    expect(rows().map(r => r.querySelector('.sdk-tool-intent')?.textContent)).toEqual(['Map the layout', 'Run the tests']);
    expect(rows()[0].textContent).toContain('finished in 4s');
    expect(rows()[0].getAttribute('data-shown')).toBe('true');
    expect(rows()[1].getAttribute('data-status')).toBe('running');
    // The run's other calls stay folded.
    expect(host.querySelector('.sdk-tool-detail')).toBeNull();
  });

  it('opens its subagent\'s tab', () => {
    const open = vi.fn();
    act(() => root.render(<SubagentsContext.Provider value={ui(open)}><ToolRun runKey="run:1" tools={[one, two]} /></SubagentsContext.Provider>));
    act(() => rows()[1].querySelector<HTMLButtonElement>('button')!.click());
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: '2', description: 'Run the tests' }));
  });

  it('is a tool card as before with them off', () => {
    act(() => root.render(<ToolRun runKey="run:1" tools={[one, two]} />));
    expect(rows()).toEqual([]);
  });
});

describe('the subagents kept in view', () => {
  const one = agentCall('1', 'Map the layout');
  const two = agentCall('2', 'Run the tests', { done: false, result: null });
  const list = [view(one, { report: '**2 entries** at the top level' }), view(two, { status: 'running', durationMs: 5000, step: 'Running npm test', report: null })];
  const ui = (open = vi.fn()): SubagentsUi => ({ byId: new Map(list.map(v => [v.id, v])), open, shownId: null });
  const names = () => [...host.querySelectorAll('.agent-row-name')].map(e => e.textContent);

  it('lead the context card: how they stand, each one\'s step or gist, and a click opens it', () => {
    const open = vi.fn();
    act(() => root.render(<AgentsCardSection list={list} ui={ui(open)} />));
    expect(host.querySelector('.ctx-heading')?.textContent).toBe('Agents1 running · 1 done');
    expect(names()).toEqual(['Map the layout', 'Run the tests']);
    expect([...host.querySelectorAll('.agent-row-sub')].map(e => e.textContent)).toEqual(['2 entries at the top level', 'Running npm test']);
    act(() => host.querySelectorAll<HTMLButtonElement>('.agent-row')[1].click());
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: '2' }));
  });

  it('are one line on the composer, which opens to their rows', () => {
    act(() => root.render(<AgentsDrawer list={list} ui={ui()} />));
    expect(host.querySelector('.agent-drawer-head')?.textContent).toContain('1 agent running');
    expect(host.querySelector('.agent-drawer-now')?.textContent).toBe('· Run the tests — Running npm test');
    expect(names()).toEqual([]);
    act(() => host.querySelector<HTMLButtonElement>('.agent-drawer-head')!.click());
    expect(names()).toEqual(['Map the layout', 'Run the tests']);
  });

  it('say how it went once all of them have ended', () => {
    act(() => root.render(<AgentsDrawer list={[list[0], { ...list[1], status: 'done', durationMs: 13_000 }]} ui={ui()} />));
    expect(host.querySelector('.agent-drawer-head')?.textContent).toContain('2 agents finished');
    expect(host.querySelector('.agent-drawer-now')?.textContent).toBe('· 13s for the longest');
  });

  it('are nothing with none to keep in view', () => {
    act(() => root.render(<><AgentsCardSection list={[]} ui={ui()} /><AgentsDrawer list={[]} ui={ui()} /></>));
    expect(host.innerHTML).toBe('');
  });
});
