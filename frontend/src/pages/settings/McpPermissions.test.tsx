// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ list: vi.fn(), startOAuth: vi.fn(), pasteLinkAction: (id: string) => `/termag/api/mcp-connectors/${id}/oauth/paste` }));
vi.mock('../../services/api', () => ({ mcpConnectorsApi: api }));

import { McpSection } from './McpSection';

const scopes = Array.from({ length: 88 }, (_, i) => ({ name: `scope_${i}`, label: i === 0 ? 'Read dashboards' : `scope_${i}` }));
const connector = (oauth: object) => ({
  id: 'c1', name: 'datadog', upstream: 'https://mcp.datadoghq.com/v1/mcp', authType: 'oauth', headers: {}, secretNames: [], missingSecrets: [],
  brokerUrl: null, updatedAt: '2026-11-04T00:00:00Z', linkStatus: 'linked', linkError: null,
  oauth: { issuer: 'https://mcp.datadoghq.com', scopes: [], scopeChoice: null, requestedScopes: null, grantedScopes: null, ...oauth },
});
let root: Root;
let el: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

beforeEach(() => {
  api.list.mockReset();
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); });

async function render(c: object) {
  api.list.mockResolvedValue({ available: true, storeAvailable: true, connectors: [c], catalog: [] });
  act(() => root.render(<McpSection focus={false} search="" />));
  await flush();
}
const trigger = () => el.querySelector('.mcp-permissions-trigger') as HTMLButtonElement;
const listed = () => [...el.querySelectorAll('.mcp-permission-list li')].filter(li => !li.closest('[hidden]')).map(li => li.textContent);

describe('Settings → MCP: a linked connector\'s permissions', () => {
  it('is one collapsed line with the count of what was granted', async () => {
    await render(connector({ grantedScopes: scopes }));
    expect(trigger().textContent).toBe('88 permissions');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(listed()).toEqual([]);
  });

  it('lists each permission by its label when opened', async () => {
    await render(connector({ grantedScopes: scopes }));
    await act(async () => { trigger().click(); });
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(listed()).toHaveLength(88);
    expect(listed()[0]).toBe('Read dashboards');
  });

  it('says what was asked for when the server didn\'t say what it granted', async () => {
    await render(connector({ requestedScopes: [{ name: 'mcp_all', label: 'mcp_all' }] }));
    expect(trigger().textContent).toBe('1 permission requested');
  });
});
