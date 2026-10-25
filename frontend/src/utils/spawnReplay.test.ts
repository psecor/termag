import { describe, expect, it } from 'vitest';
import type { SpawnNode, SpawnTreeView } from '../services/api';
import { MAX_STEP_MS, REPLAY_SPEEDS, advancePlayhead, buildLanes, offsetLabel, replaySpan, snapshotAt } from './spawnReplay';
import { RING, MIN_R, MAX_R, radialLayout, radialPath, runSeconds } from './spawnRadial';

const T0 = Date.parse('2026-10-19T10:00:00Z');
const at = (m: number) => new Date(T0 + m * 60_000).toISOString();
const node = (id: string, over: Partial<SpawnNode> = {}): SpawnNode => ({
  id, level: 0, parentId: null, relationship: 'delegate', state: 'running', title: id, provider: 'claude', depth: 1,
  child: { projectId: 'p1', projectName: 'proj', workstream: id, session: `me-proj-${id}-agent`, status: 'idle' },
  parent: null, report: null, error: null, createdAt: at(0), launchedAt: at(0), reportedAt: null, endedAt: null,
  parkedAt: null, retiredAt: null, keptReason: null, lifecycle: null, foster: null, orphanedAt: null, tokens: null, ...over,
});
const ev = (spawnId: string, kind: string, m: number, reason: string | null = null, extra: Record<string, string> = {}) => ({ spawnId, kind, reason, at: at(m), ...extra });

const view = (): SpawnTreeView => ({
  rootId: 'a', createdAt: at(0), origin: null, at: at(60), eventsTruncated: false,
  totals: { agents: 2, peakRunning: 2, tokens: 0, cacheRead: 0, secondsToLastReport: null, states: {} },
  nodes: [
    node('a', { state: 'done', reportedAt: at(30), report: { status: 'done', summary: 'ok', at: at(30) }, endedAt: at(40) }),
    node('b', { level: 1, parentId: 'a', createdAt: at(5), launchedAt: at(5), foster: { projectId: 'p0', workstream: 'main', by: 'ancestor', at: at(41) } }),
  ],
  events: [
    ev('a', 'created', 0), ev('a', 'status', 1, 'working'), ev('a', 'status', 20, 'idle'), ev('a', 'reported', 30, 'done'), ev('a', 'ended', 40, 'killed'),
    ev('b', 'created', 5), ev('b', 'status', 6, 'working'), ev('b', 'orphaned', 40), ev('b', 'adopted', 41, 'ancestor', { parentProjectId: 'p0', parentWorkstream: 'main' }),
    ev('b', 'parked', 50, 'sweep'),
  ],
});

describe('snapshotAt', () => {
  it('shows only nodes created by then, with their pane, state and lifecycle as of then', () => {
    const s = snapshotAt(view(), T0 + 3 * 60_000);
    expect(s.nodes.map(n => n.id)).toEqual(['a']);
    expect(s.nodes[0]).toMatchObject({ state: 'running', child: { status: 'working' }, endedAt: null, report: null });

    const later = snapshotAt(view(), T0 + 35 * 60_000);
    expect(later.nodes[0]).toMatchObject({ state: 'done', child: { status: 'idle' }, endedAt: null });
    expect(later.nodes[0].report?.summary).toBe('ok');
    expect(later.nodes[1]).toMatchObject({ child: { status: 'working' }, foster: null, orphanedAt: null });
  });

  it('draws the orphaning, then the adoption, then the park, each from its moment', () => {
    expect(snapshotAt(view(), T0 + 40.5 * 60_000).nodes[1]).toMatchObject({ orphanedAt: at(40), foster: null });
    expect(snapshotAt(view(), T0 + 45 * 60_000).nodes[1]).toMatchObject({ orphanedAt: null, foster: { projectId: 'p0', workstream: 'main', by: 'ancestor' } });
    expect(snapshotAt(view(), T0 + 55 * 60_000).nodes[1].parkedAt).toBe(at(50));
    expect(snapshotAt(view(), T0 + 45 * 60_000).nodes[0].endedAt).toBe(at(40));
  });

  it('shows a pane with no status event yet as unknown, not guessed', () => {
    const v = view();
    v.events = v.events.filter(e => e.kind !== 'status');
    expect(snapshotAt(v, T0 + 10 * 60_000).nodes[1].child.status).toBe('unknown');
  });
});

