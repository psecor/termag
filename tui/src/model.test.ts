import { describe, expect, it } from 'vitest';
import {
  aggregateStatus, buildRows, findRowIndex, indexSessions, inferLocalInstance, nextIndex, projectBadges,
  updateFlashes, waitingIndices, type Row,
} from './model.js';
import type { Project, SessionRow } from './types.js';

function ws(name: string, projectId = 'p1') {
  return { id: `ws-${name}`, projectId, name, branch: name, archived: false, lastActiveAt: '', createdAt: '', updatedAt: '' };
}
function project(over: Partial<Project> & { name: string }): Project {
  return {
    id: over.name, archived: false, workflows: [{ id: 'wf', type: 'agent', provider: 'claude', server: 'localhost', projectId: over.name }],
    workstreams: [ws('main', over.name)], ownerUsername: 'psecor', role: 'owner', instanceId: 'box-aaaaaa111111', kind: 'normal',
    ...over,
  };
}
function session(over: Partial<SessionRow> & { session: string }): SessionRow {
  // Default projectId/workstream are derived from the session name so fixtures
  // written as names keep indexing under the project/workstream/role key.
  const m = /^psecor-(.+?)(?:-([^-]+))?-(agent|ctrl)$/.exec(over.session);
  const derived = m ? { projectId: m[1], workstream: m[2] ?? 'main', role: m[3] as SessionRow['role'] } : {};
  return {
    projectId: 'p', projectName: 'p', owner: 'psecor', access: 'owner', workstream: 'main', role: 'agent', ...derived,
    instanceId: 'box-aaaaaa111111', connected: true, alive: true, status: 'idle', contextTokens: null, updatedAt: null,
    waitingReason: null, rateLimited: null, provider: 'claude', lastActiveAt: '', ...over,
  };
}

describe('aggregateStatus', () => {
  it('returns null for a project with no agent workflow', () => {
    const p = project({ name: 'x', workflows: [] });
    expect(aggregateStatus(p, {})).toBeNull();
  });
  it('takes the highest-priority workstream status and collapses main names', () => {
    const p = project({ name: 'termag', workstreams: [ws('main'), ws('tui')] });
    const map = indexSessions([
      session({ session: 'psecor-termag-agent', status: 'idle' }),
      session({ session: 'psecor-termag-tui-agent', status: 'waiting', workstream: 'tui' }),
    ]);
    expect(aggregateStatus(p, map)).toBe('waiting');
  });
  it('treats missing sessions as not_running', () => {
    expect(aggregateStatus(project({ name: 'x' }), {})).toBe('not_running');
  });
});

describe('projectBadges', () => {
  it('takes the max context and any rate limit, falling back to the workflow provider', () => {
    const p = project({ name: 'termag', workstreams: [ws('main'), ws('tui')] });
    const map = indexSessions([
      session({ session: 'psecor-termag-agent', contextTokens: 100_000, provider: null }),
      session({ session: 'psecor-termag-tui-agent', contextTokens: 600_000, rateLimited: 'quota', provider: null }),
    ]);
    expect(projectBadges(p, map)).toEqual({ contextTokens: 600_000, rateLimited: true, provider: 'claude' });
  });
});

