// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ endPreviewLink: vi.fn() }));
vi.mock('../../services/adminApi', () => ({ adminApi: api }));
const flags = vi.hoisted(() => ({ on: {} as Record<string, boolean> }));
vi.mock('../../flags', async () => {
  const actual = await vi.importActual<typeof import('../../flags')>('../../flags');
  return { ...actual, useFlag: (key: string, fallback: unknown) => (key in flags.on ? flags.on[key] : fallback) };
});
const { AdminPreviewLinkEnd, linkRef } = await import('./AdminPreviewLinkEnd');

let root: Root;
let el: HTMLDivElement;
beforeEach(() => {
  const css = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
  if (!css?.escape) (globalThis as { CSS?: unknown }).CSS = { ...css, escape: (v: string) => v.replace(/[^\w-]/g, c => `\\${c}`) };
  api.endPreviewLink.mockReset();
  flags.on = { 'preview-links-enabled': true };
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); });

const button = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text) as HTMLButtonElement;
function type(value: string) {
  const input = el.querySelector('.admin-preview-end-field input') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}

describe('the admin end-link button', () => {
  it('reads a cuid as the link\'s id and anything else valid as its name', () => {
    expect(linkRef('cmw5cw05n1yzda4ivy1n7sv2b')).toEqual({ id: 'cmw5cw05n1yzda4ivy1n7sv2b' });
    expect(linkRef(' Shop-Feature-X ')).toEqual({ name: 'shop-feature-x' });
    expect(linkRef('shop2demo')).toEqual({ name: 'shop2demo' });
    expect(linkRef('-bad')).toBeNull();
    expect(linkRef('')).toBeNull();
  });

  it('shows with every flag off: /admin has no flag provider, so the server decides (Bugbot, #1487)', () => {
    flags.on = {};
    act(() => root.render(<AdminPreviewLinkEnd />));
    expect(el.textContent).toContain('End a preview link');
  });

  it('asks before it ends a link, then posts the name with confirm and says what happened', async () => {
    api.endPreviewLink.mockResolvedValue({ link: { id: 'c1', name: 'shop-feature-x', endedAt: 'now', endReason: 'admin' } });
    act(() => root.render(<AdminPreviewLinkEnd />));
    expect(button('End link…').disabled).toBe(true);
    type('shop-feature-x');
    await act(async () => { button('End link…').click(); });
    expect(api.endPreviewLink).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('End shop-feature-x?');
    await act(async () => { button('End link').click(); });
    expect(api.endPreviewLink).toHaveBeenCalledWith({ name: 'shop-feature-x' });
    expect(el.querySelector('[role="status"]')?.textContent).toContain('Ended shop-feature-x');
  });

  it('cancels without ending anything, and shows a refusal', async () => {
    api.endPreviewLink.mockRejectedValue({ response: { data: { error: 'Not found' } } });
    act(() => root.render(<AdminPreviewLinkEnd />));
    type('nope-link');
    await act(async () => { button('End link…').click(); });
    await act(async () => { button('Cancel').click(); });
    expect(api.endPreviewLink).not.toHaveBeenCalled();
    await act(async () => { button('End link…').click(); });
    await act(async () => { button('End link').click(); });
    expect(el.querySelector('[role="alert"]')?.textContent).toBe('Not found');
  });
});
