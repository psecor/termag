// @vitest-environment jsdom
import React, { act } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ list: vi.fn(), connectCatalog: vi.fn(), startOAuth: vi.fn() }));
vi.mock('../../services/api', () => ({ mcpConnectorsApi: api }));

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
  api.startOAuth.mockReset();
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

  it('shows the connector name under a display name that differs from it, and names the tool prefix on hover', async () => {
    api.list.mockResolvedValue(page({
      connectors: [{ ...connector, name: 'claude-docs', displayName: 'Claude Docs' }],
      catalog: [{ ...ACME, label: 'Acme Cloud' }],
    }));
    act(() => root.render(<McpSection focus={false} search="" />));
    await flush();
    const mine = el.querySelector('.mcp-row')!;
    expect(mine.querySelector('.settings-row-name')?.textContent).toBe('Claude Docs');
    expect(mine.querySelector('.settings-row-name')?.getAttribute('title')).toBe('In tool names: mcp__claude-docs__…');
    expect(mine.querySelector('.mcp-row-connector-name')?.textContent).toBe('claude-docs');
    const offered = available()!.querySelector('.mcp-row')!;
    expect(offered.querySelector('.settings-row-name')?.textContent).toBe('Acme Cloud');
    expect(offered.querySelector('.settings-row-name')?.getAttribute('title')).toBe('In tool names: mcp__acme__…');
    expect(offered.querySelector('.mcp-row-connector-name')?.textContent).toBe('acme');
  });

  it('shows only the name when the display name is the connector name, keeping the tool prefix on hover', async () => {
    api.list.mockResolvedValue(page({
      connectors: [{ ...connector, name: 'figma', displayName: 'figma' }],
      catalog: [ACME],
    }));
    act(() => root.render(<McpSection focus={false} search="" />));
    await flush();
    const mine = el.querySelector('.mcp-row')!;
    expect(mine.querySelector('.settings-row-name')?.textContent).toBe('figma');
    expect(mine.querySelector('.settings-row-name')?.getAttribute('title')).toBe('In tool names: mcp__figma__…');
    expect(mine.querySelector('.mcp-row-connector-name')).toBeNull();
    const offered = available()!.querySelector('.mcp-row')!;
    expect(offered.querySelector('.settings-row-name')?.textContent).toBe('acme');
    expect(offered.querySelector('.settings-row-name')?.getAttribute('title')).toBe('In tool names: mcp__acme__…');
    expect(offered.querySelector('.mcp-row-connector-name')).toBeNull();
  });

  it("says an API provider (Google) is a REST API for a CLI, both offered and connected", async () => {
    api.list.mockResolvedValue(page({
      catalog: [{ name: 'google', upstream: 'https://www.googleapis.com', kind: 'api' }],
      connectors: [{ ...connector, id: 'c2', name: 'slack-api', kind: 'api' }],
    }));
    act(() => root.render(<McpSection focus={false} search="" />));
    await flush();
    expect(available()?.textContent).toContain('REST API for a CLI');
    expect(el.textContent).toContain('OAuth, REST API for a CLI (not an MCP server)');
  });

  it('gives an API provider\'s name no tool-prefix title, since it is not an MCP server on the box', async () => {
    api.list.mockResolvedValue(page({
      catalog: [{ name: 'google', upstream: 'https://www.googleapis.com', kind: 'api' }],
      connectors: [{ ...connector, id: 'c2', name: 'slack-api', displayName: 'slack-api', kind: 'api' }],
    }));
    act(() => root.render(<McpSection focus={false} search="" />));
    await flush();
    expect(el.querySelector('.mcp-row .settings-row-name')?.textContent).toBe('slack-api');
    expect(el.querySelector('.mcp-row .settings-row-name')?.hasAttribute('title')).toBe(false);
    expect(available()!.querySelector('.settings-row-name')?.hasAttribute('title')).toBe(false);
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
    expect(api.connectCatalog).toHaveBeenCalledWith('acme', { chooseScopes: true });
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('the server refused client registration');
    expect(available()).toBeNull();
    const row = el.querySelector('.mcp-row');
    expect(row?.textContent).toContain('acme');
    expect(row?.textContent).toContain('not authed');
    expect([...row!.querySelectorAll('button')].map(b => b.textContent)).toContain('Link');
  });
});

