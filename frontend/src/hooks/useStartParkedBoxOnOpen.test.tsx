// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, InstanceStatus } from '../types';

const mocks = vi.hoisted(() => ({
  boxes: [] as Instance[],
  list: vi.fn(),
  start: vi.fn(),
}));
vi.mock('../services/api', () => ({ instancesApi: { list: mocks.list, start: mocks.start } }));

import { boxFeed } from '../services/boxFeed';
import { reportStoredOpen } from '../chat/storedOpen';
import { useStartParkedBoxOnOpen } from './useStartParkedBoxOnOpen';

// The hook's starter is one per tab (module state), so every test uses its
// own box ids and nothing it remembers reaches the next test.
let seq = 0;
let id = (name: string) => name;
const box = (name: string, status: InstanceStatus) =>
  ({ id: id(name), name, kind: 'ec2', ec2InstanceId: `i-${name}`, status }) as Instance;

function Open({ projectId, instanceId, ws = 'main', showsStored = false }: { projectId: string | null; instanceId?: string; ws?: string; showsStored?: boolean }) {
  useStartParkedBoxOnOpen(projectId ? { id: projectId, instanceId: instanceId && id(instanceId) } : undefined, ws, showsStored);
  return null;
}

let root: Root;
let el: HTMLDivElement;
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const setBoxes = async (...boxes: Instance[]) => { mocks.boxes = boxes; await act(() => boxFeed.reload()); };

beforeEach(async () => {
  seq += 1;
  id = (name: string) => `${name}-t${seq}`;
  mocks.boxes = [];
  mocks.list.mockReset().mockImplementation(async () => mocks.boxes);
  mocks.start.mockReset().mockResolvedValue({ ok: true, status: 'starting' });
  boxFeed.start();
  await flush();
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); boxFeed.stop(); });

describe('useStartParkedBoxOnOpen', () => {
  it('starts the open project\'s stopped box, once', async () => {
    await setBoxes(box('b1', 'stopped'));
    mocks.list.mockImplementation(async () => [box('b1', 'starting')]);
    act(() => root.render(<Open projectId="p1" instanceId="b1" />));
    await flush();
    act(() => root.render(<Open projectId="p1" instanceId="b1" />));
    await flush();
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.start).toHaveBeenCalledWith(id('b1'));
  });

  it('sends nothing for a box that is already starting', async () => {
    await setBoxes(box('b1', 'starting'));
    act(() => root.render(<Open projectId="p1" instanceId="b1" />));
    await flush();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('decides once per open: a box that goes down while its project stays open is left down', async () => {
    await setBoxes(box('b1', 'ready'));
    act(() => root.render(<Open projectId="p1" instanceId="b1" />));
    await flush();
    await setBoxes(box('b1', 'stopped'));
    await flush();
    expect(mocks.start).not.toHaveBeenCalled();
    // Opening another workstream of it is a new open.
    act(() => root.render(<Open projectId="p1" instanceId="b1" ws="feat" />));
    await flush();
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it('starts a shared box once when two of its projects are opened in turn', async () => {
    await setBoxes(box('b1', 'stopped'));
    mocks.list.mockImplementation(async () => [box('b1', 'starting')]);
    act(() => root.render(<Open projectId="p1" instanceId="b1" />));
    await flush();
    act(() => root.render(<Open projectId="p2" instanceId="b1" />));
    await flush();
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it('never asks for a box outside the caller\'s list (someone else\'s box)', async () => {
    await setBoxes(box('mine', 'stopped'));
    act(() => root.render(<Open projectId="p1" instanceId="owners-box" />));
    await flush();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('waits for a fresh list on return, instead of deciding from the copy kept while the feed was stopped', async () => {
    await setBoxes(box('b1', 'ready'));
    // Off to the dashboard: the feed stops and keeps its list, which says ready.
    boxFeed.stop();
    // The box parks meanwhile; back in the workspace, the feed starts again
    // and its fetch is still out when the project opens.
    let answer!: (boxes: Instance[]) => void;
    mocks.list.mockImplementation(() => new Promise<Instance[]>(r => { answer = r; }));
    boxFeed.start();
    act(() => root.render(<Open projectId="p1" instanceId="b1" />));
    await flush();
    expect(mocks.start).not.toHaveBeenCalled();
    mocks.list.mockImplementation(async () => [box('b1', 'starting')]);
    await act(async () => { answer([box('b1', 'stopped')]); await new Promise(r => setTimeout(r, 0)); });
    await flush();
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it('waits for a box the list does not have yet, rather than spending the open', async () => {
    await setBoxes(box('other', 'ready'));
    act(() => root.render(<Open projectId="p1" instanceId="b1" />));
    await flush();
    await setBoxes(box('other', 'ready'), box('b1', 'stopped'));
    await flush();
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it('decides again when the open project moves onto a parked box', async () => {
    await setBoxes(box('b1', 'ready'), box('b2', 'stopped'));
    act(() => root.render(<Open projectId="p1" instanceId="b1" />));
    await flush();
    expect(mocks.start).not.toHaveBeenCalled();
    act(() => root.render(<Open projectId="p1" instanceId="b2" />));
    await flush();
    expect(mocks.start).toHaveBeenCalledWith(id('b2'));
  });
});

// A simple-UI chat with a stored transcript opens on it and leaves its box
// alone (chat/storedOpen.ts); one with nothing stored is started, as before.
describe('useStartParkedBoxOnOpen in a view that shows the stored transcript', () => {
  const key = () => `p-t${seq}|main`;
  afterEach(() => { reportStoredOpen(key(), null); });

  it('waits for the history, and starts nothing for a stopped box whose transcript is stored', async () => {
    await setBoxes(box('b1', 'stopped'));
    act(() => root.render(<Open projectId={`p-t${seq}`} instanceId="b1" showsStored />));
    await flush();
    expect(mocks.start).not.toHaveBeenCalled();
    act(() => reportStoredOpen(key(), 'stored'));
    await flush();
    expect(mocks.start).not.toHaveBeenCalled();
    // Decided: the stored view stays the answer for this open, whatever loads after.
    act(() => reportStoredOpen(key(), 'none'));
    await flush();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('a hibernated box with a stored transcript is left hibernated', async () => {
    await setBoxes(box('b1', 'hibernated'));
    act(() => root.render(<Open projectId={`p-t${seq}`} instanceId="b1" showsStored />));
    act(() => reportStoredOpen(key(), 'stored'));
    await flush();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('starts the box on open when nothing is stored (an old box, or a chat from before the store)', async () => {
    await setBoxes(box('b1', 'stopped'));
    act(() => root.render(<Open projectId={`p-t${seq}`} instanceId="b1" showsStored />));
    await flush();
    act(() => reportStoredOpen(key(), 'none'));
    await flush();
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.start).toHaveBeenCalledWith(id('b1'));
  });

  it('a view that does not show stored transcripts (the full UI, the phone) starts the box at once, as before', async () => {
    await setBoxes(box('b1', 'stopped'));
    act(() => reportStoredOpen(key(), 'stored'));
    act(() => root.render(<Open projectId={`p-t${seq}`} instanceId="b1" />));
    await flush();
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });
});
