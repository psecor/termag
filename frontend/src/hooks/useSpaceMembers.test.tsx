// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ members: vi.fn(), boxes: vi.fn() }));
vi.mock('../services/api', () => ({ spacesApi: { members: mocks.members, boxes: mocks.boxes } }));

import { useSpaceMembers, type SpaceMembers } from './useSpaceMembers';

let root: Root;
let el: HTMLDivElement;
let got: SpaceMembers;
function Probe({ space }: { space: string }) {
  got = useSpaceMembers(space);
  return null;
}
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const member = (userId: string, role: 'owner' | 'editor' | 'viewer') => ({ userId, email: `${userId}@example.com`, displayName: userId, role, addedAt: '' });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.members.mockResolvedValue({ sharing: true, members: [member('ada', 'owner')], invites: [] });
  mocks.boxes.mockResolvedValue({ boxes: [{ id: 'b1', name: 'box-1', kind: 'ec2', status: 'ready', ownerEmail: 'ada@example.com', mine: true, children: [] }] });
  el = document.createElement('div');
  root = createRoot(el);
});

afterEach(() => { act(() => root.unmount()); vi.clearAllMocks(); });

describe('useSpaceMembers', () => {
  it('loads people, boxes and the server\'s sharing answer', async () => {
    act(() => root.render(<Probe space="notes" />));
    expect(got.loaded).toBe(false);
    expect(got.sharing).toBeNull();
    await flush();
    expect(mocks.members).toHaveBeenCalledWith('notes');
    expect(got.loaded).toBe(true);
    expect(got.sharing).toBe(true);
    expect(got.members.map(m => m.userId)).toEqual(['ada']);
    expect(got.boxes.map(b => b.name)).toEqual(['box-1']);
  });

  it('reports sharing off as the server says, whatever the browser thinks', async () => {
    mocks.members.mockResolvedValue({ sharing: false, members: [member('ada', 'owner')], invites: [] });
    act(() => root.render(<Probe space="notes" />));
    await flush();
    expect(got.sharing).toBe(false);
  });

  it('reloads after a change, and runs what follows it', async () => {
    act(() => root.render(<Probe space="notes" />));
    await flush();
    mocks.members.mockResolvedValue({ sharing: true, members: [member('ada', 'owner'), member('bo', 'editor')], invites: [] });
    const after = vi.fn();
    let ok = false;
    await act(async () => { ok = await got.act(() => Promise.resolve(), 'Could not add', after); });
    expect(ok).toBe(true);
    expect(after).toHaveBeenCalledTimes(1);
    expect(got.members.map(m => m.userId)).toEqual(['ada', 'bo']);
    expect(got.error).toBe('');
  });

  it('turns a failure into the error, with the server\'s message, and stops there', async () => {
    act(() => root.render(<Probe space="notes" />));
    await flush();
    const calls = mocks.members.mock.calls.length;
    const after = vi.fn();
    let ok = true;
    await act(async () => {
      ok = await got.act(() => Promise.reject({ response: { data: { error: 'A space needs at least one owner', code: 'last_owner' } } }), 'Could not change', after);
    });
    expect(ok).toBe(false);
    expect(got.error).toBe('A space needs at least one owner');
    expect(after).not.toHaveBeenCalled();
    expect(mocks.members.mock.calls.length).toBe(calls);
    await act(async () => { await got.act(() => Promise.reject(new Error('')), 'Could not change'); });
    expect(got.error).toBe('Could not change');
  });

  it('says when the lists could not load', async () => {
    mocks.members.mockRejectedValue({ response: { data: { error: 'Not found' } } });
    act(() => root.render(<Probe space="gone" />));
    await flush();
    expect(got.loaded).toBe(false);
    expect(got.error).toBe('Not found');
  });
});
