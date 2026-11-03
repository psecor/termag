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

describe('ClaudeLoginCard after a turn failed on the sign-in', () => {
  it('asks the box again and offers a fresh sign-in even while Claude reads as signed in', async () => {
    status.mockResolvedValue(view('ready'));
    start.mockResolvedValue(view('needs-code', { url: 'https://claude.com/cai/oauth/authorize?code_challenge=x&login_method=sso' }));
    await act(async () => root.render(<ClaudeLoginCard projectId="A" owner enabled authFailure={null} />));
    await flush();
    expect(host.textContent).toBe('');
    expect(status).toHaveBeenCalledTimes(1);

    await act(async () => root.render(<ClaudeLoginCard projectId="A" owner enabled authFailure={7} />));
    await flush();
    expect(status).toHaveBeenCalledTimes(2);
    expect(host.querySelector('h2')?.textContent).toBe('Sign in to Claude Enterprise');
    expect(host.textContent).toMatch(/expired or was revoked/);

    const button = [...host.querySelectorAll('button')].find(b => b.textContent === 'Sign in')!;
    await act(async () => { button.click(); });
    await flush();
    expect(start).toHaveBeenCalledWith('A', { reauth: true });
    expect(host.querySelector('[data-mode="needs-code"]')).not.toBeNull();
  });

  it('leaves the box state to the chat when the chat already shows it', async () => {
    status.mockResolvedValue(view('offline'));
    await act(async () => root.render(<ClaudeLoginCard projectId="A" owner enabled box="stopped" hostShowsBox />));
    await flush();
    expect(host.textContent).toBe('');
    await act(async () => root.render(<ClaudeLoginCard projectId="A" owner enabled box="stopped" />));
    expect(host.querySelector('h2')?.textContent).toBe('Box is stopped');
  });
});
