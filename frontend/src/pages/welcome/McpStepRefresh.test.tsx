// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ connectCatalog: vi.fn(), startOAuth: vi.fn(), pasteLinkAction: (id: string) => `/termag/api/mcp-connectors/${id}/oauth/paste` }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../../services/api', () => ({ mcpConnectorsApi: api }));

import { McpStepRefresh, usableMcpServer } from './McpStepRefresh';
import type { McpConnectorList } from '../../services/api';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});
// React Aria's Modal reads a CSP nonce through CSS.escape, which jsdom lacks.
const css = globalThis as { CSS?: { escape?: (s: string) => string } };
css.CSS ??= {};
css.CSS.escape ??= (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);
async function render(list: McpConnectorList | null, loadError = '', search = '') {
  await act(async () => { root.render(<McpStepRefresh list={list} loadError={loadError} search={search} onReload={() => {}} />); });
}
const list = (over: Partial<McpConnectorList> = {}) => ({ available: true, storeAvailable: true, connectors: [], catalog: [], ...over }) as McpConnectorList;

describe('McpStepRefresh', () => {
  it('says Loading until the list answers', async () => {
    await render(null);
    expect(container.textContent).toContain('Loading…');
  });

  it('warns when the orchestrator has no MCP broker', async () => {
    await render(list({ available: false, catalog: [{ name: 'acme', upstream: 'https://mcp.acme.example/mcp' }] }));
    expect(container.textContent).toContain("This orchestrator has no MCP broker, so boxes don't get these servers.");
  });

  it('turns Connect off when there is no credential store to keep a sign-in', async () => {
    await render(list({ storeAvailable: false, catalog: [{ name: 'acme', upstream: 'https://mcp.acme.example/mcp' }] }));
    const connect = [...container.querySelectorAll('button')].find(b => b.textContent === 'Connect')!;
    expect(connect.disabled || connect.getAttribute('aria-disabled') === 'true' || connect.hasAttribute('data-disabled')).toBe(true);
  });

  const needsLink = {
    id: 'c1', name: 'acme', displayName: 'acme', upstream: 'https://mcp.acme.example/mcp', authType: 'oauth',
    headers: {}, secretNames: [], missingSecrets: [], brokerUrl: null, updatedAt: '2026-11-09T00:00:00Z', linkStatus: 'needs_link',
  } as McpConnectorList['connectors'][number];
  const refused = { response: { data: { error: 'The server refused termag\'s redirect URI.', redirectUri: 'https://termag.example/termag/api/mcp-connectors/oauth/callback' } } };
  const press = async (label: string) => {
    const b = [...container.querySelectorAll('button')].find(x => x.textContent === label)!;
    await act(async () => { b.click(); });
  };

  it('shows the API\'s error and callback URL when Connect fails to start', async () => {
    api.startOAuth.mockRejectedValue(refused);
    await render(list({ connectors: [needsLink] }));
    await press('Connect');
    expect(container.textContent).toContain("The server refused termag's redirect URI.");
    expect(container.textContent).toContain('https://termag.example/termag/api/mcp-connectors/oauth/callback');
  });

  it('shows the API\'s error when Retry after a failed sign-in fails to start', async () => {
    api.startOAuth.mockRejectedValue(refused);
    await render(list({ connectors: [needsLink] }), '', '?step=mcp&server=c1&error=denied');
    await press('Retry');
    expect(container.textContent).toContain("The server refused termag's redirect URI.");
  });

  it('sends a static server that is missing a secret to Settings rather than calling it connected', async () => {
    const missing = { ...needsLink, authType: 'static', linkStatus: undefined, secretNames: ['token'], missingSecrets: ['token'] } as McpConnectorList['connectors'][number];
    await render(list({ connectors: [missing] }));
    const row = container.querySelector('.wel-tool')!;
    expect(row.textContent).not.toContain('Connected');
    expect(row.textContent).toContain('Finish in Settings');
  });

  it('counts only ready MCP servers as usable', () => {
    const base = { ...needsLink, linkStatus: 'linked' } as McpConnectorList['connectors'][number];
    expect(usableMcpServer(base)).toBe(true);
    expect(usableMcpServer({ ...base, linkStatus: 'needs_link' })).toBe(false);
    expect(usableMcpServer({ ...base, kind: 'api' })).toBe(false);
    expect(usableMcpServer({ ...base, authType: 'static', missingSecrets: ['token'] })).toBe(false);
    expect(usableMcpServer({ ...base, authType: 'static', secretNames: null })).toBe(false);
    expect(usableMcpServer({ ...base, authType: 'static' })).toBe(true);
    expect(usableMcpServer({ ...base, blocked: "This MCP server isn't on termag's allowlist" })).toBe(false);
  });

  it('shows the host, not the whole URL', async () => {
    await render(list({ catalog: [{ name: 'acme', upstream: 'https://mcp.acme.example/mcp' }] }));
    expect(container.querySelector('.wel-tool code')?.textContent).toBe('mcp.acme.example');
  });
});

