// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider, edgeLogin, probeBackend } from '../contexts/ConnectionContext';
import { ConnectionOverlay } from './ConnectionOverlay';

// The real provider and overlay; only the network and the login navigation
// are stand-ins.
let root: Root;
let container: HTMLDivElement;
let login: ReturnType<typeof vi.spyOn>;

function edgeAnswers(status: number) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ type: 'basic', status })));
}
const title = () => document.querySelector('#connection-takeover-title')?.textContent;

beforeEach(async () => {
  login = vi.spyOn(edgeLogin, 'start').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ConnectionProvider><ConnectionOverlay /></ConnectionProvider>);
  });
});

afterEach(async () => {
  edgeAnswers(200);
  await act(async () => { await probeBackend(); });
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ConnectionOverlay on an expired edge session', () => {
  it('asks to sign in, and waits for the person at the tab before going to Okta', async () => {
    edgeAnswers(401);
    await act(async () => { await probeBackend(); });
    expect(title()).toBe('Signed out of termag');
    expect(login).not.toHaveBeenCalled();

    await act(async () => { window.dispatchEvent(new Event('pointerdown')); });
    expect(login).toHaveBeenCalledTimes(1);
  });

  it('a key press signs in too', async () => {
    edgeAnswers(401);
    await act(async () => { await probeBackend(); });
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })); });
    expect(login).toHaveBeenCalledTimes(1);
  });

  it('goes away without a login when the session is back (signed in from another tab)', async () => {
    edgeAnswers(401);
    await act(async () => { await probeBackend(); });
    edgeAnswers(200);
    await act(async () => { await probeBackend(); });
    expect(title()).toBeUndefined();
    await act(async () => { window.dispatchEvent(new Event('pointerdown')); });
    expect(login).not.toHaveBeenCalled();
  });
});
