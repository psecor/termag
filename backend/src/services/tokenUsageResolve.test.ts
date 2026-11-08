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

describe('resolveUsageSource — the static layout (Project.dir)', () => {
  // A box made from an environment: the checkout is at ~/code/<repo>, the project directory a link to it,
  // and a process there reports the real path.
  const S = [...P, { id: 'w', name: 'shop', workstreams: ['fix'], dir: `/home/${U}/code/web` }];
  it('attributes a cwd in the static checkout, and in its worktrees, to its project', () => {
    expect(resolveUsageSource({ cwdHint: `/home/${U}/code/web` }, U, S)).toEqual({ projectId: 'w', workstream: 'main' });
    expect(resolveUsageSource({ cwdHint: `/home/${U}/code/web/src` }, U, S)).toEqual({ projectId: 'w', workstream: 'main' });
    expect(resolveUsageSource({ cwdHint: `/home/${U}/code/web/.worktrees/fix` }, U, S)).toEqual({ projectId: 'w', workstream: 'fix' });
    expect(resolveUsageSource({ cwdHint: `/home/${U}/code/web-api` }, U, S)).toBeNull();
    // The project directory's own spelling still counts.
    expect(resolveUsageSource({ cwdHint: base('shop') }, U, S)).toEqual({ projectId: 'w', workstream: 'main' });
  });
  it("attributes Claude's log dir for the static checkout", () => {
    expect(resolveUsageSource({ cwdHint: null, dir: encodeClaudeDir(`/home/${U}/code/web`) }, U, S)).toEqual({ projectId: 'w', workstream: 'main' });
    expect(resolveUsageSource({ cwdHint: null, dir: `${encodeClaudeDir(`/home/${U}/code/web`)}--worktrees-fix` }, U, S)).toEqual({ projectId: 'w', workstream: 'fix' });
  });
});

describe('resolveUsageSource — the same path on two boxes', () => {
  // Two boxes made from one environment both check its repository out at ~/code/web (Devin, #1452).
  const two = [
    { id: 'a', name: 'web-a', workstreams: [], dir: `/home/${U}/code/web`, instanceId: 'box1' },
    { id: 'b', name: 'web-b', workstreams: ['fix'], dir: `/home/${U}/code/web`, instanceId: 'box2' },
  ];
  it("attributes a source to the project on the box it was scanned on", () => {
    expect(resolveUsageSource({ cwdHint: `/home/${U}/code/web/src`, instanceId: 'box2' }, U, two)).toEqual({ projectId: 'b', workstream: 'main' });
    expect(resolveUsageSource({ cwdHint: `/home/${U}/code/web/src`, instanceId: 'box1' }, U, two)).toEqual({ projectId: 'a', workstream: 'main' });
    expect(resolveUsageSource({ cwdHint: null, dir: encodeClaudeDir(`/home/${U}/code/web`), instanceId: 'box2' }, U, two)).toEqual({ projectId: 'b', workstream: 'main' });
    expect(resolveUsageSource({ cwdHint: null, dir: `${encodeClaudeDir(`/home/${U}/code/web`)}--worktrees-fix`, instanceId: 'box2' }, U, two)).toEqual({ projectId: 'b', workstream: 'fix' });
  });
  it("still attributes a source whose box has no matching project (a project moved to another box)", () => {
    expect(resolveUsageSource({ cwdHint: `/home/${U}/code/web`, instanceId: 'box3' }, U, two)).toEqual({ projectId: 'a', workstream: 'main' });
  });
  it("prefers the scanned box's project over a longer path on another box (Bugbot, #1462)", () => {
    // Box 1 holds a multi-repo project rooted at ~/code; box 2 a single-repo project at ~/code/web.
    const nested = [
      { id: 'web', name: 'w', workstreams: [], dir: `/home/${U}/code/web`, instanceId: 'box2' },
      { id: 'root', name: 'r', workstreams: ['fix'], dir: `/home/${U}/code`, instanceId: 'box1' },
    ];
    expect(resolveUsageSource({ cwdHint: `/home/${U}/code/web/src`, instanceId: 'box1' }, U, nested)).toEqual({ projectId: 'root', workstream: 'main' });
    expect(resolveUsageSource({ cwdHint: `/home/${U}/code/web/src`, instanceId: 'box2' }, U, nested)).toEqual({ projectId: 'web', workstream: 'main' });
    expect(resolveUsageSource({ cwdHint: null, dir: encodeClaudeDir(`/home/${U}/code/web`), instanceId: 'box1' }, U, nested)).toBeNull();
    // Within one box the longest path still wins.
    const sameBox = nested.map(p => ({ ...p, instanceId: 'box1' }));
    expect(resolveUsageSource({ cwdHint: `/home/${U}/code/web/src`, instanceId: 'box1' }, U, sameBox)).toEqual({ projectId: 'web', workstream: 'main' });
  });
});

describe('resolveUsageSource — a hyphenated sibling of this box\'s project', () => {
  // Box 1 has ~/code/web; a project that moved to box 2 had ~/code/web-api, and its usage is left on box 1 (Bugbot, #1462).
  const projects = [
    { id: 'web', name: 'web', workstreams: [], dir: `/home/${U}/code/web`, instanceId: 'box1' },
    { id: 'api', name: 'api', workstreams: [], dir: `/home/${U}/code/web-api`, instanceId: 'box2' },
  ];
  it('falls back to the other box when the cwd is beside, not inside, this box\'s project', () => {
    const hint = { cwdHint: `/home/${U}/code/web-api/src`, dir: encodeClaudeDir(`/home/${U}/code/web-api`), instanceId: 'box1' };
    expect(resolveUsageSource(hint, U, projects)).toEqual({ projectId: 'api', workstream: 'main' });
  });
  it('with only an encoded log dir, which cannot tell web/api from web-api, it stays unattributed', () => {
    expect(resolveUsageSource({ cwdHint: null, dir: encodeClaudeDir(`/home/${U}/code/web-api`), instanceId: 'box1' }, U, projects)).toBeNull();
  });
});
