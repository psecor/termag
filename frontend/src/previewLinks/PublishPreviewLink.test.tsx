// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewLinkView, PreviewListener } from '../services/previewLinksApi';

const api = vi.hoisted(() => ({ list: vi.fn(), listeners: vi.fn(), publish: vi.fn(), extend: vi.fn(), revoke: vi.fn(), removeViewer: vi.fn(), declineRequest: vi.fn() }));
vi.mock('../services/previewLinksApi', async () => {
  const actual = await vi.importActual<typeof import('../services/previewLinksApi')>('../services/previewLinksApi');
  return { ...actual, previewLinksApi: api };
});
vi.mock('../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));

const { PublishPreviewLink, LINK_WARNING, nameNote } = await import('./PublishPreviewLink');

const OK: PreviewListener = { port: 5173, pid: 10, command: 'node vite', verdict: { ok: true }, inCheckout: true };
const OUTSIDE: PreviewListener = { port: 3000, pid: 11, command: 'node server.js', verdict: { ok: true }, inCheckout: false };
const REFUSED: PreviewListener = { port: 9229, pid: 12, command: 'node --inspect', verdict: { ok: false, code: 'devtools', reason: 'a debugger can run any code as you' }, inCheckout: true };

function linkView(over: Partial<PreviewLinkView> = {}): PreviewLinkView {
  return {
    id: 'l1', name: 'shop-feature-x', projectId: 'p1', workstream: 'feature-x', port: 5173, audience: 'owner', hostMode: 'localhost', live: true,
    expiresAt: new Date(Date.now() + 24 * 3600e3).toISOString(), maxExpiresAt: new Date(Date.now() + 30 * 86400e3).toISOString(),
    endedAt: null, endReason: null, createdAt: new Date().toISOString(), url: 'https://termag.test/termag/previews/shop-feature-x',
    // The server's host: since #1366 a per-link suffix, so never the name plus the domain.
    host: 'shop-feature-x--k3x9q.preview.test', ...over,
  };
}

let root: Root;
let el: HTMLDivElement;
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

beforeEach(() => {
  const css = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
  if (!css?.escape) (globalThis as { CSS?: unknown }).CSS = { ...css, escape: (v: string) => v.replace(/[^\w-]/g, c => `\\${c}`) };
  for (const f of Object.values(api)) f.mockReset();
  api.listeners.mockResolvedValue([REFUSED, OUTSIDE, OK]);
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); });

async function mount(over: { audiencesOn?: boolean; links?: PreviewLinkView[] | null; ttl?: number } = {}) {
  act(() => root.render(
    <PublishPreviewLink projectId="p1" projectName="Shop" workstream="feature-x" links={over.links ?? []} ttlHoursDefault={over.ttl ?? 24} audiencesOn={over.audiencesOn ?? false} />,
  ));
  await flush();
}
const byText = (sel: string, text: string) => [...document.querySelectorAll(sel)].find(b => b.textContent?.trim() === text) as HTMLElement;
const publishButton = () => byText('button', 'Publish') as HTMLButtonElement;
const nameInput = () => [...el.querySelectorAll('input')].find(i => i.closest('.preview-links-name')) as HTMLInputElement;
const radio = (label: string) => [...el.querySelectorAll('input[type=radio]')].find(r => r.closest('label')?.textContent?.trim() === label) as HTMLInputElement;
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
const portShown = () => el.querySelector('.preview-links-select-button')?.textContent?.trim();

