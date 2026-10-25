// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceView } from '../services/api';
import type { SpaceChoice } from './chatSpaces';
import { useSpaceStep } from './useSpaceStep';

const mocks = vi.hoisted(() => {
  let resolve: (v: { spaces: SpaceView[] }) => void = () => {};
  return {
    enabled: true,
    list: vi.fn(() => new Promise<{ spaces: SpaceView[] }>(r => { resolve = r; })),
    addBox: vi.fn(async () => ({})),
    resolveList: (spaces: SpaceView[]) => resolve({ spaces }),
  };
});

vi.mock('../flags', () => ({
  FLAGS: { spaces: 'spaces-enabled' },
  useFlag: () => mocks.enabled,
}));
vi.mock('../services/api', () => ({
  spacesApi: { list: mocks.list, create: vi.fn(), addBox: mocks.addBox, boxes: vi.fn() },
}));

const notes: SpaceView = { id: '1', name: 'notes', description: null, createdAt: '', usedBytes: 0, quotaBytes: 1, role: 'owner', readOnly: false };

type Step = ReturnType<typeof useSpaceStep>;
let renders: Array<{ ready: boolean; value: SpaceChoice }>;
let latest: Step;

function Harness({ requested }: { requested: string | null }) {
  latest = useSpaceStep(requested);
  renders.push({ ready: latest.ready, value: latest.pickerProps.value });
  return null;
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.enabled = true;
  mocks.list.mockClear();
  mocks.addBox.mockClear();
  renders = [];
  host = document.createElement('div');
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
});

describe('useSpaceStep', () => {
  it('is not ready, and prepare refuses, until the space list has loaded', async () => {
    act(() => root.render(<Harness requested="notes" />));
    expect(latest.ready).toBe(false);
    await expect(latest.prepare()).rejects.toThrow(/still loading/);

    await act(async () => mocks.resolveList([notes]));
    expect(latest.ready).toBe(true);
    await expect(latest.prepare()).resolves.toBe('notes');
  });

  it('holds the ?space= choice on the first render that is ready', async () => {
    act(() => root.render(<Harness requested="notes" />));
    await act(async () => mocks.resolveList([notes]));
    const firstReady = renders.find(r => r.ready);
    expect(firstReady?.value).toEqual({ kind: 'existing', name: 'notes' });
  });

  it('keeps what the user picked over ?space=', async () => {
    act(() => root.render(<Harness requested="notes" />));
    await act(async () => mocks.resolveList([notes]));
    act(() => latest.pickerProps.onChange({ kind: 'none' }));
    await expect(latest.prepare()).resolves.toBeNull();
  });

  it('is ready at once and grants nothing while spaces are off', async () => {
    mocks.enabled = false;
    act(() => root.render(<Harness requested="notes" />));
    expect(latest.ready).toBe(true);
    await expect(latest.prepare()).resolves.toBeNull();
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
