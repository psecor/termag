// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ list: vi.fn(), startOAuth: vi.fn(), pasteLinkAction: (id: string) => `/termag/api/mcp-connectors/${id}/oauth/paste` }));
vi.mock('../../services/api', () => ({ mcpConnectorsApi: api }));

import { McpSection } from './McpSection';

const CALLBACK = 'https://termag.example.test/termag/api/mcp-connectors/oauth/callback';
const REFUSED = "The server refused termag's redirect URI. An admin needs to allow-list it at the provider.";
const connector = (over: object) => ({
  id: 'c1', name: 'glean', upstream: 'https://acme-be.glean.com/mcp/default', authType: 'oauth', headers: {}, secretNames: [], missingSecrets: [],
  brokerUrl: null, updatedAt: '2026-11-04T00:00:00Z', linkStatus: 'needs_link', linkError: null, oauth: null, ...over,
});
let root: Root;
let el: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

beforeEach(() => {
  api.list.mockReset();
  api.startOAuth.mockReset();
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); vi.unstubAllGlobals(); });

async function render(connectors: object[]) {
  api.list.mockResolvedValue({ available: true, storeAvailable: true, connectors, catalog: [] });
  act(() => root.render(<McpSection focus={false} search="" />));
  await flush();
}

async function link(data: object) {
  api.startOAuth.mockRejectedValue({ response: { status: 400, data } });
  const button = [...el.querySelectorAll('button')].find(b => b.textContent === 'Link') as HTMLButtonElement;
  await act(async () => { button.click(); });
  await flush();
  return el.querySelector('.error-banner') as HTMLElement;
}

describe('Settings → MCP: termag\'s callback URL', () => {
  it('is not on a connector card, linked or not', async () => {
    await render([connector({ linkStatus: 'linked', oauth: { grantedScopes: [], requestedScopes: null, scopeChoice: null } }), connector({ id: 'c2' })]);
    expect(el.querySelector('.mcp-callback')).toBeNull();
    expect(el.textContent).not.toContain(CALLBACK);
  });

  it('is under the error when the server refused termag\'s redirect URI: the one line, then the URL', async () => {
    await render([connector({})]);
    const banner = await link({ error: REFUSED, redirectUri: CALLBACK });
    expect(banner.querySelector('.mcp-error-text')?.firstChild?.textContent).toBe(REFUSED);
    expect(banner.querySelector('.mcp-callback code')?.textContent).toBe(CALLBACK);
  });

  it('copies the URL, and says so', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await render([connector({})]);
    const banner = await link({ error: REFUSED, redirectUri: CALLBACK });
    const button = banner.querySelector('.mcp-callback button') as HTMLButtonElement;
    expect(button.textContent).toBe('Copy');
    await act(async () => { button.click(); });
    expect(writeText).toHaveBeenCalledWith(CALLBACK);
    expect(button.textContent).toBe('Copied');
  });

  it('is not under any other error', async () => {
    await render([connector({})]);
    const banner = await link({ error: 'client registration failed: bad grant_types' });
    expect(banner.textContent).toContain('client registration failed: bad grant_types');
    expect(banner.querySelector('.mcp-callback')).toBeNull();
  });
});
