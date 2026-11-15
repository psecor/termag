import { describe, expect, it, vi } from 'vitest';
import type { OpenItem } from './openItems';
import type { RowStateKind } from './rowState';
import { viewGroups } from './sidebarGroups';
import {
  DEFAULT_SIDEBAR_VIEW, PROJECTS_SIDEBAR_VIEW, parsePickedSidebarView, parseSidebarView, resetSidebarViewForTests, resolveSidebarView,
  setSidebarView, SIDEBAR_GROUPINGS, SIDEBAR_VIEW_KEY,
} from './sidebarView';

describe('parseSidebarView', () => {
  it('reads each option on its own, falling back to its default', () => {
    expect(parseSidebarView(null)).toEqual(DEFAULT_SIDEBAR_VIEW);
    expect(parseSidebarView('not json')).toEqual(DEFAULT_SIDEBAR_VIEW);
    expect(parseSidebarView('[1]')).toEqual(DEFAULT_SIDEBAR_VIEW);
    // Older's threshold: 1, 3 or 7 days, or never (0); anything else is the default, 3.
    expect(parseSidebarView(JSON.stringify({ olderDays: 7 })).olderDays).toBe(7);
    expect(parseSidebarView(JSON.stringify({ olderDays: 0 })).olderDays).toBe(0);
    expect(parseSidebarView(JSON.stringify({ olderDays: 5 })).olderDays).toBe(3);
    expect(parseSidebarView(JSON.stringify({ show: 'projects', density: 'standard', groupBy: 'status', showFiles: false, showIdle: false })))
      .toEqual({ show: 'projects', density: 'standard', groupBy: 'status', showFiles: false, showIdle: false, olderDays: 3, sort: 'created' });
    // Sort (chat/sidebarSort.ts): Created or Recent activity; anything else is the default, Created.
    expect(parseSidebarView(JSON.stringify({ sort: 'recent' })).sort).toBe('recent');
    expect(parseSidebarView(JSON.stringify({ sort: 'created' })).sort).toBe('created');
    expect(parseSidebarView(JSON.stringify({ sort: 'name' })).sort).toBe('created');
    expect(parsePickedSidebarView(JSON.stringify({ sort: 'name' }))).toEqual({});
    expect(parseSidebarView(JSON.stringify({ density: 'roomy', groupBy: 'status', showFiles: 'no', sampleStates: true })))
      .toEqual({ ...DEFAULT_SIDEBAR_VIEW, groupBy: 'status' });
    expect(parseSidebarView(JSON.stringify({ groupBy: 'project' }))).toEqual({ ...DEFAULT_SIDEBAR_VIEW, groupBy: 'project' });
  });

  it('keeps a view stored before Show as it was, on Tabs', () => {
    const old = { density: 'standard', groupBy: 'project', showFiles: false, showIdle: true };
    expect(parseSidebarView(JSON.stringify(old))).toEqual({ ...old, show: 'tabs', olderDays: 3, sort: 'created' });
    expect(parseSidebarView(JSON.stringify({ ...old, show: 'everything' })).show).toBe('tabs');
    expect(DEFAULT_SIDEBAR_VIEW.show).toBe('tabs');
  });
});

