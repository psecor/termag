// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ listShares: vi.fn() }));
vi.mock('../services/api', () => ({ sharingApi: { listShares: mocks.listShares } }));

import { ownedProjectsKey, RETRY_FIRST_MS, RETRY_MAX_MS, useSharedProjectIds } from './useSharedProjectIds';

type P = { id: string; role?: 'owner' | 'collaborator' };
let root: Root;
let el: HTMLDivElement;
let got: ReturnType<typeof useSharedProjectIds>;
function Probe({ projects, userId }: { projects: P[]; userId: string | null }) {
  got = useSharedProjectIds(projects, userId);
  return null;
}
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const render = (projects: P[], userId: string | null = 'u1') => act(() => root.render(<Probe projects={projects} userId={userId} />));
const requested = () => mocks.listShares.mock.calls.map(c => c[0]).sort();

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.listShares.mockImplementation(async (id: string) => (id === 'a' ? [{ id: 's1' }] : []));
  el = document.createElement('div');
  root = createRoot(el);
});

afterEach(() => { act(() => root.unmount()); vi.clearAllMocks(); });

describe('ownedProjectsKey', () => {
  it('is the same for the same owned projects in any order, and leaves out shared-with-me ones', () => {
    expect(ownedProjectsKey([{ id: 'b' }, { id: 'a', role: 'owner' }, { id: 'c', role: 'collaborator' }]))
      .toBe(ownedProjectsKey([{ id: 'a' }, { id: 'b' }]));
    expect(ownedProjectsKey([{ id: 'a' }])).not.toBe(ownedProjectsKey([{ id: 'a' }, { id: 'b' }]));
  });
});

describe('useSharedProjectIds', () => {
  it('asks once per owned project and keeps the ones with a share', async () => {
    render([{ id: 'a' }, { id: 'b', role: 'owner' }, { id: 'c', role: 'collaborator' }]);
    await flush();
    expect(requested()).toEqual(['a', 'b']);
    expect([...got[0]]).toEqual(['a']);
  });

  it('does not ask again for a new list of the same projects (a reload every 2 s while a clone runs)', async () => {
    render([{ id: 'a' }, { id: 'b' }]);
    await flush();
    for (let i = 0; i < 5; i++) {
      render([{ id: 'b' }, { id: 'a' }, { id: 'c', role: 'collaborator' }]);
      await flush();
    }
    expect(requested()).toEqual(['a', 'b']);
    expect([...got[0]]).toEqual(['a']);
  });

  it('asks again when an owned project is added or removed', async () => {
    render([{ id: 'a' }]);
    await flush();
    render([{ id: 'a' }, { id: 'b' }]);
    await flush();
    expect(requested()).toEqual(['a', 'a', 'b']);
  });

  it('asks nothing while signed out', async () => {
    render([{ id: 'a' }], null);
    await flush();
    expect(mocks.listShares).not.toHaveBeenCalled();
  });

  describe('a failed read', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });
    const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

    it('is tried again later, for that project only, until it works', async () => {
      mocks.listShares.mockRejectedValueOnce(new Error('503'));
      render([{ id: 'a' }, { id: 'b' }]);
      await advance(0);
      expect(got[0].size).toBe(0);
      await advance(RETRY_FIRST_MS);
      expect(requested()).toEqual(['a', 'a', 'b']);
      expect([...got[0]]).toEqual(['a']);
      await advance(RETRY_MAX_MS * 2);
      expect(mocks.listShares).toHaveBeenCalledTimes(3);
    });

    it('keeps a badge it already had (the Share item that revokes, with box sharing off)', async () => {
      render([{ id: 'a' }]);
      await advance(0);
      expect([...got[0]]).toEqual(['a']);
      mocks.listShares.mockRejectedValueOnce(new Error('503'));
      render([{ id: 'a' }, { id: 'b' }]);
      await advance(0);
      expect([...got[0]]).toEqual(['a']);
    });

    it('waits twice as long each time, up to the cap', async () => {
      mocks.listShares.mockRejectedValue(new Error('503'));
      render([{ id: 'a' }]);
      await advance(0);
      const calls = () => mocks.listShares.mock.calls.length;
      await advance(RETRY_FIRST_MS);
      expect(calls()).toBe(2);
      await advance(RETRY_FIRST_MS * 2 - 1);
      expect(calls()).toBe(2);
      await advance(1);
      expect(calls()).toBe(3);
      await advance(RETRY_FIRST_MS * 4 + RETRY_FIRST_MS * 8);
      expect(calls()).toBe(5);
      await advance(RETRY_MAX_MS);
      expect(calls()).toBe(6);
      await advance(RETRY_MAX_MS);
      expect(calls()).toBe(7);
    });
  });

  it('lets the caller drop a project after its last share is revoked', async () => {
    render([{ id: 'a' }]);
    await flush();
    act(() => got[1](prev => { const next = new Set(prev); next.delete('a'); return next; }));
    expect(got[0].size).toBe(0);
  });
});
