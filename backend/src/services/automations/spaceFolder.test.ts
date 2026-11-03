import { describe, expect, it } from 'vitest';
import { AUTOMATIONS_SPACE_ROOT, chosenFolderRefusal, folderOf, legacyFolderOf, spaceFolderFor } from './spaceFolder';

describe('the fixed folder', () => {
  it('is .termag/automations/<automation id>, whatever the name', () => {
    expect(AUTOMATIONS_SPACE_ROOT).toBe('.termag/automations/');
    expect(spaceFolderFor('cmabc123')).toBe('.termag/automations/cmabc123');
  });

  it('is what a row stores; a row from before it keeps its folder until it is moved', () => {
    expect(folderOf({ id: 'a1', spaceFolder: '.termag/automations/a1' })).toBe('.termag/automations/a1');
    expect(folderOf({ id: 'a1', spaceFolder: null })).toBe('.termag/automations/a1');
    expect(folderOf({ id: 'a1', spaceFolder: 'automations/triage' })).toBe('automations/triage');
  });

  it('knows where the move script moves a legacy row from', () => {
    expect(legacyFolderOf({ spaceFolder: 'automations/triage', projectId: 'p1' })).toBe('automations/triage');
    expect(legacyFolderOf({ spaceFolder: null, projectId: 'p1' })).toBe('automations/p1');
  });
});

describe('chosenFolderRefusal', () => {
  it('lets a body without spaceFolder, or with the fixed one sent back, through', () => {
    expect(chosenFolderRefusal(undefined, null)).toBeNull();
    expect(chosenFolderRefusal('.termag/automations/a1', '.termag/automations/a1')).toBeNull();
    expect(chosenFolderRefusal('.termag/automations/a1/', '.termag/automations/a1')).toBeNull();
  });

  it('refuses any other folder, saying it is fixed', () => {
    expect(chosenFolderRefusal('reports/x', '.termag/automations/a1')).toBe("An automation's space folder is fixed (.termag/automations/a1); leave spaceFolder out");
    expect(chosenFolderRefusal('reports/x', null)).toContain('fixed (.termag/automations/<automation id>)');
    expect(chosenFolderRefusal(null, '.termag/automations/a1')).not.toBeNull();
    expect(chosenFolderRefusal(3, '.termag/automations/a1')).not.toBeNull();
  });
});
