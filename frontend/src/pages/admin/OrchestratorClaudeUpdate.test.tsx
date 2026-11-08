// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SoftwareUpdateRun, ToolUpdatePreview } from '../../services/adminApi';

const updateTool = vi.hoisted(() => vi.fn());
vi.mock('../../services/adminApi', () => ({ adminApi: { updateTool } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { OrchestratorClaudeUpdate } = await import('./OrchestratorClaudeUpdate');

const preview = (over: Partial<ToolUpdatePreview> = {}): ToolUpdatePreview => ({
  hostKey: 'orchestrator', kind: 'orchestrator', connected: true, capable: true, current: '2.1.312', target: '2.1.316', floor: '2.1.308',
  liveSessions: 0, busySessions: 0, runInFlight: false, restarts: ['none'], floorOnly: false, nothingToDo: false, ...over,
});

let root: Root; let el: HTMLDivElement;
beforeEach(() => { el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el); });
afterEach(() => { act(() => root.unmount()); el.remove(); });
const render = (p: ToolUpdatePreview) => act(() => root.render(<OrchestratorClaudeUpdate preview={p} onRequested={() => {}} />));
const button = () => [...el.querySelectorAll('button')].find(b => b.textContent === 'Update Claude Code');

describe('the orchestrator row (orchestrator-claude-update-policy)', () => {
  it('offers the update to a pinned version', () => {
    render(preview());
    expect(button()).toBeDefined();
    expect(el.textContent).toContain('2.1.312 → 2.1.316');
  });

  it('with no pin and the host at or above the floor, says floor only and offers no update', () => {
    render(preview({ target: null, floorOnly: true, nothingToDo: true }));
    expect(button()).toBeUndefined();
    expect(el.textContent).toContain('Floor only: set a version in orchestrator-claude-update-policy to move it');
  });

  it('with no pin and the host below the floor, offers the floor', () => {
    render(preview({ current: '2.1.300', target: null, floorOnly: true, nothingToDo: false }));
    expect(button()).toBeDefined();
    expect(el.textContent).toContain('2.1.300 → 2.1.308');
    expect(el.textContent).toContain('brings it up to the floor 2.1.308 and no further');
  });
});

describe('the orchestrator row\'s line, following its run', () => {
  const run = (over: Partial<SoftwareUpdateRun>): SoftwareUpdateRun => ({
    id: 'orun1', hostKey: 'orchestrator', instanceId: null, component: 'claude', trigger: 'manual', requestedById: 'u1', restart: 'none', reason: null,
    status: 'requested', outcome: null, target: '2.1.316', fromVersion: null, toVersion: null, detail: null, sessions: null,
    requestedAt: '2026-10-30T11:00:00Z', startedAt: null, finishedAt: null, ...over,
  });
  it('says updating, then the outcome, and calls onRunEnded once', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    updateTool.mockResolvedValue({ runId: 'orun1', acknowledged: true });
    const ended = vi.fn();
    const at = (runs: SoftwareUpdateRun[], p = preview()) => act(() => root.render(<OrchestratorClaudeUpdate preview={p} runs={runs} onRequested={() => {}} onRunEnded={ended} />));
    await at([]);
    await act(async () => { button()!.click(); });
    expect(el.textContent).toContain('updating… (run orun1)');
    await at([run({ status: 'running' })]);
    expect(el.textContent).toContain('updating… (run orun1)');
    expect(ended).not.toHaveBeenCalled();
    // Once it is done the preview may have nothing left to do: the line stays.
    await at([run({ status: 'done', outcome: 'updated', fromVersion: '2.1.312', toVersion: '2.1.316' })], preview({ current: '2.1.316', target: null, floorOnly: true, nothingToDo: true }));
    expect(el.textContent).toContain('updated · 2.1.312 → 2.1.316 (run orun1)');
    expect(ended).toHaveBeenCalledTimes(1);
    // Pushed out of the list by newer runs: the line keeps the outcome (Bugbot on #1211).
    await at([run({ id: 'newer' })], preview({ current: '2.1.316', target: null, floorOnly: true, nothingToDo: true }));
    expect(el.textContent).toContain('updated · 2.1.312 → 2.1.316 (run orun1)');
    expect(ended).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