describe('buildLanes', () => {
  it('colours each lane by pane status, stops it at the end, and marks reports and adoptions', () => {
    const [a, b] = buildLanes(view(), T0 + 60 * 60_000);
    expect(a.segments.map(s => [s.tone, (s.from - T0) / 60_000, (s.to - T0) / 60_000])).toEqual([
      ['unknown', 0, 1], ['working', 1, 20], ['idle', 20, 40],
    ]);
    expect(a.marks).toEqual([{ at: T0 + 30 * 60_000, kind: 'reported', reason: 'done' }]);
    expect(b.segments.map(s => s.tone)).toEqual(['unknown', 'working', 'parked']);
    expect(b.marks.map(m => m.kind)).toEqual(['orphaned', 'adopted']);
  });

  it('spans to now while a node is open, else to the last event', () => {
    expect(replaySpan(view())).toEqual({ start: T0, end: T0 + 60 * 60_000 });
    const v = view();
    v.nodes = v.nodes.map(n => ({ ...n, endedAt: at(40) }));
    expect(replaySpan(v).end).toBe(T0 + 50 * 60_000);
  });

  it('labels offsets', () => {
    expect(offsetLabel(65_000)).toBe('+1m 05s');
    expect(offsetLabel(3_900_000)).toBe('+1h 05m');
  });
});

describe('radialLayout', () => {
  const tree = (): SpawnTreeView => ({
    ...view(),
    nodes: [
      node('a', { tokens: { input: 100, output: 0, cacheRead: 0, cacheCreate: 0 } }),
      node('b', { level: 1, parentId: 'a' }),
      node('c', { level: 1, parentId: 'a', endedAt: at(30) }),
      node('d', { level: 2, parentId: 'c', foster: { projectId: 'p1', workstream: 'b', by: 'ancestor', at: null } }),
    ],
  });

  it('puts the root at the center and each level on its ring, wedges by leaves', () => {
    const l = radialLayout(tree());
    const by = new Map(l.nodes.map(n => [n.id, n]));
    expect([by.get('a')!.x, by.get('a')!.y]).toEqual([l.center, l.center]);
    for (const [id, ring] of [['b', 1], ['c', 1], ['d', 2]] as const) {
      const n = by.get(id)!;
      expect(Math.round(Math.hypot(n.x - l.center, n.y - l.center))).toBe(ring * RING);
    }
    // b and c each hold one leaf: half the circle each, b first.
    expect(by.get('b')!.angle).toBeCloseTo(Math.PI / 2);
    expect(by.get('c')!.angle).toBeCloseTo((3 * Math.PI) / 2);
    expect(by.get('d')!.angle).toBeCloseTo(by.get('c')!.angle);
  });

  it('sizes nodes by tokens and edges by run time, and draws the adoption', () => {
    const l = radialLayout(tree());
    const by = new Map(l.nodes.map(n => [n.id, n]));
    expect(by.get('a')!.r).toBe(MAX_R);
    expect(by.get('b')!.r).toBe(MIN_R);
    const w = new Map(l.edges.filter(e => e.kind === 'spawn').map(e => [e.to, e.width]));
    // b ran the whole hour, c half of it.
    expect(w.get('b')).toBe(6);
    expect(w.get('c')).toBeCloseTo(1.5 + 4.5 * 0.5);
    expect(l.edges.filter(e => e.kind === 'adopted')).toEqual([{ from: 'b', to: 'd', kind: 'adopted', width: 1.5 }]);
    // A foster that isn't drawn (the origin, say) is named on the node instead.
    const outside = radialLayout({ ...tree(), nodes: [...tree().nodes.slice(0, 3), { ...tree().nodes[3], foster: { projectId: 'p0', workstream: 'main', by: 'ancestor', at: null } }] });
    expect([...outside.fosteredOutside]).toEqual(['d']);
    expect(radialPath(by.get('a')!, by.get('b')!, l.center, 'spawn')).toMatch(/^M\d+,\d+ C/);
    expect(runSeconds(node('x', { launchedAt: null }), T0)).toBe(0);
  });
});

