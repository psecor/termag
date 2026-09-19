import { describe, it, expect } from 'vitest';
import { projectSeries, projectTokensInRange, dominantProjectToday, stableColor, OTHER_ID, UNATTRIBUTED_ID, oldSchemaHosts } from './usageProjects';
import type { UsageResponse } from '../../services/api';

const day = (input: number) => ({ input, output: 0, cacheRead: 0, cacheCreate: 0, calls: 1 });
const D = ['2026-09-18', '2026-09-19'];
const proj = (id: string, ws: string, tokens: Record<string, number>, color: string | null = null) => ({
  projectId: id, name: id.toUpperCase(), color, workstream: ws,
  days: Object.fromEntries(Object.entries(tokens).map(([d, t]) => [d, day(t)])),
});

describe('projectSeries', () => {
  it('sums workstreams per project, ranks, folds the tail into Other, appends Unattributed', () => {
    const usage: UsageResponse = {
      days: {},
      projects: [
        proj('a', 'main', { '2026-09-19': 100 }, '#123456'), proj('a', 'feat', { '2026-09-19': 50 }),
        proj('b', 'main', { '2026-09-19': 90 }), proj('c', 'main', { '2026-09-19': 10 }),
        proj('d', 'main', { '2026-09-17': 999 }), // outside range → dropped
      ],
      unattributed: { '2026-09-19': day(7) },
    };
    const s = projectSeries(usage, D, 2);
    expect(s.map(x => [x.id, x.total])).toEqual([['a', 150], ['b', 90], [OTHER_ID, 10], [UNATTRIBUTED_ID, 7]]);
    expect(s[0].color).toBe('#123456');
    expect(s[1].color).toBe(stableColor('b'));
    expect(s[2].label).toBe('Other (1)');
  });
  it('no projects / no unattributed → empty', () => {
    expect(projectSeries({ days: {} }, D)).toEqual([]);
    expect(projectSeries({ days: {}, projects: [], unattributed: { '2026-09-19': day(0) } }, D)).toEqual([]);
  });
});

describe('projectTokensInRange', () => {
  it('sums workstreams and ignores dates outside the range', () => {
    const m = projectTokensInRange({ days: {}, projects: [proj('a', 'main', { '2026-09-19': 5, '2026-09-01': 100 }), proj('a', 'x', { '2026-09-18': 6 })] }, D);
    expect(m.get('a')).toBe(11);
  });
});

describe('dominantProjectToday', () => {
  const T = '2026-09-19';
  it('returns the project at ≥ 50 % of attributed tokens (boundary inclusive)', () => {
    const half = { days: {}, projects: [proj('a', 'main', { [T]: 50 }), proj('b', 'main', { [T]: 50 })] };
    expect(dominantProjectToday(half, T)?.projectId).toBe('a');
    const under = { days: {}, projects: [proj('a', 'main', { [T]: 49 }), proj('b', 'main', { [T]: 51 })] };
    expect(dominantProjectToday(under, T)?.projectId).toBe('b');
    const split3 = { days: {}, projects: [proj('a', 'main', { [T]: 40 }), proj('b', 'main', { [T]: 30 }), proj('c', 'main', { [T]: 30 })] };
    expect(dominantProjectToday(split3, T)).toBeNull();
  });
  it('null without projects or without tokens today', () => {
    expect(dominantProjectToday({ days: {} }, T)).toBeNull();
    expect(dominantProjectToday(null, T)).toBeNull();
    expect(dominantProjectToday({ days: {}, projects: [proj('a', 'main', { '2026-09-18': 5 })] }, T)).toBeNull();
  });
});

describe('oldSchemaHosts', () => {
  it('names hosts on schema 1 only', () => {
    expect(oldSchemaHosts({ days: {}, hosts: [
      { hostKey: 'legacy', instanceId: null, name: 'orchestrator', connected: true, lastScanAt: null, schema: 2 },
      { hostKey: 'i1', instanceId: 'i1', name: 'box-a', connected: true, lastScanAt: null, schema: 1 },
    ] })).toEqual(['box-a']);
  });
});
