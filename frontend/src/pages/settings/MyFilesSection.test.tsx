// @vitest-environment jsdom
// Settings → My files (part B): the switch and the space.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  user: {} as { myFilesOnBoxes?: boolean; myFilesSpace?: string | null },
  updatePreferences: vi.fn(),
}));
const flags = vi.hoisted(() => ({ on: true }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../../flags', async importOriginal => {
  const actual = await importOriginal<typeof import('../../flags')>();
  return { ...actual, useFlag: <T,>(_key: string, fallback: T) => (flags.on as T) ?? fallback };
});

import { MyFilesSection } from './MyFilesSection';

let root: Root;
let el: HTMLDivElement;
const render = () => act(() => root.render(<MyFilesSection />));
const toggle = () => el.querySelector('#my-files input[type="checkbox"], #my-files [role="switch"]') as HTMLInputElement | null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  flags.on = true;
  auth.user = { myFilesOnBoxes: true, myFilesSpace: 'dev-my-files' };
  auth.updatePreferences.mockReset();
  auth.updatePreferences.mockResolvedValue(undefined);
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); });

describe('Settings > My files', () => {
  it('is on by default, names My files, and offers Use an existing space', () => {
    render();
    expect(toggle()?.checked).toBe(true);
    expect(el.textContent).toContain('Put My files on my boxes');
    expect(el.textContent).toContain('dev-my-files');
    expect(el.textContent).toContain('Use an existing space as My files…');
  });

  it('saves Off as myFilesOnBoxes: false and says the files stay', async () => {
    render();
    await act(async () => { toggle()!.click(); });
    expect(auth.updatePreferences).toHaveBeenCalledWith({ myFilesOnBoxes: false });
    auth.user = { myFilesOnBoxes: false, myFilesSpace: 'dev-my-files' };
    render();
    expect(toggle()?.checked).toBe(false);
    expect(el.textContent).toContain('Its files stay');
  });

  it('is not there with the flag off, or when the server sends no My files fields', () => {
    flags.on = false;
    render();
    expect(el.querySelector('#my-files')).toBeNull();
    flags.on = true;
    auth.user = {};
    render();
    expect(el.querySelector('#my-files')).toBeNull();
  });
});
