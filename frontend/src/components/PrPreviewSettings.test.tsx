// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ flags: {} as Record<string, boolean>, api: { settings: vi.fn(), saveSettings: vi.fn() } }));
vi.mock('../flags', () => ({
  FLAGS: { prLinkShares: 'browser-pane-pr-link-shares-enabled' },
  useFlag: (key: string, fallback: boolean) => (key in mocks.flags ? mocks.flags[key] : fallback),
}));
vi.mock('../services/api', () => ({ previewSharesApi: mocks.api }));

import { PrPreviewSettings } from './PrPreviewSettings';

let root: Root;
let el: HTMLDivElement;
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const input = (i: number) => el.querySelectorAll('input')[i] as HTMLInputElement;
function type(field: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => { setter.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
}
const save = () => [...el.querySelectorAll('button')].find(b => b.textContent === 'Save') as HTMLButtonElement;

beforeEach(() => {
  mocks.flags = { 'browser-pane-pr-link-shares-enabled': true };
  mocks.api.settings.mockReset();
  mocks.api.saveSettings.mockReset();
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); });

describe('PR preview settings', () => {
  it('shows nothing, and asks nothing, with PR link shares off', async () => {
    mocks.flags = {};
    act(() => root.render(<PrPreviewSettings projectId="p1" />));
    await flush();
    expect(el.textContent).toBe('');
    expect(mocks.api.settings).not.toHaveBeenCalled();
  });

  it('loads the project\'s settings, saves only a change, and shows what the server kept', async () => {
    mocks.api.settings.mockResolvedValue({ prLinksEnabled: false, pathFilter: ['static/'], reviewerAccountHint: null, recipe: null });
    act(() => root.render(<PrPreviewSettings projectId="p1" />));
    await flush();
    expect(input(0).checked).toBe(false);
    expect(input(1).value).toBe('static/');
    expect(save().disabled).toBe(true);
    act(() => { input(0).click(); });
    type(input(1), 'static/ ./internal');
    type(input(2), 'me@x / pw');
    mocks.api.saveSettings.mockResolvedValue({ prLinksEnabled: true, pathFilter: ['static/', 'internal'], reviewerAccountHint: 'me@x / pw', recipe: null });
    await act(async () => { (el.querySelector('form') as HTMLFormElement).requestSubmit(); await new Promise(r => setTimeout(r, 0)); });
    expect(mocks.api.saveSettings).toHaveBeenCalledWith('p1', { prLinksEnabled: true, pathFilter: 'static/ ./internal', reviewerAccountHint: 'me@x / pw' });
    expect(input(1).value).toBe('static/ internal');
    expect(el.textContent).toContain('Saved.');
    expect(save().disabled).toBe(true);
  });

  it('shows the server\'s reason for a setting it refuses', async () => {
    mocks.api.settings.mockResolvedValue({ prLinksEnabled: false, pathFilter: [], reviewerAccountHint: null, recipe: null });
    act(() => root.render(<PrPreviewSettings projectId="p1" />));
    await flush();
    type(input(1), 'a/../b');
    mocks.api.saveSettings.mockRejectedValue({ response: { data: { error: 'not a path prefix: a/../b' } } });
    await act(async () => { (el.querySelector('form') as HTMLFormElement).requestSubmit(); await new Promise(r => setTimeout(r, 0)); });
    expect(el.querySelector('[role=alert]')?.textContent).toBe('not a path prefix: a/../b');
  });
});
