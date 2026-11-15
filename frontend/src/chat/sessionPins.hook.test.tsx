// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ flag: true, user: { id: 'u1' } as { id: string } | null }));
vi.mock('../services/api', () => ({ sessionPinsApi: {} }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock('../flags', () => ({ FLAGS: { userProjects: 'user-projects-enabled' }, useFlag: () => state.flag }));

import { SessionPinsStore, useSessionPins, type SessionPins } from './sessionPins';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(store: SessionPinsStore) {
  const seen: { current: SessionPins | null } = { current: null };
  function Probe() { seen.current = useSessionPins(store); return null; }
  const root = createRoot(document.createElement('div'));
  act(() => root.render(<Probe />));
  return { seen, rerender: () => act(() => root.render(<Probe />)), unmount: () => act(() => root.unmount()) };
}

const list = vi.fn();
const store = () => new SessionPinsStore({ list, pin: vi.fn(), unpin: vi.fn() }, new EventTarget());

beforeEach(() => {
  list.mockReset();
  list.mockResolvedValue([{ workstreamId: 'a', projectId: 'p1', workstream: 'main', pinnedAt: '2026-11-13T12:00:00.000Z' }]);
  state.flag = true;
  state.user = { id: 'u1' };
});

describe('useSessionPins', () => {
  it('reads the pins with user-projects-enabled on, and lets go when it unmounts', async () => {
    const s = store();
    const { seen, unmount } = mount(s);
    await act(async () => { await Promise.resolve(); });
    expect(list).toHaveBeenCalledTimes(1);
    expect(seen.current).toMatchObject({ enabled: true, settled: true });
    expect(seen.current!.pins?.map(p => p.workstreamId)).toEqual(['a']);
    expect(seen.current!.isPinned('a')).toBe(true);
    unmount();
    expect(s.getSnapshot().pins).toBeNull();
  });

  it('reads nothing with the flag off or signed out, and its pin does nothing', async () => {
    state.flag = false;
    const { seen } = mount(store());
    expect(seen.current).toMatchObject({ enabled: false, pins: null, settled: true });
    expect(await seen.current!.pin({ workstreamId: 'a', projectId: 'p1', workstream: 'main' })).toBe(false);
    state.flag = true;
    state.user = null;
    mount(store());
    expect(list).not.toHaveBeenCalled();
  });

  it('is not enabled when the server says pins are off', async () => {
    list.mockRejectedValue({ response: { status: 404, data: { code: 'session_pins_disabled' } } });
    const { seen } = mount(store());
    await act(async () => { await Promise.resolve(); });
    expect(seen.current).toMatchObject({ enabled: false, pins: null, settled: true, offOnServer: true });
  });
});