describe('replay fidelity (Devin\'s review)', () => {
  const resumed = (): SpawnTreeView => ({
    ...view(),
    nodes: [node('a', { parkedAt: null, endedAt: null })],
    events: [
      ev('a', 'created', 0), ev('a', 'status', 1, 'working'), ev('a', 'parked', 10, 'sweep'),
      // Its pane killed while parked: the end sweep ends it; a resume relaunches it.
      ev('a', 'ended', 20, 'killed'), ev('a', 'resumed', 30, 'owner'), ev('a', 'status', 31, 'working'),
    ],
  });

  it('a resume clears an end as well as a park, and the lane carries on', () => {
    expect(snapshotAt(resumed(), T0 + 25 * 60_000).nodes[0]).toMatchObject({ endedAt: at(20), parkedAt: at(10) });
    expect(snapshotAt(resumed(), T0 + 35 * 60_000).nodes[0]).toMatchObject({ endedAt: null, parkedAt: null, child: { status: 'working' } });
    const [lane] = buildLanes(resumed(), T0 + 40 * 60_000);
    // The ended stretch (20–30) is a gap; the lane resumes, then works again.
    expect(lane.segments.map(s => [s.tone, (s.from - T0) / 60_000, (s.to - T0) / 60_000])).toEqual([
      ['unknown', 0, 1], ['working', 1, 10], ['parked', 10, 20], ['unknown', 30, 31], ['working', 31, 40],
    ]);
  });

  it('a parked pane reads not running, whatever it last reported', () => {
    expect(snapshotAt(resumed(), T0 + 15 * 60_000).nodes[0].child.status).toBe('not_running');
  });

  it('a failed spawn closes its lane and does not hold the replay open', () => {
    const v: SpawnTreeView = { ...view(), nodes: [node('a', { state: 'failed' })], events: [ev('a', 'created', 0), ev('a', 'failed', 2, 'launch')] };
    expect(replaySpan(v).end).toBe(T0 + 2 * 60_000);
    expect(buildLanes(v, T0 + 60 * 60_000)[0].segments.map(s => s.tone)).toEqual(['unknown']);
  });

  it('keeps radial sizes fixed while replay draws a subset of the tree', () => {
    const full: SpawnTreeView = {
      ...view(),
      nodes: [
        node('a', { tokens: { input: 10, output: 0, cacheRead: 0, cacheCreate: 0 } }),
        node('b', { level: 1, parentId: 'a', createdAt: at(30), tokens: { input: 1000, output: 0, cacheRead: 0, cacheCreate: 0 } }),
      ],
    };
    const early = snapshotAt(full, T0 + 10 * 60_000);
    const alone = radialLayout(early).nodes[0].r;
    const scaled = radialLayout(early, full).nodes[0].r;
    expect(alone).toBe(MAX_R);
    expect(scaled).toBe(radialLayout(full).nodes.find(n => n.id === 'a')!.r);
  });
});

