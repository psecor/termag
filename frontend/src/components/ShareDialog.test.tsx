// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), extend: vi.fn(), revoke: vi.fn(), revokeViewer: vi.fn() }));
const usersApi = vi.hoisted(() => ({ search: vi.fn(async () => []) }));
vi.mock('../services/api', () => ({ previewSharesApi: api, usersApi, previewShareLink: (id: string, at?: string | null, linkPath?: string | null) => `https://termag.test/termag${linkPath ?? `/p/${id}`}${at ? `?at=${encodeURIComponent(at)}` : ''}` }));

import { ShareDialog } from './ShareDialog';

const share = (over: Record<string, unknown> = {}) => ({
  id: 's1', workstream: 'feature-x', grantee: { id: 'u2', email: 'gus@x.test', name: 'Gus' }, recipe: { kind: 'webapp-dev-stack' },
  expiresAt: new Date(Date.now() + 20 * 3600e3).toISOString(), revokedAt: null, endedAt: null, endedReason: null,
  lastOpenedAt: null, createdAt: new Date().toISOString(), liveViewers: 1, blockedOrigins: ['127.0.0.2:9000'], ...over,
});
let root: Root;
let el: HTMLDivElement;
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const writeText = vi.fn(async () => {});

function mount(atPath: string | null = null, defaultTtlHours = 24) {
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root.render(<ShareDialog projectId="p1" workstream="feature-x" defaultTtlHours={defaultTtlHours} atPath={atPath} onClose={() => {}} />));
}
const button = (text: string) => [...el.querySelectorAll('button')].find(b => b.textContent === text)!;
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  localStorage.clear();
  Object.assign(navigator, { clipboard: { writeText } });
  writeText.mockClear();
});
afterEach(() => { act(() => root.unmount()); el.remove(); });

