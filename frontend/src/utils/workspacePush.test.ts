import { describe, expect, it } from 'vitest';
import { workspaceChangeFromPush } from './workspacePush';

describe('workspaceChangeFromPush', () => {
  it('names the list a workspace push says changed', () => {
    expect(workspaceChangeFromPush({ type: 'workspace', what: 'projects' })).toBe('projects');
    expect(workspaceChangeFromPush({ type: 'workspace', what: 'boxes' })).toBe('boxes');
  });

  it('ignores other frames and lists it does not know', () => {
    expect(workspaceChangeFromPush({ type: 'status', what: 'projects' })).toBeNull();
    expect(workspaceChangeFromPush({ type: 'claude-session' })).toBeNull();
    expect(workspaceChangeFromPush({ type: 'workspace', what: 'spaces' })).toBeNull();
    expect(workspaceChangeFromPush({ type: 'workspace' })).toBeNull();
  });
});
