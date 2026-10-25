import { describe, expect, it } from 'vitest';
import { isAutomationProject, projectKindTraits } from './projectKind';

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
});
