import { describe, it, expect } from 'vitest';
import { matchSession, ProjectLike } from './sessionResolver';

const owner = 'alice';
function proj(over: Partial<ProjectLike>): ProjectLike {
  return { id: 'id', name: 'proj', instanceId: null, workstreams: [{ name: 'main' }], ...over };
}

describe('matchSession', () => {
  it('matches a main-workstream agent session', () => {
    const projects = [proj({ id: 'p1', name: 'termag', workstreams: [{ name: 'main' }] })];
    expect(matchSession('alice-termag-agent', owner, projects))
      .toEqual({ projectId: 'p1', workstream: 'main', instanceId: null });
  });

  it('matches a non-main workstream and a non-agent role', () => {
    const projects = [proj({ id: 'p1', name: 'termag', workstreams: [{ name: 'main' }, { name: 'feature' }] })];
    expect(matchSession('alice-termag-feature-ctrl', owner, projects))
      .toEqual({ projectId: 'p1', workstream: 'feature', instanceId: null });
  });

  it('handles hyphenated project names', () => {
    const projects = [proj({ id: 'p1', name: 'ic-okr-viewer', workstreams: [{ name: 'main' }] })];
    expect(matchSession('alice-ic-okr-viewer-agent', owner, projects))
      .toEqual({ projectId: 'p1', workstream: 'main', instanceId: null });
  });

  it('handles hyphenated project AND workstream names', () => {
    const projects = [proj({ id: 'p1', name: 'ic-okr-viewer', workstreams: [{ name: 'main' }, { name: 'small-fixes' }] })];
    expect(matchSession('alice-ic-okr-viewer-small-fixes-agent', owner, projects))
      .toEqual({ projectId: 'p1', workstream: 'small-fixes', instanceId: null });
  });

  it('disambiguates project-vs-workstream against real DB names', () => {
    // "alice-foo-bar-agent" is ambiguous on its own; the actual project decides.
    const asWorkstream = [proj({ id: 'pW', name: 'foo', workstreams: [{ name: 'main' }, { name: 'bar' }] })];
    expect(matchSession('alice-foo-bar-agent', owner, asWorkstream))
      .toEqual({ projectId: 'pW', workstream: 'bar', instanceId: null });

    const asProject = [proj({ id: 'pP', name: 'foo-bar', workstreams: [{ name: 'main' }] })];
    expect(matchSession('alice-foo-bar-agent', owner, asProject))
      .toEqual({ projectId: 'pP', workstream: 'main', instanceId: null });
  });

  it('defaults to main when a project has no workstreams', () => {
    const projects = [proj({ id: 'p1', name: 'termag', workstreams: [] })];
    expect(matchSession('alice-termag-agent', owner, projects))
      .toEqual({ projectId: 'p1', workstream: 'main', instanceId: null });
  });

  it('returns null when nothing matches', () => {
    const projects = [proj({ id: 'p1', name: 'termag', workstreams: [{ name: 'main' }] })];
    expect(matchSession('alice-other-agent', owner, projects)).toBeNull();
  });

  it('carries the matched project instanceId through', () => {
    const projects = [proj({ id: 'p1', name: 'termag', instanceId: 'box-1', workstreams: [{ name: 'main' }] })];
    expect(matchSession('alice-termag-agent', owner, projects))
      .toEqual({ projectId: 'p1', workstream: 'main', instanceId: 'box-1' });
  });
});
