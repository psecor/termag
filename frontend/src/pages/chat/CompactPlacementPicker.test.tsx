// @vitest-environment jsdom
// The compact "Where this session runs" (under user-projects-enabled): Auto and New box in sight, one line a
// box, the ones that are up then the asleep ones under one "wakes when you start", the rest folded, a filter from
// FILTER_FROM boxes, and one selection across the lists.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../types';
import { CompactPlacementPicker } from './CompactPlacementPicker';
import { AUTO, type PlacementBox, type PlacementView } from '../../chat/boxPlacement';

const mocks = vi.hoisted(() => ({
  terminate: vi.fn(async () => ({})),
  // The box itself (GET /api/instances/:id): its live projects, which the list doesn't carry.
  get: vi.fn(async (id: string): Promise<unknown> => ({ id, projects: id === 'dev-0' ? [{ id: 'p1', name: 'termag' }, { id: 'p2', name: 'orch', label: 'space orchestrator' }] : [] })),
  reload: vi.fn(async () => {}),
  statusMap: {} as Record<string, { status: string }>,
}));
vi.mock('../../services/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return { ...actual, instancesApi: { ...actual.instancesApi, terminate: mocks.terminate, get: mocks.get } };
});
vi.mock('../../services/boxFeed', () => ({ boxFeed: { reload: mocks.reload } }));
vi.mock('../../contexts/ProjectContext', () => ({ useProjects: () => ({ statusMap: mocks.statusMap }) }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const pbox = (id: string, over: Partial<PlacementBox> = {}): PlacementBox => ({
  instanceId: id, name: id, status: 'stopped', connected: false, heat: 'ok', heatReasons: [], load: null,
  sessions: 1, hasRepos: false, checkoutProjectId: null, lastUsedAt: null, ...over,
});
const placed = [
  pbox('up-a', { status: 'ready', connected: true, sessions: 2 }),
  ...Array.from({ length: 10 }, (_, i) => pbox(`dev-${i}`, { lastUsedAt: `2026-11-${String(12 - i).padStart(2, '0')}T00:00:00Z` })),
];
const view: PlacementView = { policy: 'reuse-first', policySource: 'org', recommended: { kind: 'box', instanceId: 'up-a', reason: ['Last used'] }, boxes: placed, newBox: { source: 'pool' } };
const instances = placed.map(b => ({
  id: b.instanceId, name: b.name, status: b.status, kind: b.instanceId === 'dev-1' ? 'external' : 'ec2',
})) as unknown as Instance[];

function render(selection = AUTO, onSelect = vi.fn(), onRetry = vi.fn()) {
  act(() => {
    root.render(
      <MemoryRouter>
        <CompactPlacementPicker view={view} failed={false} onRetry={onRetry} boxes={instances} selection={selection} onSelect={onSelect}
          autoName="up-a" newBoxTitle="New box" repoWords="has termag" wakingId={null} />
      </MemoryRouter>,
    );
  });
  return onSelect;
}
const rowNames = () => [...host.querySelectorAll('.cp-row .cp-name')].map(n => n.textContent);
const states = () => [...host.querySelectorAll('.cp-row .cp-state')].map(n => n.textContent);

describe('CompactPlacementPicker', () => {
  it('shows Auto, the box that is up, the most recent asleep ones, the rest folded, and New box', () => {
    render();
    expect(rowNames()).toEqual(['Auto (recommended)', 'up-a', 'dev-0', 'dev-1', 'dev-2', 'dev-3', 'New box']);
    expect(states()).toEqual(['up-a · Last used', 'Up · 2 sessions', 'Asleep · 1 session', 'Asleep · 1 session', 'Asleep · 1 session', 'Asleep · 1 session', 'A ready box from the pool']);
    // "wakes when you start" once, by its group, not on each row.
    expect(host.textContent!.match(/wakes when you start/g)).toHaveLength(1);
    expect(host.querySelector('.cp-more')?.textContent).toBe('6 more asleep boxes');
    expect(host.querySelector('[data-tip]')?.getAttribute('data-tip')).toContain('Up');
  });

  it('opens the rest from "N more asleep boxes"', () => {
    render();
    act(() => { (host.querySelector('.cp-more') as HTMLElement).click(); });
    expect(rowNames()).toHaveLength(13);
    expect(host.querySelector('.cp-more')).toBeNull();
  });

  it('filters from eight boxes, by name', () => {
    render();
    const input = host.querySelector<HTMLInputElement>('.cp-filter input')!;
    expect(input).toBeTruthy();
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'dev-9');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(rowNames()).toEqual(['Auto (recommended)', 'dev-9', 'New box']);
  });

  it('keeps one selection across its lists, and a click picks the box', () => {
    const onSelect = render('dev-2');
    const selected = () => [...host.querySelectorAll('.cp-row[data-selected]')].map(n => n.querySelector('.cp-name')?.textContent);
    expect(selected()).toEqual(['dev-2']);
    const row = [...host.querySelectorAll<HTMLElement>('.cp-row')].find(r => r.querySelector('.cp-name')?.textContent === 'up-a')!;
    act(() => { row.click(); });
    expect(onSelect).toHaveBeenCalledWith('up-a');
  });

  it('shows a folded box that is picked', () => {
    render('dev-9');
    expect(rowNames()).toContain('dev-9');
    expect(host.querySelector('.cp-more')?.textContent).toBe('5 more asleep boxes');
  });
});

// From review: "I wonder if we should be able to release boxes from this menu, too?"
describe('Release box… (CompactPlacementPicker)', () => {
  beforeEach(() => { mocks.terminate.mockClear(); mocks.reload.mockClear(); mocks.get.mockClear(); mocks.statusMap = {}; });
  const more = (name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="Options for ${name}"]`);
  const openMenu = async (name: string) => { await act(async () => { more(name)!.click(); }); };
  const item = () => document.querySelector<HTMLElement>('[role="menuitem"]');
  const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

  it("has a ⋯ on each EC2 box's row, none on your own machine's (external) box", () => {
    render();
    expect(more('dev-0')).toBeTruthy();
    expect(more('up-a')).toBeTruthy();
    expect(more('dev-1')).toBeNull();
  });

  it('confirms what goes, then terminates it, updates the list in place and falls back to Auto if it was picked', async () => {
    const onSelect = vi.fn();
    const onRetry = vi.fn();
    render('dev-0', onSelect, onRetry);
    await openMenu('dev-0');
    expect(item()?.textContent).toContain('Release box…');
    await act(async () => { item()!.click(); });
    await flush();
    const dialog = document.querySelector('.cp-release-dialog')!;
    expect(mocks.get).toHaveBeenCalledWith('dev-0');
    expect(dialog.textContent).toContain('Release dev-0?');
    expect(dialog.textContent).toContain('Its 1 session end');
    // Its live checkouts, read from the box itself (the list never carries them), as Lab names them.
    expect(dialog.textContent).toMatch(/Its checkouts go: termag, orch.*space orchestrator.*\./);
    expect(dialog.textContent).toContain('Anything not pushed on dev-0 is lost.');
    expect(mocks.terminate).not.toHaveBeenCalled();
    const release = [...dialog.querySelectorAll('button')].find(b => b.textContent === 'Release dev-0')!;
    await act(async () => { release.click(); });
    await flush();
    expect(mocks.terminate).toHaveBeenCalledWith('dev-0', true);
    expect(mocks.reload).toHaveBeenCalled();
    expect(onRetry).toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith(AUTO);
    expect(document.querySelector('.cp-release-dialog')).toBeNull();
  });

  // Devin and Bugbot on #1878: the box list has no projects, so the confirm said "no checkouts" and still archived them.
  it("won't release until it has read what's on the box, and says so when it can't", async () => {
    let answer: (v: unknown) => void = () => {};
    mocks.get.mockImplementationOnce(() => new Promise(r => { answer = r; }));
    render();
    await openMenu('dev-0');
    await act(async () => { item()!.click(); });
    const dialog = () => document.querySelector('.cp-release-dialog')!;
    const release = () => [...dialog().querySelectorAll('button')].find(b => b.textContent === 'Release dev-0')!;
    expect(dialog().textContent).toContain("Reading what's on dev-0…");
    expect(release().hasAttribute('disabled') || release().getAttribute('aria-disabled') === 'true' || release().hasAttribute('data-disabled')).toBe(true);
    await act(async () => { release().click(); });
    expect(mocks.terminate).not.toHaveBeenCalled();
    await act(async () => { answer(Promise.reject(new Error('down'))); });
    await flush();
    expect(dialog().textContent).toContain("Couldn't read what's on dev-0, so it isn't released.");
    await act(async () => { [...dialog().querySelectorAll('button')].find(b => b.textContent === 'Try again')!.click(); });
    await flush();
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(dialog().textContent).toContain('Its checkouts go: termag');
  });

  it("doesn't offer Release on a box a session is working on, and says why", async () => {
    mocks.statusMap = { 'dev-0|ada-termag-agent-main': { status: 'working' } };
    render();
    await openMenu('dev-0');
    expect(item()?.getAttribute('aria-disabled')).toBe('true');
    expect(item()?.textContent).toContain('A session is working on it');
  });

  it('keeps the pick when another box is released, and says why one could not be', async () => {
    const onSelect = vi.fn();
    mocks.terminate.mockRejectedValueOnce(Object.assign(new Error('no'), { response: { data: { error: 'The box is still starting' } } }));
    render('up-a', onSelect);
    await openMenu('dev-2');
    await act(async () => { item()!.click(); });
    await flush();
    const release = [...document.querySelectorAll('.cp-release-dialog button')].find(b => b.textContent === 'Release dev-2') as HTMLElement;
    await act(async () => { release.click(); });
    await flush();
    expect(document.querySelector('.cp-release-dialog')?.textContent).toContain('The box is still starting');
    expect(onSelect).not.toHaveBeenCalled();
  });
});
