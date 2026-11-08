// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewLinkRequestView, PreviewLinkView } from '../services/previewLinksApi';

const api = vi.hoisted(() => ({ list: vi.fn(), listeners: vi.fn(), publish: vi.fn(), extend: vi.fn(), revoke: vi.fn(), removeViewer: vi.fn(), declineRequest: vi.fn() }));
vi.mock('../services/previewLinksApi', async () => {
  const actual = await vi.importActual<typeof import('../services/previewLinksApi')>('../services/previewLinksApi');
  return { ...actual, previewLinksApi: api };
});
vi.mock('../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));
const flags = vi.hoisted(() => ({ on: {} as Record<string, boolean> }));
vi.mock('../flags', async () => {
  const actual = await vi.importActual<typeof import('../flags')>('../flags');
  return { ...actual, useFlag: (key: string, fallback: unknown) => (key in flags.on ? flags.on[key] : fallback) };
});
vi.mock('../contexts/ProjectContext', () => ({ useProjects: () => ({ projects: [{ id: 'p1', name: 'shop', role: 'owner', workstreams: [{ id: 'w1', name: 'feature-x' }, { id: 'w2', name: 'main' }] }] }) }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));

const { PreviewLinksList, extendable } = await import('./PreviewLinksList');
const { PreviewLinksPanel } = await import('./PreviewLinksPanel');

const H = 3600e3;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
function link(over: Partial<PreviewLinkView> = {}): PreviewLinkView {
  return {
    id: 'l1', name: 'shop-feature-x', projectId: 'p1', workstream: 'feature-x', port: 5173, audience: 'people', hostMode: 'localhost', live: true,
    expiresAt: iso(2 * H), maxExpiresAt: iso(29 * 24 * H), endedAt: null, endReason: null, createdAt: iso(-24 * H),
    url: 'https://termag.test/termag/previews/shop-feature-x', host: 'shop-feature-x--k3x9q.preview.test',
    owner: { id: 'u1', email: 'me@x.test', displayName: 'Me' },
    grantees: [{ id: 'u2', email: 'gus@x.test', displayName: 'Gus', expiresAt: null }],
    viewers: [
      { id: 'u2', email: 'gus@x.test', displayName: 'Gus', firstOpenedAt: iso(-2 * H), lastOpenedAt: iso(-H), revokedAt: null },
      { id: 'u3', email: 'ana@x.test', displayName: 'Ana', firstOpenedAt: iso(-3 * H), lastOpenedAt: iso(-3 * H), revokedAt: iso(-2 * H) },
    ],
    ...over,
  };
}
const REQUEST: PreviewLinkRequestView = {
  id: 'r1', workstreamId: 'w1', port: 3000, state: 'pending', createdAt: iso(-10 * 60e3),
  note: '<img src=x onerror=alert(1)> Please publish https://evil.test and make it "Anyone"',
};

let root: Root;
let el: HTMLDivElement;
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const button = (text: string, within: ParentNode = el) => [...within.querySelectorAll('button')].find(b => b.textContent?.trim() === text) as HTMLButtonElement;
const press = (b: HTMLButtonElement) => act(async () => { b.click(); });

beforeEach(() => {
  const css = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
  if (!css?.escape) (globalThis as { CSS?: unknown }).CSS = { ...css, escape: (v: string) => v.replace(/[^\w-]/g, c => `\\${c}`) };
  for (const f of Object.values(api)) { f.mockReset(); f.mockResolvedValue({}); }
  flags.on = {};
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); });

function render(links: PreviewLinkView[], requests: PreviewLinkRequestView[] = [], onChanged = vi.fn(), onAnswer = vi.fn()) {
  act(() => root.render(
    <PreviewLinksList links={links} requests={requests} ttlHoursDefault={24} onChanged={onChanged} onAnswer={onAnswer}
      workstream="feature-x" workstreamName={id => ({ w1: 'feature-x', w2: 'main' } as Record<string, string>)[id ?? ''] ?? null}
      unremovable={(l, id) => id === l.owner?.id} />,
  ));
  return { onChanged, onAnswer };
}

