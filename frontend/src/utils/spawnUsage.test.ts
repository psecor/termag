import { describe, expect, it } from 'vitest';
import { childLink, fosterNote, groupTreesByOrigin, hasSpawnActivity, meterFill, meterTone, nodeTokenTotal, pickedSession, reasonLabel, sessionKey, sessionLabel, spawnActions, spawnStateLabel, spawnStateTone } from './spawnUsage';

describe('meters', () => {
  it('turns near at 80% of a limit and full at it', () => {
    expect(meterTone(3, 20)).toBe('ok');
    expect(meterTone(16, 20)).toBe('near');
    expect(meterTone(20, 20)).toBe('full');
    expect(meterTone(7, 8)).toBe('near');
    expect(meterTone(0, 0)).toBe('full');
  });

  it('fills 0–1, capped', () => {
    expect(meterFill(5, 20)).toBe(0.25);
    expect(meterFill(30, 20)).toBe(1);
  });
});

describe('labels', () => {
  it('names refusal reasons in plain words, unknown ones as they are', () => {
    expect(reasonLabel('box_busy')).toBe('box running hot');
    expect(reasonLabel('box-failed')).toBe('box failed');
    expect(reasonLabel('http_502')).toBe('http 502');
  });

  it('says when an agent has ended, keeping its last state', () => {
    expect(spawnStateLabel({ state: 'needs_input', endedAt: null })).toBe('needs input');
    expect(spawnStateLabel({ state: 'done', endedAt: '2026-10-18T00:00:00Z' })).toBe('ended · done');
    expect(spawnStateTone({ state: 'blocked', endedAt: null })).toBe('attention');
    expect(spawnStateTone({ state: 'running', endedAt: null })).toBe('live');
    expect(spawnStateTone({ state: 'done', endedAt: 'x' })).toBe('ended');
  });
});

describe('section data', () => {
  const empty = { budget: { limits: {} as never, used: { depth: 0, openHere: null, lastHour: 0, running: 0 }, finishedRunning: 0, hints: [] }, trees: [], treesTotal: 0, refusals: [], boxes: [], days: 7 };

  it('shows only with a spawn or a refusal', () => {
    expect(hasSpawnActivity(null)).toBe(false);
    expect(hasSpawnActivity(empty)).toBe(false);
    expect(hasSpawnActivity({ ...empty, refusals: [{ reason: 'rate', count: 1 }] })).toBe(true);
  });

  it('totals tokens as the rest of the dashboard does', () => {
    expect(nodeTokenTotal({ tokens: { input: 1, output: 2, cacheRead: 3, cacheCreate: 4 } })).toBe(10);
    expect(nodeTokenTotal({ tokens: null })).toBeNull();
  });

  it('links a child to its workstream, main without a ws', () => {
    const child = { projectId: 'p 1', projectName: 'x', workstream: 'add-tests', session: 's', status: 'idle' };
    expect(childLink({ child })).toBe('/?project=p%201&ws=add-tests');
    expect(childLink({ child: { ...child, workstream: 'main' } })).toBe('/?project=p%201');
    expect(childLink({ child: { ...child, projectId: null } })).toBeNull();
  });
});

describe('lifecycle', () => {
  it('labels parked, kept and retired, and tones them apart from ended', () => {
    const base = { state: 'done', endedAt: null };
    expect(spawnStateLabel({ ...base, parkedAt: 'x' })).toBe('parked · done');
    expect(spawnStateLabel({ ...base, parkedAt: 'x', keptReason: '1 commit never pushed' })).toBe('parked · kept: 1 commit never pushed');
    expect(spawnStateLabel({ ...base, parkedAt: 'x', retiredAt: 'y' })).toBe('retired · done');
    expect(spawnStateTone({ ...base, parkedAt: 'x' })).toBe('parked');
    expect(spawnStateTone({ ...base, retiredAt: 'y' })).toBe('ended');
    expect(spawnStateLabel({ ...base, parkedAt: 'x', endedAt: 'z' })).toBe('ended · parked');
    expect(spawnStateTone({ ...base, parkedAt: 'x', endedAt: 'z' })).toBe('ended');
  });

  it('offers park and retire when done, resume and retire when parked, nothing once retired or still working', () => {
    expect(spawnActions({ state: 'done', endedAt: null })).toEqual(['park', 'retire']);
    expect(spawnActions({ state: 'done', endedAt: null, parkedAt: 'x' })).toEqual(['resume', 'retire']);
    expect(spawnActions({ state: 'done', endedAt: null, retiredAt: 'y' })).toEqual([]);
    expect(spawnActions({ state: 'running', endedAt: null })).toEqual([]);
    expect(spawnActions({ state: 'blocked', endedAt: null })).toEqual([]);
  });
});

describe('orphans', () => {
  const sessions = [{ projectId: 'p1', workstream: 'main', label: 'proj' }, { projectId: 'p1', workstream: 'coord', label: 'proj/coord' }];
  it('names a foster and who chose it', () => {
    expect(fosterNote({ foster: { projectId: 'p1', workstream: 'coord', by: 'ancestor', at: null } }, sessions)).toBe('adopted by proj/coord (its nearest living ancestor)');
    expect(fosterNote({ foster: { projectId: 'p9', workstream: 'main', by: 'home', at: null } }, sessions)).toBe('adopted by another project (the orphan home)');
    expect(fosterNote({ foster: null }, sessions)).toBeNull();
    expect(sessionLabel(undefined, 'p9', 'ws')).toBe("another project's ws");
  });

  it('round-trips a picked session, and shows the section for orphans alone', () => {
    expect(pickedSession(sessionKey({ projectId: 'p1', workstream: 'coord' }))).toEqual({ projectId: 'p1', workstream: 'coord' });
    expect(pickedSession('')).toBeNull();
    const empty = { trees: [], refusals: [] } as unknown as Parameters<typeof hasSpawnActivity>[0];
    expect(hasSpawnActivity({ ...empty!, orphans: [{}] } as never)).toBe(true);
  });
});

describe('groupTreesByOrigin (the parent row)', () => {
  const n = (id: string, state = 'running') => ({ id, state, endedAt: null, parkedAt: null, retiredAt: null } as never);
  const o = (ws: string) => ({ projectId: 'p1', workstream: ws, session: `me-proj-${ws}-agent`, label: `proj/${ws}` });
  it('puts trees under the session that started them, in newest-tree order, browser-started ones apart', () => {
    const groups = groupTreesByOrigin([
      { rootId: 't3', createdAt: '3', origin: o('a'), nodes: [n('x'), n('y', 'needs_input')] },
      { rootId: 't2', createdAt: '2', origin: null, nodes: [n('z', 'done')] },
      { rootId: 't1', createdAt: '1', origin: o('a'), nodes: [n('w', 'done')] },
    ]);
    expect(groups.map(g => [g.origin?.label ?? null, g.trees.map(t => t.rootId), g.agents, g.running, g.attention])).toEqual([
      ['proj/a', ['t3', 't1'], 3, 1, 1],
      [null, ['t2'], 1, 0, 0],
    ]);
  });
});
