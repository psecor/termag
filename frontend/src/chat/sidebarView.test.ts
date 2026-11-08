import { describe, expect, it } from 'vitest';
import type { OpenItem } from './openItems';
import type { RowStateKind } from './rowState';
import { viewGroups } from './sidebarGroups';
import { DEFAULT_SIDEBAR_VIEW, parseSidebarView } from './sidebarView';

describe('parseSidebarView', () => {
  it('reads each option on its own, falling back to its default', () => {
    expect(parseSidebarView(null)).toEqual(DEFAULT_SIDEBAR_VIEW);
    expect(parseSidebarView('not json')).toEqual(DEFAULT_SIDEBAR_VIEW);
    expect(parseSidebarView('[1]')).toEqual(DEFAULT_SIDEBAR_VIEW);
    expect(parseSidebarView(JSON.stringify({ density: 'standard', groupBy: 'status', showFiles: false, showIdle: false })))
      .toEqual({ density: 'standard', groupBy: 'status', showFiles: false, showIdle: false });
    expect(parseSidebarView(JSON.stringify({ density: 'roomy', groupBy: 'status', showFiles: 'no', sampleStates: true })))
      .toEqual({ ...DEFAULT_SIDEBAR_VIEW, groupBy: 'status' });
    expect(parseSidebarView(JSON.stringify({ groupBy: 'project' }))).toEqual({ ...DEFAULT_SIDEBAR_VIEW, groupBy: 'project' });
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
      ['Recent', ['d', 'z']],
      ['Not running', ['c']],
      ['Files', ['readme']],
    ]);
    expect(names(viewGroups(groups, { groupBy: 'status', showFiles: false, showIdle: false }, stateOf)).map(g => g[0]))
      .toEqual(['Needs you', 'Working', 'Recent']);
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
});