describe('buildRows', () => {
  const meta = project({ name: 'MetaTerm', kind: 'metaterm', instanceId: null, pinned: true });
  const a = project({ name: 'alpha', instanceId: 'box-bbbbbb222222' });
  const b = project({ name: 'beta', pinned: true, workstreams: [ws('main', 'beta'), ws('feat', 'beta')] });
  const c = project({ name: 'gamma' });
  const shared = project({ name: 'theirs', role: 'collaborator', ownerUsername: 'zane', instanceId: 'box-cccccc333333' });
  const sharedOnHost = project({ name: 'theirs-local', role: 'collaborator', ownerUsername: 'zane', instanceId: null });
  const host = project({ name: 'local', instanceId: null });
  const projects = [meta, c, a, b, host, shared, sharedOnHost];

  it('groups metaterm first, then boxes (local first), shared, host; pinned float; multi-ws gets sub-rows', () => {
    const map = indexSessions([session({ session: 'psecor-gamma-agent', projectId: 'gamma' })]);
    const rows = buildRows(projects, map, { localSessions: new Set(['psecor-gamma-agent']) });
    const shape = rows.map(r => r.kind === 'group' ? `[${r.label}]` : r.kind === 'project' ? r.project.name : `  ↳${r.workstream.name}`);
    expect(shape).toEqual([
      'MetaTerm',
      '[this box …111111]', 'beta', '  ↳main', '  ↳feat', 'gamma',
      '[box …222222]', 'alpha',
      '[shared with me]', 'theirs',
      '[orchestrator host]', 'local', 'theirs-local',
    ]);
    expect(rows.filter(r => r.kind === 'group' && r.label.startsWith('this box'))).toHaveLength(1);
    const gamma = rows.find(r => r.kind === 'project' && r.project.name === 'gamma') as Extract<Row, { kind: 'project' }>;
    expect(gamma.local).toBe(true);
    const alpha = rows.find(r => r.kind === 'project' && r.project.name === 'alpha') as Extract<Row, { kind: 'project' }>;
    expect(alpha.local).toBe(false);
  });

  it('filters by project, owner or workstream name and hides archived', () => {
    const rows = buildRows([...projects, project({ name: 'old', archived: true })], {}, { filter: 'feat' });
    expect(rows.filter(r => r.kind === 'project').map(r => (r as any).project.name)).toEqual(['beta']);
    expect(buildRows(projects, {}, { filter: 'zane' }).filter(r => r.kind === 'project')).toHaveLength(2);
    expect(buildRows(projects, {}, { filter: 'old' })).toHaveLength(0);
    const archivedWs = project({ name: 'arch', workstreams: [ws('main', 'arch'), { ...ws('gone', 'arch'), archived: true }] });
    expect(buildRows([archivedWs], {}, { filter: 'gone' })).toHaveLength(0);
  });

  it('findRowIndex prefers the workstream row for multi-workstream projects', () => {
    const rows = buildRows(projects, {});
    const i = findRowIndex(rows, { projectId: 'beta', workstream: 'feat' });
    expect(rows[i].kind).toBe('workstream');
    const j = findRowIndex(rows, { projectId: 'gamma', workstream: 'main' });
    expect(rows[j].kind).toBe('project');
    // The project row of a multi-workstream project is its own selectable row.
    const k = findRowIndex(rows, { projectId: 'beta', workstream: 'main', kind: 'project' });
    expect(rows[k].kind).toBe('project');
    expect(findRowIndex(rows, { projectId: 'beta', workstream: 'main', kind: 'workstream' })).toBe(k + 1);
    expect(findRowIndex(rows, { projectId: 'beta', workstream: 'gone' })).toBe(rows.findIndex(r => r.kind === 'project' && r.project.id === 'beta'));
    expect(findRowIndex(rows, null)).toBe(-1);
  });
});

describe('updateFlashes', () => {
  const mounted = 1_000_000;
  it('ignores changes inside the grace period, flashes afterwards, reports waiting', () => {
    let s = { prev: {}, flashUntil: {} };
    let u = updateFlashes(s, { a: 'idle', b: 'idle' }, mounted, mounted);
    expect(Object.keys(u.next.flashUntil)).toHaveLength(0); // first sight, no prev
    u = updateFlashes(u.next, { a: 'working', b: 'idle' }, mounted + 1000, mounted);
    expect(Object.keys(u.next.flashUntil)).toHaveLength(0); // in grace
    u = updateFlashes(u.next, { a: 'working', b: 'waiting' }, mounted + 5000, mounted);
    expect(u.next.flashUntil.b).toEqual({ status: 'waiting', until: mounted + 5000 + 15_000 });
    expect(u.nowWaiting).toEqual(['b']);
    u = updateFlashes(u.next, { a: 'working', b: 'waiting' }, mounted + 5000 + 15_001, mounted);
    expect(u.next.flashUntil.b).toBeUndefined(); // expired
  });
});

