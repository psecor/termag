// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolUpdatePreview } from '../../services/adminApi';

vi.mock('../../services/adminApi', () => ({ adminApi: { updateTool: vi.fn() } }));
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
