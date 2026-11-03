import { describe, expect, it } from 'vitest';
import { automationHref, groupRuns, subtrees, newestRunsFirst, runLabel, runsStatus, runsSubtitle, runsUnfolded, RUNS_SHOWN, shownRuns, type RunLike } from './automationRuns';

const run = (workstream: string, projectId = 'babysit', projectName = 'pr-babysitter'): RunLike => ({ projectId, projectName, workstream, kind: 'automation' });
const normal = (projectId: string, workstream = 'main'): RunLike => ({ projectId, projectName: projectId, workstream, kind: 'normal' });

describe('groupRuns', () => {
  it('puts an automation’s runs in one group where its first run was, newest first', () => {
    const rows = [normal('main-proj'), run('run-20261028-1800'), normal('termag-5'), run('run-20261028-1830')];
    const out = groupRuns(rows, r => r);
    expect(out.map(x => (x.group ? `group:${x.group.projectName}` : x.item.projectId))).toEqual(['main-proj', 'group:pr-babysitter', 'termag-5']);
    expect(out[1].group?.runs.map(r => r.workstream)).toEqual(['run-20261028-1830', 'run-20261028-1800']);
  });

  it('keeps two automations apart, and leaves a normal project’s workstreams and an automation’s main alone', () => {
    const rows = [run('run-20261028-1800', 'a', 'alpha'), normal('p', 'fix-1'), run('main', 'a', 'alpha'), run('run-20261028-1800', 'b', 'beta')];
    const out = groupRuns(rows, r => r);
    expect(out.map(x => (x.group ? `${x.group.projectId}:${x.group.runs.length}` : `${x.item.projectId}|${x.item.workstream}`)))
      .toEqual(['a:1', 'p|fix-1', 'a|main', 'b:1']);
  });

  it('leaves an item whose row is null as it is (a nested row)', () => {
    const items = [{ r: run('run-20261028-1800'), depth: 1 }, { r: run('run-20261028-1830'), depth: 0 }];
    const out = groupRuns(items, x => (x.depth === 0 ? x.r : null));
    expect(out).toHaveLength(2);
    expect(out[0].item?.depth).toBe(1);
    expect(out[1].group?.runs).toHaveLength(1);
  });
});

describe('newestRunsFirst', () => {
  it('orders by occurrence, a same-minute rerun after its first, and a ten after a two', () => {
    const names = ['run-20261027-0900', 'run-20261028-1800', 'run-20261028-1800-2', 'run-20261028-1800-10', 'run-20261028-0900'];
    expect(newestRunsFirst(names, n => n)).toEqual(['run-20261028-1800-10', 'run-20261028-1800-2', 'run-20261028-1800', 'run-20261028-0900', 'run-20261027-0900']);
  });
});

describe('runsStatus', () => {
  it('is working while any run works', () => {
    expect(runsStatus(['idle', 'working', 'not_running'])).toBe('working');
  });
  it('is the latest run’s status otherwise', () => {
    expect(runsStatus(['not_running', 'waiting', 'idle'])).toBe('not_running');
    expect(runsStatus(['waiting', 'idle'])).toBe('waiting');
  });
  it('is not running with no runs', () => {
    expect(runsStatus([])).toBe('not_running');
  });
});

describe('shownRuns', () => {
  const runs = Array.from({ length: 14 }, (_, i) => `r${i}`);
  it('caps the list at the newest ten', () => {
    expect(RUNS_SHOWN).toBe(10);
    expect(shownRuns(runs, () => false)).toEqual(runs.slice(0, 10));
  });
  it('adds the open run when it is older than those', () => {
    expect(shownRuns(runs, r => r === 'r12')).toEqual([...runs.slice(0, 10), 'r12']);
    expect(shownRuns(runs, r => r === 'r3')).toEqual(runs.slice(0, 10));
  });
});

describe('runsUnfolded', () => {
  const none = new Map<string, boolean>();
  it('is folded by default', () => {
    expect(runsUnfolded('babysit', none, null)).toBe(false);
    expect(runsUnfolded('babysit', none, { projectId: 'other', workstream: 'run-20261028-1800' })).toBe(false);
  });
  it('is unfolded when one of its runs is open, not its main', () => {
    expect(runsUnfolded('babysit', none, { projectId: 'babysit', workstream: 'run-20261028-1800' })).toBe(true);
    expect(runsUnfolded('babysit', none, { projectId: 'babysit', workstream: 'main' })).toBe(false);
  });
  it('is as the person left it, whatever is open', () => {
    expect(runsUnfolded('babysit', new Map([['babysit', true]]), null)).toBe(true);
    expect(runsUnfolded('babysit', new Map([['babysit', false]]), { projectId: 'babysit', workstream: 'run-20261028-1800' })).toBe(false);
  });
});

describe('labels', () => {
  const now = new Date('2026-10-28T19:00:00Z');
  it('names a run by its occurrence in the automation’s zone', () => {
    expect(runLabel('run-20261028-1800', 'UTC', now)).toBe('Wed 18:00');
    expect(runLabel('run-20261028-1800-2', 'UTC', now)).toBe('Wed 18:00 (2)');
    expect(runLabel('scratch', 'UTC', now)).toBe('scratch');
  });
  it('subtitles with the schedule, or why it is not running', () => {
    const a = { schedule: '0 9 * * 1-5', timezone: 'UTC', enabled: true, pausedReason: null, nextRunAt: null, lastRun: null };
    expect(runsSubtitle(a, now)).toBe('weekdays at 09:00 (UTC)');
    expect(runsSubtitle({ ...a, pausedReason: 'consecutive_failures' }, now)).toBe('paused: kept failing');
    expect(runsSubtitle({ ...a, enabled: false }, now)).toBe('off');
    expect(runsSubtitle({ ...a, schedule: '*/30 * * * *' }, now)).toBe('every 30 min');
    expect(runsSubtitle({ ...a, schedule: '0 */6 * * *' }, now)).toBe('every 6 h');
  });
  it('links Show all to the automation’s page', () => {
    expect(automationHref('a b')).toBe('/automations/a%20b');
  });
});

describe('subtrees', () => {
  it('cuts a laid-out tree into each top-level row with what is under it', () => {
    const rows = [{ k: 'a', d: 0 }, { k: 'a1', d: 1 }, { k: 'a11', d: 2 }, { k: 'b', d: 0 }, { k: 'c', d: 0 }, { k: 'c1', d: 1 }];
    expect(subtrees(rows, r => r.d).map(t => t.map(r => r.k))).toEqual([['a', 'a1', 'a11'], ['b'], ['c', 'c1']]);
  });
  it('keeps a run\'s subtree whole inside its automation\'s group', () => {
    const rows = [{ r: run('run-20261028-1800'), d: 0 }, { r: normal('kid'), d: 1 }, { r: normal('other'), d: 0 }, { r: run('run-20261028-1830'), d: 0 }];
    const out = groupRuns(subtrees(rows, x => x.d), t => t[0].r);
    expect(out.map(x => (x.group ? x.group.runs.map(t => t.map(y => y.r.workstream === 'main' ? y.r.projectId : y.r.workstream)) : x.item[0].r.projectId)))
      .toEqual([[['run-20261028-1830'], ['run-20261028-1800', 'kid']], 'other']);
  });
});
