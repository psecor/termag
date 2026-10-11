import { describe, it, expect } from 'vitest';
import { runningProviderForSource } from '../providers/registry';
import type { AgentStatus, Project } from '../types';
import type { RecentRow } from '../services/api';
import { buildInbox, buildRows, defaultGroup, isInboxGroupId, normalizeGroupId, providerFor, rowKey, workingCount } from './inbox';
import { statusKey } from '../utils/statusKey';

const NOW = new Date(2026, 9, 7, 15, 0, 0).getTime();
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

function project(over: Partial<Project> & { name: string; id: string }): Project {
  return {
    archived: false,
    workflows: [{ id: `wf-${over.id}`, type: 'agent', provider: 'claude', server: 'x', projectId: over.id }],
    workstreams: [{ id: `ws-${over.id}-main`, projectId: over.id, name: 'main', branch: 'main', archived: false, lastActiveAt: at(60), createdAt: at(600), updatedAt: at(60) }],
    ...over,
  };
}
const st = (status: AgentStatus['status'], minutesAgo: number, extra: Partial<AgentStatus> = {}): AgentStatus =>
  ({ status, updatedAt: at(minutesAgo), ...extra });

const termag = project({ id: 'p1', name: 'termag', instanceId: 'box1', pinned: true, workstreams: [
  { id: 'ws-p1-main', projectId: 'p1', name: 'main', branch: 'main', archived: false, lastActiveAt: at(5), createdAt: at(600), updatedAt: at(5) },
  { id: 'ws-p1-tui', projectId: 'p1', name: 'termag-tui', branch: 'termag-tui', archived: false, lastActiveAt: at(9), createdAt: at(600), updatedAt: at(9) },
  { id: 'ws-p1-old', projectId: 'p1', name: 'old', branch: 'old', archived: true, lastActiveAt: at(900), createdAt: at(900), updatedAt: at(900) },
]});
const webapp = project({ id: 'p2', name: 'webapp', instanceId: 'box1' });
const sysadmin = project({ id: 'p3', name: 'sysadmin', instanceId: 'box1' });
const research = project({ id: 'p4', name: 'research', instanceId: 'box2', ownerUsername: 'zane', role: 'collaborator',
  workflows: [{ id: 'wf-p4', type: 'agent', provider: 'devin', server: 'x', projectId: 'p4' }] });
const noAgent = project({ id: 'p5', name: 'data-only', workflows: [] });
const archived = project({ id: 'p6', name: 'gone', archived: true });

const statusMap: Record<string, AgentStatus> = {
  [statusKey('box1', 'psecor-termag-agent')]: st('working', 1, { message: 'Editing App.tsx', contextTokens: 412_000 }),
  [statusKey('box1', 'psecor-termag-termag-tui-agent')]: st('waiting', 9, { waitingReason: 'user_input', message: 'Which approach do you prefer?' }),
  [statusKey('box1', 'psecor-webapp-agent')]: st('waiting', 2, { waitingReason: 'approval', message: 'Allow Bash(pnpm test)?' }),
  [statusKey('box1', 'psecor-sysadmin-agent')]: st('idle', 180),
  [statusKey('box2', 'zane-research-agent')]: st('idle', 1440),
};
const projects = [termag, webapp, sysadmin, research, noAgent, archived];

describe('buildRows', () => {
  const rows = buildRows(projects, statusMap, 'psecor');

  it('makes one row per live workstream of each project with an agent', () => {
    expect(rows.map(r => r.key)).toEqual(['p1|main', 'p1|termag-tui', 'p2|main', 'p3|main', 'p4|main']);
  });

  it('builds the session name from the owner so shared projects resolve their status', () => {
    const shared = rows.find(r => r.projectId === 'p4')!;
    expect(shared.owner).toBe('zane');
    expect(shared.shared).toBe(true);
    expect(shared.status).toBe('idle');
    expect(shared.provider).toBe('devin');
  });

  it('carries the status fields the row renders', () => {
    const main = rows.find(r => r.key === 'p1|main')!;
    expect(main).toMatchObject({ status: 'working', message: 'Editing App.tsx', contextTokens: 412_000, pinned: true, provider: 'claude' });
  });
});

