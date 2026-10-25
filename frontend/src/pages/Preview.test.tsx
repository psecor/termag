// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ get: vi.fn(), askWake: vi.fn(), wake: vi.fn() }));
vi.mock('../services/api', () => ({ previewSharesApi: api }));
const pane = vi.hoisted(() => ({ props: null as any }));
vi.mock('../components/BrowserPane', () => ({
  BrowserPane: (props: any) => { pane.props = props; return <div data-testid="pane">pane</div>; },
}));

import Preview from './Preview';

const active = { id: 'cshare0000000001', owner: { name: 'Olive' }, project: { name: 'webapp' }, workstream: 'feature-x', expiresAt: new Date(Date.now() + 5 * 3600e3).toISOString(), state: 'active', boxStatus: 'ready' };
let root: Root;
let el: HTMLDivElement;
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

function mount(path: string) {
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root.render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/preview/:shareId" element={<Preview />} /></Routes>
    </MemoryRouter>,
  ));
}

beforeEach(() => {
  pane.props = null;
  api.get.mockReset();
  api.askWake.mockReset();
  api.wake.mockReset();
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as any;
});
afterEach(() => { act(() => root.unmount()); el.remove(); });

describe('the reviewer\'s preview page', () => {
  it('opens the share\'s guest pane with a safe at, under the owner\'s header', async () => {
    api.get.mockResolvedValue(active);
    mount('/preview/cshare0000000001?at=%2Fdefault%2Fflags');
    await flush();
    expect(el.textContent).toContain("Olive's preview");
    expect(el.textContent).toContain('feature-x');
    expect(pane.props.share).toEqual({ shareId: 'cshare0000000001', at: '/default/flags', asGuest: false });
    expect(pane.props.url).toBe('about:blank');
    act(() => pane.props.onCheckout({ branch: 'feature-x', head: 'abcdef1234567', dirty: 3 }));
    expect(el.textContent).toContain('feature-x @ abcdef12');
    expect(el.textContent).toContain('3 uncommitted changes shown live');
  });

  it('drops an unsafe at, and says so for an owner previewing as guest', async () => {
    api.get.mockResolvedValue(active);
    mount('/preview/cshare0000000001?at=%2F%2Fevil.example&as=guest');
    await flush();
    expect(pane.props.share).toEqual({ shareId: 'cshare0000000001', at: null, asGuest: true });
    expect(el.textContent).toContain('previewing as your guest');
    expect(el.textContent).not.toContain('sign in as');
  });

  it('titles the tab after the preview, and gives the old title back when it goes', async () => {
    document.title = 'termag';
    api.get.mockResolvedValue(active);
    mount('/preview/cshare0000000001');
    await flush();
    expect(document.title).toBe("Olive's preview · webapp");
    act(() => root.render(<div />));
    expect(document.title).toBe('termag');
  });

  it('a PR\'s preview names the PR, and says when the box shows another commit than its head', async () => {
    const pr = { repo: 'example-org/webapp', number: 42, url: 'https://github.com/example-org/webapp/pull/42', headOid: 'f00dfeed1234567890' };
    api.get.mockResolvedValue({ ...active, pr });
    mount('/preview/cshare0000000001');
    await flush();
    const link = el.querySelector('a[href="https://github.com/example-org/webapp/pull/42"]');
    expect(link?.textContent).toBe('webapp#42');
    act(() => pane.props.onCheckout({ branch: 'feat/x', head: 'abcdef1234567', dirty: 0 }));
    expect(el.textContent).toContain('box @ abcdef12');
    expect(el.textContent).toContain('PR head @ f00dfeed');
    expect(el.querySelector('.preview-header-differs')).not.toBeNull();
    act(() => pane.props.onCheckout({ branch: 'feat/x', head: 'f00dfeed1234567890', dirty: 0 }));
    expect(el.querySelector('.preview-header-differs')).toBeNull();
  });

  it('tells the reviewer what to sign in to the app with', async () => {
    api.get.mockResolvedValue({ ...active, signInHint: 'reviewer@example.com / example-password' });
    mount('/preview/cshare0000000001');
    await flush();
    expect(el.querySelector('.preview-header-hint')?.textContent).toBe(' · sign in as reviewer@example.com / example-password');
  });

  it('says it isn\'t shared with you for a 404, and shows a closed share\'s reason to its grantee', async () => {
    api.get.mockRejectedValue({ response: { status: 404 } });
    mount('/preview/cshare0000000001');
    await flush();
    expect(el.textContent).toContain("This preview isn't shared with you.");
    expect(pane.props).toBeNull();
    act(() => root.unmount()); el.remove();
    api.get.mockResolvedValue({ ...active, state: 'expired', message: 'This preview has expired. Ask its owner to share it again.' });
    mount('/preview/cshare0000000001');
    await flush();
    expect(el.textContent).toContain('This preview has expired.');
    expect(pane.props).toBeNull();
  });

  it('asks a phone to open it on a desktop', async () => {
    window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as any;
    api.get.mockResolvedValue(active);
    mount('/preview/cshare0000000001');
    await flush();
    expect(el.textContent).toContain('Open this preview on a desktop');
    expect(pane.props).toBeNull();
  });

  it('tells an owner previewing their own share to start their box, with no one to ask', async () => {
    api.get.mockResolvedValue({ ...active, asOwner: true });
    mount('/preview/cshare0000000001?as=guest');
    await flush();
    act(() => pane.props.onClosed(4409, 'box asleep', "Olive's box is asleep."));
    expect(el.textContent).toContain('Your box is asleep');
    expect([...el.querySelectorAll('button')].some(b => b.textContent?.includes('Ask'))).toBe(false);
    expect([...el.querySelectorAll('button')].some(b => b.textContent === 'Try again')).toBe(true);
  });

  it('when the owner\'s box is asleep, offers to ask them on Slack, and to try again', async () => {
    api.get.mockResolvedValue(active);
    api.askWake.mockResolvedValue({ ok: true, sent: true });
    mount('/preview/cshare0000000001');
    await flush();
    act(() => pane.props.onClosed(4409, 'box asleep', "Olive's box is asleep."));
    expect(el.textContent).toContain("Olive's box is asleep");
    const askButton = [...el.querySelectorAll('button')].find(b => b.textContent?.includes('Ask Olive'))!;
    await act(async () => { askButton.click(); await new Promise(r => setTimeout(r, 0)); });
    expect(api.askWake).toHaveBeenCalledWith('cshare0000000001');
    expect(el.textContent).toContain('Asked Olive on Slack');
    // A second ask inside the backend's window is told so, not sent.
    api.askWake.mockRejectedValue({ response: { status: 429, data: { code: 'asked-recently' } } });
    await act(async () => { askButton.click(); await new Promise(r => setTimeout(r, 0)); });
    expect(el.textContent).toContain('Olive was asked a few minutes ago');
    const again = [...el.querySelectorAll('button')].find(b => b.textContent === 'Try again')!;
    pane.props = null;
    act(() => again.click());
    expect(pane.props).not.toBeNull();
  });

  it('a reviewer wakes a box the idle sweep put to sleep, then the pane dials again once it is up', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const pr = { repo: 'example-org/webapp', number: 42, url: 'https://github.com/example-org/webapp/pull/42', headOid: null };
      api.get.mockResolvedValue({ ...active, pr, boxStatus: 'hibernated', canWake: true });
      mount('/preview/cshare0000000001');
      await flush();
      const firstPane = pane.props;
      act(() => firstPane.onClosed(4409));
      await flush();
      const wakeButton = [...el.querySelectorAll('button')].find(b => b.textContent === 'Wake the box')!;
      expect(wakeButton).toBeDefined();
      expect(el.textContent).not.toContain('Ask Olive to wake it');
      api.wake.mockResolvedValue({ ok: true, status: 'starting' });
      api.get.mockResolvedValueOnce({ ...active, pr, boxStatus: 'starting', canWake: false }).mockResolvedValue({ ...active, pr, boxStatus: 'ready', canWake: false });
      await act(async () => { wakeButton.click(); });
      expect(api.wake).toHaveBeenCalledWith('cshare0000000001');
      expect(el.textContent).toContain("Waking Olive's box");
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(el.querySelector('[data-testid="pane"]')).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(el.querySelector('[data-testid="pane"]')).not.toBeNull();
      expect(pane.props).not.toBe(firstPane);
    } finally { vi.useRealTimers(); }
  });

  it('a wake the owner\'s budget refuses says why; a box its owner put to sleep offers only asking them', async () => {
    api.get.mockResolvedValue({ ...active, boxStatus: 'hibernated', canWake: true });
    mount('/preview/cshare0000000001');
    await flush();
    act(() => pane.props.onClosed(4409));
    await flush();
    api.wake.mockRejectedValue({ response: { status: 429, data: { error: 'This box was woken for a reviewer a few minutes ago.', code: 'too-soon' } } });
    await act(async () => { [...el.querySelectorAll('button')].find(b => b.textContent === 'Wake the box')!.click(); });
    await flush();
    expect(el.querySelector('.error-text')?.textContent).toBe('This box was woken for a reviewer a few minutes ago.');
    act(() => root.unmount());
    api.get.mockResolvedValue({ ...active, boxStatus: 'hibernated', canWake: false });
    mount('/preview/cshare0000000001');
    await flush();
    act(() => pane.props.onClosed(4409));
    await flush();
    expect([...el.querySelectorAll('button')].some(b => b.textContent === 'Wake the box')).toBe(false);
    expect(el.textContent).toContain("A reviewer can't wake it.");
  });

  it('a box that settles back down after a wake stops the wait at once, and offers waking again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      api.get.mockResolvedValue({ ...active, boxStatus: 'hibernated', canWake: true });
      mount('/preview/cshare0000000001');
      await flush();
      act(() => pane.props.onClosed(4409));
      await flush();
      api.wake.mockResolvedValue({ ok: true, status: 'starting' });
      api.get.mockResolvedValue({ ...active, boxStatus: 'hibernated', canWake: true });
      await act(async () => { [...el.querySelectorAll('button')].find(b => b.textContent === 'Wake the box')!.click(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(el.querySelector('.error-text')?.textContent).toBe("Olive's box didn't come up and is asleep again. You can try waking it again.");
      expect([...el.querySelectorAll('button')].find(b => b.textContent === 'Wake the box')?.disabled).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});