describe('the share dialog', () => {
  it('lists this workstream\'s live shares: who, looking now, what their browser was refused', async () => {
    api.list.mockResolvedValue([share(), share({ id: 's2', workstream: 'other' }), share({ id: 's3', endedAt: new Date().toISOString() })]);
    mount();
    await flush();
    expect(el.querySelectorAll('.share-dialog-row')).toHaveLength(1);
    expect(el.textContent).toContain('Gus');
    expect(el.textContent).toContain('looking now');
    expect(el.textContent).toContain('127.0.0.2:9000');
  });

  it('shares with an email for the flag\'s default lifetime and copies the link', async () => {
    api.list.mockResolvedValue([]);
    api.create.mockResolvedValue({ id: 'snew', expiresAt: '', link: '/p/snew', ttlHours: 24 });
    mount();
    await flush();
    type(el.querySelector('input[type=email]') as HTMLInputElement, 'gus@x.test');
    await act(async () => { (el.querySelector('form') as HTMLFormElement).requestSubmit(); await new Promise(r => setTimeout(r, 0)); });
    expect(api.create).toHaveBeenCalledWith('p1', { email: 'gus@x.test', workstream: 'feature-x', ttlHours: 24 });
    expect(writeText).toHaveBeenCalledWith('https://termag.test/termag/p/snew');
    // Remembered in this browser, so the picker offers them next time.
    expect(JSON.parse(localStorage.getItem('termag-recent-people')!)).toEqual([expect.objectContaining({ email: 'gus@x.test' })]);
  });

  it('remembers nobody when the share fails', async () => {
    api.list.mockResolvedValue([]);
    api.create.mockRejectedValue({ response: { status: 404, data: { error: 'No termag user has that email. They need to sign in to termag once first.' } } });
    mount();
    await flush();
    type(el.querySelector('input[type=email]') as HTMLInputElement, 'nobody@x.test');
    await act(async () => { (el.querySelector('form') as HTMLFormElement).requestSubmit(); await new Promise(r => setTimeout(r, 0)); });
    expect(el.querySelector('[role=alert]')?.textContent).toContain('sign in to termag once');
    expect(localStorage.getItem('termag-recent-people')).toBeNull();
  });

  it('shares a list of loopback addresses when asked to, split on spaces, commas and lines', async () => {
    api.list.mockResolvedValue([]);
    api.create.mockResolvedValue({ id: 'snew', expiresAt: '', link: '/p/snew', ttlHours: 24 });
    mount();
    await flush();
    type(el.querySelector('input[type=email]') as HTMLInputElement, 'gus@x.test');
    const manual = [...el.querySelectorAll('input[type=radio]')][1] as HTMLInputElement;
    act(() => { manual.click(); });
    const area = el.querySelector('textarea[aria-label="Addresses"]') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => { setter.call(area, ' 127.0.0.2:3000,127.0.0.2:3001\n https://127.0.0.2:4443/ '); area.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { (el.querySelector('form') as HTMLFormElement).requestSubmit(); await new Promise(r => setTimeout(r, 0)); });
    expect(api.create).toHaveBeenCalledWith('p1', {
      email: 'gus@x.test', workstream: 'feature-x', ttlHours: 24,
      recipe: { kind: 'manual', origins: ['127.0.0.2:3000', '127.0.0.2:3001', 'https://127.0.0.2:4443/'] },
    });
  });

  it('names a lifetime the flag sets in hours properly', async () => {
    api.list.mockResolvedValue([]);
    mount(null, 1);
    await flush();
    expect([...el.querySelectorAll('option')].map(o => o.textContent)).toEqual(['1 hour', '3 days', '7 days']);
  });

  it('says so when the person already had a share, which the server renewed', async () => {
    api.list.mockResolvedValue([share()]);
    api.create.mockResolvedValue({ id: 's1', expiresAt: '', link: '/p/s1', ttlHours: 24, renewed: true });
    mount();
    await flush();
    type(el.querySelector('input[type=email]') as HTMLInputElement, 'gus@x.test');
    await act(async () => { (el.querySelector('form') as HTMLFormElement).requestSubmit(); await new Promise(r => setTimeout(r, 0)); });
    expect(el.textContent).toContain('Already shared with gus@x.test: their share is renewed, same link (copied).');
    expect(writeText).toHaveBeenCalledWith('https://termag.test/termag/p/s1');
    expect(el.querySelectorAll('.share-dialog-row')).toHaveLength(1);
  });

  it('copies links that open at the page the owner\'s pane shows', async () => {
    api.list.mockResolvedValue([share()]);
    mount('/default/production/features/my-flag?tab=targeting');
    await flush();
    expect(el.textContent).toContain('Links open at /default/production/features/my-flag?tab=targeting');
    await act(async () => { button('Copy link').click(); await new Promise(r => setTimeout(r, 0)); });
    expect(writeText).toHaveBeenCalledWith(`https://termag.test/termag/p/${share().id}?at=%2Fdefault%2Fproduction%2Ffeatures%2Fmy-flag%3Ftab%3Dtargeting`);
  });

  it('offers Extend only when the chosen lifetime ends later than the share already does', async () => {
    api.list.mockResolvedValue([share({ expiresAt: new Date(Date.now() + 6 * 24 * 3600e3).toISOString() })]);
    api.extend.mockResolvedValue({});
    mount();
    await flush();
    // The dialog opens on the 1-day default: extending a 6-day share to it would end it sooner.
    expect(el.textContent).not.toContain('Extend');
    const select = el.querySelector('select') as HTMLSelectElement;
    act(() => { select.value = '168'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { button('Extend to 7 days from now').click(); await new Promise(r => setTimeout(r, 0)); });
    expect(api.extend).toHaveBeenCalledWith('p1', 's1', 168);
  });

  it('shows why a share was refused, and stops sharing on request', async () => {
    api.list.mockResolvedValue([share()]);
    api.create.mockRejectedValue({ response: { data: { error: 'No termag user has that email.' } } });
    api.revoke.mockResolvedValue({ ok: true });
    mount();
    await flush();
    type(el.querySelector('input[type=email]') as HTMLInputElement, 'nobody@x.test');
    await act(async () => { (el.querySelector('form') as HTMLFormElement).requestSubmit(); await new Promise(r => setTimeout(r, 0)); });
    expect(el.textContent).toContain('No termag user has that email.');
    await act(async () => { button('Stop sharing').click(); await new Promise(r => setTimeout(r, 0)); });
    expect(api.revoke).toHaveBeenCalledWith('p1', 's1');
  });

  it('lists a PR\'s link share: its PR, who opened it (each removable), its token link, and no extend', async () => {
    const token = 'e'.repeat(32);
    api.list.mockResolvedValue([share({
      id: 'clink1', audience: 'link', grantee: null, linkPath: `/p/${token}`, expiresAt: new Date(Date.now() + 10 * 86400e3).toISOString(),
      pr: { repo: 'example-org/webapp', number: 42, url: 'https://github.com/example-org/webapp/pull/42', headOid: null },
      viewers: [
        { userId: 'u-vic', name: 'Vic', email: 'vic@x.test', firstOpenedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(), revokedAt: null },
        { userId: 'u-ann', name: 'Ann', email: 'ann@x.test', firstOpenedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(), revokedAt: new Date().toISOString() },
      ],
    })]);
    api.revokeViewer.mockResolvedValue({ ok: true });
    mount();
    await flush();
    expect(el.textContent).toContain('Link on webapp#42');
    expect(el.querySelectorAll('.share-dialog-viewers li')).toHaveLength(2);
    expect(el.textContent).toContain('removed');
    expect([...el.querySelectorAll('button')].some(b => b.textContent?.startsWith('Extend'))).toBe(false);
    await act(async () => { button('Copy link').click(); await new Promise(r => setTimeout(r, 0)); });
    expect(writeText).toHaveBeenCalledWith(`https://termag.test/termag/p/${token}`);
    await act(async () => { button('Remove').click(); await new Promise(r => setTimeout(r, 0)); });
    expect(api.revokeViewer).toHaveBeenCalledWith('p1', 'clink1', 'u-vic');
  });
});
