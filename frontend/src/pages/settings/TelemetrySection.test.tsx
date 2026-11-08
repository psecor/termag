// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  user: {} as { telemetryTitles?: boolean },
  updatePreferences: vi.fn(),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));

import { TelemetrySection } from './TelemetrySection';

let root: Root;
let el: HTMLDivElement;
const render = () => act(() => root.render(<TelemetrySection />));
const box = () => el.querySelector('#telemetry input[type="checkbox"]') as HTMLInputElement;

beforeEach(() => {
  auth.user = {};
  auth.updatePreferences.mockReset();
  auth.updatePreferences.mockResolvedValue(undefined);
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); });

describe('Settings > Telemetry', () => {
  it('is on for a user who never set it, and an older backend that sends nothing', () => {
    render();
    expect(box().checked).toBe(true);
    expect(el.textContent).toContain('Include my chat titles');
  });

  it('is off once turned off, and saves the choice as telemetryTitles', async () => {
    auth.user = { telemetryTitles: true };
    render();
    await act(async () => { box().click(); });
    expect(auth.updatePreferences).toHaveBeenCalledWith({ telemetryTitles: false });
    auth.user = { telemetryTitles: false };
    render();
    expect(box().checked).toBe(false);
    expect(el.textContent).toContain('chat titles stay out');
  });
});
