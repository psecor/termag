import { describe, expect, it } from 'vitest';
import {
  autoChoice, autoLine, boxRowLine, hotBoxNote, boxStateWords, defaultWords, meterPercent, meterTone, newBoxSourceWords, pillLabel,
  placementKey, reasonLine, repoWordsFor, type PlacementBox, type PlacementView,
  ASLEEP_SHOWN, boxRowShort, boxRowTip, isAsleep, pickerGroups, releaseLines, workingBoxIds,
} from './boxPlacement';

const box = (over: Partial<PlacementBox> = {}): PlacementBox => ({
  instanceId: 'b1', name: 'dev', status: 'ready', connected: true, heat: 'ok', heatReasons: [], load: 0.4,
  sessions: 0, hasRepos: false, checkoutProjectId: null, lastUsedAt: null, ...over,
});
const view = (recommended: PlacementView['recommended']): PlacementView => ({
  policy: 'reuse-first', policySource: 'org', recommended, boxes: [], newBox: { source: 'cold' },
});

describe('Runs on: Auto words', () => {
  it('joins the reason most important first', () => {
    expect(reasonLine(['Last used', 'has termag', 'room to spare'])).toBe('Last used · has termag · room to spare');
  });

  it('says each state a box can be in', () => {
    expect(boxStateWords({ status: 'ready', connected: true })).toBe('Up');
    expect(boxStateWords({ status: 'ready', connected: false })).toBe('Offline');
    expect(boxStateWords({ status: 'stopped', connected: false })).toBe('Asleep · wakes when you start');
    expect(boxStateWords({ status: 'hibernated', connected: false })).toBe('Asleep · wakes when you start');
    expect(boxStateWords({ status: 'starting', connected: false })).toBe('Starting');
    expect(boxStateWords({ status: 'stopping', connected: true })).toBe('Going to sleep · wakes when you start');
  });

  it('puts state, sessions and the repository under a box, and a hot box says why instead', () => {
    expect(boxRowLine(box({ sessions: 2, hasRepos: true }), 'has termag')).toBe('Up · 2 sessions · has termag');
    expect(boxRowLine(box({ sessions: 1 }), 'has termag')).toBe('Up · 1 session');
    expect(boxRowLine(box({ heat: 'hot', heatReasons: ['memory 91% (limit 85%)', 'disk 95% (limit 90%)', 'load 2.00/core (limit 1.50/core)'] }), null))
      .toBe('Running hot: memory 91%, disk 95%');
  });

  it('caps the meter at the threshold and colours it by heat', () => {
    expect(meterPercent(0.42)).toBe(42);
    expect(meterPercent(1.3)).toBe(100);
    expect(meterPercent(null)).toBeNull();
    expect(meterTone({ heat: 'hot' })).toBe('danger');
    expect(meterTone({ heat: 'warm' })).toBe('warning');
    expect(meterTone({ heat: 'unknown' })).toBe('success');
  });

  it('says where New box comes from, the default and the repository', () => {
    expect(newBoxSourceWords('pool')).toBe('A ready box from the pool');
    expect(newBoxSourceWords('cold')).toBe('A new launch · takes a few minutes');
    expect(defaultWords('reuse-first')).toBe('Default: reuse a box');
    expect(defaultWords('fresh-first')).toBe('Default: a fresh box');
    expect(repoWordsFor(['example-org/termag', 'example-org/termag-desktop'])).toBe('has termag + termag-desktop');
    expect(repoWordsFor([])).toBeNull();
  });

  it('labels the pill Runs on: Auto whatever Auto picked, and a pick by its name', () => {
    expect(pillLabel({ auto: true, resolvedName: 'dev' })).toBe('Runs on: Auto');
    expect(pillLabel({ auto: true, resolvedName: 'New box' })).toBe('Runs on: Auto');
    expect(pillLabel({ auto: true, resolvedName: null })).toBe('Runs on: Auto');
    expect(pillLabel({ auto: false, resolvedName: 'busy' })).toBe('Runs on: busy');
    expect(pillLabel({ auto: false, resolvedName: null })).toBe('Runs on: New box');
  });

  it("says Auto's box and why, the reason alone while the box isn't named, checking while it loads, and nothing once it failed", () => {
    const v = view({ kind: 'box', instanceId: 'b1', reason: ['Last used', 'has termag'] });
    expect(autoLine({ view: v, failed: false, name: 'dev' })).toBe('dev · Last used · has termag');
    expect(autoLine({ view: v, failed: false, name: null })).toBe('Last used · has termag');
    expect(autoLine({ view: null, failed: false, name: null })).toBe('Checking your boxes…');
    expect(autoLine({ view: null, failed: true, name: null })).toBeNull();
  });
});