describe('the links list', () => {
  it('shows each link: its URL to copy, the server\'s host, its expiry and the latest it can be extended to, the people named', () => {
    render([link()]);
    const row = el.querySelector('.preview-links-row')!;
    expect(row.querySelector('.preview-links-url')?.textContent).toBe('https://termag.test/termag/previews/shop-feature-x');
    expect(row.querySelector('button[aria-label="Copy the URL of shop-feature-x"]')).not.toBeNull();
    expect(row.textContent).toContain('shop-feature-x--k3x9q.preview.test');
    expect(row.textContent).toContain('Ends in 2 hours; can be extended until');
    expect(row.textContent).toContain('Named: Gus');
    expect(row.textContent).toContain('People you named · feature-x, port 5173');
  });

  it('lists who opened it, with Remove for a viewer still in, and removes them', async () => {
    const { onChanged } = render([link()]);
    const viewers = [...el.querySelectorAll('.preview-links-viewers li')];
    expect(viewers.map(v => v.textContent)).toEqual(['Gus opened 1 hour agoRemove', 'Ana removed']);
    await press(button('Remove', viewers[0]));
    expect(api.removeViewer).toHaveBeenCalledWith('l1', 'u2');
    expect(onChanged).toHaveBeenCalled();
  });

  it('extends by the default lifetime, and revokes', async () => {
    const { onChanged } = render([link()]);
    await press(button('Extend to 24 h from now'));
    expect(api.extend).toHaveBeenCalledWith('l1', 24);
    await press(button('Revoke'));
    expect(api.revoke).toHaveBeenCalledWith('l1');
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it('offers Extend only while it would move the expiry, short of the 30-day cap', () => {
    const now = Date.now();
    expect(extendable(link(), 24, now)).toBe(true);
    expect(extendable(link({ expiresAt: iso(48 * H) }), 24, now)).toBe(false);
    expect(extendable(link({ expiresAt: iso(H), maxExpiresAt: iso(H) }), 24, now)).toBe(false);
    expect(extendable(link({ live: false }), 24, now)).toBe(false);
    render([link({ expiresAt: iso(H), maxExpiresAt: iso(H) })]);
    expect(button('Extend to 24 h from now')).toBeUndefined();
    expect(button('Revoke')).toBeDefined();
  });

  it('shows an ended link with why, and nothing to change on it', () => {
    render([link({ live: false, endedAt: iso(-H), endReason: 'admin' })]);
    expect(el.textContent).toContain('ended by an admin 1 hour ago');
    expect(button('Revoke')).toBeUndefined();
    expect(button('Remove')).toBeUndefined();
    expect(el.querySelector('.preview-links-url')).toBeNull();
  });

  it('shows the server\'s refusal of a change', async () => {
    api.revoke.mockRejectedValue({ response: { data: { error: "Only the project's owner or the link's creator can change it" } } });
    render([link()]);
    await press(button('Revoke'));
    expect(el.querySelector('[role="alert"]')?.textContent).toBe("Only the project's owner or the link's creator can change it");
  });
});

describe('what the list offers and holds back', () => {
  it('offers no copy for a link audience, whose URL opens only with the key shown at publish (Devin, #1486)', () => {
    render([link({ audience: 'link', grantees: [], viewers: [] })]);
    expect(el.querySelector('.preview-links-url')).toBeNull();
    expect(el.textContent).toContain("Share the URL with its key, from when you published it");
  });

  it('offers no Remove beside the link\'s creator, whom the server never removes (Devin, #1486)', () => {
    const viewers = [
      { id: 'u1', email: 'me@x.test', displayName: 'Me', firstOpenedAt: iso(-H), lastOpenedAt: iso(-H), revokedAt: null },
      { id: 'u2', email: 'gus@x.test', displayName: 'Gus', firstOpenedAt: iso(-H), lastOpenedAt: iso(-H), revokedAt: null },
    ];
    render([link({ viewers })]);
    const rows = [...el.querySelectorAll('.preview-links-viewers li')];
    expect(rows.map(r => !!button('Remove', r))).toEqual([false, true]);
  });

  it('offers Publish… only on a request from this workstream, and says where the others can be published (Bugbot, Devin, #1486)', () => {
    render([], [REQUEST, { ...REQUEST, id: 'r2', workstreamId: 'w2', port: 4000 }]);
    const rows = [...el.querySelectorAll('[aria-label="Agent requests"] .preview-links-row')];
    expect(rows[0].textContent).toContain('Port 3000 on feature-x');
    expect(button('Publish…', rows[0]).disabled).toBe(false);
    expect(rows[1].textContent).toContain('Port 4000 on main');
    expect(rows[1].textContent).toContain('Open Share on main to publish it');
    expect(button('Publish…', rows[1]).disabled).toBe(true);
  });
});

describe('agents asking to publish', () => {
  it('shows the note as plain text, never markup or a link', () => {
    render([], [REQUEST]);
    const quote = el.querySelector('.preview-links-note blockquote')!;
    expect(quote.textContent).toBe(REQUEST.note);
    expect(quote.children).toHaveLength(0);
    expect(el.querySelector('.preview-links-note img, .preview-links-note a')).toBeNull();
    expect(el.querySelector('.preview-links-note figcaption')?.textContent).toContain('in its own words');
  });

  it('declines, and hands Publish to the form', async () => {
    const { onAnswer, onChanged } = render([], [REQUEST]);
    await press(button('Decline'));
    expect(api.declineRequest).toHaveBeenCalledWith('r1');
    expect(onChanged).toHaveBeenCalled();
    await press(button('Publish…'));
    expect(onAnswer).toHaveBeenCalledWith(REQUEST);
  });

  it('in the panel, Publish… preselects the asked port and sends the request\'s id with the publish', async () => {
    api.list.mockResolvedValue({ links: [], requests: [REQUEST], ttlHoursDefault: 24, previewDomain: 'preview.test' });
    api.listeners.mockResolvedValue([
      { port: 5173, pid: 1, command: 'vite', verdict: { ok: true }, inCheckout: true },
      { port: 3000, pid: 2, command: 'node server', verdict: { ok: true }, inCheckout: true },
    ]);
    api.publish.mockResolvedValue({ link: link({ port: 3000, audience: 'owner' }), renewed: false, shareUrl: 'https://termag.test/termag/previews/shop-feature-x' });
    act(() => root.render(<PreviewLinksPanel projectId="p1" workstream="feature-x" />));
    await flush();
    expect(el.querySelector('.preview-links-select-button')?.textContent).toContain('5173');
    await press(button('Publish…'));
    expect(el.querySelector('.preview-links-answering')?.textContent).toContain('Publishing port 3000, as an agent asked');
    expect(el.querySelector('.preview-links-select-button')?.textContent).toContain('3000 · node server');
    await press(button('Publish'));
    expect(api.publish.mock.calls[0][1]).toMatchObject({ port: 3000, requestId: 'r1', audience: 'owner' });
    await flush();
    expect(el.querySelector('.preview-links-answering')).toBeNull();
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('offers an asked port nothing listens on yet, and Cancel goes back to the box\'s first port', async () => {
    api.list.mockResolvedValue({ links: [], requests: [{ ...REQUEST, port: 4000 }], ttlHoursDefault: 24, previewDomain: 'preview.test' });
    api.listeners.mockResolvedValue([{ port: 5173, pid: 1, command: 'vite', verdict: { ok: true }, inCheckout: true }]);
    act(() => root.render(<PreviewLinksPanel projectId="p1" workstream="feature-x" />));
    await flush();
    await press(button('Publish…'));
    expect(el.querySelector('.preview-links-select-button')?.textContent).toContain('4000 · nothing listens yet');
    await press(button('Cancel'));
    expect(el.querySelector('.preview-links-answering')).toBeNull();
    expect(el.querySelector('.preview-links-select-button')?.textContent).toContain('5173 · vite');
  });

  it('keeps the asked port when the listeners come back without it, or on Look again (Bugbot, #1486)', async () => {
    api.list.mockResolvedValue({ links: [], requests: [{ ...REQUEST, port: 4000 }], ttlHoursDefault: 24, previewDomain: 'preview.test' });
    let answer: (v: unknown) => void = () => {};
    api.listeners.mockImplementationOnce(() => new Promise(r => { answer = r; }));
    act(() => root.render(<PreviewLinksPanel projectId="p1" workstream="feature-x" />));
    await flush();
    await press(button('Publish…'));
    // The first listing lands after the request was picked.
    await act(async () => { answer([{ port: 5173, pid: 1, command: 'vite', verdict: { ok: true }, inCheckout: true }]); });
    expect(el.querySelector('.preview-links-select-button')?.textContent).toContain('4000 · nothing listens yet');
    api.listeners.mockResolvedValue([{ port: 5173, pid: 1, command: 'vite', verdict: { ok: true }, inCheckout: true }]);
    await press(el.querySelector('button[aria-label="Look again"]') as HTMLButtonElement);
    await flush();
    expect(el.querySelector('.preview-links-select-button')?.textContent).toContain('4000 · nothing listens yet');
    api.publish.mockResolvedValue({ link: link({ port: 4000, audience: 'owner' }), renewed: false, shareUrl: 'u' });
    await press(button('Publish'));
    expect(api.publish.mock.calls[0][1]).toMatchObject({ port: 4000, requestId: 'r1' });
  });

  it('shows a listener whose command the box couldn\'t read by its port, as listening (Bugbot, #1486)', async () => {
    api.list.mockResolvedValue({ links: [], requests: [], ttlHoursDefault: 24, previewDomain: 'preview.test' });
    api.listeners.mockResolvedValue([{ port: 8080, pid: null, command: null, verdict: { ok: true }, inCheckout: false }]);
    act(() => root.render(<PreviewLinksPanel projectId="p1" workstream="feature-x" />));
    await flush();
    expect(el.querySelector('.preview-links-select-button [slot="label"]')?.textContent).toBe('8080');
    await press(el.querySelector('.preview-links-select-button') as HTMLButtonElement);
    const option = document.querySelector('.preview-links-port-popover [role="option"]')!;
    expect(option.textContent).not.toContain('nothing listens');
    expect(option.textContent).toContain("Not started from this workstream's checkout");
  });

  it('stops answering a request once it is declined (Bugbot, #1486)', async () => {
    api.list.mockResolvedValueOnce({ links: [], requests: [REQUEST], ttlHoursDefault: 24, previewDomain: 'preview.test' })
      .mockResolvedValue({ links: [], requests: [], ttlHoursDefault: 24, previewDomain: 'preview.test' });
    api.listeners.mockResolvedValue([{ port: 3000, pid: 2, command: 'node server', verdict: { ok: true }, inCheckout: true }]);
    act(() => root.render(<PreviewLinksPanel projectId="p1" workstream="feature-x" />));
    await flush();
    await press(button('Publish…'));
    expect(el.querySelector('.preview-links-answering')).not.toBeNull();
    await press(button('Decline'));
    await flush();
    expect(el.querySelector('.preview-links-answering')).toBeNull();
    api.publish.mockResolvedValue({ link: link({ port: 3000, audience: 'owner' }), renewed: false, shareUrl: 'u' });
    await press(button('Publish'));
    expect(api.publish.mock.calls[0][1].requestId).toBeUndefined();
  });

  it('holds the asked port while answering, and refuses one the box refuses, with its reason (Bugbot, Devin, #1486)', async () => {
    api.list.mockResolvedValue({ links: [], requests: [{ ...REQUEST, port: 9229 }], ttlHoursDefault: 24, previewDomain: 'preview.test' });
    api.listeners.mockResolvedValue([
      { port: 5173, pid: 1, command: 'vite', verdict: { ok: true }, inCheckout: true },
      { port: 9229, pid: 2, command: 'node --inspect', verdict: { ok: false, code: 'devtools', reason: 'a debugger runs any code as you' }, inCheckout: true },
    ]);
    act(() => root.render(<PreviewLinksPanel projectId="p1" workstream="feature-x" />));
    await flush();
    expect((el.querySelector('.preview-links-select-button') as HTMLButtonElement).disabled).toBe(false);
    await press(button('Publish…'));
    expect((el.querySelector('.preview-links-select-button') as HTMLButtonElement).disabled).toBe(true);
    expect(el.querySelector('.preview-links-answering')?.textContent).toContain("can't be published: a debugger runs any code as you");
    expect(button('Publish').disabled).toBe(true);
  });

  it('publishes a request from the implicit main checkout in Share on main, and hides the empty-box hint for its port (Devin, Bugbot, #1486)', async () => {
    api.list.mockResolvedValue({ links: [], requests: [{ ...REQUEST, workstreamId: null, port: 4000 }], ttlHoursDefault: 24, previewDomain: 'preview.test' });
    api.listeners.mockResolvedValue([]);
    act(() => root.render(<PreviewLinksPanel projectId="p1" workstream="main" />));
    await flush();
    expect(el.textContent).toContain('Nothing listens on this box yet');
    expect(el.querySelector('[aria-label="Agent requests"]')?.textContent).toContain('Port 4000 on main');
    await press(button('Publish…'));
    expect(el.textContent).not.toContain('Nothing listens on this box yet');
    expect(el.querySelector('.preview-links-select-button')?.textContent).toContain('4000 · nothing listens yet');
  });
});

describe('a double-click', () => {
  it('sends a change once (Bugbot, #1486)', async () => {
    let done: (v: unknown) => void = () => {};
    api.declineRequest.mockImplementation(() => new Promise(r => { done = r; }));
    render([], [REQUEST]);
    const decline = button('Decline');
    await act(async () => { decline.click(); decline.click(); });
    expect(api.declineRequest).toHaveBeenCalledTimes(1);
    await act(async () => { done({}); });
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it('disables every action while one is in flight, rather than dropping a click (Devin, #1486)', async () => {
    let done: (v: unknown) => void = () => {};
    api.revoke.mockImplementation(() => new Promise(r => { done = r; }));
    render([link()], [REQUEST]);
    await act(async () => { button('Revoke').click(); });
    expect(button('Decline').disabled).toBe(true);
    expect(button('Extend to 24 h from now').disabled).toBe(true);
    await act(async () => { done({}); });
    expect(button('Decline').disabled).toBe(false);
  });
});

describe('the panel', () => {
  it('applies only the latest read of the list (Bugbot, #1486)', async () => {
    const reads: Array<(v: unknown) => void> = [];
    api.list.mockImplementation(() => new Promise(r => { reads.push(r); }));
    api.listeners.mockResolvedValue([]);
    act(() => root.render(<PreviewLinksPanel projectId="p1" workstream="feature-x" />));
    const answer = (live: boolean) => ({ links: [live ? link() : link({ live: false, endedAt: iso(0), endReason: 'revoked' })], requests: live ? [REQUEST] : [], ttlHoursDefault: 24, previewDomain: 'preview.test' });
    await act(async () => { reads[0](answer(true)); });
    await press(button('Revoke'));
    await press(button('Decline'));
    expect(reads).toHaveLength(3);
    // The later read lands first, then the earlier, slower one: the list stays as the later one says.
    await act(async () => { reads[2](answer(false)); });
    await act(async () => { reads[1](answer(true)); });
    expect(button('Revoke')).toBeUndefined();
    expect(el.textContent).toContain('revoked');
  });

  it('offers no Publish on an asked port before the box has listed its ports (Bugbot, #1486)', async () => {
    api.list.mockResolvedValue({ links: [], requests: [REQUEST], ttlHoursDefault: 24, previewDomain: 'preview.test' });
    api.listeners.mockImplementation(() => new Promise(() => {}));
    act(() => root.render(<PreviewLinksPanel projectId="p1" workstream="feature-x" />));
    await flush();
    await press(button('Publish…'));
    expect(button('Publish').disabled).toBe(true);
  });
});

