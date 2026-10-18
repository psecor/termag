import { describe, it, expect } from 'vitest';
import { humanActivityKey } from './humanActivity';
import { CLOUD_WORKTIME_LABEL, CLOUD_WORKTIME_PROJECT, resolveWorktimeProject, toWorktimeProjectRows, workTimeIdentity } from './worktimeProjects';

const NAMES = ['termag', 'ic', 'ic-sample-app', 'research'];

describe('resolveWorktimeProject', () => {
  it('exact name → main workstream', () => {
    expect(resolveWorktimeProject('termag', NAMES)).toEqual({ projectName: 'termag', workstream: 'main' });
  });
  it('folded workstream → project + remainder', () => {
    expect(resolveWorktimeProject('termag-feature', NAMES)).toEqual({ projectName: 'termag', workstream: 'feature' });
  });
  it('prefers the longest matching project name when names nest', () => {
    expect(resolveWorktimeProject('ic-sample-app-small-fixes', NAMES))
      .toEqual({ projectName: 'ic-sample-app', workstream: 'small-fixes' });
  });
  it('exact match wins over a shorter prefix', () => {
    expect(resolveWorktimeProject('ic-sample-app', NAMES)).toEqual({ projectName: 'ic-sample-app', workstream: 'main' });
  });
  it('requires a dash boundary (no partial-word prefix)', () => {
    expect(resolveWorktimeProject('termagx', NAMES)).toBeNull();
  });
  it('the reserved cloud project resolves to its label before any name, and no real project can carry it', () => {
    expect(resolveWorktimeProject(CLOUD_WORKTIME_PROJECT, [...NAMES, 'claude', 'claude-cloud'])).toEqual({ projectName: CLOUD_WORKTIME_LABEL, workstream: 'main' });
    expect(/^[a-zA-Z0-9_-]+$/.test(CLOUD_WORKTIME_PROJECT)).toBe(false); // routes/projects.ts rejects it as a name
    const rows = toWorktimeProjectRows(
      [{ project: CLOUD_WORKTIME_PROJECT, provider: 'claude', date: '2026-10-09', totalMs: 1000, sessions: 1, instanceId: 'box-a' }],
      [{ id: 'p1', name: 'claude-cloud', instanceId: 'box-a' }],
    );
    expect(rows[0]).toMatchObject({ projectId: null, projectName: CLOUD_WORKTIME_LABEL, workstream: 'main' });
  });
  it('unknown → null', () => {
    expect(resolveWorktimeProject('gone', NAMES)).toBeNull();
  });
});

describe('toWorktimeProjectRows', () => {
  const projects = [{ id: 'p1', name: 'termag' }, { id: 'p2', name: 'ic-sample-app' }];
  it('resolves ids, keeps human rows, passes totals through', () => {
    const rows = toWorktimeProjectRows([
      { project: 'termag', provider: 'claude', date: '2026-09-18', totalMs: 1000, sessions: 2 },
      { project: 'termag-feature', provider: 'human', date: '2026-09-18', totalMs: 500, sessions: 1 },
    ], projects);
    expect(rows).toEqual([
      { projectId: 'p1', projectName: 'termag', workstream: 'main', provider: 'claude', date: '2026-09-18', totalMs: 1000, sessions: 2 },
      { projectId: 'p1', projectName: 'termag', workstream: 'feature', provider: 'human', date: '2026-09-18', totalMs: 500, sessions: 1 },
    ]);
  });
  it('unresolved names keep the raw name with a null id', () => {
    const [row] = toWorktimeProjectRows([{ project: 'old-proj', provider: 'claude', date: 'd', totalMs: 1, sessions: 1 }], projects);
    expect(row).toMatchObject({ projectId: null, projectName: 'old-proj', workstream: 'main' });
  });

  it('does not merge two cx projects that share a name on different boxes', () => {
    const boxes = [
      { id: 'cx-a', name: 'cx', instanceId: 'box-a' },
      { id: 'cx-b', name: 'cx', instanceId: 'box-b' },
    ];
    const rows = toWorktimeProjectRows([
      { project: 'cx', provider: 'claude', date: 'd', totalMs: 60_000, sessions: 1, instanceId: 'box-a' },
      { project: 'cx', provider: 'claude', date: 'd', totalMs: 60_000, sessions: 1, instanceId: 'box-b' },
      { project: 'cx', provider: 'human', date: 'd', totalMs: 1000, sessions: 1, instanceId: '' },
    ], boxes);
    expect(rows.map(r => r.projectId)).toEqual(['cx-a', 'cx-b', null]);
  });

  it('keeps work-time and human-heartbeat identity apart per box', () => {
    expect(workTimeIdentity('alice', 'cx', 'claude', 'd', 'box-a').instanceId).toBe('box-a');
    expect(workTimeIdentity('alice', 'cx', 'human', 'd', null).instanceId).toBe('');
    expect(humanActivityKey('alice', 'cx', 'box-a')).not.toBe(humanActivityKey('alice', 'cx', 'box-b'));
    expect(humanActivityKey('alice', 'cx', null)).toBe(humanActivityKey('alice', 'cx', null));
  });
});
