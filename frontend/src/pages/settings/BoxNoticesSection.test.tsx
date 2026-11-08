// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  user: {} as { boxIdleNotify?: boolean },
  updatePreferences: vi.fn(),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));

import { BoxNoticesSection } from './BoxNoticesSection';

let root: Root;
let el: HTMLDivElement;
const render = () => act(() => root.render(<BoxNoticesSection />));
const box = () => el.querySelector('#box-notices input[type="checkbox"]') as HTMLInputElement;

beforeEach(() => {
  auth.user = {};
  auth.updatePreferences.mockReset();
  auth.updatePreferences.mockResolvedValue(undefined);
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); });

describe('Settings > Box notices', () => {
  it('is on for a user who never set it, and an older backend that sends nothing', () => {
    render();
    expect(box().checked).toBe(true);
    expect(el.textContent).toContain('Message me in Slack when termag stops one of my boxes');
  });

  it('is off once turned off, and saves the choice as boxIdleNotify', async () => {
    auth.user = { boxIdleNotify: true };
    render();
    await act(async () => { box().click(); });
    expect(auth.updatePreferences).toHaveBeenCalledWith({ boxIdleNotify: false });
    auth.user = { boxIdleNotify: false };
    render();
    expect(box().checked).toBe(false);
    expect(el.textContent).toContain('boxes still stop');
  });

  it('says so when the save fails', async () => {
    auth.updatePreferences.mockRejectedValue(new Error('nope'));
    render();
    await act(async () => { box().click(); });
    expect(el.textContent).toContain('Could not save that.');
  });
});
