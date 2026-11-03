// @vitest-environment jsdom
// Where termag opens, kept on the user.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ me: vi.fn(), updatePreferences: vi.fn() }));
vi.mock('../services/api', () => ({ authApi: { me: api.me, updatePreferences: api.updatePreferences } }));

import { AuthProvider, useAuth } from './AuthContext';
import { currentUiMode, recordUiMode, UI_MODE_KEY } from '../chat/uiMode';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const user = { id: 'u1', email: 'e2e@termag.local', displayName: 'E2E', unixUsername: 'e2e' };
let root: Root;
let host: HTMLDivElement;
let seen: ReturnType<typeof useAuth> | null = null;

function Probe() { seen = useAuth(); return null; }

async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<AuthProvider><Probe /></AuthProvider>); });
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  seen = null;
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

describe('where termag opens, kept on the user', () => {
  it('applies the kept choice to this browser before anything reads it', async () => {
    localStorage.setItem(UI_MODE_KEY, 'full');
    api.me.mockResolvedValue({ ...user, uiMode: 'simple' });
    await mount();
    expect(currentUiMode()).toBe('simple');
    expect(seen?.user?.uiMode).toBe('simple');
    expect(api.updatePreferences).not.toHaveBeenCalled();
  });

  it('keeps a new choice on the user once per change', async () => {
    api.me.mockResolvedValue({ ...user, uiMode: null });
    api.updatePreferences.mockImplementation(async (p: { uiMode: string }) => ({ ...user, uiMode: p.uiMode }));
    await mount();
    await act(async () => { recordUiMode('full'); });
    expect(api.updatePreferences).toHaveBeenCalledExactlyOnceWith({ uiMode: 'full' });
    await act(async () => { recordUiMode('full'); });
    expect(api.updatePreferences).toHaveBeenCalledTimes(1);
    await act(async () => { recordUiMode('simple'); });
    expect(api.updatePreferences).toHaveBeenLastCalledWith({ uiMode: 'simple' });
  });

  it('sends nothing while the server leaves the choice out (the flag is off)', async () => {
    localStorage.setItem(UI_MODE_KEY, 'simple');
    api.me.mockResolvedValue({ ...user });
    await mount();
    await act(async () => { recordUiMode('full'); });
    expect(api.updatePreferences).not.toHaveBeenCalled();
    expect(currentUiMode()).toBe('full');
  });
});
