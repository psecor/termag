import { describe, expect, it } from 'vitest';
import type { Instance } from '../types';
import { DEFAULT_THEME } from '../theme/schema';
import { hiddenAsks, withoutAsks } from './askBoxGroups';
import { stoppedBoxGroups } from './stoppedBoxGroups';

const box = (id: string, createdFor: Instance['createdFor'], status: Instance['status'] = 'ready') => ({ id, createdFor, status });
const sorted = (s: Set<string>) => [...s].sort();

describe('hiddenAsks: boxes', () => {
  const boxes = [
    box('mine', null),
    box('old', undefined), // an orchestrator from before the mark, or a box made before it
    box('ask-1', 'ask'),
    box('ask-2', 'ask', 'stopped'),
  ];
  // As `termag ask --new-box` makes them: the project on an ask box carries the mark too.
  const projects = [
    ...boxes.map(b => ({ id: `p-${b.id}`, instanceId: b.id, createdFor: b.createdFor })),
    { id: 'p-local', instanceId: null },
  ];
  const input = { enabled: true, boxes, projects, activeProjectId: null };

  it('hides nothing while the setting is off, its default', () => {
    expect(DEFAULT_THEME.sidebarHideAskBoxes).toBe(false);
    const hidden = hiddenAsks({ ...input, enabled: DEFAULT_THEME.sidebarHideAskBoxes });
    expect(hidden.boxIds.size + hidden.projectIds.size).toBe(0);
  });

  it('hides every box made for termag ask, running or stopped, and only those', () => {
    expect(sorted(hiddenAsks(input).boxIds)).toEqual(['ask-1', 'ask-2']);
  });

  it('keeps the open project\'s box, so the session on screen stays in the list', () => {
    expect(sorted(hiddenAsks({ ...input, activeProjectId: 'p-ask-1' }).boxIds)).toEqual(['ask-2']);
  });

  it('keeps an ask box with a live cloud session under it', () => {
    expect(sorted(hiddenAsks({ ...input, boxesWithCloud: new Set(['ask-2']) }).boxIds)).toEqual(['ask-1']);
  });
});

describe('hiddenAsks: projects on the person\'s own boxes', () => {
  const boxes = [box('mine', null), box('ask-1', 'ask')];
  const projects = [
    { id: 'work', instanceId: 'mine', createdFor: null },
    { id: 'asked-here', instanceId: 'mine', createdFor: 'ask' }, // termag ask --new-box onto a box that was already there
    { id: 'old-asked', instanceId: 'mine' }, // no mark: made before it existed, or by hand
    { id: 'on-ask-box', instanceId: 'ask-1', createdFor: 'ask' },
    { id: 'shared-ask', instanceId: 'someone-elses', createdFor: 'ask' },
    { id: 'local', instanceId: null, createdFor: 'ask' },
  ];
  const input = { enabled: true, boxes, projects, activeProjectId: null };

  it('hides each project made for an ask on a box of the person\'s, and nothing else', () => {
    expect(sorted(hiddenAsks(input).projectIds)).toEqual(['asked-here', 'on-ask-box']);
  });

  it('keeps the open project, and hides nothing while the setting is off', () => {
    expect(sorted(hiddenAsks({ ...input, activeProjectId: 'asked-here' }).projectIds)).toEqual(['on-ask-box']);
    expect(hiddenAsks({ ...input, enabled: false }).projectIds.size).toBe(0);
  });

  it('keeps an open ask project\'s box but not the other asks on it', () => {
    const more = [...projects, { id: 'on-ask-box-2', instanceId: 'ask-1', createdFor: 'ask' }];
    const hidden = hiddenAsks({ ...input, projects: more, activeProjectId: 'on-ask-box' });
    expect(hidden.boxIds.has('ask-1')).toBe(false);
    expect(sorted(hidden.projectIds)).toEqual(['asked-here', 'on-ask-box-2']);
  });

  it('keeps an ask box that holds a project of the person\'s own, open or not, with only that project', () => {
    const more = [...projects, { id: 'website', instanceId: 'ask-1', createdFor: null }]; // made later in New project, on the ask box
    for (const activeProjectId of [null, 'work']) {
      const hidden = hiddenAsks({ ...input, projects: more, activeProjectId });
      expect(hidden.boxIds.has('ask-1')).toBe(false);
      expect(hidden.projectIds.has('website')).toBe(false);
      expect(hidden.projectIds.has('on-ask-box')).toBe(true);
      expect(withoutAsks(more, hidden).filter(p => p.instanceId === 'ask-1').map(p => p.id)).toEqual(['website']);
    }
  });
});

describe('withoutAsks', () => {
  const projects = [
    { id: 'a', instanceId: 'mine' },
    { id: 'b', instanceId: 'ask-1' },
    { id: 'c', instanceId: null },
    { id: 'd', instanceId: 'ask-1' },
    { id: 'e', instanceId: 'mine' },
  ];

  it('drops the projects on hidden boxes and the hidden projects, and keeps the rest, "this host" included', () => {
    expect(withoutAsks(projects, { boxIds: new Set(['ask-1']), projectIds: new Set(['e']) }).map(p => p.id)).toEqual(['a', 'c']);
  });

  it('returns the list itself when nothing is hidden', () => {
    expect(withoutAsks(projects, { boxIds: new Set(), projectIds: new Set() })).toBe(projects);
  });

  it('leaves Show stopped counting only the stopped boxes it would bring back', () => {
    const boxes = [box('mine', null, 'stopped'), box('ask-1', 'ask', 'stopped'), box('only-asks', null, 'stopped')];
    const all = [
      { id: 'a', instanceId: 'mine' },
      { id: 'b', instanceId: 'ask-1', createdFor: 'ask' },
      { id: 'c', instanceId: 'only-asks', createdFor: 'ask' },
    ];
    const hidden = hiddenAsks({ enabled: true, boxes, projects: all, activeProjectId: null });
    const stopped = stoppedBoxGroups({ boxes, projects: withoutAsks(all, hidden), activeProjectId: null });
    expect([...stopped.boxIds]).toEqual(['mine']);
    expect(stopped.projectCount).toBe(1);
  });
});
