import { describe, it, expect } from 'vitest';
import { resolveUsageSource, encodeClaudeDir } from './tokenUsageResolve';

const U = 'psecor';
const P = [
  { id: 't', name: 'termag', workstreams: ['main', 'feature'] },
  { id: 'td', name: 'termag-dev', workstreams: [] },
  { id: 'r', name: 'research', workstreams: ['org-chart'] },
];
const base = (n: string) => `/home/${U}/termag/projects/${n}`;

describe('resolveUsageSource — cwd hints', () => {
  it('main dir and nested drift resolve to main', () => {
    expect(resolveUsageSource({ cwdHint: base('termag') }, U, P)).toEqual({ projectId: 't', workstream: 'main' });
    expect(resolveUsageSource({ cwdHint: `${base('termag')}/backend/src` }, U, P)).toEqual({ projectId: 't', workstream: 'main' });
  });
  it('worktree dir resolves to its workstream; unknown worktree keeps the project + name', () => {
    expect(resolveUsageSource({ cwdHint: `${base('termag')}/.worktrees/feature/frontend` }, U, P)).toEqual({ projectId: 't', workstream: 'feature' });
    expect(resolveUsageSource({ cwdHint: `${base('termag')}/.worktrees/hotfix` }, U, P)).toEqual({ projectId: 't', workstream: 'hotfix' });
  });
  it('hyphenated siblings: termag-dev never lands in termag', () => {
    expect(resolveUsageSource({ cwdHint: base('termag-dev') }, U, P)).toEqual({ projectId: 'td', workstream: 'main' });
    expect(resolveUsageSource({ cwdHint: `${base('termag-dev')}/x` }, U, P)).toEqual({ projectId: 'td', workstream: 'main' });
  });
  it('outside any project → null; still-remapped mac path → null', () => {
    expect(resolveUsageSource({ cwdHint: `/home/${U}` }, U, P)).toBeNull();
    expect(resolveUsageSource({ cwdHint: `/Users/${U}/termag/projects/termag` }, U, P)).toBeNull();
  });
});

describe('resolveUsageSource — encoded dir fallback', () => {
  it('exact main dir and --worktrees- suffix', () => {
    expect(resolveUsageSource({ cwdHint: null, dir: encodeClaudeDir(base('research')) }, U, P)).toEqual({ projectId: 'r', workstream: 'main' });
    expect(resolveUsageSource({ cwdHint: null, dir: `${encodeClaudeDir(base('research'))}--worktrees-org-chart` }, U, P)).toEqual({ projectId: 'r', workstream: 'org-chart' });
  });
  it('sibling names are not dash-prefix matched', () => {
    expect(resolveUsageSource({ cwdHint: null, dir: encodeClaudeDir(base('termag-dev')) }, U, P)).toEqual({ projectId: 'td', workstream: 'main' });
    expect(resolveUsageSource({ cwdHint: null, dir: encodeClaudeDir(base('termag-x')) }, U, P)).toBeNull();
  });
  it('nothing usable → null', () => {
    expect(resolveUsageSource({ cwdHint: null, dir: null }, U, P)).toBeNull();
  });
});
