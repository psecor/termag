// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({ statusMap: {} as Record<string, { status: string }> }));
vi.mock('../contexts/ProjectContext', () => ({ useProjects: () => ({ statusMap: state.statusMap }) }));
vi.mock('./push', async (importOriginal) => ({
  ...await importOriginal<typeof import('./push')>(),
  checkTappedNotification: vi.fn(),
}));
vi.mock('./shownNotifications', async (importOriginal) => ({
  ...await importOriginal<typeof import('./shownNotifications')>(),
  infersTaps: () => true,
}));

import { checkTappedNotification } from './push';
import { useInferredNotificationTap } from './useInferredNotificationTap';

let where = '';
function Probe() {
  useInferredNotificationTap();
  const { pathname, search } = useLocation();
  where = `${pathname}${search}`;
  return null;
}

let root: Root | null = null;
async function mount() {
  root = createRoot(document.createElement('div'));
  await act(async () => {
    root!.render(<MemoryRouter initialEntries={['/chat']}><Probe /></MemoryRouter>);
  });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

const TAPPED = { tag: 'box-a|alice-cx-agent', url: 'https://t.example/termag/chat/p/p1?ws=feat', at: 0 };

beforeEach(() => {
  where = '';
  state.statusMap = {};
  vi.mocked(checkTappedNotification).mockReset().mockResolvedValue(TAPPED);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe('useInferredNotificationTap', () => {
  it('opens a tapped needs-you notification while its session still waits', async () => {
    state.statusMap = { 'box-a|alice-cx-agent': { status: 'waiting' } };
    await mount();
    expect(checkTappedNotification).toHaveBeenCalledWith(true);
    expect(where).toBe('/chat/p/p1?ws=feat');
  });

  it('opens nothing once its session stopped waiting', async () => {
    state.statusMap = { 'box-a|alice-cx-agent': { status: 'working' } };
    await mount();
    expect(where).toBe('/chat');
  });

});
