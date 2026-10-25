import { describe, expect, it } from 'vitest';
import { PARENT_GONE_MISSES, chooseAdopter, effectiveParent, needsParent, parentGone, parseOrphanHome, type OrphanRow } from './spawnOrphans';

const row = (over: Partial<OrphanRow> = {}): OrphanRow => ({
  state: 'running', retiredAt: null, endedAt: null, reportedAt: null, nudgedAt: null,
  parentProjectId: 'p1', parentWorkstream: 'ws1', parentRole: 'agent',
  fosterProjectId: null, fosterWorkstream: null, fosterRole: null, ...over,
});

describe('effectiveParent', () => {
  it('is the foster once one adopted it, else the original parent', () => {
    expect(effectiveParent(row())).toEqual({ projectId: 'p1', workstream: 'ws1', role: 'agent' });
    expect(effectiveParent(row({ fosterProjectId: 'p0', fosterWorkstream: 'main' }))).toEqual({ projectId: 'p0', workstream: 'main', role: 'agent' });
    expect(effectiveParent(row({ parentProjectId: null }))).toBeNull();
  });
});

describe('needsParent', () => {
  it('matters while working or waiting on someone, or with a report nobody was told about', () => {
    for (const state of ['starting', 'running', 'blocked', 'needs_input']) expect(needsParent(row({ state }))).toBe(true);
    const t = new Date('2026-10-19T00:00:00Z');
    expect(needsParent(row({ state: 'done', reportedAt: t }))).toBe(true);
    expect(needsParent(row({ state: 'done', reportedAt: t, nudgedAt: new Date(t.getTime() + 1) }))).toBe(false);
    expect(needsParent(row({ state: 'done', reportedAt: new Date(t.getTime() + 5), nudgedAt: t }))).toBe(true);
    expect(needsParent(row({ retiredAt: t }))).toBe(false);
    expect(needsParent(row({ state: 'failed' }))).toBe(false);
    // Ended: its agent is gone, so only an unread report still needs someone.
    expect(needsParent(row({ endedAt: t }))).toBe(false);
    expect(needsParent(row({ endedAt: t, reportedAt: t }))).toBe(true);
  });
});

describe('parentGone', () => {
  const live = { projectLive: true, workstreamLive: true, spawnGone: false, sessionLive: true, misses: 0 };
  it('is gone at once when its project, workstream or own spawn is', () => {
    expect(parentGone({ ...live, projectLive: false })).toEqual({ gone: true });
    expect(parentGone({ ...live, workstreamLive: false })).toEqual({ gone: true });
    expect(parentGone({ ...live, spawnGone: true })).toEqual({ gone: true });
  });

  it('needs its pane missing for ten sweeps in a row, and decides nothing for an unreachable box', () => {
    expect(parentGone({ ...live, sessionLive: false })).toEqual({ gone: false, misses: 1 });
    expect(parentGone({ ...live, sessionLive: false, misses: PARENT_GONE_MISSES - 1 })).toEqual({ gone: true });
    expect(parentGone({ ...live, sessionLive: true, misses: 4 })).toEqual({ gone: false, misses: 0 });
    expect(parentGone({ ...live, sessionLive: null, misses: 4 })).toEqual({ gone: false, misses: 4 });
  });
});

describe('chooseAdopter', () => {
  const a = (projectId: string, alive: boolean) => ({ projectId, workstream: 'main', role: 'agent', alive });
  it('takes the nearest living ancestor, else the home, else nobody', () => {
    expect(chooseAdopter([a('gp', false), a('ggp', true)], a('home', true), null)).toMatchObject({ by: 'ancestor', projectId: 'ggp' });
    expect(chooseAdopter([a('gp', false)], a('home', true), null)).toMatchObject({ by: 'home', projectId: 'home' });
    expect(chooseAdopter([a('gp', false)], a('home', false), null)).toEqual({ by: 'none' });
    expect(chooseAdopter([], null, null)).toEqual({ by: 'none' });
  });

  it('never picks the child itself', () => {
    const self = { projectId: 'home', workstream: 'main', role: 'agent' };
    expect(chooseAdopter([], a('home', true), self)).toEqual({ by: 'none' });
  });
});

describe('parseOrphanHome', () => {
  it('reads the stored setting, main by default', () => {
    expect(parseOrphanHome({ projectId: 'p9' })).toEqual({ projectId: 'p9', workstream: 'main' });
    expect(parseOrphanHome({ projectId: 'p9', workstream: 'coord' })).toEqual({ projectId: 'p9', workstream: 'coord' });
    expect(parseOrphanHome(null)).toBeNull();
    expect(parseOrphanHome({ workstream: 'x' })).toBeNull();
  });
});
