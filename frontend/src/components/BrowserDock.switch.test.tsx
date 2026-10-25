// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserDock } from './BrowserDock';

// The pane's effects want a socket and a resize observer; neither does
// anything here. The socket never opens, so the pane stays "starting".
class StillSocket { readyState = 0; onmessage: unknown = null; onclose: unknown = null; send() {} close() {} }
class StillObserver { observe() {} disconnect() {} }

let root: Root;
let host: HTMLDivElement;
const dock = (projectId: string) => <BrowserDock projectId={projectId} workstream="main" expanded onToggle={() => {}} />;
const urlField = () => host.querySelector<HTMLInputElement>('input[aria-label="URL"]')!;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('ResizeObserver', StillObserver);
  vi.stubGlobal('WebSocket', StillSocket);
  window.localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('BrowserDock across a project switch', () => {
  it('mounts the pane with the URL remembered for the project it shows, not the one it showed before', async () => {
    window.localStorage.setItem('termag.browserPane.url.pA/main', 'http://127.0.0.1:3000/');
    window.localStorage.setItem('termag.browserPane.url.pB/main', 'http://127.0.0.1:4000/');
    await act(async () => { root.render(dock('pA')); });
    expect(urlField().value).toBe('http://127.0.0.1:3000/');
    // The dock stays mounted; only its project changes. The new pane must dial pB's page.
    await act(async () => { root.render(dock('pB')); });
    expect(urlField().value).toBe('http://127.0.0.1:4000/');
    // A project with nothing remembered starts blank, whatever the previous one showed.
    await act(async () => { root.render(dock('pC')); });
    expect(urlField().value).toBe('');
  });
});