describe('waiting navigation', () => {
  it('wraps around in both directions', () => {
    expect(nextIndex([2, 5, 9], 5, 1)).toBe(9);
    expect(nextIndex([2, 5, 9], 9, 1)).toBe(2);
    expect(nextIndex([2, 5, 9], 2, -1)).toBe(9);
    expect(nextIndex([], 0, 1)).toBeNull();
  });
  it('lists waiting rows, using sub-rows for multi-workstream projects', () => {
    const b = project({ name: 'beta', workstreams: [ws('main', 'beta'), ws('feat', 'beta')] });
    const c = project({ name: 'gamma' });
    const map = indexSessions([
      session({ session: 'psecor-beta-feat-agent', status: 'waiting' }),
      session({ session: 'psecor-gamma-agent', status: 'waiting' }),
    ]);
    const rows = buildRows([b, c], map);
    const idx = waitingIndices(rows);
    expect(idx.map(i => rows[i].kind)).toEqual(['workstream', 'project']);
  });
});

describe('indexSessions', () => {
  it('keeps same-named sessions from different boxes apart', () => {
    const rows = [
      session({ session: 'psecor-sysadmin-agent', projectId: 'sa-A', instanceId: 'A', status: 'working' }),
      session({ session: 'psecor-sysadmin-agent', projectId: 'sa-B', instanceId: 'B', status: 'idle' }),
    ];
    const map = indexSessions(rows);
    expect(Object.keys(map)).toHaveLength(2);
    expect(aggregateStatus(project({ name: 'sysadmin', id: 'sa-A', instanceId: 'A' }), map)).toBe('working');
    expect(aggregateStatus(project({ name: 'sysadmin', id: 'sa-B', instanceId: 'B' }), map)).toBe('idle');
    // and the inference still sees both rows
    expect(inferLocalInstance(Object.values(map), new Set(['psecor-sysadmin-agent']))).toBe('A');
  });
});

describe('inferLocalInstance', () => {
  it('picks the instance with the most alive sessions present on the local tmux server', () => {
    const rows = [
      session({ session: 'psecor-sysadmin-agent', instanceId: 'A' }),
      session({ session: 'psecor-sysadmin-agent', instanceId: 'B' }),
      session({ session: 'psecor-termag-agent', instanceId: 'B' }),
      session({ session: 'psecor-termag-ctrl', instanceId: 'B', role: 'ctrl' }),
      session({ session: 'psecor-sysadmin-agent', instanceId: null }),
      session({ session: 'psecor-dead-agent', instanceId: 'B', alive: false }),
    ];
    const local = new Set(['psecor-sysadmin-agent', 'psecor-termag-agent', 'psecor-termag-ctrl', 'unrelated']);
    expect(inferLocalInstance(rows, local)).toBe('B');
    expect(inferLocalInstance(rows, new Set())).toBeUndefined();
    expect(inferLocalInstance(rows, new Set(['nothing-matches']))).toBeUndefined();
    // Only the orchestrator's own sessions match → the null instance is "this host".
    expect(inferLocalInstance([session({ session: 'psecor-MetaTerm-agent', instanceId: null })], new Set(['psecor-MetaTerm-agent']))).toBeNull();
  });
  it('a same-named project on another box is not marked local', () => {
    const a = project({ name: 'sysadmin', id: 'sa-A', instanceId: 'A' });
    const b = project({ name: 'sysadmin', id: 'sa-B', instanceId: 'B' });
    const t = project({ name: 'termag', id: 't-B', instanceId: 'B' });
    const map = indexSessions([
      session({ session: 'psecor-sysadmin-agent', projectId: 'sa-B', instanceId: 'B' }),
      session({ session: 'psecor-termag-agent', projectId: 't-B', instanceId: 'B' }),
    ]);
    const rows = buildRows([a, b, t], map, { localSessions: new Set(['psecor-sysadmin-agent', 'psecor-termag-agent']) });
    const locals = rows.filter(r => r.kind === 'project' && r.local).map(r => (r as any).project.id);
    expect(locals).toEqual(['sa-B', 't-B']);
  });
});
