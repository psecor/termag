import { describe, expect, it } from 'vitest';
import { floorOnlyText, heldText, orchestratorConfirmText, orchestratorConflictText } from './orchestratorClaudeUpdate';
import type { ToolUpdatePreview } from '../services/adminApi';

const preview: ToolUpdatePreview = {
  hostKey: 'orchestrator', kind: 'orchestrator', connected: true, capable: true, current: '2.1.308', target: 'latest', floor: '2.1.308',
  liveSessions: 0, busySessions: 0, runInFlight: false, restarts: ['none'],
};
const err = (status: number, data: Record<string, string>) => ({ response: { status, data } });

describe('the orchestrator row', () => {
  it('confirms with the versions, the runner restart and the sessions it leaves running', () => {
    const t = orchestratorConfirmText(preview);
    expect(t).toContain('2.1.308 → latest (floor 2.1.308)');
    expect(t).toContain('runner orchestrator restarts');
    expect(t).toContain('keep the old binary');
  });

  it('says what a refusal means', () => {
    expect(orchestratorConflictText(err(409, { code: 'not_capable' }))).toMatch(/no Claude Code updater/);
    expect(orchestratorConflictText(err(409, { code: 'run_in_flight' }))).toMatch(/already running/);
    expect(orchestratorConflictText(err(502, { code: 'helper_refused', error: 'sudo: a password is required' }))).toBe('The root helper refused the run: sudo: a password is required');
    expect(orchestratorConflictText(err(409, { code: 'other' }))).toBe('Refused (other).');
    expect(orchestratorConflictText(err(500, {}))).toBeNull();
  });

  it('says when a quarantine holds the runner orchestrator', () => {
    expect(heldText(preview)).toBeNull();
    expect(heldText({ ...preview, runnerHeld: true })).toMatch(/quarantined.*runner orchestrator is stopped/);
  });

  it('says floor only with no pin, and that nothing would move while at the floor', () => {
    expect(floorOnlyText(preview)).toBeNull();
    const none = { ...preview, target: null, floorOnly: true, nothingToDo: true };
    expect(floorOnlyText(none)).toBe('Floor only: set a version in orchestrator-claude-update-policy to move it (at or above the floor 2.1.308, nothing to install).');
    expect(floorOnlyText({ ...none, nothingToDo: false })).toMatch(/brings it up to the floor 2.1.308 and no further/);
    expect(orchestratorConfirmText({ ...none, nothingToDo: false, current: '2.1.300' })).toContain('2.1.300 → the floor 2.1.308 (no version pinned)');
    expect(orchestratorConflictText({ response: { status: 409, data: { code: 'floor_only' } } })).toMatch(/Floor only/);
  });
});
