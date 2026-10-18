import { describe, expect, it, vi } from 'vitest';
import { findMatches, parseRoles, searchSessions, type SearchableRow, type SearchDeps } from './sessionSearch';
import { SessionAccessError } from './sessionAccess';

vi.mock('./agentRegistry', () => ({ sendForProject: vi.fn() }));
vi.mock('../db', () => ({ prisma: {} }));

describe('findMatches', () => {
  const pane = ['$ npm test', 'Error: connect ECONNREFUSED 127.0.0.1:5432', '  at TCP', 'retrying', 'error: econnrefused again', '', ''].join('\n');

  it('matches case-insensitively, newest first, with a line of context each side', () => {
    const m = findMatches(pane, 'ECONNrefused');
    expect(m.count).toBe(2);
    expect(m.matches.map(x => x.line)).toEqual([5, 2]);
    expect(m.matches[1]).toEqual({ line: 2, text: 'Error: connect ECONNREFUSED 127.0.0.1:5432', before: ['$ npm test'], after: ['  at TCP'] });
    expect(m.lastLine).toBe(5);
    expect(m.totalLines).toBe(5); // trailing blank lines dropped
  });

  it('matches the query as a phrase and strips ANSI', () => {
    expect(findMatches('\x1b[31mconnect ECONNREFUSED\x1b[0m', 'connect econnrefused').count).toBe(1);
    expect(findMatches('connect, then ECONNREFUSED', 'connect econnrefused').count).toBe(0);
    expect(findMatches('anything', '   ').count).toBe(0);
  });

  it('caps the matches it returns but counts them all, and clips long lines around the hit', () => {
    const many = Array.from({ length: 12 }, (_, i) => `hit ${i}`).join('\n');
    const m = findMatches(many, 'hit');
    expect(m.count).toBe(12);
    expect(m.matches).toHaveLength(5);
    const long = `${'a'.repeat(500)}NEEDLE${'b'.repeat(500)}`;
    const t = findMatches(long, 'needle').matches[0].text;
    expect(t).toContain('NEEDLE');
    expect(t.length).toBeLessThanOrEqual(242);
    expect(t.startsWith('…') && t.endsWith('…')).toBe(true);
  });
});

describe('parseRoles', () => {
  it('keeps known roles and falls back to agent, ctrl, review', () => {
    // Canonical order, so the two spellings share a cache entry.
    expect(parseRoles('ctrl,agent,ctrl')).toEqual(['agent', 'ctrl']);
    expect(parseRoles('review, agent')).toEqual(['agent', 'review']);
    expect(parseRoles('nope')).toEqual(['agent', 'ctrl', 'review']);
    expect(parseRoles(undefined)).toEqual(['agent', 'ctrl', 'review']);
  });
});

describe('searchSessions', () => {
  const row = (over: Partial<SearchableRow>): SearchableRow => ({
    projectId: 'p1', projectName: 'termag', owner: 'ada', access: 'owner', workstream: 'main',
    role: 'agent', session: 'ada-termag-agent', connected: true, alive: true, status: 'idle', ...over,
  });
  const panes: Record<string, string> = {
    'p1|agent': 'old ECONNREFUSED\nlater\nlater',
    'p1|ctrl': 'ok\nECONNREFUSED at the bottom',
    'p2|agent': 'nothing here',
  };
  const deps = (rows: SearchableRow[], over: Partial<SearchDeps> = {}): SearchDeps => ({
    listRows: async () => rows,
    accessProject: async (_u, projectId) => (role, ws) => ({ host: { userId: 'u1', instanceId: 'box1' }, session: `${projectId}|${role}|${ws}` }),
    capture: async (_h, session) => panes[session.split('|').slice(0, 2).join('|')] ?? '',
    ...over,
  });

  it('searches live panes of the chosen roles and puts the newest mention first', async () => {
    const rows = [
      row({}), row({ role: 'ctrl', session: 'ada-termag-ctrl' }), row({ projectId: 'p2', projectName: 'webapp' }),
      row({ role: 'data', alive: true }),           // role not searched
      row({ projectId: 'p3', alive: false }),       // no pane
    ];
    const r = await searchSessions('u1', 'econnrefused', {}, deps(rows));
    expect(r.hits.map(h => `${h.projectId}|${h.role}`)).toEqual(['p1|ctrl', 'p1|agent']);
    expect(r).toMatchObject({ searched: 3, unreachable: 0, skipped: 0, roles: ['agent', 'ctrl', 'review'], lines: 500 });
  });

  it('counts panes behind an offline agent, and denied or failed panes, as unreachable without failing the search', async () => {
    const rows = [
      row({}),
      // What collectSessionRows really produces for an offline agent: never alive.
      row({ projectId: 'p5', connected: false, alive: false }), row({ projectId: 'p5', role: 'ctrl', connected: false, alive: false }),
      row({ projectId: 'p2' }), row({ projectId: 'p4' }),
      row({ projectId: 'p6', alive: false }), // agent up, pane not running: nothing to search, not unreachable
    ];
    const r = await searchSessions('u1', 'econnrefused', { roles: ['agent', 'ctrl'] }, deps(rows, {
      accessProject: async (_u, projectId) => {
        if (projectId === 'p2') throw new SessionAccessError(404, 'Project not found');
        return (role, ws) => ({ host: { userId: 'u1', instanceId: null }, session: `${projectId}|${role}|${ws}` });
      },
      capture: async (_h, session) => { if (session.startsWith('p4')) throw new Error('timeout'); return panes[session.split('|').slice(0, 2).join('|')] ?? ''; },
    }));
    expect(r.hits.map(h => h.projectId)).toEqual(['p1']);
    expect(r).toMatchObject({ searched: 1, unreachable: 4, skipped: 0 });
  });

  it('checks each project once per search, and each pane against it', async () => {
    const rows = [row({}), row({ role: 'ctrl' }), row({ role: 'review', workstream: 'feat' }), row({ projectId: 'p2' })];
    const perPane = vi.fn((role: string, ws: string) => ({ host: { userId: 'u1', instanceId: null }, session: `x|${role}|${ws}` }));
    const accessProject = vi.fn(async () => perPane);
    await searchSessions('u1', 'zz', {}, deps(rows, { accessProject }));
    expect(accessProject.mock.calls.map(c => c[1]).sort()).toEqual(['p1', 'p2']);
    expect(perPane).toHaveBeenCalledTimes(4);
    expect(perPane).toHaveBeenCalledWith('review', 'feat');
  });

  it('caps the panes per search and reports the rest as skipped', async () => {
    const rows = Array.from({ length: 65 }, (_, i) => row({ projectId: `x${i}` }));
    const capture = vi.fn(async () => '');
    const r = await searchSessions('u1', 'zz', {}, deps(rows, { capture }));
    expect(capture).toHaveBeenCalledTimes(60);
    expect(r).toMatchObject({ searched: 60, skipped: 5, hits: [] });
  });
});