describe('McpStepRefresh, every sign-in inline', () => {
  // jsdom has no layout: the paste field scrolls into view when a sign-in starts.
  beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
  type C = McpConnectorList['connectors'][number];
  const OPTIONS = [{ name: 'channels:read', label: 'Read channels' }, { name: 'chat:write', label: 'Post messages' }];
  const base = {
    id: 'c1', name: 'acme', displayName: 'acme', upstream: 'https://mcp.acme.example/mcp', authType: 'oauth',
    headers: {}, secretNames: [], missingSecrets: [], brokerUrl: null, updatedAt: '2026-11-10T00:00:00Z', linkStatus: 'needs_link',
  } as C;
  const choosy = (over: Partial<C> = {}) => ({
    ...base, ...over,
    oauth: { issuer: 'https://auth.acme.example', scopes: OPTIONS.map(o => o.name), scopeChoice: { options: OPTIONS }, requestedScopes: null, grantedScopes: null },
  }) as C;
  const LOOPBACK = 'https://auth.relic.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A53682%2Fcallback&state=s';
  const buttons = () => [...document.querySelectorAll('button')].map(b => b.textContent);
  const press = async (label: string) => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent === label)!;
    await act(async () => { b.click(); });
  };

  it('labels an unlinked server Connect, as a catalog server is', async () => {
    await render(list({ connectors: [base], catalog: [{ name: 'linear', upstream: 'https://mcp.linear.app/mcp' }] }));
    expect(buttons().filter(t => t === 'Connect')).toHaveLength(2);
    expect(buttons()).not.toContain('Sign in');
  });

  it('shows the paste box on the row for a localhost sign-in, posting back to the wizard', async () => {
    const open = vi.fn(() => ({ opener: {} }));
    vi.stubGlobal('open', open);
    api.startOAuth.mockResolvedValue(LOOPBACK);
    await render(list({ connectors: [{ ...base, pasteLink: true }] }));
    await press('Connect');
    expect(open).toHaveBeenCalledWith(LOOPBACK, '_blank');
    expect(api.startOAuth).toHaveBeenCalledWith('c1', undefined, 'welcome');
    const form = container.querySelector('.wel-tool form') as HTMLFormElement;
    expect(form.getAttribute('action')).toBe('/termag/api/mcp-connectors/c1/oauth/paste');
    expect(form.getAttribute('method')).toBe('post');
    expect((form.querySelector('input[name="returnTo"]') as HTMLInputElement).value).toBe('welcome');
    expect(form.querySelector('input[name="url"]')).not.toBeNull();
    expect(form.textContent).toContain('Sign in in the new tab, then paste the address of the page it ends on.');
    expect(buttons()).not.toContain('Finish in Settings');
  });

  it('moves focus to the paste field once Connect opens the localhost sign-in', async () => {
    vi.stubGlobal('open', vi.fn(() => ({ opener: {} })));
    api.startOAuth.mockResolvedValue(LOOPBACK);
    await render(list({ connectors: [{ ...base, pasteLink: true }] }));
    const field = container.querySelector('.wel-paste input[name="url"]');
    expect(field).not.toBeNull();
    expect(document.activeElement).not.toBe(field);
    await press('Connect');
    expect(document.activeElement).toBe(container.querySelector('.wel-paste input[name="url"]'));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('offers the sign-in page as a link when the browser blocks the new tab', async () => {
    vi.stubGlobal('open', vi.fn(() => null));
    api.startOAuth.mockResolvedValue(LOOPBACK);
    await render(list({ connectors: [{ ...base, pasteLink: true }] }));
    await press('Connect');
    const a = container.querySelector('.wel-tool form a') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe(LOOPBACK);
  });

  it('opens the scope checklist on Connect and signs in with only the ticked scopes', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    api.startOAuth.mockResolvedValue('https://auth.acme.example/authorize');
    await render(list({ connectors: [choosy()] }));
    await press('Connect');
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('What may agents do in acme?');
    expect([...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].filter(b => b.checked)).toHaveLength(0);
    await act(async () => { (dialog.querySelector('input[value="chat:write"]') as HTMLInputElement).click(); });
    await press('Continue');
    expect(api.startOAuth).toHaveBeenCalledWith('c1', ['chat:write'], 'welcome');
    expect(assign).toHaveBeenCalledWith('https://auth.acme.example/authorize');
  });

  it('offers Change permissions on a linked server with a choice of scopes', async () => {
    await render(list({ connectors: [choosy({ linkStatus: 'linked' })] }));
    expect(container.querySelector('.wel-tool')!.textContent).toContain('Connected');
    await press('Change permissions');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('What may agents do in acme?');
  });

  it('shows why the last sign-in failed on the row', async () => {
    await render(list({ connectors: [{ ...base, linkError: 'The sign-in expired.' }] }));
    expect(container.querySelector('.wel-tool')!.textContent).toContain('The sign-in expired.');
  });

  it('copies the callback URL under a refused redirect', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    api.startOAuth.mockRejectedValue({ response: { data: { error: 'Refused.', redirectUri: 'https://t.example/cb' } } });
    await render(list({ connectors: [base] }));
    await press('Connect');
    await press('Copy');
    expect(writeText).toHaveBeenCalledWith('https://t.example/cb');
    expect(buttons()).toContain('Copied');
  });
});
