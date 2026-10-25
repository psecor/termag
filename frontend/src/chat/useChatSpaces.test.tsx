// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceBoxGrant, SpaceView } from '../services/api';
import { useChatSpaces, type ChatSpaces } from './useChatSpaces';

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

vi.mock('../flags', () => ({ FLAGS: { spaces: 'spaces-enabled' }, useFlag: () => true }));
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
});
