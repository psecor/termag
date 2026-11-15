// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  user: {} as { boxPlacement?: string | null; boxPlacementOrg?: string },
  updatePreferences: vi.fn(),
  flags: {} as Record<string, unknown>,
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: mocks.user, updatePreferences: mocks.updatePreferences }) }));
vi.mock('../../flags', async () => {
  const actual = await vi.importActual<typeof import('../../flags')>('../../flags');
  return { ...actual, useFlag: (key: string, fallback: unknown) => (key in mocks.flags ? mocks.flags[key] : fallback) };
});

import { BoxPlacementSection } from './BoxPlacementSection';

let root: Root;
let el: HTMLDivElement;
const render = () => act(() => root.render(<BoxPlacementSection />));
const radio = (label: string) => [...el.querySelectorAll('label')].find(l => l.textContent?.includes(label))?.querySelector('input') as HTMLInputElement;

beforeEach(() => {
  mocks.flags = { 'box-placement-enabled': true };
  mocks.user = { boxPlacement: null, boxPlacementOrg: 'reuse-first' };
  mocks.updatePreferences.mockReset();
  mocks.updatePreferences.mockResolvedValue(undefined);
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); });

describe('Settings > Where new sessions run', () => {
  it('shows nothing with box-placement-enabled off, or from a backend that sends no org default', () => {
    mocks.flags = {};
    render();
    expect(el.textContent).toBe('');
    mocks.flags = { 'box-placement-enabled': true };
    mocks.user = {};
    render();
    expect(el.textContent).toBe('');
  });

  it("follows the org's default until a choice is made, and names it", () => {
    mocks.user = { boxPlacement: null, boxPlacementOrg: 'fresh-first' };
    render();
    expect(radio('A fresh box').checked).toBe(true);
    expect(radio('Reuse one of my boxes').checked).toBe(false);
    expect(el.textContent).toContain("Your default unless you pick a box. Your org's default is a fresh box.");
  });

  it('shows the choice made, and saves a new one as boxPlacement', async () => {
    mocks.user = { boxPlacement: 'fresh-first', boxPlacementOrg: 'reuse-first' };
    render();
    expect(radio('A fresh box').checked).toBe(true);
    expect(el.textContent).toContain("Your org's default is to reuse one of your boxes.");
    await act(async () => { radio('Reuse one of my boxes').click(); });
    expect(mocks.updatePreferences).toHaveBeenCalledWith({ boxPlacement: 'reuse-first' });
  });

  it('offers to follow the org again once a choice is made, and saves null', async () => {
    render();
    expect(el.textContent).not.toContain("Follow my org's default");
    mocks.user = { boxPlacement: 'fresh-first', boxPlacementOrg: 'reuse-first' };
    render();
    const follow = [...el.querySelectorAll('button')].find(b => b.textContent === "Follow my org's default") as HTMLButtonElement;
    await act(async () => { follow.click(); });
    expect(mocks.updatePreferences).toHaveBeenCalledWith({ boxPlacement: null });
  });

  it('says so when the save fails', async () => {
    mocks.updatePreferences.mockRejectedValue(new Error('nope'));
    render();
    await act(async () => { radio('A fresh box').click(); });
    expect(el.textContent).toContain('Could not save that.');
  });
});