describe('autoChoice', () => {
  const ids = new Set(['b1']);
  it('is the recommended box while New session can launch on it, and New box when that is the pick', () => {
    expect(autoChoice({ view: view({ kind: 'box', instanceId: 'b1', reason: [] }), failed: false, boxIds: ids, newBox: 'new' })).toBe('b1');
    // A box the list hasn't got (not loaded yet, or gone since): waited for, never a New box launched for nothing.
    expect(autoChoice({ view: view({ kind: 'box', instanceId: 'gone', reason: [] }), failed: false, boxIds: ids, newBox: 'new' })).toBeNull();
    expect(autoChoice({ view: view({ kind: 'box', instanceId: 'b1', reason: [] }), failed: false, boxIds: new Set(), newBox: 'new' })).toBeNull();
    expect(autoChoice({ view: view({ kind: 'new', source: 'pool', reason: [] }), failed: false, boxIds: ids, newBox: 'new' })).toBe('new');
  });

  it('is nothing yet while the placement loads, and New box once it failed', () => {
    expect(autoChoice({ view: null, failed: false, boxIds: ids, newBox: 'new' })).toBeNull();
    expect(autoChoice({ view: null, failed: true, boxIds: ids, newBox: 'new' })).toBe('new');
  });

  it("keys a placement by its repositories in any order, and the size", () => {
    expect(placementKey(['b/b', 'a/a'], 'large')).toBe(placementKey(['a/a', 'b/b'], 'large'));
    expect(placementKey(['a/a'], null)).not.toBe(placementKey(['a/a'], 'large'));
  });
});

describe('hotBoxNote', () => {
  const hot = box({ instanceId: 'b2', name: 'build', heat: 'hot', heatReasons: ['memory 91% (limit 85%)'] });
  it("names the hot box, why, and where Auto would go next time", () => {
    const v = { ...view({ kind: 'box', instanceId: 'b1', reason: [] }), boxes: [box(), hot] };
    expect(hotBoxNote(hot, v)).toBe('build is running hot (memory 91%). Auto would pick dev next time.');
    expect(hotBoxNote(hot, view({ kind: 'new', source: 'pool', reason: [] }))).toBe('build is running hot (memory 91%). Auto would pick a new box next time.');
  });
  it('is nothing for a box that is not hot', () => {
    expect(hotBoxNote(box(), view({ kind: 'box', instanceId: 'b1', reason: [] }))).toBeNull();
    expect(hotBoxNote(undefined, view({ kind: 'box', instanceId: 'b1', reason: [] }))).toBeNull();
  });
});

