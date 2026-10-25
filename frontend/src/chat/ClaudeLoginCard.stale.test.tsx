// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const status = vi.fn();
const start = vi.fn();
const submit = vi.fn();
const cancel = vi.fn();
vi.mock('../services/api', () => ({
  claudeLoginApi: {
    status: (...args: unknown[]) => status(...args),
    start: (...args: unknown[]) => start(...args),
    submit: (...args: unknown[]) => submit(...args),
    cancel: (...args: unknown[]) => cancel(...args),
  },
}));

import { ClaudeLoginCard } from './ClaudeLoginCard';

function view(phase: string, extra: Record<string, unknown> = {}) {
  return { loggedIn: phase === 'ready', authMethod: phase === 'ready' ? 'claude.ai' : 'none', phase, ...extra };
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  status.mockReset();
  start.mockReset();
  submit.mockReset();
  cancel.mockReset();
  status.mockResolvedValue(view('needed'));
  cancel.mockResolvedValue(view('needed'));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe('ClaudeLoginCard after a chat switch', () => {
  it('ignores a start that settles after the chat changed', async () => {
    let resolveStart!: (value: ReturnType<typeof view>) => void;
    start.mockImplementationOnce(() => new Promise(resolve => { resolveStart = resolve; }));

    await act(async () => root.render(<ClaudeLoginCard projectId="A" owner enabled />));
    await flush();
    expect(host.textContent).toMatch(/Sign in to Claude Enterprise/);

    const button = [...host.querySelectorAll('button')].find(b => b.textContent === 'Sign in');
    expect(button).toBeTruthy();
    await act(async () => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(start).toHaveBeenCalledWith('A');

    await act(async () => root.render(<ClaudeLoginCard projectId="B" owner enabled />));
    expect(cancel).toHaveBeenCalledWith('A');
    expect(cancel).not.toHaveBeenCalledWith('B');
    await flush();
    expect(host.textContent).toMatch(/Sign in to Claude Enterprise/);
    expect(host.textContent).not.toMatch(/Signed in to Claude/);

    await act(async () => { resolveStart(view('ready')); });
    await flush();
    expect(host.textContent).toMatch(/Sign in to Claude Enterprise/);
    expect(host.textContent).not.toMatch(/Signed in to Claude/);
  });

  it('loads the new chat after a switch instead of keeping the old signed-in view', async () => {
    status
      .mockResolvedValueOnce(view('ready'))
      .mockResolvedValue(view('needed'));

    await act(async () => root.render(<ClaudeLoginCard projectId="A" owner enabled />));
    await flush();
    // ready + not engaged → card hidden
    expect(host.querySelector('[data-mode]')).toBeNull();

    await act(async () => root.render(<ClaudeLoginCard projectId="B" owner enabled />));
    await flush();
    expect(host.textContent).toMatch(/Sign in to Claude Enterprise/);
  });
});
