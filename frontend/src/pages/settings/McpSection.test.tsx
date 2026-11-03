// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ list: vi.fn(), connectCatalog: vi.fn() }));
vi.mock('../../services/api', () => ({ mcpConnectorsApi: api }));
vi.mock('../../flags', async () => {
  const actual = await vi.importActual<typeof import('../../flags')>('../../flags');
  return { ...actual, useFlag: (key: string, fallback: unknown) => (key === actual.FLAGS.mcpBroker ? true : fallback) };
});

import { McpSection } from './McpSection';

const ACME = { name: 'acme', upstream: 'https://mcp.acme.example/mcp' };
const page = (over: object) => ({ available: true, storeAvailable: true, connectors: [], catalog: [], ...over });
const connector = {
  id: 'c1', name: 'acme', upstream: ACME.upstream, authType: 'oauth', headers: {}, secretNames: [], missingSecrets: [],
  brokerUrl: null, updatedAt: '2026-10-30T00:00:00Z', linkStatus: 'needs_link', linkError: null, oauth: null,
};
let root: Root;
let el: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const available = () => el.querySelector('[aria-label="Available to connect"]');

beforeEach(() => {
  api.list.mockReset();
  api.connectCatalog.mockReset();
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); });

describe('Settings → MCP catalog', () => {
  it('lists a catalog server under Available to connect, apart from Your servers', async () => {
    api.list.mockResolvedValue(page({ catalog: [ACME] }));
    act(() => root.render(<McpSection focus={false} search="" />));
    await flush();
    expect(available()?.textContent).toContain('acme');
    expect(el.textContent).toContain('Your servers');
    expect(el.textContent).toContain('No MCP servers yet.');
  });

  it('reloads after a Connect that made the connector but could not start sign-in, so the server moves to Your servers', async () => {
    api.list.mockResolvedValueOnce(page({ catalog: [ACME] }));
    // The connector now exists, not yet signed in to.
    api.list.mockResolvedValueOnce(page({ connectors: [connector] }));
    api.connectCatalog.mockRejectedValue({ response: { data: { error: 'the server refused client registration' } } });
    act(() => root.render(<McpSection focus={false} search="" />));
    await flush();
    const connect = [...available()!.querySelectorAll('button')].find(b => b.textContent === 'Connect')!;
    await act(async () => { connect.click(); });
    await flush();
    expect(api.connectCatalog).toHaveBeenCalledWith('acme');
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('the server refused client registration');
    expect(available()).toBeNull();
    const row = el.querySelector('.mcp-row');
    expect(row?.textContent).toContain('acme');
    expect(row?.textContent).toContain('not authed');
    expect([...row!.querySelectorAll('button')].map(b => b.textContent)).toContain('Link');
  });
});