describe('the view under user-projects-enabled', () => {
  it('opens on Projects, by project, for someone who never picked a view', () => {
    expect(parseSidebarView(null, true)).toEqual(PROJECTS_SIDEBAR_VIEW);
    expect(PROJECTS_SIDEBAR_VIEW).toMatchObject({ show: 'projects', groupBy: 'project' });
    expect(parseSidebarView(JSON.stringify({ density: 'standard' }), true)).toEqual({ ...PROJECTS_SIDEBAR_VIEW, density: 'standard' });
  });

  it('keeps a picked grouping, Space included, until milestone 8 retires spaces, and has no Tabs', () => {
    // The redesign has one list: a kept Tabs is every session under the flag, and stays Tabs without it.
    expect(parseSidebarView(JSON.stringify({ v: 2, show: 'tabs' }), true).show).toBe('projects');
    expect(parseSidebarView(JSON.stringify({ v: 2, show: 'tabs' }), false).show).toBe('tabs');
    expect(parseSidebarView(JSON.stringify({ v: 2, show: 'tabs', groupBy: 'space' }), true).groupBy).toBe('space');
    // Milestone 3 wrote Space, its default, with every change: not a pick.
    expect(parseSidebarView(JSON.stringify({ show: 'tabs', groupBy: 'space' }), true).groupBy).toBe('project');
    expect(parseSidebarView(JSON.stringify({ show: 'tabs', groupBy: 'space' }), false).groupBy).toBe('space');
    expect(parseSidebarView(JSON.stringify({ groupBy: 'status' }), true).groupBy).toBe('status');
    // Never picked: by Project under the flag, by Space without it.
    expect(parseSidebarView(JSON.stringify({ v: 2, show: 'tabs' }), true).groupBy).toBe('project');
    expect(parseSidebarView(JSON.stringify({ v: 2, show: 'tabs' }), false).groupBy).toBe('space');
  });

  it("reads milestone 3's whole saved view, which wrote Tabs whenever any option changed, as no pick of Tabs", () => {
    const old = { show: 'tabs', density: 'standard', groupBy: 'space', showFiles: true, showIdle: false };
    expect(parseSidebarView(JSON.stringify(old), true)).toEqual({ ...PROJECTS_SIDEBAR_VIEW, density: 'standard', showIdle: false });
    expect(parseSidebarView(JSON.stringify(old), false)).toEqual({ ...old, olderDays: 3, sort: 'created' });
    // Projects was never the default, so a kept Projects was picked.
    expect(parseSidebarView(JSON.stringify({ ...old, show: 'projects' }), false).show).toBe('projects');
  });

  it('is as before with the flag off', () => {
    expect(parseSidebarView(null, false)).toEqual(DEFAULT_SIDEBAR_VIEW);
    expect(resolveSidebarView({}, false)).toEqual(DEFAULT_SIDEBAR_VIEW);
    expect(resolveSidebarView({ groupBy: 'space' }, false).groupBy).toBe('space');
    expect(resolveSidebarView({ groupBy: 'space' }, true).groupBy).toBe('space');
  });

  it('keeps only what was picked, so a later default still applies to the rest', () => {
    const kept = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v); } });
    try {
      resetSidebarViewForTests();
      setSidebarView({ density: 'standard' });
      const raw = kept.get(SIDEBAR_VIEW_KEY) ?? null;
      expect(JSON.parse(raw!)).toEqual({ v: 2, density: 'standard' });
      setSidebarView({ show: 'tabs' });
      expect(parseSidebarView(kept.get(SIDEBAR_VIEW_KEY) ?? null, false).show).toBe('tabs');
      setSidebarView({ show: 'projects' });
      setSidebarView({ show: 'tabs' });
      expect(parseSidebarView(raw, true).show).toBe('projects');
      expect(parseSidebarView(raw, false).show).toBe('tabs');
      expect(parseSidebarView(kept.get(SIDEBAR_VIEW_KEY) ?? null, false).show).toBe('tabs');
      expect(parseSidebarView(kept.get(SIDEBAR_VIEW_KEY) ?? null, true).show).toBe('projects');
    } finally {
      resetSidebarViewForTests();
      vi.unstubAllGlobals();
    }
    expect(parsePickedSidebarView(JSON.stringify({ show: 'all', density: 'standard', showIdle: false }))).toEqual({ density: 'standard', showIdle: false });
  });

  it('offers Space, Project and Status', () => {
    expect(SIDEBAR_GROUPINGS).toEqual(['space', 'project', 'status']);
  });
});

const chat = (id: string, projectId = id): OpenItem => ({ id, openedAt: 0, kind: 'chat', projectId, workstream: id });
const file = (id: string, space: string): OpenItem => ({ id, openedAt: 0, kind: 'file', space, path: `${id}.md` });

