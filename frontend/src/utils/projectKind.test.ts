import { describe, expect, it } from 'vitest';
import * as backend from '../../../backend/src/services/projectKind';
import { isAutomationProject, PROJECT_KIND_TRAITS, PROJECT_KINDS, projectKindTraits } from './projectKind';

describe('projectKindTraits (frontend mirror)', () => {
  it('treats a missing or unknown kind as normal', () => {
    expect(projectKindTraits(undefined)).toEqual(projectKindTraits('normal'));
    expect(projectKindTraits('odd')).toEqual(projectKindTraits('normal'));
  });

  it('keeps MetaTerm locked down and lets an automation be renamed and archived but not branched', () => {
    expect(projectKindTraits('metaterm')).toMatchObject({ canBranchOff: false, canRenameProject: false, listedAsWork: false });
    expect(projectKindTraits('automation')).toMatchObject({ canBranchOff: false, canSwitchAgent: false, canRenameProject: true, canArchive: true, listedAsWork: true, isAutomation: true, runsMainAgent: false });
  });

  it('recognises an automation project', () => {
    expect(isAutomationProject({ kind: 'automation' })).toBe(true);
    expect(isAutomationProject({ kind: 'normal' })).toBe(false);
    expect(isAutomationProject(null)).toBe(false);
  });

  // The same table as backend/src/services/projectKind.test.ts.
  it('keeps a space orchestrator out of every list and offers none of a normal project\'s actions', () => {
    expect(projectKindTraits('space-orchestrator')).toEqual({
      runsMainAgent: false, canBranchOff: false, canRenameProject: false, canArchive: false, canShare: false,
      canHandOff: false, canSwitchAgent: false, hasPaneActions: false, listedAsWork: false, inProjectLists: false, isAutomation: false,
    });
  });
});

// Kept in sync by hand, like the provider registry: every kind, and every trait
// the two files share, must agree with the backend's.
describe('projectKindTraits against the backend registry', () => {
  it('has the same kinds', () => {
    expect([...PROJECT_KINDS]).toEqual([...backend.PROJECT_KINDS]);
  });

  it('agrees on every shared trait for every kind', () => {
    for (const kind of PROJECT_KINDS) {
      const front = PROJECT_KIND_TRAITS[kind] as unknown as Record<string, boolean>;
      const back = backend.PROJECT_KIND_TRAITS[kind] as unknown as Record<string, boolean>;
      const shared = Object.keys(front).filter(k => k in back);
      expect(shared.length, kind).toBeGreaterThan(5);
      for (const key of shared) expect(front[key], `${kind}.${key}`).toBe(back[key]);
    }
  });

  it('gives an unknown kind the normal traits on both sides', () => {
    expect(projectKindTraits('odd').inProjectLists).toBe(backend.projectKindTraits('odd').inProjectLists);
  });
});
