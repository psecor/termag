import { describe, expect, it } from 'vitest';
import type { BoxLifecycle, Instance } from '../types';
import { boxNeedsAttention, stoppedBoxGroups, stoppedToggleLabel } from './stoppedBoxGroups';

const lc = (over: Partial<BoxLifecycle> = {}): BoxLifecycle => ({
  canAutoHibernate: true, idleHibernateHours: null, hibernatedTerminateDays: null, hibernateDueAt: null,
  terminateDueAt: null, parkedAt: null, unsavedWork: null, note: null, warning: null, ...over,
});
const box = (id: string, status: Instance['status'], over: Partial<Instance> = {}) => ({ id, status, ...over });
const NOW = Date.parse('2026-10-27T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

describe('stoppedBoxGroups', () => {
  const boxes = [
    box('run', 'ready'),
    box('stop', 'stopped'),
    box('hib', 'hibernated'),
    box('term', 'terminated'),
    box('starting', 'starting'),
    box('stopping', 'stopping'),
    box('hibernating', 'hibernating'),
    box('failed', 'failed'),
  ];
  const projects = [
    ...boxes.map(b => ({ id: `p-${b.id}`, instanceId: b.id })),
    { id: 'p-stop-2', instanceId: 'stop' },
    { id: 'p-local', instanceId: null },
  ];

  it('hides stopped, hibernated and terminated boxes by default, and counts their projects', () => {
    const r = stoppedBoxGroups({ boxes, projects, activeProjectId: null, now: NOW });
    expect([...r.boxIds].sort()).toEqual(['hib', 'stop', 'term']);
    expect(r.projectCount).toBe(4);
  });

  it('never hides a box on the way up or down, running, or failed', () => {
    const r = stoppedBoxGroups({ boxes, projects, activeProjectId: null, now: NOW });
    for (const id of ['run', 'starting', 'stopping', 'hibernating', 'failed']) expect(r.boxIds.has(id), id).toBe(false);
  });

  it('keeps the box of the open project (the URL\'s ?project=)', () => {
    const r = stoppedBoxGroups({ boxes, projects, activeProjectId: 'p-stop-2', now: NOW });
    expect(r.boxIds.has('stop')).toBe(false);
    expect(r.projectCount).toBe(2);
  });

  it('keeps a box with a live cloud session under it', () => {
    const r = stoppedBoxGroups({ boxes, projects, activeProjectId: null, boxesWithCloud: new Set(['hib']), now: NOW });
    expect(r.boxIds.has('hib')).toBe(false);
  });

  it('only counts boxes that have a project in the list, since only those have a group', () => {
    const r = stoppedBoxGroups({ boxes: [box('empty', 'stopped'), box('stop', 'stopped')], projects: [{ id: 'p', instanceId: 'stop' }], activeProjectId: null, now: NOW });
    expect([...r.boxIds]).toEqual(['stop']);
  });

  it('keeps boxes that need attention', () => {
    const attention = [
      box('err', 'stopped', { provisioningError: 'the agent never connected after the start' }),
      box('claim', 'stopped', { onClaimStatus: 'failed' }),
      box('warn', 'stopped', { lifecycle: lc({ warning: "can't hibernate" }) }),
      box('unpushed', 'stopped', { lifecycle: lc({ unsavedWork: 'unsaved' }) }),
      box('old', 'hibernated', { hibernatedAt: daysAgo(52) }),
    ];
    const quiet = [
      box('clean', 'stopped', { lifecycle: lc({ unsavedWork: 'clean', note: 'Auto-stopped after 6 h idle.' }) }),
      box('young', 'hibernated', { hibernatedAt: daysAgo(3) }),
    ];
    const all = [...attention, ...quiet];
    const r = stoppedBoxGroups({ boxes: all, projects: all.map(b => ({ id: b.id, instanceId: b.id })), activeProjectId: null, now: NOW });
    expect([...r.boxIds].sort()).toEqual(['clean', 'young']);
    for (const b of attention) expect(boxNeedsAttention(b, NOW), b.id).toBe(true);
  });
});

describe('stoppedToggleLabel', () => {
  it('says what a click does, with the number of boxes', () => {
    expect(stoppedToggleLabel(false, 12)).toBe('Show stopped (12)');
    expect(stoppedToggleLabel(true, 12)).toBe('Hide stopped (12)');
  });
});
