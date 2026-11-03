import { describe, expect, it } from 'vitest';
import {
  compareVersions, conflictText, fleetButtonLabel, fleetConfirmText, fleetResultLines, hostConfirmText, hostRequestedText, hostUpdateAction, isUpdateOff,
  defaultRestart, latestRunByHost, restartChoices, restartLabel, runAt, runClass, runSessionsText, runStateText, runVersions, scopeCount, toolForInventory, updateTool, UPDATE_TOOLS,
} from './toolUpdate';
import type { ToolUpdatePreview, SoftwareHost, SoftwareState, SoftwareUpdateRun } from '../services/adminApi';

const claude = updateTool('claude');
const codex = updateTool('codex');
const preview = (over: Partial<ToolUpdatePreview> = {}): ToolUpdatePreview => ({
  hostKey: 'box:i-1', connected: true, capable: true, current: '2.1.300', target: '2.1.320', floor: '2.1.308',
  liveSessions: 3, busySessions: 1, runInFlight: false, ...over,
});
const httpError = (status: number, code?: string) => ({ response: { status, data: code ? { code } : {} } });
const host = (hostKey: string, kind: SoftwareHost['kind'], version: string | null, state: SoftwareState, component = 'claude'): SoftwareHost => ({
  hostKey, kind, name: hostKey, owner: null, boxKind: null, status: null, connected: true, lastInventoryAt: null,
  cells: version || state === 'missing' ? { [component]: { version, raw: null, path: null, state, observedAt: '2026-10-29T00:00:00Z' } } : {},
});
const run = (over: Partial<SoftwareUpdateRun> = {}): SoftwareUpdateRun => ({
  id: 'r1', hostKey: 'box:i-1', instanceId: null, component: 'claude', trigger: 'manual', requestedById: 'u1', restart: 'idle',
  status: 'done', outcome: 'updated', target: '2.1.320', fromVersion: '2.1.300', toVersion: '2.1.320', detail: null, sessions: null,
  requestedAt: '2026-10-29T10:00:00Z', startedAt: '2026-10-29T10:00:05Z', finishedAt: '2026-10-29T10:02:00Z', ...over,
});

describe('the host panel action', () => {
  it('is hidden while loading, when the flag is off and when the box cannot update', () => {
    expect(hostUpdateAction(null)).toEqual({ kind: 'hidden' });
    expect(hostUpdateAction('off')).toEqual({ kind: 'hidden' });
    expect(hostUpdateAction(preview({ capable: false }))).toEqual({ kind: 'hidden' });
  });
  it('is disabled offline or with a run in flight, and ready otherwise', () => {
    expect(hostUpdateAction(preview({ connected: false }))).toEqual({ kind: 'disabled', reason: 'offline' });
    expect(hostUpdateAction(preview({ runInFlight: true }))).toEqual({ kind: 'disabled', reason: 'an update is already running' });
    expect(hostUpdateAction(preview())).toEqual({ kind: 'ready' });
  });
  it('reads only 404 claude_update_off as the flag being off', () => {
    expect(isUpdateOff(httpError(404, 'claude_update_off'))).toBe(true);
    expect(isUpdateOff(httpError(404))).toBe(false);
    expect(isUpdateOff(httpError(500, 'claude_update_off'))).toBe(false);
    expect(isUpdateOff(new Error('network'))).toBe(false);
  });
  it('says what a 409 means, and leaves other failures to errorText', () => {
    expect(conflictText(httpError(409, 'offline'), claude)).toMatch(/offline/);
    expect(conflictText(httpError(409, 'not_capable'), claude)).toBe('The box’s agent can’t run a Claude Code update yet (no tool-update-v1).');
    expect(conflictText(httpError(409, 'run_in_flight'), claude)).toMatch(/already running/);
    expect(conflictText(httpError(409, 'something_new'), claude)).toBe('Refused (something_new).');
    expect(conflictText(httpError(500), claude)).toBeNull();
  });
  it('tells a started update from one whose acknowledgement was lost, neither as an error', () => {
    expect(hostRequestedText({ runId: 'r1', acknowledged: true })).toEqual({ text: 'update started (run r1)', className: '' });
    const lost = hostRequestedText({ runId: 'r2', acknowledged: false });
    expect(lost.text).toBe('update sent, but the box’s acknowledgement was lost (run r2): it may be running; the runs list will say');
    expect(lost.className).toBe('admin-warn');
  });
  it('confirms with the versions, the session counts and what the restart does', () => {
    const text = hostConfirmText(claude, 'ada-box', preview(), 'force');
    expect(text).toContain('Update Claude Code on ada-box?');
    expect(text).toContain('2.1.300 → 2.1.320 (floor 2.1.308)');
    expect(text).toContain('3 live Claude Code sessions, 1 busy.');
    expect(text).toContain('Restart: restart sessions now. Restarting now cuts the 1 running turn.');
    expect(hostConfirmText(claude, 'b', preview({ liveSessions: 1, busySessions: 0 }), 'none')).toContain('1 live Claude Code session, 0 busy.');
    expect(hostConfirmText(claude, 'b', preview(), 'idle')).toContain('Restart: restart sessions when idle. Sessions restart as each goes idle.');
  });
});