describe('buildInbox', () => {
  const recents: RecentRow[] = [
    { projectId: 'p3', projectName: 'sysadmin', workstream: 'main', owner: 'psecor', access: 'owner', instanceId: 'box1', archived: false, lastVisitedAt: at(30), status: 'idle', statusUpdatedAt: at(180), lastActiveAt: at(180), provider: 'claude' },
    { projectId: 'p1', projectName: 'termag', workstream: 'main', owner: 'psecor', access: 'owner', instanceId: 'box1', archived: false, lastVisitedAt: at(40), status: 'working', statusUpdatedAt: at(1), lastActiveAt: at(1), provider: 'claude' },
    { projectId: 'p4', projectName: 'research', workstream: 'main', owner: 'zane', access: 'collaborator', instanceId: 'box2', archived: false, lastVisitedAt: at(26 * 60), status: 'idle', statusUpdatedAt: at(1440), lastActiveAt: at(1440), provider: 'devin' },
    { projectId: 'p6', projectName: 'gone', workstream: 'main', owner: 'psecor', access: 'owner', instanceId: null, archived: true, lastVisitedAt: at(10), status: 'idle', statusUpdatedAt: null, lastActiveAt: at(10), provider: 'claude' },
  ];
  const groups = buildInbox(projects, statusMap, 'psecor', { recents, now: NOW });

  it('orders the groups Needs you, Sessions, Recents and drops empty ones', () => {
    expect(groups.map(g => g.id)).toEqual(['needs-you', 'sessions', 'recents']);
    expect(buildInbox([], {}, 'psecor')).toEqual([]);
  });

  it('puts the working rows in a section at the top of Sessions, then the idle ones', () => {
    const sessions = groups[1];
    expect(sessions.rows.map(r => [r.key, r.section])).toEqual([['p1|main', 'working'], ['p3|main', 'idle'], ['p4|main', 'idle']]);
    expect(workingCount(sessions)).toBe(1);
    expect(workingCount(undefined)).toBe(0);
  });

  it('puts approvals first in Needs you, then the longest-waiting question', () => {
    expect(groups[0].rows.map(r => r.key)).toEqual(['p2|main', 'p1|termag-tui']);
  });

  it('keeps pinned first among the idle rows, then recent activity', () => {
    expect(groups[1].rows.filter(r => r.section === 'idle').map(r => r.key)).toEqual(['p3|main', 'p4|main']);
  });

  it('lists Recents newest first, skipping rows already in Needs you / Working and archived projects', () => {
    const recentKeys = groups[2].rows.map(r => r.key);
    expect(recentKeys).toEqual(['p3|main', 'p4|main']);
    expect(groups[2].rows[0].bucket).toBe('Today');
    expect(groups[2].rows[1].bucket).toBe('Yesterday');
  });

  it('honours the recents limit', () => {
    const limited = buildInbox(projects, statusMap, 'psecor', { recents, now: NOW, recentsLimit: 1 });
    expect(limited.find(g => g.id === 'recents')!.rows).toHaveLength(1);
  });
});

describe('providerFor', () => {
  it('prefers the workstream-scoped agent workflow', () => {
    const p = project({ id: 'p9', name: 'x', workflows: [
      { id: 'a', type: 'agent', provider: 'claude', server: 'x', projectId: 'p9', workstreamId: 'ws-main' },
      { id: 'b', type: 'agent', provider: 'devin', server: 'x', projectId: 'p9', workstreamId: 'ws-feat' },
    ]});
    expect(providerFor(p, 'ws-feat')).toBe('devin');
    expect(providerFor(p, 'ws-main')).toBe('claude');
    expect(providerFor(p, 'ws-unknown')).toBe('claude');
  });

  it('prefers the provider actually running, from the live status source', () => {
    const p = project({ id: 'p9', name: 'x', workflows: [
      { id: 'a', type: 'agent', provider: 'claude', server: 'x', projectId: 'p9', workstreamId: 'ws-main' },
    ]});
    // A workstream branched off a Claude project, running pi.
    expect(providerFor(p, 'ws-main', 'pi-ext:pi')).toBe('pi');
    expect(providerFor(p, 'ws-main', 'claude-hooks')).toBe('claude');
    // The bare poller source does not say which provider; keep the configured one.
    expect(providerFor(p, 'ws-main', 'tmux-poller')).toBe('claude');
    expect(providerFor(p, 'ws-main', 'something-new')).toBe('claude');
    expect(providerFor(p, 'ws-main', null)).toBe('claude');
    // One rule for phone and desktop.
    expect(runningProviderForSource('tmux-poller')).toBeUndefined();
    expect(runningProviderForSource('tmux-poller:devin')).toBe('devin');
    expect(runningProviderForSource(undefined)).toBeUndefined();
    expect(rowKey('p9', 'feat')).toBe('p9|feat');
  });
});

