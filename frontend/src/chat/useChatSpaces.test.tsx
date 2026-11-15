// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceBoxGrant, SpaceView } from '../services/api';
import { ChatSpacesProvider, useChatSpaces, useWhenSpacesLoaded, type ChatSpaces, type SharedChatSpaces } from './useChatSpaces';
import { spaceColor } from './spaceColors';

const mocks = vi.hoisted(() => {
  const pending: Array<() => void> = [];
  return {
    boxes: [] as string[],
    pending,
    list: vi.fn(() => new Promise<{ spaces: SpaceView[] }>(r => {
      pending.push(() => r({ spaces: [{ id: '1', name: 'mine', description: null, createdAt: '', usedBytes: 0, quotaBytes: 1, role: 'owner', readOnly: false }] }));
    })),
  };
});

vi.mock('../services/api', () => ({
  spacesApi: {
    list: mocks.list,
    boxes: async () => ({ boxes: mocks.boxes.map(id => ({ id, name: id, kind: 'ec2', status: 'ready', ownerEmail: null, mine: true, children: [] }) as SpaceBoxGrant) }),
  },
}));

let latest: ChatSpaces;
function Harness({ reloadKey }: { reloadKey: string }) {
  latest = useChatSpaces({ withBoxes: true, reloadKey });
  return null;
}

let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  root = createRoot(document.createElement('div'));
  mocks.pending.length = 0;
});
afterEach(() => { act(() => root.unmount()); });

async function settle() {
  await act(async () => { mocks.pending.splice(0).forEach(r => r()); await new Promise(r => setTimeout(r, 0)); });
}

describe('useChatSpaces', () => {
  it('marks the index stale while a new box\'s reload is in flight', async () => {
    mocks.boxes = ['box-a'];
    act(() => root.render(<Harness reloadKey="box-a" />));
    expect(latest.current).toBe(false);
    await settle();
    expect(latest.current).toBe(true);
    expect(latest.index.get('box-a')).toEqual(['mine']);

    // A session starts in the space: its box is granted, then appears.
    mocks.boxes = ['box-a', 'box-b'];
    act(() => root.render(<Harness reloadKey="box-a,box-b" />));
    expect(latest.loaded).toBe(true);
    expect(latest.current).toBe(false);
    expect(latest.index.has('box-b')).toBe(false);
    await settle();
    expect(latest.current).toBe(true);
    expect(latest.index.get('box-b')).toEqual(['mine']);
  });

  it('keeps the spaces it has when a reload fails, so the sidebar doesn\'t empty', async () => {
    mocks.boxes = ['box-a'];
    act(() => root.render(<Harness reloadKey="box-a" />));
    await settle();
    expect(latest.spaces.map(s => s.name)).toEqual(['mine']);
    // A change in the Share dialog asks for a reload, and the list request fails.
    mocks.list.mockImplementationOnce(() => Promise.reject(new Error('Network Error')));
    act(() => latest.reload!());
    await settle();
    expect(latest.loaded).toBe(true);
    expect(latest.spaces.map(s => s.name)).toEqual(['mine']);
    expect(latest.index.get('box-a')).toEqual(['mine']);
    expect(latest.current).toBe(true);
  });

  it('still settles as loaded and empty when the first load fails', async () => {
    mocks.list.mockImplementationOnce(() => Promise.reject(new Error('Network Error')));
    act(() => root.render(<Harness reloadKey="" />));
    await settle();
    expect(latest.loaded).toBe(true);
    expect(latest.spaces).toEqual([]);
  });
});


describe('useWhenSpacesLoaded', () => {
  const shared = (loaded: boolean): SharedChatSpaces => ({ loaded, spaces: [], index: new Map(), current: loaded, colorOf: spaceColor });
  let get: () => Promise<string | null>;
  function Asker({ value, chat = 'p/a' }: { value: string | null; chat?: string }) {
    get = useWhenSpacesLoaded(value, chat, 1000);
    return null;
  }

  it('waits for the spaces to land and gives the value they make', async () => {
    act(() => root.render(<ChatSpacesProvider value={shared(false)}><Asker value={null} /></ChatSpacesProvider>));
    let got: string | null | undefined;
    void get().then(v => { got = v; });
    await act(async () => { await Promise.resolve(); });
    expect(got).toBeUndefined();
    await act(async () => { root.render(<ChatSpacesProvider value={shared(true)}><Asker value="team-alpha" /></ChatSpacesProvider>); });
    expect(got).toBe('team-alpha');
    await expect(get()).resolves.toBe('team-alpha');
  });

  it('gives up with null when they never land', async () => {
    vi.useFakeTimers();
    try {
      act(() => root.render(<ChatSpacesProvider value={shared(false)}><Asker value="team-alpha" /></ChatSpacesProvider>));
      const got = get();
      await act(async () => { vi.advanceTimersByTime(1000); });
      await expect(got).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails a wait when its chat unmounts, rather than giving null', async () => {
    act(() => root.render(<ChatSpacesProvider value={shared(false)}><Asker value="team-alpha" /></ChatSpacesProvider>));
    const got = expect(get()).rejects.toThrow('the chat closed before its spaces loaded');
    act(() => root.render(<ChatSpacesProvider value={shared(false)}>{null}</ChatSpacesProvider>));
    await got;
  });

  it('fails a wait when the chat changes, rather than giving the next chat\'s space', async () => {
    act(() => root.render(<ChatSpacesProvider value={shared(false)}><Asker value={null} chat="p/a" /></ChatSpacesProvider>));
    const got = expect(get()).rejects.toThrow('the chat closed before its spaces loaded');
    await act(async () => { root.render(<ChatSpacesProvider value={shared(true)}><Asker value="other-space" chat="p/b" /></ChatSpacesProvider>); });
    await got;
    await expect(get()).resolves.toBe('other-space');
  });

  it('does not wait outside a ChatSpacesProvider', async () => {
    act(() => root.render(<Asker value={null} />));
    await expect(get()).resolves.toBeNull();
  });
});