describe('Settings → MCP scope choice', () => {
  const opt = (name: string, label: string) => ({ name, label });
  const OPTIONS = [
    opt('search:read.public', 'Search messages in public channels'),
    opt('channels:history', 'Read public channel history'),
    opt('chat:write', 'Send messages'),
  ];
  const slack = (over: object = {}) => ({
    ...connector, id: 's1', name: 'slack', upstream: 'https://mcp.slack.com/mcp',
    oauth: { issuer: 'https://mcp.slack.com', scopes: OPTIONS.map(o => o.name), scopeChoice: { options: OPTIONS }, requestedScopes: null, grantedScopes: null },
    ...over,
  });
  const button = (root: ParentNode, text: string) => [...root.querySelectorAll('button')].find(b => b.textContent === text)!;
  const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement | null;
  const ticked = () => [...dialog()!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].filter(b => b.checked).map(b => b.value);
  let assign: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows the checklist on Link with nothing ticked, and signs in with only the ticked scopes', async () => {
    api.list.mockResolvedValue(page({ connectors: [slack()] }));
    api.startOAuth.mockResolvedValue('https://slack.com/oauth/v2_user/authorize?x=1');
    act(() => root.render(<McpSection focus={false} search="" />));
    await flush();
    await act(async () => { button(el, 'Link').click(); });
    expect(dialog()?.textContent).toContain('Send messages');
    expect(ticked()).toEqual([]);
    expect(button(dialog()!, 'Continue to sign in').disabled).toBe(true);
    expect(api.startOAuth).not.toHaveBeenCalled();

    // Ticked out of order; the request lists them in the server's order.
    for (const v of ['channels:history', 'search:read.public']) {
      await act(async () => { dialog()!.querySelector<HTMLInputElement>(`input[value="${v}"]`)!.click(); });
    }
    expect(button(dialog()!, 'Continue to sign in').disabled).toBe(false);
    await act(async () => { button(dialog()!, 'Continue to sign in').click(); });
    await flush();
    expect(api.startOAuth).toHaveBeenCalledWith('s1', ['search:read.public', 'channels:history']);
    expect(assign).toHaveBeenCalledWith('https://slack.com/oauth/v2_user/authorize?x=1');
  });

  it('ticks every scope with Select all and none with Clear, and Continue follows', async () => {
    api.list.mockResolvedValue(page({ connectors: [slack()] }));
    act(() => root.render(<McpSection focus={false} search="" />));
    await flush();
    await act(async () => { button(el, 'Link').click(); });
    expect(button(dialog()!, 'Clear').disabled).toBe(true);
    await act(async () => { button(dialog()!, 'Select all').click(); });
    expect(ticked()).toEqual(OPTIONS.map(o => o.name));
    expect(button(dialog()!, 'Select all').disabled).toBe(true);
    expect(button(dialog()!, 'Continue to sign in').disabled).toBe(false);
    await act(async () => { button(dialog()!, 'Clear').click(); });
    expect(ticked()).toEqual([]);
    expect(button(dialog()!, 'Continue to sign in').disabled).toBe(true);
  });

  it('scrolls only the scope list: Select all, Clear and the buttons sit outside it', async () => {
    api.list.mockResolvedValue(page({ connectors: [slack()] }));
    act(() => root.render(<McpSection focus={false} search="" />));
    await flush();
    await act(async () => { button(el, 'Link').click(); });
    const list = dialog()!.querySelector('.mcp-scope-list')!;
    expect(list.querySelectorAll('input[type="checkbox"]')).toHaveLength(OPTIONS.length);
    for (const b of ['Select all', 'Clear', 'Cancel', 'Continue to sign in']) expect(list.contains(button(dialog()!, b)), b).toBe(false);
    // jsdom does no layout, so the rule that makes it scroll is pinned from App.css.
    const css = readFileSync(join(__dirname, '../../App.css'), 'utf8');
    // The list takes its height and scroll from the shared .scroll-list (also New session's environment list).
    expect(list.classList.contains('scroll-list')).toBe(true);
    const rule = /^\.scroll-list \{([^}]*)\}/m.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/max-height: min\(40vh, 320px\)/);
    expect(rule).toMatch(/overflow-y: auto/);
  });

  it('shows what was granted on a linked row, and Change permissions opens with the current grant ticked', async () => {
    const granted = [{ name: 'search:read.public', label: 'Search messages in public channels' }];
    api.list.mockResolvedValue(page({ connectors: [slack({ linkStatus: 'linked', oauth: { ...slack().oauth, requestedScopes: [...granted, { name: 'chat:write', label: 'Send messages' }], grantedScopes: granted } })] }));
    act(() => root.render(<McpSection focus={false} search="" />));
    await flush();
    const row = el.querySelector('.mcp-row')!;
    expect(row.textContent).toContain('1 permission');
    expect([...row.querySelectorAll('button')].map(b => b.textContent)).not.toContain('Re-link');
    await act(async () => { button(row, 'Change permissions').click(); });
    // The grant, not the larger request.
    expect(ticked()).toEqual(['search:read.public']);
  });

  it('links a server with nothing to choose straight to its sign-in', async () => {
    api.list.mockResolvedValue(page({ connectors: [{ ...connector, oauth: { issuer: 'https://auth.example', scopes: [], scopeChoice: null, requestedScopes: null, grantedScopes: null } }] }));
    api.startOAuth.mockResolvedValue('https://auth.example/authorize');
    act(() => root.render(<McpSection focus={false} search="" />));
    await flush();
    await act(async () => { button(el, 'Link').click(); });
    await flush();
    expect(dialog()).toBeNull();
    expect(api.startOAuth).toHaveBeenCalledWith('c1', undefined);
    expect(assign).toHaveBeenCalledWith('https://auth.example/authorize');
  });

  it('frees Connect once the checklist is open, so a failed reload leaves it usable after Cancel', async () => {
    api.list.mockResolvedValueOnce(page({ catalog: [ACME] }));
    // The reload after Connect fails, so the catalog row stays where it was.
    api.list.mockRejectedValueOnce({ response: { data: { error: 'network down' } } });
    api.connectCatalog.mockResolvedValue({ id: 's1', authorizeUrl: null, connector: slack() });
    act(() => root.render(<McpSection focus={false} search="" />));
    await flush();
    await act(async () => { button(available()!, 'Connect').click(); });
    await flush();
    expect(dialog()).not.toBeNull();
    await act(async () => { button(dialog()!, 'Cancel').click(); });
    expect(dialog()).toBeNull();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('network down');
    expect(button(available()!, 'Connect').disabled).toBe(false);
  });

  it('asks a catalog connect to let the person choose, then shows the checklist for the connector it made', async () => {
    api.list.mockResolvedValueOnce(page({ catalog: [ACME] }));
    api.list.mockResolvedValue(page({ connectors: [slack()] }));
    api.connectCatalog.mockResolvedValue({ id: 's1', authorizeUrl: null, connector: slack() });
    act(() => root.render(<McpSection focus={false} search="" />));
    await flush();
    await act(async () => { button(available()!, 'Connect').click(); });
    await flush();
    expect(api.connectCatalog).toHaveBeenCalledWith('acme', { chooseScopes: true });
    expect(dialog()?.textContent).toContain('Read public channel history');
    expect(assign).not.toHaveBeenCalled();
  });
});