// the compact picker (pages/chat/CompactPlacementPicker.tsx, under user-projects-enabled).
describe('the compact picker', () => {
  it("says a box's state short, with its sessions, and wakes-when-you-start nowhere on a row", () => {
    expect(boxRowShort(box({ sessions: 1 }))).toBe('Up · 1 session');
    expect(boxRowShort(box({ status: 'stopped', sessions: 3 }))).toBe('Asleep · 3 sessions');
    expect(boxRowShort(box({ status: 'hibernating' }))).toBe('Asleep');
    expect(boxRowShort(box({ heat: 'hot', sessions: 2 }))).toBe('Running hot · 2 sessions');
    expect(boxRowShort(box({ connected: false }))).toBe('Offline');
    expect(boxRowShort(box({ status: 'starting' }))).toBe('Starting');
    expect(isAsleep('stopping')).toBe(true);
    expect(isAsleep('ready')).toBe(false);
  });

  it('puts the rest in the tooltip: the full state, why hot, sessions, the repository, the load, last use', () => {
    const now = Date.parse('2026-11-14T15:00:00Z');
    const age = (ms: number) => `${Math.round(ms / 3_600_000)}h`;
    expect(boxRowTip(box({ status: 'stopped', sessions: 2, hasRepos: true, load: 0.42, lastUsedAt: '2026-11-14T12:00:00Z' }), 'has termag', now, age))
      .toBe('Asleep · wakes when you start\n2 sessions\nhas termag\nLoad: 42% of running hot\nLast used 3h ago');
    expect(boxRowTip(box({ heat: 'hot', heatReasons: ['memory 91% (limit 85%)'], load: null }), null, now, age))
      .toBe('Up\nRunning hot: memory 91%\nNo sessions');
  });

  const rows = [
    box({ instanceId: 'u1', name: 'up-1' }),
    ...Array.from({ length: 9 }, (_, i) => box({ instanceId: `a${i}`, name: `sleepy-${i}`, status: 'stopped', lastUsedAt: `2026-11-${String(10 - i).padStart(2, '0')}T00:00:00Z` })),
    box({ instanceId: 'u2', name: 'up-2', status: 'starting' }),
  ];

  it('lists the boxes that are up, then the asleep ones by last use, the most recent few and the rest folded', () => {
    const g = pickerGroups(rows, { expanded: false, filter: '', selected: 'auto' });
    expect(g.up.map(r => r.name)).toEqual(['up-1', 'up-2']);
    expect(g.asleep.map(r => r.name)).toEqual(['sleepy-0', 'sleepy-1', 'sleepy-2', 'sleepy-3']);
    expect(g.asleep).toHaveLength(ASLEEP_SHOWN);
    expect(g.more).toBe(5);
    expect(pickerGroups(rows, { expanded: true, filter: '', selected: 'auto' }).asleep).toHaveLength(9);
  });

  it('keeps the picked box in sight when it would be folded, and never folds just one', () => {
    const g = pickerGroups(rows, { expanded: false, filter: '', selected: 'a8' });
    expect(g.asleep.map(r => r.instanceId)).toEqual(['a0', 'a1', 'a2', 'a3', 'a8']);
    expect(g.more).toBe(4);
    expect(pickerGroups(rows.slice(0, ASLEEP_SHOWN + 2), { expanded: false, filter: '', selected: 'auto' }).more).toBe(0);
  });

  it('filters by name and shows every match', () => {
    const g = pickerGroups(rows, { expanded: false, filter: 'SLEEPY-8', selected: 'auto' });
    expect(g.asleep.map(r => r.name)).toEqual(['sleepy-8']);
    expect(g.up).toEqual([]);
    expect(g.more).toBe(0);
  });
});

describe('Release box…', () => {
  it('knows the boxes a session is working on, from the status map', () => {
    expect([...workingBoxIds({ 'b1|ada-termag-agent-main': { status: 'working' }, 'b2|x': { status: 'idle' }, '|local': { status: 'working' } })]).toEqual(['b1']);
  });

  it('says what goes: its sessions, its checkouts, and anything not pushed', () => {
    expect(releaseLines({ name: 'dev-03', sessions: 2, checkouts: ['termag', 'termag-2'] })).toEqual([
      'Its 2 sessions end, and their chats stay in Archived.', 'Its checkouts go: termag, termag-2.', 'Anything not pushed on dev-03 is lost.',
    ]);
    expect(releaseLines({ name: 'dev-04', sessions: 0, checkouts: [] })).toEqual(['It has no sessions.', 'It has no checkouts.', 'Anything not pushed on dev-04 is lost.']);
  });
});