describe('the fleet action', () => {
  const hosts = [
    host('box:a', 'box', '2.1.300', 'outdated'), host('box:b', 'box', '2.1.310', 'behind'), host('box:c', 'box', '2.1.320', 'current'),
    host('agent:d', 'agent', '2.1.299', 'outdated'), host('orchestrator', 'orchestrator', '2.1.200', 'outdated'), host('box:e', 'box', null, 'missing'),
  ];
  it('orders versions numerically and refuses what does not parse', () => {
    expect(compareVersions('2.1.9', '2.1.10')).toBe(-1);
    expect(compareVersions('2.1.10 (Claude Code)', '2.1.10')).toBe(0);
    expect(compareVersions('latest', '2.1.10')).toBeNull();
  });
  it('counts hosts below the floor only once a floor is known, leaving out the orchestrator and missing installs', () => {
    expect(scopeCount(claude, hosts, 'below-floor', { floor: '2.1.308', target: 'latest' })).toBe(2);
    expect(scopeCount(claude, hosts, 'below-floor', null)).toBeNull();
  });
  it('counts behind against an exact target, else the matrix states', () => {
    expect(scopeCount(claude, hosts, 'behind', { floor: '2.1.308', target: '2.1.320' })).toBe(3);
    expect(scopeCount(claude, hosts, 'behind', { floor: '2.1.308', target: 'latest' })).toBe(3);
    expect(scopeCount(claude, [host('box:a', 'box', '2.1.300', 'current')], 'behind', null)).toBe(0);
  });
  it('labels the button and the confirm with the count', () => {
    expect(fleetButtonLabel('behind', 3)).toBe('Update behind (3)');
    expect(fleetButtonLabel('below-floor', null)).toBe('Update below floor (?)');
    expect(fleetConfirmText(claude, 'below-floor', 2, 'idle', { floor: '2.1.308', target: null })).toMatch(/^Update Claude Code on about 2 hosts below the floor 2\.1\.308\?/);
    expect(fleetConfirmText(claude, 'behind', 1, 'force', null)).toContain('about 1 host behind the target?');
    expect(fleetConfirmText(claude, 'behind', 1, 'force', null)).toContain('(cuts running turns)');
  });
  it('reports runs and each skipped host with its reason', () => {
    const out = fleetResultLines({ runs: [{ hostKey: 'box:a', runId: 'x' }], skipped: [{ hostKey: 'box:b', reason: 'offline' }, { hostKey: 'box:z', reason: 'weird' }] }, (k: string) => k.replace('box:', ''));
    expect(out.summary).toBe('1 run requested, 2 skipped');
    expect(out.skipped).toEqual(['b: offline', 'z: weird']);
    expect(fleetResultLines({ runs: [], skipped: [] }, (k: string) => k).summary).toBe('0 runs requested');
  });
});

describe('a run in a cell', () => {
  it('keeps each host’s newest run', () => {
    const m = latestRunByHost([run({ id: 'new', requestedAt: '2026-10-29T11:00:00Z' }), run({ id: 'old' }), run({ id: 'other', hostKey: 'box:i-2' })]);
    expect(m.get('box:i-1')?.id).toBe('new');
    expect(m.get('box:i-2')?.id).toBe('other');
  });
  it('words the state, the versions and the class', () => {
    expect(runStateText(run())).toBe('updated');
    expect(runStateText(run({ status: 'running', outcome: null }))).toBe('running');
    expect(runStateText(run({ status: 'failed', outcome: 'failed' }))).toBe('failed');
    expect(runStateText(run({ status: 'failed', outcome: 'partial' }))).toBe('failed · partial');
    expect(runVersions(run())).toBe('2.1.300 → 2.1.320');
    expect(runVersions(run({ outcome: 'current', fromVersion: '2.1.320' }))).toBe('2.1.320');
    expect(runVersions(run({ fromVersion: null, toVersion: null }))).toBe('→ 2.1.320');
    expect(runVersions(run({ fromVersion: null, toVersion: null, target: null }))).toBeNull();
    expect(runClass(run())).toBe('admin-ok');
    expect(runClass(run({ status: 'refused', outcome: null }))).toBe('admin-bad');
    expect(runClass(run({ outcome: 'partial' }))).toBe('admin-warn');
    expect(runClass(run({ status: 'expired', outcome: null }))).toBe('admin-warn');
    expect(runClass(run({ status: 'requested', outcome: null }))).toBe('');
  });
  it('ages a run by its last timestamp and lists only the session counts that happened', () => {
    expect(runAt(run())).toBe('2026-10-29T10:02:00Z');
    expect(runAt(run({ finishedAt: null, startedAt: null }))).toBe('2026-10-29T10:00:00Z');
    expect(runSessionsText(run({ sessions: { stopped: 2, resumed: 1, fresh: 1, cut: 0, typed: 0, other: 0, runnersLeft: 0 } }))).toBe('2 stopped · 1 resumed · 1 fresh');
    expect(runSessionsText(run())).toBe('');
  });
});

