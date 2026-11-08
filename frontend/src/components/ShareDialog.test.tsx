// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), extend: vi.fn(), revoke: vi.fn(), revokeViewer: vi.fn(), stackCheck: vi.fn(), settings: vi.fn() }));
const usersApi = vi.hoisted(() => ({ search: vi.fn(async () => []) }));
const flags = vi.hoisted(() => ({ on: {} as Record<string, boolean> }));
vi.mock('../flags', async () => {
  const actual = await vi.importActual<typeof import('../flags')>('../flags');
  return { ...actual, useFlag: (key: string, fallback: unknown) => (key in flags.on ? flags.on[key] : fallback) };
});
const env = vi.hoisted(() => ({ projects: [] as unknown[] }));
vi.mock('../contexts/ProjectContext', () => ({ useProjects: () => ({ projects: env.projects }) }));
vi.mock('../services/api', () => ({ previewSharesApi: api, usersApi, previewShareLink: (id: string, at?: string | null, linkPath?: string | null) => `https://termag.test/termag${linkPath ?? `/p/${id}`}${at ? `?at=${encodeURIComponent(at)}` : ''}` }));

const linksApi = vi.hoisted(() => ({ list: vi.fn(), listeners: vi.fn(), publish: vi.fn() }));
vi.mock('../services/previewLinksApi', () => ({ previewLinksApi: linksApi, previewLinkError: () => 'refused' }));
vi.mock('../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));

import { ShareDialog } from './ShareDialog';

/** The share choice whose label starts with `text`: by name, so a choice that isn't shown doesn't shift the rest. */
const radio = (root: HTMLElement, text: string) =>
  [...root.querySelectorAll('input[type=radio]')].find(r => r.parentElement?.textContent?.trim().startsWith(text)) as HTMLInputElement;


const share = (over: Record<string, unknown> = {}) => ({
  id: 's1', workstream: 'feature-x', grantee: { id: 'u2', email: 'gus@x.test', name: 'Gus' }, recipe: { kind: 'webapp-dev-stack' },
  expiresAt: new Date(Date.now() + 20 * 3600e3).toISOString(), revokedAt: null, endedAt: null, endedReason: null,
  lastOpenedAt: null, createdAt: new Date().toISOString(), liveViewers: 1, blockedOrigins: ['127.0.0.2:9000'], ...over,
});
let root: Root;
let el: HTMLDivElement;
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const writeText = vi.fn(async () => {});

function mount(atPath: string | null = null, defaultTtlHours = 24, onSwitchWorkstream?: (ws: string) => void, workstream = 'feature-x') {
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root.render(<ShareDialog projectId="p1" workstream={workstream} defaultTtlHours={defaultTtlHours} atPath={atPath} onClose={() => {}} onSwitchWorkstream={onSwitchWorkstream} />));
}
const button = (text: string) => [...el.querySelectorAll('button')].find(b => b.textContent === text)!;
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  api.settings.mockResolvedValue({ prLinksEnabled: false, pathFilter: [], reviewerAccountHint: null });
  api.stackCheck.mockResolvedValue({ checked: false });
  flags.on = {};
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

  it('focuses the email field as it opens', async () => {
    api.list.mockResolvedValue([]);
    mount();
    await flush();
    expect(document.activeElement).toBe(el.querySelector('input[type=email]'));
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

  it('shares by a link anyone signed in can open when nobody is named, and copies its token link', async () => {
    const token = 'f'.repeat(32);
    api.list.mockResolvedValue([]);
    api.create.mockResolvedValue({ id: 'copen1', expiresAt: '', link: `/p/${token}`, linkPath: `/p/${token}`, ttlHours: 24 });
    mount('/flags');
    await flush();
    expect(el.textContent).toContain('Leave it empty for a link anyone signed in to termag can open.');
    expect((el.querySelector('input[type=email]') as HTMLInputElement).required).toBe(false);
    await act(async () => { button('Share with anyone and copy link').click(); await new Promise(r => setTimeout(r, 0)); });
    expect(api.create).toHaveBeenCalledWith('p1', { audience: 'link', workstream: 'feature-x', ttlHours: 24 });
    expect(writeText).toHaveBeenCalledWith(`https://termag.test/termag/p/${token}?at=%2Fflags`);
    // Nobody to remember.
    expect(localStorage.getItem('termag-recent-people')).toBeNull();
    // Naming someone shares with them, as before.
    type(el.querySelector('input[type=email]') as HTMLInputElement, 'gus@x.test');
    expect(button('Share and copy link')).toBeDefined();
  });

  it('says so when the workstream\'s open link was renewed', async () => {
    api.list.mockResolvedValue([]);
    api.create.mockResolvedValue({ id: 'copen1', expiresAt: '', link: `/p/${'f'.repeat(32)}`, linkPath: `/p/${'f'.repeat(32)}`, ttlHours: 24, renewed: true });
    mount();
    await flush();
    await act(async () => { button('Share with anyone and copy link').click(); await new Promise(r => setTimeout(r, 0)); });
    expect(el.textContent).toContain('Already shared by link: it is renewed, same link (copied).');
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
    const manual = radio(el, "These addresses on this box");
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

  it("shares the app the workstream's environment file runs, the box resolving its ports", async () => {
    api.list.mockResolvedValue([]);
    api.create.mockResolvedValue({ id: 'snew', expiresAt: '', link: '/p/snew', ttlHours: 24 });
    mount();
    await flush();
    type(el.querySelector('input[type=email]') as HTMLInputElement, 'gus@x.test');
    env.projects = [{ id: 'p1', environmentStatus: { ports: [{ name: 'frontend', port: 5174, path: '/termag/', healthy: true }] } }];
    // The project's status is its main checkout's app (the claim's chain), so the main workstream's to share.
    mount(null, 24, undefined, 'main');
    await flush();
    type(el.querySelector('input[type=email]') as HTMLInputElement, 'gus@x.test');
    const repo = radio(el, "This environment's app");
    expect(repo.parentElement?.textContent?.trim()).toBe("This environment's app · frontend · 5174");
    act(() => { repo.click(); });
    await act(async () => { (el.querySelector('form') as HTMLFormElement).requestSubmit(); await new Promise(r => setTimeout(r, 0)); });
    expect(api.create).toHaveBeenCalledWith('p1', { email: 'gus@x.test', workstream: 'main', ttlHours: 24, recipe: { kind: 'repo' } });
  });

  // Review on #998: a project with no environment port (none, or a box whose agent is older) has nothing for
  // "This environment's app" to open, so it isn't offered.
  it("doesn't offer this environment's app when the project's environment names no port", async () => {
    api.list.mockResolvedValue([]);
    env.projects = [{ id: 'p1', environmentStatus: null }];
    mount();
    await flush();
    const labels = [...el.querySelectorAll('input[type=radio]')].map(r => r.parentElement?.textContent?.trim());
    expect(labels).not.toContain("This environment's app");
    expect(labels.length).toBe(2);
  });

  // Bugbot on #998 (e1fbcadb): Project.environmentStatus is the main checkout's app; another workstream's share would
  // bind main's listeners and be refused at attach, so it isn't offered there.
  // Decision #71 on #998: environment-selection-enabled off hides the choice, as it hides every environment choice.
  it("doesn't offer this environment's app while environment selection is off", async () => {
    api.list.mockResolvedValue([]);
    env.projects = [{ id: 'p1', environmentStatus: { ports: [{ name: 'frontend', port: 5174, path: '/termag/', healthy: true }] } }];
    flags.on['environment-selection-enabled'] = false;
    mount(null, 24, undefined, 'main');
    await flush();
    expect(radio(el, "This environment's app")).toBeUndefined();
    delete flags.on['environment-selection-enabled'];
  });

  it("offers this environment's app on the main workstream only", async () => {
    api.list.mockResolvedValue([]);
    env.projects = [{ id: 'p1', environmentStatus: { ports: [{ name: 'frontend', port: 5174, path: '/termag/', healthy: true }] } }];
    mount();
    await flush();
    expect(radio(el, "This environment's app")).toBeUndefined();
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

  it('says which checkout a PR\'s link share comes from when it is not the workstream\'s own (4d)', async () => {
    api.list.mockResolvedValue([share({
      id: 'clink2', audience: 'link', grantee: null, linkPath: `/p/${'d'.repeat(32)}`, checkoutDir: '/home/olive/src/webapp',
      pr: { repo: 'example-org/webapp', number: 43, url: 'https://github.com/example-org/webapp/pull/43', headOid: null }, viewers: [],
    })]);
    mount();
    await flush();
    expect(el.textContent).toContain('from ~/src/webapp');
    expect(el.querySelector('[title="/home/olive/src/webapp"]')).not.toBeNull();
  });

  it('lists an open link: anyone signed in, who opened it, its token link, and extend', async () => {
    const token = 'a'.repeat(32);
    api.list.mockResolvedValue([share({
      id: 'copen1', audience: 'link', grantee: null, linkPath: `/p/${token}`, pr: null,
      viewers: [{ userId: 'u-vic', name: 'Vic', email: 'vic@x.test', firstOpenedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(), revokedAt: null }],
    })]);
    api.extend.mockResolvedValue({});
    mount();
    await flush();
    expect(el.textContent).toContain('Open link anyone signed in to termag who opens it');
    expect(el.textContent).not.toContain('someone');
    expect(el.querySelectorAll('.share-dialog-viewers li')).toHaveLength(1);
    await act(async () => { button('Copy link').click(); await new Promise(r => setTimeout(r, 0)); });
    expect(writeText).toHaveBeenCalledWith(`https://termag.test/termag/p/${token}`);
    const select = el.querySelector('select') as HTMLSelectElement;
    act(() => { select.value = '168'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { button('Extend to 7 days from now').click(); await new Promise(r => setTimeout(r, 0)); });
    expect(api.extend).toHaveBeenCalledWith('p1', 'copen1', 168);
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
    expect(el.textContent).not.toContain('from ~/');
    expect(el.querySelectorAll('.share-dialog-viewers li')).toHaveLength(2);
    expect(el.textContent).toContain('removed');
    expect([...el.querySelectorAll('button')].some(b => b.textContent?.startsWith('Extend'))).toBe(false);
    await act(async () => { button('Copy link').click(); await new Promise(r => setTimeout(r, 0)); });
    expect(writeText).toHaveBeenCalledWith(`https://termag.test/termag/p/${token}`);
    await act(async () => { button('Remove').click(); await new Promise(r => setTimeout(r, 0)); });
    expect(api.revokeViewer).toHaveBeenCalledWith('p1', 'clink1', 'u-vic');
  });

  it('warns before sharing when the dev stack running is another workstream\'s, and offers to share that one', async () => {
    api.list.mockResolvedValue([]);
    api.stackCheck.mockResolvedValue({
      checked: true, ok: false, reason: 'other-workstream', holder: { dir: '/home/o/termag/projects/p/', workstream: 'main' },
      message: 'The dev stack on your box was started from the main workstream, not feature-x, so a reviewer would be refused.',
    });
    const switchTo = vi.fn();
    mount(null, 24, switchTo);
    await flush();
    expect(api.stackCheck).toHaveBeenCalledWith('p1', 'feature-x');
    expect(el.querySelector('.share-dialog-stack')?.textContent).toContain('started from the main workstream, not feature-x');
    act(() => button('Share main instead').click());
    expect(switchTo).toHaveBeenCalledWith('main');
    // Addresses on the box have no webapp dev stack to check. (The environment's app isn't offered here: this
    // project's environment names no port.)
    expect(radio(el, "This environment's app")).toBeUndefined();
    act(() => radio(el, 'These addresses on this box').click());
    await flush();
    expect(el.querySelector('.share-dialog-stack')).toBeNull();
  });

  it('says nothing when a reviewer would get in, or the box could not be asked, and offers no switch it cannot make', async () => {
    api.list.mockResolvedValue([]);
    api.stackCheck.mockResolvedValue({ checked: true, ok: true });
    mount();
    await flush();
    expect(el.querySelector('.share-dialog-stack')).toBeNull();
    act(() => root.unmount()); el.remove();
    api.stackCheck.mockResolvedValue({ checked: true, ok: false, reason: 'other-workstream', holder: { dir: '/x', workstream: 'main' }, message: 'Started from main.' });
    mount();
    await flush();
    expect(el.querySelector('.share-dialog-stack')?.textContent).toBe('Started from main.');
  });

  it('shows a share\'s last refusal, and whose stack was in the way', async () => {
    api.list.mockResolvedValue([share({ blockedOrigins: [], lastRefusal: {
      at: new Date(Date.now() - 2 * 3600e3).toISOString(),
      message: "The dev stack running on the owner's box was started from another checkout, not this workstream's.",
      holder: '/home/olive/src/webapp',
    } })]);
    mount();
    await flush();
    expect(el.textContent).toContain('Refused 2 hours ago');
    expect(el.textContent).toContain('started from another checkout');
    expect(el.textContent).toContain('The stack running was started from ~/src/webapp.');
  });
});

describe('the delivery choice (preview links)', () => {
  beforeEach(() => {
    for (const f of Object.values(linksApi)) f.mockReset();
    api.list.mockResolvedValue([]);
    linksApi.list.mockResolvedValue({ links: [], requests: [], ttlHoursDefault: 24, previewDomain: 'preview.test' });
    linksApi.listeners.mockResolvedValue([]);
  });
  const choice = (label: string) => [...el.querySelectorAll('.share-delivery input[type=radio]')].find(r => r.closest('label')?.textContent?.trim() === label) as HTMLInputElement;

  it('is not offered while preview-links-enabled is off: the dialog is the preview share alone', async () => {
    mount();
    await flush();
    expect(el.querySelector('.share-delivery')).toBeNull();
    expect(el.querySelector('.preview-links')).toBeNull();
    expect(linksApi.list).not.toHaveBeenCalled();
  });

  const shown = (sel: string) => { const e = el.querySelector(sel); return !!e && !e.closest('[hidden]'); };

  it('with the flag on, starts in termag and switches to "In your browser", the publish form for this workstream', async () => {
    flags.on = { 'preview-links-enabled': true };
    mount();
    await flush();
    expect(el.querySelector('.share-delivery')?.classList.contains('lp-theme')).toBe(true);
    expect(choice('In termag').checked).toBe(true);
    expect(shown('.share-dialog-form')).toBe(true);
    expect(el.querySelector('.preview-links')).toBeNull();
    act(() => { choice('In your browser').click(); });
    await flush();
    expect(shown('.share-dialog-form')).toBe(false);
    expect(shown('.preview-links-publish')).toBe(true);
    expect(linksApi.list).toHaveBeenCalledWith('p1');
    expect(linksApi.listeners).toHaveBeenCalledWith('p1', 'feature-x');
    act(() => { choice('In termag').click(); });
    expect(shown('.share-dialog-form')).toBe(true);
    expect(shown('.preview-links-publish')).toBe(false);
  });

  it('keeps a published link\'s one-time URL across a switch away and back (Bugbot, #1485)', async () => {
    flags.on = { 'preview-links-enabled': true };
    env.projects = [{ id: 'p1', name: 'shop' }];
    linksApi.listeners.mockResolvedValue([{ port: 5173, pid: 1, command: 'vite', verdict: { ok: true }, inCheckout: true }]);
    linksApi.publish.mockResolvedValue({
      link: { id: 'l1', name: 'feature-x', audience: 'link', url: 'https://t/termag/previews/feature-x', host: 'feature-x--k3.preview.test', expiresAt: new Date().toISOString() },
      renewed: false, shareUrl: 'https://t/termag/previews/feature-x/KEY',
    });
    mount();
    await flush();
    act(() => { choice('In your browser').click(); });
    await flush();
    await act(async () => { button('Publish').click(); });
    expect(el.querySelector('.preview-links-result .preview-links-url')?.textContent).toBe('https://t/termag/previews/feature-x/KEY');
    const reads = linksApi.list.mock.calls.length;
    act(() => { choice('In termag').click(); });
    act(() => { choice('In your browser').click(); });
    expect(shown('.preview-links-result')).toBe(true);
    expect(el.querySelector('.preview-links-result .preview-links-url')?.textContent).toBe('https://t/termag/previews/feature-x/KEY');
    // Not remounted: the list wasn't read again.
    expect(linksApi.list.mock.calls.length).toBe(reads);
  });

  it('starts a fresh publish form for another workstream, without the last one\'s link (Bugbot, #1485)', async () => {
    flags.on = { 'preview-links-enabled': true };
    env.projects = [{ id: 'p1', name: 'shop' }];
    linksApi.listeners.mockResolvedValue([{ port: 5173, pid: 1, command: 'vite', verdict: { ok: true }, inCheckout: true }]);
    linksApi.publish.mockResolvedValue({
      link: { id: 'l1', name: 'shop-feature-x', audience: 'link', url: 'https://t/termag/previews/shop-feature-x', host: null, expiresAt: new Date().toISOString() },
      renewed: false, shareUrl: 'https://t/termag/previews/shop-feature-x/KEY',
    });
    mount();
    await flush();
    act(() => { choice('In your browser').click(); });
    await flush();
    await act(async () => { button('Publish').click(); });
    expect(el.querySelector('.preview-links-result')).not.toBeNull();
    act(() => root.render(<ShareDialog projectId="p1" workstream="other" defaultTtlHours={24} onClose={() => {}} />));
    await flush();
    expect(el.querySelector('.preview-links-result')).toBeNull();
    expect((el.querySelector('.preview-links-name input') as HTMLInputElement).value).toBe('shop-other');
  });
});

