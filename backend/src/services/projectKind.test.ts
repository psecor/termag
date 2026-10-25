import { describe, expect, it } from 'vitest';
import { PROJECT_KINDS, WORK_PROJECT_KINDS, isProjectKind, kindRefusal, projectKindTraits } from './projectKind';

describe('projectKindTraits', () => {
  it('treats an unknown or missing kind as normal', () => {
    expect(projectKindTraits(undefined)).toEqual(projectKindTraits('normal'));
    expect(projectKindTraits('weird')).toEqual(projectKindTraits('normal'));
    expect(projectKindTraits('normal').canBranchOff).toBe(true);
  });

  it('keeps MetaTerm locked down as before', () => {
    const t = projectKindTraits('metaterm');
    expect(t).toMatchObject({ canBranchOff: false, canRenameProject: false, canArchive: false, canShare: false, canHandOff: false, canSwitchAgent: false, canEditWorkflows: false, listedAsWork: false });
  });

  it('lets an automation be renamed, archived and shared, but not branched or re-agented by hand', () => {
    const t = projectKindTraits('automation');
    expect(t).toMatchObject({ isAutomation: true, runsMainAgent: false, canBranchOff: false, canSwitchAgent: false, canEditWorkflows: false, canRenameProject: true, canArchive: true, canShare: true, listedAsWork: true });
  });

  it('counts normal and automation projects as work', () => {
    expect(WORK_PROJECT_KINDS).toEqual(['normal', 'automation']);
    expect(PROJECT_KINDS).toContain('metaterm');
    expect(isProjectKind('automation')).toBe(true);
    expect(isProjectKind('')).toBe(false);
  });

  it('words a refusal by kind', () => {
    expect(kindRefusal('metaterm', 'branch off')).toBe('MetaTerm cannot branch off');
    expect(kindRefusal('automation', 'branch off')).toBe('An automation cannot branch off');
  });
});