describe('per tool', () => {
  it('lists Claude Code, Codex and the Cursor agent, each with its matrix column and capability', () => {
    expect(UPDATE_TOOLS.map(t => [t.component, t.label, t.inventory, t.capability])).toEqual([
      ['claude', 'Claude Code', 'claude', 'tool-update-v1'],
      ['codex', 'Codex', 'codex', 'tool-update-codex-v1'],
      ['cursor', 'Cursor agent', 'cursor-agent', 'tool-update-cursor-v1'],
      ['devin', 'Devin CLI', 'devin', 'tool-update-devin-v1'],
      ['pi', 'pi', 'pi', 'tool-update-pi-v1'],
      ['gh', 'GitHub CLI', 'gh', 'tool-update-gh-v1'],
      ['aws', 'AWS CLI', 'aws', 'tool-update-aws-v1'],
      ['node', 'Node', 'node', 'tool-update-node-v1'],
    ]);
    expect(toolForInventory('codex')).toBe(codex);
    expect(toolForInventory('cursor-agent')).toBe(updateTool('cursor'));
    expect(toolForInventory('devin')).toBe(updateTool('devin'));
    expect(toolForInventory('pi')).toBe(updateTool('pi'));
    expect(toolForInventory('gh')).toBe(updateTool('gh'));
    expect(toolForInventory('aws')).toBe(updateTool('aws'));
    expect(toolForInventory('node')).toBe(updateTool('node'));
    expect(toolForInventory('python')).toBeUndefined();
    expect(restartChoices(updateTool('node')).map(c => c.value)).toEqual(['none']);
    expect(restartChoices(updateTool('aws')).map(c => c.value)).toEqual(['none']);
    expect(defaultRestart(updateTool('aws'))).toBe('none');
  });

  it('offers the GitHub CLI, which has no sessions, only "binary only", and starts there', () => {
    const gh = updateTool('gh');
    expect(restartChoices(gh).map(c => c.value)).toEqual(['none']);
    expect(restartChoices(gh)[0].note).toBe('GitHub CLI has no sessions to restart');
    expect(defaultRestart(gh)).toBe('none');
    expect(defaultRestart(updateTool('pi'))).toBe('idle');
    expect(restartChoices(updateTool('pi')).map(c => c.value)).toEqual(['none', 'idle', 'force']);
  });

  it('counts the Cursor agent\'s fleet from its column, against an exact build', () => {
    const cursor = updateTool('cursor');
    const hs = [host('box:a', 'box', '2026.10.01-0a1b2c3', 'behind', 'cursor-agent'), host('box:b', 'box', '2026.10.22-27dcf5f', 'current', 'cursor-agent')];
    expect(scopeCount(cursor, hs, 'behind', { floor: '2025.09.17-25b418f', target: '2026.10.22-27dcf5f' })).toBe(1);
    expect(scopeCount(cursor, hs, 'below-floor', { floor: '2025.09.17-25b418f', target: 'latest' })).toBe(0);
    // Another build of the target's day is behind it, whatever its hash (Bugbot on #1080).
    const sameDay = [host('box:c', 'box', '2026.10.22-0a1b2c3', 'behind', 'cursor-agent'), host('box:d', 'box', '2026.10.22-9f9f9f9', 'behind', 'cursor-agent'), ...hs];
    expect(scopeCount(cursor, sameDay, 'behind', { floor: '2025.09.17-25b418f', target: '2026.10.22-27dcf5f' })).toBe(3);
    // Under latest, as the server's behindReference: the newest day's one build, or every build of that
    // day when there are several, whatever the matrix's states say (Bugbot on #1080).
    const latest = { floor: '2025.09.17-25b418f', target: 'latest' };
    expect(scopeCount(cursor, hs, 'behind', latest)).toBe(1);
    const twoOfDay = [host('box:c', 'box', '2026.10.22-0a1b2c3', 'current', 'cursor-agent'), host('box:d', 'box', '2026.10.22-9f9f9f9', 'current', 'cursor-agent'), host('box:e', 'box', '2026.10.01-aaaaaaa', 'current', 'cursor-agent')];
    expect(scopeCount(cursor, twoOfDay, 'behind', latest)).toBe(3);
    expect(scopeCount(cursor, [twoOfDay[0], twoOfDay[2]], 'behind', latest)).toBe(1);
    // The reference is every box's, counted or not: another build of the day on an offline host makes
    // the day ambiguous, as on the server, so the online one on it counts too.
    expect(scopeCount(cursor, [twoOfDay[0], twoOfDay[2]], 'behind', latest, twoOfDay)).toBe(2);
    // A tool whose versions are not dated keeps the matrix's own states.
    expect(scopeCount(updateTool('codex'), [host('box:f', 'box', '0.165.0', 'behind', 'codex'), host('box:g', 'box', '0.166.0', 'current', 'codex')], 'behind', { floor: '0.131.0', target: 'latest' })).toBe(1);
    // A floor compares by day: another build of the floor's day is not below it.
    expect(scopeCount(cursor, sameDay, 'below-floor', { floor: '2026.10.22-27dcf5f', target: 'latest' })).toBe(1);
    expect(hostConfirmText(cursor, 'otter-box', preview({ current: '2026.10.01-0a1b2c3', target: 'latest', floor: '2025.09.17-25b418f' }), 'none')).toContain('Update Cursor agent on otter-box?');
  });
  it('counts the Cursor agent behind its newest pin, as the preview names it, never a newer build in the fleet (Bugbot on #1080)', () => {
    const cursor = updateTool('cursor');
    // The server's preview names latest as the newest pinned build (runs.ts previewTarget).
    const pinned = { floor: '2025.09.17-25b418f', target: '2026.10.22-27dcf5f' };
    const hs = [
      host('box:pin', 'box', '2026.10.22-27dcf5f', 'behind', 'cursor-agent'),
      host('box:ahead', 'box', '2026.11.02-9f8e7d6', 'current', 'cursor-agent'),
      host('box:old', 'box', '2026.10.01-0a1b2c3', 'outdated', 'cursor-agent'),
    ];
    // On the pin is current and past it is ahead: only the older one is behind.
    expect(scopeCount(cursor, hs, 'behind', pinned)).toBe(1);
  });
  it('keeps Claude Code\'s words as they were', () => {
    expect(restartChoices(claude).map(c => [c.value, c.label, c.note])).toEqual([
      ['none', 'binary only', 'running sessions keep the old version until they next start'],
      ['idle', 'restart sessions when idle', 'each Claude Code pane restarts once its turn ends'],
      ['force', 'restart sessions now', 'cuts running turns'],
    ]);
    expect(restartLabel('idle')).toBe('restart sessions when idle');
  });
  it('words Codex\'s confirms, conflicts and restart notes for Codex', () => {
    expect(restartChoices(codex)[1].note).toBe('each Codex pane restarts once its turn ends');
    const text = hostConfirmText(codex, 'ada-box', preview({ current: '0.163.0', target: 'latest', floor: '0.131.0', liveSessions: 2, busySessions: 0 }), 'idle');
    expect(text).toContain('Update Codex on ada-box?');
    expect(text).toContain('0.163.0 → latest (floor 0.131.0)');
    expect(text).toContain('2 live Codex sessions, 0 busy.');
    expect(conflictText(httpError(409, 'not_capable'), codex)).toBe('The box’s agent can’t run a Codex update yet (no tool-update-codex-v1).');
    expect(fleetConfirmText(codex, 'behind', 4, 'none', { floor: '0.131.0', target: '0.166.0' })).toMatch(/^Update Codex on about 4 hosts behind the target 0\.166\.0\?/);
  });
  it('counts Codex\'s fleet from the codex column, never Claude Code\'s', () => {
    const hosts = [
      host('box:a', 'box', '0.162.0', 'outdated', 'codex'), host('box:b', 'box', '0.165.0', 'current', 'codex'),
      host('box:c', 'box', '2.1.300', 'outdated'), host('box:d', 'box', null, 'missing', 'codex'),
    ];
    expect(scopeCount(codex, hosts, 'behind', { floor: '0.131.0', target: '0.165.0' })).toBe(1);
    expect(scopeCount(codex, hosts, 'behind', { floor: '0.131.0', target: 'latest' })).toBe(1);
    expect(scopeCount(codex, hosts, 'below-floor', { floor: '0.131.0', target: 'latest' })).toBe(0);
    expect(scopeCount(claude, hosts, 'behind', null)).toBe(1);
  });
});
