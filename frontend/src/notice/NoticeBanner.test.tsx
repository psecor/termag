// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setFlagValues } from '../flags';
import { NOTICE_DISMISSED_KEY } from './notice';
import { NoticeBanner } from './NoticeBanner';

vi.mock('../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));

const PSA = {
  id: 'chromium-psa-2026-11-13',
  tone: 'warning',
  title: 'Browsers are broken on boxes built since Nov 11.',
  message: "Open your box's **Terminal** tab and run `sudo snap install chromium`.",
  link: { label: 'Details', url: 'https://example.com/notices/chromium' },
  dismissible: true,
};

let root: Root;
let host: HTMLDivElement;

function show(value: unknown) {
  setFlagValues({ 'notice-banner': value });
  act(() => root.render(<NoticeBanner className="chat-pane-notice" />));
}
const alert = () => host.querySelector<HTMLElement>('[role="alert"]');
const closeButton = () => host.querySelector<HTMLButtonElement>('button[aria-label="Close"]');

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setFlagValues(undefined);
  vi.useRealTimers();
});

describe('NoticeBanner', () => {
  it('shows nothing for no notice', () => {
    for (const value of [null, {}, { id: 'x' }]) {
      show(value);
      expect(host.innerHTML, JSON.stringify(value)).toBe('');
    }
  });

  it('draws the notice in a LaunchPad Alert of its tone, with its link and commands', () => {
    show(PSA);
    const slot = host.querySelector<HTMLElement>('.notice-slot')!;
    expect(slot.classList.contains('chat-pane-notice')).toBe(true);
    expect(slot.classList.contains('lp-theme')).toBe(true);
    expect(slot.dataset.tone).toBe('warning');
    expect(alert()!.className).toMatch(/_warning/);
    expect(host.querySelector('.notice-title')!.textContent).toBe('Browsers are broken on boxes built since Nov 11.');
    expect(host.querySelector('.notice-text strong:not(.notice-title)')!.textContent).toBe('Terminal');
    expect(host.querySelector('.notice-cmd code')!.textContent).toBe('sudo snap install chromium');
    const link = host.querySelector<HTMLAnchorElement>('a.notice-link')!;
    expect(link.href).toBe('https://example.com/notices/chromium');
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
    expect(alert()!.textContent).toContain("Open your box's Terminal tab and run sudo snap install chromium.");
  });

  it('draws an outage as an error, and an undismissible one without Close', () => {
    show({ ...PSA, tone: 'outage', dismissible: false });
    expect(alert()!.className).toMatch(/_error/);
    expect(closeButton()).toBeNull();
  });

  it('shows markup it does not know as text', () => {
    show({ id: 'x', message: '<img src=x onerror="alert(1)"> [a](https://example.com) *b*' });
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelectorAll('a')).toHaveLength(0);
    expect(host.querySelector('.notice-text')!.textContent).toBe('<img src=x onerror="alert(1)"> [a](https://example.com) *b*');
  });

  it('stays dismissed in this browser until the id changes', () => {
    show(PSA);
    act(() => closeButton()!.click());
    expect(alert()).toBeNull();
    expect(JSON.parse(localStorage.getItem(NOTICE_DISMISSED_KEY)!)).toEqual(['chromium-psa-2026-11-13']);

    act(() => root.unmount());
    root = createRoot(host);
    show(PSA);
    expect(alert()).toBeNull();

    show({ ...PSA, id: 'chromium-psa-2026-11-13-r2' });
    expect(alert()).not.toBeNull();
  });

  it('hides when another tab dismisses it', () => {
    show(PSA);
    localStorage.setItem(NOTICE_DISMISSED_KEY, JSON.stringify([PSA.id]));
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: NOTICE_DISMISSED_KEY })); });
    expect(alert()).toBeNull();
  });

  it('hides itself at endsAt, and never shows one that has ended', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-20T22:59:00Z'));
    show({ ...PSA, endsAt: '2026-11-20T23:00:00Z' });
    expect(alert()).not.toBeNull();
    act(() => { vi.advanceTimersByTime(59_000); });
    expect(alert()).not.toBeNull();
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(alert()).toBeNull();

    show({ ...PSA, id: 'other', endsAt: '2026-11-20T22:00:00Z' });
    expect(alert()).toBeNull();
  });

  it('once ended, stays hidden without re-rendering itself', () => {
    // A clock that moves on every read, as the real one does between renders.
    let t = Date.parse('2026-11-21T00:00:00Z');
    let reads = 0;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => {
      if (++reads > 500) throw new Error('Date.now read in a loop');
      return t++;
    });
    try {
      show({ ...PSA, endsAt: '2026-11-20T23:00:00Z' });
      expect(alert()).toBeNull();
      expect(reads).toBeLessThan(50);
    } finally {
      spy.mockRestore();
    }
  });

  it('copies a command with a click', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    show(PSA);
    const cmd = host.querySelector<HTMLButtonElement>('.notice-cmd')!;
    expect(cmd.getAttribute('aria-label')).toBe('Copy sudo snap install chromium');
    await act(async () => { cmd.click(); });
    expect(writeText).toHaveBeenCalledWith('sudo snap install chromium');
    expect(host.querySelector('.notice-copied')!.textContent).toBe('Copied');
  });

  it('offers More only when the text is cut short', () => {
    show(PSA);
    expect(host.querySelector('.notice-more')).toBeNull();

    // jsdom has no layout: the clamped text overflows its three lines.
    const proto = HTMLElement.prototype;
    const saved = ['scrollHeight', 'clientHeight'].map(k => [k, Object.getOwnPropertyDescriptor(proto, k)] as const);
    const clampedText = (el: HTMLElement, cut: number, full: number) => (el.classList.contains('notice-text') ? cut : full);
    Object.defineProperty(proto, 'scrollHeight', { configurable: true, get() { return clampedText(this, 100, 0); } });
    Object.defineProperty(proto, 'clientHeight', { configurable: true, get() { return clampedText(this, 60, 0); } });
    try {
      show({ ...PSA, id: 'long' });
      const more = () => host.querySelector<HTMLElement>('.notice-more');
      expect(more()!.textContent).toBe('More');
      act(() => more()!.click());
      expect(host.querySelector('.notice-slot')!.hasAttribute('data-expanded')).toBe(true);
      expect(more()!.textContent).toBe('Less');
      expect(more()!.getAttribute('aria-expanded')).toBe('true');
    } finally {
      for (const [k, d] of saved) if (d) Object.defineProperty(proto, k, d); else delete (proto as unknown as Record<string, unknown>)[k];
    }
  });
});
