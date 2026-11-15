// @vitest-environment jsdom
// The sidebar's View options (ViewOptions.tsx): Sort, beside Group by, under the sidebar redesign only.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSidebarViewForTests, SIDEBAR_VIEW_KEY } from '../../chat/sidebarView';
import { ViewOptions } from './ViewOptions';

const flags = vi.hoisted(() => ({ redesign: false }));
vi.mock('../../flags', async importOriginal => {
  const actual = await importOriginal<typeof import('../../flags')>();
  return { ...actual, useFlag: <T,>(key: string, fallback: T) => (key === 'user-projects-enabled' ? flags.redesign as T : fallback) };
});

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  flags.redesign = false;
  localStorage.clear();
  resetSidebarViewForTests();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function open() {
  act(() => root.render(<ViewOptions />));
  act(() => host.querySelector<HTMLElement>('button[aria-label="View options"]')!.click());
}
const group = (label: string) => document.querySelector(`[role="radiogroup"][aria-label="${label}"], [aria-label="${label}"][role="group"]`);
const option = (label: string, name: string) =>
  [...(group(label)?.querySelectorAll<HTMLElement>('button, [role="radio"]') ?? [])].find(b => b.textContent?.trim() === name);

describe('View options: Sort', () => {
  it('offers Created and Recent activity under the redesign, Created to start, and keeps the pick', () => {
    flags.redesign = true;
    open();
    expect(group('Sort')).toBeTruthy();
    expect(option('Sort', 'Created')?.getAttribute('aria-checked') ?? option('Sort', 'Created')?.getAttribute('aria-pressed')).toBe('true');
    act(() => option('Sort', 'Recent activity')!.click());
    expect(JSON.parse(localStorage.getItem(SIDEBAR_VIEW_KEY)!)).toMatchObject({ sort: 'recent' });
    expect(option('Sort', 'Recent activity')?.getAttribute('aria-checked') ?? option('Sort', 'Recent activity')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('has no Sort with the flag off', () => {
    open();
    expect(group('Group by')).toBeTruthy();
    expect(group('Sort')).toBeNull();
  });
});

describe('View options: Files and new tabs', () => {
  const switchNamed = (name: string) => [...document.querySelectorAll('.chat-view-switch')].find(l => l.textContent?.includes(name));
  it('offers the switch with the flag off', () => {
    open();
    expect(switchNamed('Files and new tabs')).toBeTruthy();
  });

  it('has none under the redesign, whose files are the side panel\'s', () => {
    flags.redesign = true;
    open();
    expect(switchNamed('Files and new tabs')).toBeUndefined();
    expect(switchNamed("Sessions that aren't running")).toBeTruthy();
  });
});