describe('replay fidelity (Devin\'s second review)', () => {
  it('ignores a late status on a parked pane, as the lane does', () => {
    const v: SpawnTreeView = {
      ...view(),
      nodes: [node('a')],
      events: [ev('a', 'created', 0), ev('a', 'status', 1, 'working'), ev('a', 'parked', 10, 'sweep'), ev('a', 'status', 11, 'working')],
    };
    expect(snapshotAt(v, T0 + 12 * 60_000).nodes[0].child.status).toBe('not_running');
    const segs = buildLanes(v, T0 + 12 * 60_000)[0].segments;
    expect(segs[segs.length - 1].tone).toBe('parked');
  });

  it('drops the foster when an adopted node is orphaned, as spawnView does', () => {
    const v: SpawnTreeView = {
      ...view(),
      nodes: [node('a')],
      events: [ev('a', 'created', 0), ev('a', 'adopted', 5, 'ancestor', { parentProjectId: 'p0', parentWorkstream: 'main' }), ev('a', 'orphaned', 9)],
    };
    expect(snapshotAt(v, T0 + 7 * 60_000).nodes[0].foster).toMatchObject({ projectId: 'p0' });
    expect(snapshotAt(v, T0 + 10 * 60_000).nodes[0]).toMatchObject({ foster: null, orphanedAt: at(9) });
  });
});

describe('runSeconds (Bugbot)', () => {
  it('counts only the time its pane ran: not parked or ended gaps, and nothing after a failure', () => {
    const n = node('a', { launchedAt: at(0), parkedAt: null, endedAt: null });
    const events = [ev('a', 'launched', 0, 'create'), ev('a', 'parked', 10, 'sweep'), ev('a', 'resumed', 30, 'owner'), ev('a', 'ended', 35, 'killed')];
    // 0–10 and 30–35 ran; the 20 minutes parked don't count, nor anything after the end.
    expect(runSeconds(n, T0 + 60 * 60_000, events)).toBe(15 * 60);
    const failed = node('f', { state: 'failed', launchedAt: at(0) });
    expect(runSeconds(failed, T0 + 60 * 60_000, [ev('f', 'launched', 0, 'create'), ev('f', 'failed', 2, 'error')])).toBe(2 * 60);
    expect(runSeconds(failed, T0 + 60 * 60_000)).toBe(0);
  });
});

describe('radialLayout for a session', () => {
  it('puts the session at the center and each tree\'s root on the first ring, with a branch to each', () => {
    const v: SpawnTreeView = {
      ...view(), scope: 'session', rootId: 'session:p1:main', rootIds: ['a', 'b'],
      origin: { projectId: 'p1', workstream: 'main', session: 'me-proj-agent', label: 'proj', status: 'idle' },
      nodes: [node('a'), node('a1', { level: 1, parentId: 'a' }), node('b')],
    };
    const l = radialLayout(v);
    const by = new Map(l.nodes.map(n => [n.id, n]));
    expect(by.get('origin')).toMatchObject({ x: l.center, y: l.center, node: null });
    for (const [id, ring] of [['a', 1], ['b', 1], ['a1', 2]] as const) {
      const p = by.get(id)!;
      expect(Math.round(Math.hypot(p.x - l.center, p.y - l.center))).toBe(ring * RING);
    }
    expect(l.edges.filter(e => e.from === 'origin').map(e => e.to)).toEqual(['a', 'b']);
  });
});

describe('replay speeds', () => {
  it('offers 1× up to 10000×, slowest first (the default is the first)', () => {
    expect(REPLAY_SPEEDS).toEqual([1, 10, 60, 100, 1000, 10000]);
  });
});

describe('advancePlayhead', () => {
  it('moves by the wall time that passed times the speed, so a late tick keeps the rate', () => {
    // A tick that took 250 ms instead of 100: at 1000× that is 250 s of tree time, not 100 s.
    expect(advancePlayhead(0, 250, 1000, 1e9)).toEqual({ t: 250_000, done: false });
    expect(advancePlayhead(0, 100, 10, 1e9)).toEqual({ t: 1000, done: false });
  });

  it('stops at the end, never runs backwards, and caps a long gap', () => {
    expect(advancePlayhead(900, 200, 1, 1000)).toEqual({ t: 1000, done: true });
    expect(advancePlayhead(500, -50, 60, 1e9)).toEqual({ t: 500, done: false });
    expect(advancePlayhead(0, 60_000, 1, 1e9)).toEqual({ t: MAX_STEP_MS, done: false });
  });
});
