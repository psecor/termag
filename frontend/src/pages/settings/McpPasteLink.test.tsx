// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  startOAuth: vi.fn(),
  pasteLinkAction: (id: string) => `/termag/api/mcp-connectors/${id}/oauth/paste`,
}));
vi.mock('../../services/api', () => ({ mcpConnectorsApi: api }));

import { McpSection } from './McpSection';

const connector = (over: object) => ({
  id: 'c1', name: 'newrelic', upstream: 'https://mcp.newrelic.com/mcp', authType: 'oauth', headers: {}, secretNames: [], missingSecrets: [],
  brokerUrl: null, updatedAt: '2026-11-04T00:00:00Z', linkStatus: 'needs_link', linkError: null, oauth: null, ...over,
});
const page = (connectors: object[]) => ({ available: true, storeAvailable: true, connectors, catalog: [] });
let root: Root;
let el: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

beforeEach(() => {
  api.list.mockReset();
  sessionStorage.clear();
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); });

async function render(connectors: object[]) {
  api.list.mockResolvedValue(page(connectors));
  act(() => root.render(<McpSection focus={false} search="" />));
  await flush();
}

describe('Settings → MCP paste box (mcp-oauth-loopback-servers)', () => {
  it('shows the explanation and a form that posts the pasted address for a listed server', async () => {
    await render([connector({ pasteLink: true })]);
    const form = el.querySelector('form.mcp-paste') as HTMLFormElement;
    expect(form).not.toBeNull();
    expect(form.method).toBe('post');
    expect(form.getAttribute('action')).toBe('/termag/api/mcp-connectors/c1/oauth/paste');
    expect(form.textContent).toContain("Sign in in the new tab. When it lands on a page that won't load, copy that page's address, close the tab and paste it here.");
    expect(form.querySelector('input[name="url"]')).not.toBeNull();
  });

  it('enables Finish linking only once something is pasted', async () => {
    await render([connector({ pasteLink: true })]);
    const input = el.querySelector('input[name="url"]') as HTMLInputElement;
    const button = el.querySelector('form.mcp-paste button[type="submit"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'http://localhost:53682/callback?code=x&state=y');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button.disabled).toBe(false);
  });

  it('shows no box on a linked server with no re-link open, nor on a server off the list', async () => {
    await render([connector({ pasteLink: true, linkStatus: 'linked' }), connector({ id: 'c2', name: 'linear', pasteLink: false })]);
    expect(el.querySelector('form.mcp-paste')).toBeNull();
    expect(el.textContent).not.toContain('Paste the sign-in address');
  });
});

describe('Link on a listed server opens the sign-in in a new tab', () => {
  const LOOPBACK_URL = `https://login.example.test/authorize?client_id=c&redirect_uri=${encodeURIComponent('http://localhost:53682/callback')}&state=s`;
  let assign: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    api.startOAuth.mockReset();
    // jsdom has no scrollIntoView; the paste box scrolls itself into view when a sign-in opens.
    Element.prototype.scrollIntoView = vi.fn();
    assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const clickLink = async () => {
    const link = [...el.querySelectorAll('button')].find(b => b.textContent === 'Link') as HTMLButtonElement;
    await act(async () => { link.click(); });
    await flush();
  };

  it('opens the new tab, keeps Settings, and frees the row', async () => {
    const tab = { opener: window as unknown };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as Window);
    api.startOAuth.mockResolvedValue(LOOPBACK_URL);
    await render([connector({ pasteLink: true })]);
    await clickLink();
    expect(open).toHaveBeenCalledWith(LOOPBACK_URL, '_blank');
    expect(tab.opener).toBeNull();
    expect(assign).not.toHaveBeenCalled();
    expect(el.querySelector('form.mcp-paste')).not.toBeNull();
    expect(el.querySelector('.mcp-paste-fallback')).toBeNull();
    const link = [...el.querySelectorAll('button')].find(b => b.textContent === 'Link') as HTMLButtonElement;
    expect(link.disabled).toBe(false);
  });

  it('shows a plain link to the sign-in page when the browser blocks the new tab', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    api.startOAuth.mockResolvedValue(LOOPBACK_URL);
    await render([connector({ pasteLink: true })]);
    await clickLink();
    const a = el.querySelector('.mcp-paste-fallback a') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe(LOOPBACK_URL);
    expect(a.target).toBe('_blank');
    expect(a.rel).toContain('noopener');
    expect(assign).not.toHaveBeenCalled();
  });

  it('shows the box on a linked server once its re-link is open', async () => {
    vi.spyOn(window, 'open').mockReturnValue({ opener: null } as Window);
    api.startOAuth.mockResolvedValue(LOOPBACK_URL);
    await render([connector({ pasteLink: true, linkStatus: 'linked' })]);
    expect(el.querySelector('form.mcp-paste')).toBeNull();
    const relink = [...el.querySelectorAll('button')].find(b => b.textContent === 'Re-link') as HTMLButtonElement;
    await act(async () => { relink.click(); });
    await flush();
    expect(el.querySelector('form.mcp-paste')?.getAttribute('action')).toContain('/c1/');
  });

  it('keeps a linked server\'s re-link box across a reload of Settings, until the server links', async () => {
    vi.spyOn(window, 'open').mockReturnValue({ opener: null } as Window);
    api.startOAuth.mockResolvedValue(LOOPBACK_URL);
    await render([connector({ pasteLink: true, linkStatus: 'linked' })]);
    const relink = [...el.querySelectorAll('button')].find(b => b.textContent === 'Re-link') as HTMLButtonElement;
    await act(async () => { relink.click(); });
    await flush();
    // A reload: a new page with nothing in React state.
    act(() => root.unmount());
    root = createRoot(el);
    await render([connector({ pasteLink: true, linkStatus: 'linked' })]);
    expect(el.querySelector('form.mcp-paste')?.getAttribute('action')).toContain('/c1/');
    // The paste's redirect back: ?server=c1&linked=1.
    act(() => root.unmount());
    root = createRoot(el);
    api.list.mockResolvedValue(page([connector({ pasteLink: true, linkStatus: 'linked' })]));
    act(() => root.render(<McpSection focus={false} search="?server=c1&linked=1" />));
    await flush();
    expect(el.querySelector('form.mcp-paste')).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it('leaves a normal server\'s Link as it was: the Settings tab goes to the sign-in page', async () => {
    const open = vi.spyOn(window, 'open');
    const NORMAL = 'https://auth.example.test/authorize?redirect_uri=https%3A%2F%2Ftermag.example.test%2Fcb';
    api.startOAuth.mockResolvedValue(NORMAL);
    await render([connector({ pasteLink: false })]);
    await clickLink();
    expect(assign).toHaveBeenCalledWith(NORMAL);
    expect(open).not.toHaveBeenCalled();
  });
});
