import { describe, it, expect } from 'vitest';
import type { Project, Workstream } from '../types';
import { filterChoices, isWorkstreamName, linkedByText, scopedProjects, suggestWorkstreamName, workstreamChoices } from './workstreamChoices';

const ws = (name: string, lastActiveAt: string, over: Partial<Workstream> = {}): Workstream =>
  ({ id: name, projectId: 'p', name, branch: name, archived: false, lastActiveAt, createdAt: '', updatedAt: '', ...over });
const project = (id: string, name: string, workstreams: Workstream[], over: Partial<Project> = {}): Project =>
  ({ id, name, archived: false, workflows: [], workstreams, ...over });

describe('workstreamChoices', () => {
  it('lists own live workstreams, most recently active first, main by its project name', () => {
    const choices = workstreamChoices([
      project('p1', 'termag', [ws('main', '2026-10-01'), ws('termag-pr-dash', '2026-10-14'), ws('old', '2026-10-13', { archived: true })]),
      project('p2', 'gone', [ws('main', '2026-10-15')], { archived: true }),
      project('p3', 'MetaTerm', [ws('main', '2026-10-15')], { kind: 'metaterm' }),
      project('p4', 'shared', [ws('main', '2026-10-15')], { role: 'collaborator' }),
    ], null).choices;
    expect(choices.map(c => c.label)).toEqual(['termag · termag-pr-dash', 'termag']);
    expect(choices[0]).toMatchObject({ projectId: 'p1', workstream: 'termag-pr-dash' });
  });
  it('leaves out where the PR already is', () => {
    const choices = workstreamChoices([project('p1', 'termag', [ws('main', '1'), ws('a', '2')])], { projectId: 'p1', projectName: 'termag', workstream: 'a' }).choices;
    expect(choices.map(c => c.workstream)).toEqual(['main']);
  });
});

describe('repository scope and filtering', () => {
  const projects = [
    project('p1', 'termag', [ws('main', '1'), ws('termag-pr-dash', '3')]),
    project('p2', 'webapp', [ws('main', '2'), ws('webapp-nova', '4')]),
  ];
  it('offers only projects with a checkout of the PR\'s repository, in any case', () => {
    const got = workstreamChoices(projects, null, 'Example-Org/Termag', [{ projectId: 'p1', workstream: 'main', repo: 'example-org/termag' }]);
    expect(got.sameRepo).toBe(true);
    expect(got.choices.map(c => c.label)).toEqual(['termag · termag-pr-dash', 'termag']);
  });
  it('offers everything when no checkout of the repository is known', () => {
    const got = workstreamChoices(projects, null, 'example-org/research', [{ projectId: 'p1', workstream: 'main', repo: 'example-org/termag' }]);
    expect(got.sameRepo).toBe(false);
    expect(got.choices).toHaveLength(4);
  });
  it('filters by every typed word, in any order', () => {
    const { choices } = workstreamChoices(projects, null);
    expect(filterChoices(choices, 'nova web').map(c => c.workstream)).toEqual(['webapp-nova']);
    expect(filterChoices(choices, '  ')).toHaveLength(4);
    expect(filterChoices(choices, 'nope')).toEqual([]);
  });
});

describe('linkedByText', () => {
  it('names each source and nothing else', () => {
    expect(linkedByText('manual')).toBe('attached by you');
    expect(linkedByText('created')).toBe('opened from there');
    expect(linkedByText(undefined)).toBeNull();
  });
});

describe('a new workstream for a PR', () => {
  it('suggests the repository\'s name and the branch\'s last segment, the prefix kept once', () => {
    expect(suggestWorkstreamName('example-org/termag', 'feat/pr-defer')).toBe('termag-pr-defer');
    expect(suggestWorkstreamName('example-org/termag', 'termag-worktree-pr-pills')).toBe('termag-worktree-pr-pills');
    expect(suggestWorkstreamName('example-org/webapp', 'psecor/nova.panel fix')).toBe('webapp-nova-panel-fix');
    expect(suggestWorkstreamName('example-org/termag', `feat/${'x'.repeat(80)}`)).toHaveLength(48);
    expect(isWorkstreamName(suggestWorkstreamName('example-org/termag', 'feat/äö'))).toBe(true);
  });
  it('validates names as the backend does', () => {
    expect(isWorkstreamName('termag-pr-defer')).toBe(true);
    expect(isWorkstreamName('main')).toBe(false);
    expect(isWorkstreamName('a b')).toBe(false);
    expect(isWorkstreamName('')).toBe(false);
  });
  it('offers the projects with a checkout of the repository, most recently active first', () => {
    const projects = [
      project('p1', 'termag', [ws('main', '1')], { lastActiveAt: '2026-10-01' }),
      project('p2', 'termag-2', [ws('main', '1')], { lastActiveAt: '2026-10-03' }),
      project('p3', 'webapp', [ws('main', '1')], { lastActiveAt: '2026-10-05' }),
      project('p4', 'MetaTerm', [ws('main', '1')], { kind: 'metaterm' }),
    ];
    const checkouts = [{ projectId: 'p1', workstream: 'main', repo: 'example-org/termag' }, { projectId: 'p2', workstream: 'main', repo: 'example-org/termag' }];
    expect(scopedProjects(projects, 'example-org/termag', checkouts).map(p => p.id)).toEqual(['p2', 'p1']);
    expect(scopedProjects(projects, 'example-org/research', checkouts).map(p => p.id)).toEqual(['p3', 'p2', 'p1']);
  });
});
