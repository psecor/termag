import { describe, expect, it } from 'vitest';
import type { InboxRow } from '../mobile/inbox';
import type { OpenItem } from './openItems';
import type { RowStateKind } from './rowState';
import type { SpawnLink } from './explorerAgents';
import {
  needsYouCount, projectGroupFolded, projectGroups, readProjectFolds, repoSetKey, repoSetName, toggleProjectFold,
  PROJECT_FOLDS_KEY, type GroupedProject, type GroupedUserProject, type ProjectGroupsInput, type SessionOpenPr,
} from './sidebarGroups';

const T0 = Date.parse('2026-11-10T12:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

function row(projectId: string, workstream = 'main', over: Partial<InboxRow> = {}): InboxRow {
  return {
    key: `${projectId}|${workstream}`, projectId, projectName: projectId, workstream, owner: 'me', shared: false,
    provider: 'claude-chat', instanceId: 'box-1', kind: 'normal', pinned: false, status: 'idle', waitingReason: null,
    updatedAt: at(0), message: null, contextTokens: null, rateLimited: null, review: null, ring: null, band: 'other',
    ...over,
  } as InboxRow;
}

/** The input around `rows`: states by row key (default done), projects by id, each session's activity in minutes. */
function input(rows: InboxRow[], o: {
  states?: Record<string, RowStateKind>;
  projects?: Record<string, GroupedProject>;
  active?: Record<string, number>;
  links?: SpawnLink[];
  showIdle?: boolean;
  showFiles?: boolean;
  files?: OpenItem[];
  openKey?: string | null;
  openTab?: string | null;
  userProjects?: GroupedUserProject[];
  openPrs?: SessionOpenPr[];
} = {}): ProjectGroupsInput {
  return {
    rows,
    stateOf: r => o.states?.[r.key] ?? 'done',
    projectOf: id => o.projects?.[id],
    activeAt: r => (o.active?.[r.key] != null ? T0 + o.active[r.key] * 60_000 : null),
    links: o.links ?? [],
    view: { showIdle: o.showIdle ?? true, showFiles: o.showFiles ?? true },
    files: o.files ?? [],
    openKey: o.openKey ?? null,
    openTab: o.openTab ?? null,
    userProjects: o.userProjects,
    openPrs: o.openPrs,
  };
}

const shape = (input: ProjectGroupsInput) => projectGroups(input).map(g => [g.name, g.rows.map(r => r.key), g.count]);

describe('repoSetKey / repoSetName', () => {
  it('is one key for a repository set, whatever its order, case or .git', () => {
    expect(repoSetKey({ repoKeys: ['example-org/termag', 'example-org/termag-desktop'] }))
      .toBe(repoSetKey({ repoKeys: ['Example-Org/Termag-Desktop.git', 'example-org/termag'] }));
    expect(repoSetKey({ repoKeys: ['example-org/termag'] })).not.toBe(repoSetKey({ repoKeys: ['example-org/termag', 'example-org/dev'] }));
    expect(repoSetKey({ repoKeys: [] })).toBe('no-repo');
    expect(repoSetKey({})).toBe('no-repo');
    expect(repoSetKey(undefined)).toBe('no-repo');
  });

  it('names one, two, more and none', () => {
    expect(repoSetName(['example-org/termag'])).toBe('termag');
    expect(repoSetName(['example-org/termag', 'example-org/termag-desktop'])).toBe('termag + termag-desktop');
    expect(repoSetName(['example-org/termag-desktop', 'example-org/termag'])).toBe('termag-desktop + termag');
    expect(repoSetName(['example-org/dev', 'a/b', 'a/c', 'a/d'])).toBe('dev + 3 more');
    expect(repoSetName([])).toBe('No repo');
    expect(repoSetName(undefined)).toBe('No repo');
  });
});

describe('projectGroups', () => {
  const termag = { repoKeys: ['example-org/termag'] };

  it('puts one repository on two boxes in one group, and a session with no repository under No repo', () => {
    const rows = [row('t1', 'main', { instanceId: 'box-1' }), row('t2', 'main', { instanceId: 'box-2' }), row('scratch')];
    const projects = { t1: termag, t2: { repoKeys: ['Example-Org/termag.git'] }, scratch: { repoKeys: [] } };
    expect(shape(input(rows, { projects, active: { 't1|main': 5, 't2|main': 9, 'scratch|main': 1 } })))
      .toEqual([['termag', ['t2|main', 't1|main'], 2], ['No repo', ['scratch|main'], 1]]);
  });

  it('puts a repository set in one group whichever order its checkouts hold it, named in the latest one\'s order', () => {
    const rows = [row('w1'), row('w2')];
    const projects = {
      w1: { repoKeys: ['example-org/termag', 'example-org/termag-desktop'] },
      w2: { repoKeys: ['example-org/termag-desktop', 'example-org/termag'] },
    };
    expect(shape(input(rows, { projects, active: { 'w1|main': 1, 'w2|main': 2 } })))
      .toEqual([['termag-desktop + termag', ['w2|main', 'w1|main'], 2]]);
    expect(shape(input(rows, { projects, active: { 'w1|main': 3, 'w2|main': 2 } }))[0][0]).toBe('termag + termag-desktop');
  });

  it('pins Needs you on top, oldest wait first, out of its group, which still counts it', () => {
    const rows = [
      row('t1'), row('t1', 'fix', { updatedAt: at(-30) }), row('t2', 'main', { updatedAt: at(-5) }), row('g'),
    ];
    const projects = { t1: termag, t2: termag, g: { repoKeys: ['example-org/webapp'] } };
    const states = { 't1|fix': 'approval', 't2|main': 'unread', 'g|main': 'error' } as const;
    const g = projectGroups(input(rows, { projects, states, active: { 't1|main': 3, 'g|main': 9 } }));
    expect(g.map(x => [x.name, x.rows.map(r => r.key), x.count])).toEqual([
      ['Needs you', ['t1|fix', 't2|main', 'g|main'], 3],
      ['termag', ['t1|main'], 3],
    ]);
    // Answered, it is back in its group.
    const after = shape(input(rows, { projects, states: { 't2|main': 'unread', 'g|main': 'error' }, active: { 't1|main': 3, 't1|fix': 4 } }));
    expect(after[1]).toEqual(['termag', ['t1|fix', 't1|main'], 3]);
  });

  it('counts for the phone exactly the rows Needs you lists, whatever the filters', () => {
    const rows = [row('a'), row('b'), row('c'), row('d'), row('e')];
    const states = { 'a|main': 'approval', 'b|main': 'unread', 'c|main': 'error', 'd|main': 'off', 'e|main': 'working' } as const;
    const stateOf = (r: InboxRow) => states[r.key as keyof typeof states];
    expect(needsYouCount(rows, stateOf)).toBe(3);
    const g = projectGroups(input(rows, { states, showIdle: false, showFiles: false }));
    expect(g[0]).toMatchObject({ key: 'needs-you', count: 3 });
    expect(needsYouCount([row('d')], stateOf)).toBe(0);
  });

  it('keeps a session that finished since you looked in its group, not Needs you', () => {
    // An unseen row keeps its kind, done or off (chat/rowState.ts); only the blue dot says it.
    const rows = [row('t1'), row('t2')];
    const g = projectGroups(input(rows, { projects: { t1: termag, t2: termag }, states: { 't1|main': 'done', 't2|main': 'off' } }));
    expect(g.map(x => x.name)).toEqual(['termag']);
  });

  it('puts shared sessions under Shared with me and automation runs under Automations, after the projects', () => {
    const rows = [
      row('auto', 'run-20261110-0900', { kind: 'automation' }), row('bob', 'main', { shared: true }), row('t1'),
      row('auto', 'run-20261109-0900', { kind: 'automation' }),
    ];
    expect(shape(input(rows, {
      projects: { t1: termag, bob: termag, auto: {} },
      active: { 'auto|run-20261110-0900': 50, 'auto|run-20261109-0900': 10, 'bob|main': 60 },
    }))).toEqual([
      ['termag', ['t1|main'], 1],
      ['Shared with me', ['bob|main'], 1],
      ['Automations', ['auto|run-20261110-0900', 'auto|run-20261109-0900'], 2],
    ]);
  });

  it('puts an ask or a spawn in the group of the session that started it, so it nests there', () => {
    const rows = [row('t1'), row('g', 'ask-th1'), row('g'), row('g', 'spawned')];
    const links: SpawnLink[] = [
      { projectId: 'g', workstream: 'ask-th1', parentProjectId: 't1', parentWorkstream: 'main' },
      { projectId: 'g', workstream: 'spawned', parentProjectId: 'g', parentWorkstream: 'ask-th1' },
    ];
    const projects = { t1: termag, g: { repoKeys: ['example-org/webapp'] } };
    expect(shape(input(rows, { projects, links, active: { 'g|main': 9 } }))).toEqual([
      ['webapp', ['g|main'], 1],
      ['termag', ['t1|main', 'g|ask-th1', 'g|spawned'], 3],
    ]);
    // A child whose parent is up in Needs you stays in its own group; a loop leaves each where it is.
    const up = shape(input(rows, { projects, links, states: { 't1|main': 'approval' } }));
    expect(up.find(g => g[0] === 'webapp')?.[1]).toEqual(['g|ask-th1', 'g|main', 'g|spawned']);
    const loop: SpawnLink[] = [
      { projectId: 'g', workstream: 'main', parentProjectId: 't1', parentWorkstream: 'main' },
      { projectId: 't1', workstream: 'main', parentProjectId: 'g', parentWorkstream: 'main' },
    ];
    expect(shape(input([row('t1'), row('g')], { projects, links: loop })).map(g => g[0]).sort()).toEqual(['termag', 'webapp']);
  });

  it('drops sessions that aren\'t running with the filter off, except the one on screen', () => {
    const rows = [row('t1'), row('t1', 'old'), row('t2')];
    const states = { 't1|old': 'off', 't2|main': 'off' } as const;
    const projects = { t1: termag, t2: { repoKeys: ['a/other'] } };
    expect(shape(input(rows, { projects, states, showIdle: false }))).toEqual([['termag', ['t1|main'], 1]]);
    expect(shape(input(rows, { projects, states, showIdle: false, openKey: 't2|main' })).map(g => g[0]).sort()).toEqual(['other', 'termag']);
    expect(projectGroups(input([row('t2')], { projects, states, showIdle: false }))).toEqual([]);
  });

  it('orders groups pinned first, then by their latest activity, and rows most recent first', () => {
    const rows = [row('a'), row('b'), row('c'), row('c', 'two')];
    const projects = {
      a: { repoKeys: ['x/a'], lastActiveAt: at(1) },
      b: { repoKeys: ['x/b'], lastActiveAt: at(30), pinned: false },
      c: { repoKeys: ['x/c'], lastActiveAt: at(2), pinned: true },
    };
    expect(shape(input(rows, { projects, active: { 'c|two': 5 } }))).toEqual([
      ['c', ['c|two', 'c|main'], 2],
      ['b', ['b|main'], 1],
      ['a', ['a|main'], 1],
    ]);
  });

  it("sorts a project's sessions by their own activity, not their project's, which is the latest of them", () => {
    // main last active at 09:00 and feature at 11:00, so the project says 11:00 for both.
    const rows = [row('t1', 'main'), row('t1', 'feature'), row('t2')];
    const projects = { t1: { ...termag, lastActiveAt: at(120) }, t2: { repoKeys: ['x/old'], lastActiveAt: at(60) } };
    expect(shape(input(rows, { projects, active: { 't1|main': 0, 't1|feature': 120 } }))).toEqual([
      ['termag', ['t1|feature', 't1|main'], 2],
      // A session with no activity of its own falls back to its project's.
      ['old', ['t2|main'], 1],
    ]);
    // The group still counts its project's activity: termag (120) stays ahead of a group whose session is at 90.
    const later = shape(input([...rows, row('t3')], { projects: { ...projects, t3: { repoKeys: ['x/new'] } }, active: { 't1|main': 0, 't1|feature': 10, 't3|main': 90 } }));
    expect(later.map(g => g[0])).toEqual(['termag', 'new', 'old']);
  });

  it('lists file and new tabs under Files when they are on, and the open one always', () => {
    const file: OpenItem = { id: 'f1', openedAt: 0, kind: 'file', space: 'notes', path: 'a.md' };
    const tab: OpenItem = { id: 'e1', openedAt: 0, kind: 'explorer', space: 'notes' };
    const chat: OpenItem = { id: 'c1', openedAt: 0, kind: 'chat', projectId: 't1', workstream: 'main' };
    const files = [chat, file, tab];
    expect(shape(input([row('t1')], { projects: { t1: termag }, files }))).toEqual([['termag', ['t1|main'], 1], ['Files', [], 2]]);
    expect(projectGroups(input([row('t1')], { projects: { t1: termag }, files, showFiles: false })).map(g => g.name)).toEqual(['termag']);
    const open = projectGroups(input([row('t1')], { projects: { t1: termag }, files, showFiles: false, openTab: 'f1' }));
    expect(open.at(-1)?.items.map(i => i.id)).toEqual(['f1']);
  });

  it('has no Files under the sidebar redesign: files are the side panel\'s', () => {
    const file: OpenItem = { id: 'f1', openedAt: 0, kind: 'file', space: 'notes', path: 'a.md' };
    const groups = projectGroups({ ...input([row('t1')], { projects: { t1: termag }, files: [file], openTab: 'f1' }), redesign: { elsewhere: new Set() } });
    expect(groups.map(g => g.kind)).not.toContain('files');
  });
});

describe("projectGroups by the person's projects", () => {
  const termag = { repoKeys: ['example-org/termag'], userProjectId: 'up-t' };
  const desk = { repoKeys: ['example-org/termag-desktop'], userProjectId: 'up-d' };
  const own: GroupedUserProject[] = [
    { id: 'up-t', name: 'Termag web', lastActiveAt: at(1) },
    { id: 'up-d', name: 'Desktop', lastActiveAt: at(1) },
  ];

  it('groups checkouts by their project, by its name, and a checkout with none by its repository set', () => {
    const rows = [row('t1'), row('t2'), row('d1'), row('late')];
    const projects = {
      t1: termag, t2: { ...termag, repoKeys: ['example-org/termag', 'example-org/dev'] }, d1: desk,
      // The backfill hasn't reached it: milestone 3's group.
      late: { repoKeys: ['example-org/termag'], userProjectId: null },
    };
    const groups = projectGroups(input(rows, { projects, userProjects: own, active: { 't1|main': 9, 't2|main': 5, 'd1|main': 7, 'late|main': 1 } }));
    expect(groups.map(g => [g.key, g.name, g.rows.map(r => r.key), g.userProjectId])).toEqual([
      ['userproject:up-t', 'Termag web', ['t1|main', 't2|main'], 'up-t'],
      ['userproject:up-d', 'Desktop', ['d1|main'], 'up-d'],
      ['repos:example-org/termag', 'termag', ['late|main'], undefined],
    ]);
  });

  it('keeps the repository sets until the projects are read, and for a project it no longer lists', () => {
    const rows = [row('t1'), row('d1')];
    const projects = { t1: termag, d1: desk };
    expect(projectGroups(input(rows, { projects })).map(g => g.name)).toEqual(['termag', 'termag-desktop']);
    // An archived project isn't passed: its checkout falls back.
    expect(projectGroups(input(rows, { projects, userProjects: [own[0]] })).map(g => g.name).sort()).toEqual(['Termag web', 'termag-desktop']);
  });

  it('shows a project with no session as an empty group, by its activity, and not while idle sessions are hidden', () => {
    const fresh: GroupedUserProject = { id: 'up-new', name: 'Brand new', lastActiveAt: at(30) };
    const groups = projectGroups(input([row('t1')], { projects: { t1: termag }, userProjects: [...own, fresh], active: { 't1|main': 5 } }));
    expect(groups.map(g => [g.name, g.rows.length, g.count, g.empty ?? false])).toEqual([
      ['Brand new', 0, 0, true],
      ['Termag web', 1, 1, false],
      ['Desktop', 0, 0, true],
    ]);
    const idleHidden = projectGroups(input([row('t1', 'main', { status: 'working' })], {
      projects: { t1: termag }, userProjects: [...own, fresh], showIdle: false, states: { 't1|main': 'working' },
    }));
    expect(idleHidden.map(g => g.name)).toEqual(['Termag web']);
  });

  it("never calls a project empty while its record has sessions the project list doesn't show under it yet", () => {
    // The project list was read before the flag (no userProjectId), or hasn't answered: its checkout sits in its repository set.
    const groups = projectGroups(input([row('t1')], { projects: { t1: { repoKeys: ['example-org/termag'], userProjectId: null } }, userProjects: [{ ...own[0], liveSessions: 1 }] }));
    expect(groups.map(g => [g.name, g.empty ?? false])).toEqual([['termag', false]]);
    expect(projectGroups(input([], { userProjects: [{ ...own[0], liveSessions: 0 }] })).map(g => [g.name, g.empty])).toEqual([['Termag web', true]]);
  });

  it('never calls a project empty when its sessions are up in Needs you, or nest under another group', () => {
    const rows = [row('t1'), row('d1', 'ask-1')];
    const links = [{ projectId: 'd1', workstream: 'ask-1', parentProjectId: 't1', parentWorkstream: 'main' }] as SpawnLink[];
    const groups = projectGroups(input(rows, { projects: { t1: termag, d1: desk }, userProjects: own, links }));
    expect(groups.map(g => [g.name, g.rows.map(r => r.key)])).toEqual([['Termag web', ['t1|main', 'd1|ask-1']]]);
    const needs = projectGroups(input([row('d1')], { projects: { d1: desk }, userProjects: [own[1]], states: { 'd1|main': 'approval' } }));
    expect(needs.map(g => [g.name, g.empty ?? false])).toEqual([['Needs you', false]]);
  });

  it("counts a project's open PRs once each, and points at its most recently active session with one", () => {
    const rows = [row('t1'), row('t1', 'fix'), row('t2'), row('d1')];
    const projects = { t1: termag, t2: termag, d1: desk };
    const openPrs = [
      { key: 't1|main', pr: 'example-org/termag#1' },
      { key: 't1|fix', pr: 'example-org/termag#2' },
      { key: 't2|main', pr: 'example-org/termag#2' },
      // Up in Needs you: still the project's.
      { key: 'd1|main', pr: 'example-org/termag-desktop#7' },
      // A session the list doesn't show.
      { key: 'gone|main', pr: 'example-org/termag#9' },
    ];
    const groups = projectGroups(input(rows, {
      projects, userProjects: own, openPrs, states: { 'd1|main': 'approval' },
      active: { 't1|main': 1, 't1|fix': 8, 't2|main': 4, 'd1|main': 2 },
    }));
    expect(groups.find(g => g.name === 'Termag web')?.prs).toEqual({ count: 2, openKey: 't1|fix' });
    expect(groups.find(g => g.name === 'Needs you')?.prs).toBeUndefined();
    // Desktop's only session is up in Needs you, so it has no group of its own to carry the count.
    expect(groups.some(g => g.name === 'Desktop')).toBe(false);
    expect(projectGroups(input([row('t1')], { projects, userProjects: own })).find(g => g.name === 'Termag web')?.prs).toBeUndefined();
  });
});

describe('project folds', () => {
  const store = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
  };

  it('folds Automations by default and nothing else, and keeps a toggle per browser', () => {
    const s = store();
    let folds = readProjectFolds(s);
    expect(projectGroupFolded(folds, 'automations')).toBe(true);
    expect(projectGroupFolded(folds, 'repos:example-org/termag')).toBe(false);
    folds = toggleProjectFold(folds, 'automations', s);
    folds = toggleProjectFold(folds, 'repos:example-org/termag', s);
    const again = readProjectFolds(s);
    expect(projectGroupFolded(again, 'automations')).toBe(false);
    expect(projectGroupFolded(again, 'repos:example-org/termag')).toBe(true);
    expect(JSON.parse(s.getItem(PROJECT_FOLDS_KEY)!)).toEqual(folds);
  });

  it('reads garbage as no folds', () => {
    for (const raw of ['nope', '[1]', '{"a":"yes","b":true}']) {
      const s = store();
      s.setItem(PROJECT_FOLDS_KEY, raw);
      expect(readProjectFolds(s)).toEqual(raw.includes('"b"') ? { b: true } : {});
    }
    expect(readProjectFolds(null)).toEqual({});
  });
});