describe('publishing from the Share dialog', () => {
  it('lists the box\'s listeners, preselects one started from this checkout, and disables a refused one with its reason', async () => {
    await mount();
    expect(api.listeners).toHaveBeenCalledWith('p1', 'feature-x');
    expect(portShown()).toBe('5173 · node vite');
    await act(async () => { (el.querySelector('.preview-links-select-button') as HTMLButtonElement).click(); });
    const options = [...document.querySelectorAll('.preview-links-port-popover [role="option"]')] as HTMLElement[];
    expect(options.map(o => o.querySelector('[slot="label"]')?.textContent)).toEqual(['9229 · node --inspect', '3000 · node server.js', '5173 · node vite']);
    expect(options[0].getAttribute('aria-disabled')).toBe('true');
    expect(options[0].textContent).toContain("Can't be published: a debugger can run any code as you");
    expect(options[1].textContent).toContain("Not started from this workstream's checkout");
    expect(document.querySelector('.preview-links-port-popover')?.classList.contains('lp-theme')).toBe(true);
  });

  it('keeps the list it had when Look again fails, and only the latest listing counts (Bugbot, #1485)', async () => {
    await mount();
    expect(portShown()).toBe('5173 · node vite');
    api.listeners.mockRejectedValueOnce({ response: { data: { error: "The box isn't connected" } } });
    await act(async () => { (el.querySelector('button[aria-label="Look again"]') as HTMLButtonElement).click(); });
    expect(portShown()).toBe('5173 · node vite');
    expect(el.textContent).toContain("The box isn't connected");
    let slow: (v: unknown) => void = () => {};
    api.listeners.mockImplementationOnce(() => new Promise(r => { slow = r; })).mockResolvedValueOnce([OUTSIDE]);
    await act(async () => { (el.querySelector('button[aria-label="Look again"]') as HTMLButtonElement).click(); });
    await act(async () => { (el.querySelector('button[aria-label="Look again"]') as HTMLButtonElement).click(); });
    await act(async () => { slow([OK]); });
    expect(portShown()).toContain('3000 · node server.js');
  });

  it('says so when nothing listens, and has nothing to publish', async () => {
    api.listeners.mockResolvedValue([]);
    await mount();
    expect(el.textContent).toContain('Nothing listens on this box yet');
    expect(publishButton().disabled).toBe(true);
  });

  it('suggests <project>-<workstream> and checks the name as it is typed', async () => {
    await mount();
    expect(nameInput().value).toBe('shop-feature-x');
    expect(publishButton().disabled).toBe(false);
    type(nameInput(), 'Ab');
    expect(nameInput().value).toBe('ab');
    expect(el.textContent).toContain('3 to 40 lowercase letters');
    expect(publishButton().disabled).toBe(true);
    type(nameInput(), 'admin');
    expect(el.textContent).toContain('"admin" is reserved');
    type(nameInput(), 'xn--abc');
    expect(el.textContent).toContain('is reserved');
    type(nameInput(), 'shop-demo');
    expect(el.querySelector('.preview-links-name')?.textContent).not.toContain('lowercase');
    expect(publishButton().disabled).toBe(false);
  });

  it('suggests the name once the project arrives, but never over a typed one (Bugbot, #1485)', async () => {
    const render = (projectName: string) => act(() => root.render(
      <PublishPreviewLink projectId="p1" projectName={projectName} workstream="feature-x" links={[]} ttlHoursDefault={24} audiencesOn={false} />,
    ));
    render('');
    await flush();
    expect(nameInput().value).toBe('');
    render('Shop');
    expect(nameInput().value).toBe('shop-feature-x');
    type(nameInput(), 'my-demo');
    render('Shop2');
    expect(nameInput().value).toBe('my-demo');
  });

  it('says a name renews this workstream\'s live link, or is another workstream\'s', () => {
    const links = [linkView(), linkView({ id: 'l2', name: 'shop', workstream: 'main' }), linkView({ id: 'l3', name: 'old', live: false })];
    expect(nameNote('shop-feature-x', 'feature-x', links)).toContain('renews your live link');
    expect(nameNote('shop', 'feature-x', links)).toBe('The main workstream has a live link with this name.');
    expect(nameNote('old', 'feature-x', links)).toBeNull();
    expect(nameNote('new', 'feature-x', null)).toBeNull();
  });

  it('offers only "Only me" while the audience flag is off', async () => {
    await mount();
    expect([...el.querySelectorAll('.preview-links-audience label')].map(l => l.textContent?.trim())).toEqual(['Only me']);
    expect(radio('Only me').checked).toBe(true);
    expect(el.textContent).not.toContain(LINK_WARNING);
  });

  it('with the flag on, preselects "Only me", warns under the link audience, and wants an email for "People I name"', async () => {
    await mount({ audiencesOn: true });
    const labels = [...el.querySelectorAll('.preview-links-audience label')].map(l => l.textContent?.trim());
    expect(labels).toEqual(['Only me', 'People I name', 'Anyone on termag with the link']);
    expect(radio('Only me').checked).toBe(true);
    const warning = el.querySelector('.preview-links-warning')!;
    expect(warning.textContent).toBe(LINK_WARNING);
    expect(warning.previousElementSibling?.textContent?.trim()).toBe('Anyone on termag with the link');
    act(() => { radio('People I name').click(); });
    expect(publishButton().disabled).toBe(true);
    const emails = el.querySelector('.preview-links-emails input') as HTMLInputElement;
    type(emails, 'Gus@x.test, gus@x.test  ana@x.test');
    expect(publishButton().disabled).toBe(false);
    api.publish.mockResolvedValue({ link: linkView({ audience: 'people' }), renewed: false, shareUrl: 'https://termag.test/termag/previews/shop-feature-x' });
    await act(async () => { publishButton().click(); });
    expect(api.publish.mock.calls[0][1]).toMatchObject({ audience: 'people', emails: ['gus@x.test', 'ana@x.test'] });
  });

  it('shows the lifetime from the server\'s default, clamped to 1 to 168 hours, and the 30-day cap', async () => {
    await mount({ ttl: 500 });
    const ttl = el.querySelector('.preview-links-ttl input') as HTMLInputElement;
    expect(ttl.value).toBe('168');
    expect(el.querySelector('.preview-links-ttl')?.textContent).toContain('up to 30 days from its first publish');
  });

  it('publishes what the form says, Host: localhost by default, and shows the share URL to copy and the host the server named', async () => {
    api.publish.mockResolvedValue({ link: linkView({ audience: 'link' }), renewed: false, shareUrl: 'https://termag.test/termag/previews/shop-feature-x/TOKEN' });
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    await mount({ audiencesOn: true });
    act(() => { radio('Anyone on termag with the link').click(); });
    await act(async () => { publishButton().click(); });
    expect(api.publish).toHaveBeenCalledWith('p1', { workstream: 'feature-x', port: 5173, name: 'shop-feature-x', audience: 'link', ttlHours: 24, hostMode: 'localhost' });
    const result = el.querySelector('.preview-links-result')!;
    expect(result.querySelector('.preview-links-url')?.textContent).toBe('https://termag.test/termag/previews/shop-feature-x/TOKEN');
    expect(result.textContent).toContain('shows only now');
    expect(result.textContent).toContain('shop-feature-x--k3x9q.preview.test');
    await act(async () => { (result.querySelector('button[aria-label="Copy the share URL"]') as HTMLButtonElement).click(); });
    expect(writeText).toHaveBeenCalledWith('https://termag.test/termag/previews/shop-feature-x/TOKEN');
  });

  it('sends hostMode public when Host: localhost is unticked under Advanced', async () => {
    api.publish.mockResolvedValue({ link: linkView({ hostMode: 'public' }), renewed: true, shareUrl: null, note: 'The link keeps its token' });
    await mount();
    await act(async () => { byText('button', 'Advanced').click(); });
    const box = [...el.querySelectorAll('input[type=checkbox]')].find(c => c.closest('label')?.textContent?.includes('Host: localhost')) as HTMLInputElement;
    expect(box.checked).toBe(true);
    act(() => { box.click(); });
    await act(async () => { publishButton().click(); });
    expect(api.publish.mock.calls[0][1].hostMode).toBe('public');
    const result = el.querySelector('.preview-links-result')!;
    expect(result.textContent).toContain('Renewed.');
    expect(result.querySelector('.preview-links-url')?.textContent).toBe('https://termag.test/termag/previews/shop-feature-x');
    expect(result.textContent).toContain('The link keeps its token');
  });

  it('never offers a link audience\'s bare URL when a renew kept its key (Devin, #1485)', async () => {
    api.publish.mockResolvedValue({ link: linkView({ audience: 'link' }), renewed: true, shareUrl: null, note: 'The link keeps its token; share the URL you were given when it was made' });
    await mount({ audiencesOn: true });
    act(() => { radio('Anyone on termag with the link').click(); });
    await act(async () => { publishButton().click(); });
    const result = el.querySelector('.preview-links-result')!;
    expect(result.querySelector('.preview-links-url')).toBeNull();
    expect(result.querySelector('button[aria-label="Copy the share URL"]')).toBeNull();
    expect(result.textContent).toContain('share the URL you were given when you first published it');
  });

  it('reports busy while a publish is in flight, so the dialog stays open for its one-time URL (Devin, #1485)', async () => {
    let finish: (v: unknown) => void = () => {};
    api.publish.mockImplementation(() => new Promise(r => { finish = r; }));
    const onBusyChange = vi.fn();
    act(() => root.render(
      <PublishPreviewLink projectId="p1" projectName="Shop" workstream="feature-x" links={[]} ttlHoursDefault={24} audiencesOn={false} onBusyChange={onBusyChange} />,
    ));
    await flush();
    await act(async () => { publishButton().click(); });
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    await act(async () => { finish({ link: linkView(), renewed: false, shareUrl: 'https://termag.test/termag/previews/shop-feature-x' }); });
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it('shows the server\'s refusal', async () => {
    api.publish.mockRejectedValue({ response: { data: { error: 'This link has reached its 30-day limit; publish it again.', code: 'lifetime_cap' } } });
    await mount();
    await act(async () => { publishButton().click(); });
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('30-day limit');
  });
});
