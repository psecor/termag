import { describe, it, expect } from 'vitest';
import { resolveWorktimeProject, toWorktimeProjectRows } from './worktimeProjects';

const NAMES = ['termag', 'ic', 'ic-okr-viewer', 'research'];

describe('resolveWorktimeProject', () => {
  it('exact name → main workstream', () => {
    expect(resolveWorktimeProject('termag', NAMES)).toEqual({ projectName: 'termag', workstream: 'main' });
  });
  it('folded workstream → project + remainder', () => {
    expect(resolveWorktimeProject('termag-feature', NAMES)).toEqual({ projectName: 'termag', workstream: 'feature' });
  });
  it('prefers the longest matching project name when names nest', () => {
    expect(resolveWorktimeProject('ic-okr-viewer-small-fixes', NAMES))
      .toEqual({ projectName: 'ic-okr-viewer', workstream: 'small-fixes' });
  });
  it('exact match wins over a shorter prefix', () => {
    expect(resolveWorktimeProject('ic-okr-viewer', NAMES)).toEqual({ projectName: 'ic-okr-viewer', workstream: 'main' });
  });
  it('requires a dash boundary (no partial-word prefix)', () => {
    expect(resolveWorktimeProject('termagx', NAMES)).toBeNull();
  });
  it('unknown → null', () => {
    expect(resolveWorktimeProject('gone', NAMES)).toBeNull();
  });
});

describe('toWorktimeProjectRows', () => {
  const projects = [{ id: 'p1', name: 'termag' }, { id: 'p2', name: 'ic-okr-viewer' }];
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
});