describe('viewGroups', () => {
  const states: Record<string, RowStateKind> = { a: 'working', b: 'approval', c: 'off', d: 'done', e: 'error' };
  const stateOf = (i: OpenItem) => (i.kind === 'chat' ? states[i.projectId] ?? null : null);
  const groups = [
    { space: 'notes', items: [chat('a'), file('readme', 'notes'), chat('c')] },
    { space: 'ops', items: [chat('b'), chat('d')] },
    { space: null, items: [chat('e'), chat('z')] },
  ];
  const names = (g: ReturnType<typeof viewGroups>) => g.map(x => [x.status?.name ?? x.space, x.items.map(i => i.id)]);

  it('keeps the spaces and their order, with nothing filtered by default', () => {
    expect(names(viewGroups(groups, DEFAULT_SIDEBAR_VIEW, stateOf)))
      .toEqual([['notes', ['a', 'readme', 'c']], ['ops', ['b', 'd']], [null, ['e', 'z']]]);
  });

  it('hides files and agents that are not running, and remembers what a space had', () => {
    const g = viewGroups(groups, { groupBy: 'space', showFiles: false, showIdle: false }, stateOf);
    expect(names(g)).toEqual([['notes', ['a']], ['ops', ['b', 'd']], [null, ['e', 'z']]]);
    expect(g[0].total).toBe(3);
  });

  it('never hides the open tab, whatever the filters', () => {
    const off = { groupBy: 'space' as const, showFiles: false, showIdle: false };
    expect(names(viewGroups(groups, off, stateOf, 'readme'))[0]).toEqual(['notes', ['a', 'readme']]);
    expect(names(viewGroups(groups, off, stateOf, 'c'))[0]).toEqual(['notes', ['a', 'c']]);
    expect(names(viewGroups(groups, { ...off, groupBy: 'status' }, stateOf, 'c')).map(g => g[0])).toContain('Not running');
  });

  it('groups by state in the order they need you, files last, and drops empty groups', () => {
    expect(names(viewGroups(groups, { groupBy: 'status', showFiles: true, showIdle: true }, stateOf))).toEqual([
      ['Needs you', ['b', 'e']],
      ['Working', ['a']],
      ['Idle', ['d', 'z']],
      ['Not running', ['c']],
      ['Files', ['readme']],
    ]);
    expect(names(viewGroups(groups, { groupBy: 'status', showFiles: false, showIdle: false }, stateOf)).map(g => g[0]))
      .toEqual(['Needs you', 'Working', 'Idle']);
  });

  it('groups by project, by name, files last, and keeps the open tab whatever the filters', () => {
    const tabs = [
      { space: 'notes', items: [chat('a', 'p-web'), file('readme', 'notes'), chat('c', 'p-api')] },
      { space: null, items: [chat('e', 'p-web'), chat('z', 'p-gone')] },
    ];
    const projectOf = (i: OpenItem & { kind: 'chat' }) =>
      ({ 'p-web': 'web-app', 'p-api': 'api-server' } as Record<string, string>)[i.projectId] ?? null;
    const project = { groupBy: 'project' as const, showFiles: true, showIdle: true };
    const g = viewGroups(tabs, project, () => null, null, projectOf);
    expect(names(g)).toEqual([
      ['api-server', ['c']],
      ['p-gone', ['z']],
      ['web-app', ['a', 'e']],
      ['Files', ['readme']],
    ]);
    expect(g.map(x => x.status?.key)).toEqual(['project:p-api', 'project:p-gone', 'project:p-web', 'files']);
    const off = { ...project, showFiles: false, showIdle: false };
    const offState = (i: OpenItem) => (i.kind === 'chat' && i.id === 'c' ? 'off' : 'working');
    expect(names(viewGroups(tabs, off, offState, 'c', projectOf))).toEqual([
      ['api-server', ['c']],
      ['p-gone', ['z']],
      ['web-app', ['a', 'e']],
    ]);
  });

  it("groups by the person's project under user-projects-enabled, a checkout with none under its own", () => {
    const tabs = [
      { space: 'notes', items: [chat('a', 'p-web'), chat('c', 'p-web-2')] },
      { space: null, items: [chat('e', 'p-api'), chat('z', 'p-new')] },
    ];
    const projectOf = (i: OpenItem & { kind: 'chat' }) => ({ 'p-new': 'new-checkout' } as Record<string, string>)[i.projectId] ?? i.projectId;
    const userProjectOf = (i: OpenItem & { kind: 'chat' }) => ({
      'p-web': { id: 'up-web', name: 'Web app' }, 'p-web-2': { id: 'up-web', name: 'Web app' }, 'p-api': { id: 'up-api', name: 'API' },
    } as Record<string, { id: string; name: string }>)[i.projectId] ?? null;
    const g = viewGroups(tabs, { groupBy: 'project', showFiles: true, showIdle: true }, () => null, null, projectOf, userProjectOf);
    expect(names(g)).toEqual([['API', ['e']], ['new-checkout', ['z']], ['Web app', ['a', 'c']]]);
    expect(g.map(x => x.status?.key)).toEqual(['userproject:up-api', 'project:p-new', 'userproject:up-web']);
  });
});

describe('Group by under project-files-enabled', () => {
  it('reads a kept Space as Project, and offers no Space, only with both flags', async () => {
    const { resolveSidebarView, sidebarGroupings } = await import('./sidebarView');
    expect(resolveSidebarView({ groupBy: 'space' }, true, true).groupBy).toBe('project');
    expect(resolveSidebarView({ groupBy: 'status' }, true, true).groupBy).toBe('status');
    expect(resolveSidebarView({ groupBy: 'space' }, true, false).groupBy).toBe('space');
    expect(resolveSidebarView({ groupBy: 'space' }, false, true).groupBy).toBe('space');
    expect(sidebarGroupings(true, true)).toEqual(['project', 'status']);
    expect(sidebarGroupings(true, false)).toEqual(['space', 'project', 'status']);
  });
});