describe('defaultGroup', () => {
  const groups = buildInbox(projects, statusMap, 'psecor', { now: NOW });

  it('keeps the user\'s pick when that tab has rows', () => {
    expect(defaultGroup(groups, 'sessions')).toBe('sessions');
  });

  it('falls back to the first non-empty group in tab order', () => {
    expect(defaultGroup(groups, null)).toBe('needs-you');
    expect(defaultGroup(groups, 'recents')).toBe('needs-you'); // no recents were supplied
    const quiet = buildInbox([sysadmin], statusMap, 'psecor', { now: NOW });
    expect(defaultGroup(quiet, null)).toBe('sessions');
  });

  it('opens Recents when there is nothing live at all', () => {
    expect(defaultGroup([], null)).toBe('recents');
    expect(defaultGroup([], 'sessions')).toBe('sessions');
    expect(isInboxGroupId('sessions')).toBe(true);
    expect(isInboxGroupId('nope')).toBe(false);
  });

  it('maps the retired Working and Idle tab ids onto Sessions', () => {
    expect(normalizeGroupId('working')).toBe('sessions');
    expect(normalizeGroupId('idle')).toBe('sessions');
    expect(normalizeGroupId('recents')).toBe('recents');
    expect(normalizeGroupId('nope')).toBeNull();
    expect(normalizeGroupId(null)).toBeNull();
  });
});

describe('cloud sessions', () => {
  const cloud = (over: Partial<import('../types').CloudSession> = {}): import('../types').CloudSession => ({
    key: 'cse_01A', sessionId: 'cse_01A', url: 'https://claude.ai/code/session_01A', seq: 3, name: 'Claude Cloud 3', title: 'Fix the auth bug', clientPlatform: 'ios',
    state: 'running', exitReason: null, queuedReason: null, queuedSince: null,
    current: { orderId: 'ord.1', instanceId: 'box1', boxName: 'ada-box', slot: 2, sessionName: 'ada-claude-runner-s2-ord_d1-r', startedAt: at(30), endedAt: null, durationSec: null, exitStatus: null, exitReason: null, alive: true, usage: null, checkoutBytes: null, kept: null },
    runs: [], firstSeenAt: at(30), lastSeenAt: at(1), eventCount: 2, ...over,
  });
  it('adds a row per active session with the live status under the runner name, in the right group', () => {
    const statusMap = { [statusKey('box1', 'ada-claude-runner-s2-ord_d1-r')]: st('waiting', 2, { waitingReason: 'approval' }) };
    const groups = buildInbox([termag], statusMap, 'ada', { now: NOW, cloudSessions: [
      cloud(),
      cloud({ key: 'cse_01Q', sessionId: 'cse_01Q', state: 'queued', current: null, queuedReason: 'no box', queuedSince: at(45), lastSeenAt: at(1) }),
      cloud({ key: 'cse_01E', sessionId: 'cse_01E', state: 'ended', exitReason: 'completed' }),
    ] });
    const needs = groups.find(g => g.id === 'needs-you')!.rows;
    expect(needs.map(r => r.key)).toEqual(['cloud|cse_01A']);
    expect(needs[0]).toMatchObject({ kind: 'cloud', projectName: 'Claude Cloud 3', url: 'https://claude.ai/code/session_01A', waitingReason: 'approval', provider: 'claude' });
    const idle = groups.find(g => g.id === 'sessions')!.rows.filter(r => r.section === 'idle');
    // The clock is time queued, not time since the latest re-offer.
    expect(idle.find(r => r.key === 'cloud|cse_01Q')).toMatchObject({ status: 'not_running', message: 'no box', updatedAt: at(45) });
    expect(idle.find(r => r.key === 'cloud|cse_01E')).toBeUndefined();
  });
  it('adds nothing without sessions', () => {
    const a = buildInbox([termag], {}, 'ada', { now: NOW });
    const b = buildInbox([termag], {}, 'ada', { now: NOW, cloudSessions: [] });
    expect(a.map(g => g.rows.length)).toEqual(b.map(g => g.rows.length));
  });
});
