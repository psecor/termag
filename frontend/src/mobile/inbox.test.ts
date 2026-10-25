import { describe, it, expect } from 'vitest';
import { runningProviderForSource } from '../providers/registry';
import type { AgentStatus, Project } from '../types';
import type { RecentRow, SessionRow } from '../services/api';
import { bandFor, buildHome, conversationHref, stateSince, buildRows, matchesFilter, opensReview, parseFilter, providerFor, recentSessions, rowKey, searchRows, statusLabel, statusMapFromSessions } from './inbox';
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

// Review panes ride the agent session's status.
const docs = project({ id: 'p7', name: 'docs', instanceId: 'box1' });
const infra = project({ id: 'p8', name: 'infra', instanceId: 'box1' });
const review = (state: 'reviewing' | 'waiting' | 'done', minutesAgo: number, pr: number, seen = false) => ({
  state, pr, url: null, at: at(minutesAgo), doneAt: state === 'done' ? at(minutesAgo) : null, seenAt: seen ? at(0) : null,
});
const reviewStatus: Record<string, AgentStatus> = {
  ...statusMap,
  [statusKey('box1', 'psecor-termag-agent')]: st('working', 1, { message: 'Editing App.tsx', contextTokens: 412_000, review: review('reviewing', 3, 311) }),
  [statusKey('box1', 'psecor-docs-agent')]: st('idle', 20, { review: review('reviewing', 20, 312) }),
  [statusKey('box1', 'psecor-infra-agent')]: st('idle', 40, { review: review('done', 15, 313) }),
};
const withReviews = [...projects, docs, infra];

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

  it('carries the workstream\'s session title, null where there is none', () => {
    const titled = projects.map(p => (p.id === 'p1'
      ? { ...p, workstreams: p.workstreams.map(w => (w.name === 'termag-tui' ? { ...w, sessionTitle: 'TUI resize bug' } : w)) }
      : p));
    const out = buildRows(titled, statusMap, 'psecor');
    expect(out.find(r => r.key === 'p1|termag-tui')?.sessionTitle).toBe('TUI resize bug');
    expect(out.find(r => r.key === 'p1|main')?.sessionTitle).toBeNull();
    expect(out.find(r => r.key === 'p2|main')?.sessionTitle).toBeNull();
  });
});

describe('buildHome', () => {
  const home = buildHome(withReviews, reviewStatus, 'psecor');

  it('orders one list: needs you, running, reviewing, then the rest', () => {
    expect(home.rows.map(r => `${r.key}:${r.band}`)).toEqual([
      'p2|main:attention',        // approval first
      'p1|termag-tui:attention',  // then the agent's question
      'p8|main:attention',        // then a finished review nobody has read
      'p1|main:running',
      'p7|main:reviewing',
      'p3|main:other',            // idle, most recent first
      'p4|main:other',
    ]);
  });

  it('counts awaiting you, running agents and every live review', () => {
    // termag·main is running AND has a review going: it sits in Running and counts as reviewing too.
    expect(home.counts).toEqual({ attention: 3, running: 1, reviewing: 2 });
    expect(home.rows.filter(r => matchesFilter(r, 'reviewing')).map(r => r.key)).toEqual(['p1|main', 'p7|main']);
    expect(home.rows.filter(r => matchesFilter(r, 'running')).map(r => r.key)).toEqual(['p1|main']);
  });

  it('drops a done review from attention once it has been seen', () => {
    const seen = { ...reviewStatus, [statusKey('box1', 'psecor-infra-agent')]: st('idle', 40, { review: review('done', 15, 313, true) }) };
    const row = buildHome(withReviews, seen, 'psecor').rows.find(r => r.key === 'p8|main')!;
    expect(row).toMatchObject({ band: 'other', ring: null });
  });

  it('puts Devin waiting after the agent questions and before finished reviews', () => {
    const s = { ...reviewStatus, [statusKey('box1', 'psecor-docs-agent')]: st('idle', 20, { review: review('waiting', 5, 312) }) };
    expect(buildHome(withReviews, s, 'psecor').rows.filter(r => r.band === 'attention').map(r => r.key))
      .toEqual(['p2|main', 'p1|termag-tui', 'p7|main', 'p8|main']);
  });

  it('keeps pinned first among the rest, then idle before not running', () => {
    const s = { ...statusMap, [statusKey('box1', 'psecor-termag-agent')]: st('not_running', 1), [statusKey('box1', 'psecor-termag-termag-tui-agent')]: st('not_running', 1) };
    const other = buildHome([termag, sysadmin, webapp], s, 'psecor').rows.filter(r => r.band === 'other').map(r => r.key);
    expect(other.slice(0, 2).sort()).toEqual(['p1|main', 'p1|termag-tui']);
    expect(other.slice(2)).toEqual(['p3|main']);
  });

  it('labels each row with its state', () => {
    const label = (key: string) => statusLabel(home.rows.find(r => r.key === key)!);
    expect(label('p2|main')).toBe('Needs approval');
    expect(label('p1|termag-tui')).toBe('Asked you a question');
    expect(label('p8|main')).toBe('Review ready #313');
    expect(label('p1|main')).toBe('Running');
    expect(label('p7|main')).toBe('Reviewing #312');
    expect(label('p3|main')).toBe('Ready');
  });

  it('opens the review tab only when the row is about its review', () => {
    const opens = (key: string) => opensReview(home.rows.find(r => r.key === key)!);
    expect(opens('p8|main')).toBe(true);   // review ready
    expect(opens('p7|main')).toBe(true);   // reviewing beside an idle agent
    expect(opens('p1|main')).toBe(false);  // the agent is running: that is the news
    expect(opens('p2|main')).toBe(false);
  });

  it('links a row to its workstream, on the review tab when the row is about its review', () => {
    const href = (key: string) => conversationHref(home.rows.find(r => r.key === key)!);
    expect(href('p8|main')).toBe('/m/p/p8?role=review');
    expect(href('p1|termag-tui')).toBe('/m/p/p1?ws=termag-tui');
    expect(href('p1|main')).toBe('/m/p/p1');
    expect(conversationHref({ projectId: 'a b', workstream: 'feat/x', status: 'idle', ring: 'reviewing' })).toBe('/m/p/a%20b?ws=feat%2Fx&role=review');
  });

  it('clocks a review-led row from the review, others from the agent', () => {
    const since = (key: string) => stateSince(home.rows.find(r => r.key === key)!);
    expect(since('p8|main')).toBe(at(15)); // doneAt, not the agent's idle-since 40m
    expect(since('p7|main')).toBe(at(20));
    expect(since('p1|main')).toBe(at(1));
  });

  it('bands by the first rule that holds', () => {
    expect(bandFor('working', 'done')).toBe('attention');
    expect(bandFor('working', 'reviewing')).toBe('running');
    expect(bandFor('not_running', 'reviewing')).toBe('reviewing');
    expect(bandFor('idle', null)).toBe('other');
  });
});

describe('parseFilter', () => {
  it('reads ?f= and maps the retired tab ids', () => {
    expect(parseFilter('reviewing')).toBe('reviewing');
    expect(parseFilter(null, 'needs-you')).toBe('attention');
    expect(parseFilter(null, 'working')).toBe('running');
    expect(parseFilter(null, 'sessions')).toBeNull();
    expect(parseFilter('nope')).toBeNull();
  });
});

describe('search tab', () => {
  const home = buildHome(withReviews, reviewStatus, 'psecor');
  const recents: RecentRow[] = [
    { projectId: 'p3', projectName: 'sysadmin', workstream: 'main', owner: 'psecor', access: 'owner', instanceId: 'box1', archived: false, lastVisitedAt: at(30), status: 'idle', statusUpdatedAt: at(180), lastActiveAt: at(180), provider: 'claude' },
    { projectId: 'p1', projectName: 'termag', workstream: 'main', owner: 'psecor', access: 'owner', instanceId: 'box1', archived: false, lastVisitedAt: at(40), status: 'idle', statusUpdatedAt: at(100), lastActiveAt: at(100), provider: 'claude' },
    { projectId: 'p4', projectName: 'research', workstream: 'main', owner: 'zane', access: 'collaborator', instanceId: 'box2', archived: false, lastVisitedAt: at(26 * 60), status: 'idle', statusUpdatedAt: at(1440), lastActiveAt: at(1440), provider: 'devin' },
    { projectId: 'p6', projectName: 'gone', workstream: 'main', owner: 'psecor', access: 'owner', instanceId: null, archived: true, lastVisitedAt: at(10), status: 'idle', statusUpdatedAt: null, lastActiveAt: at(10), provider: 'claude' },
  ];

  it('lists recent sessions newest first with the live status, skipping archived ones', () => {
    const rows = recentSessions(home.rows, recents, NOW);
    expect(rows.map(r => `${r.key}:${r.bucket}`)).toEqual(['p3|main:Today', 'p1|main:Today', 'p4|main:Yesterday']);
    expect(rows[1].status).toBe('working'); // from statusMap, not the visit row
    expect(recentSessions(home.rows, recents, NOW, 1)).toHaveLength(1);
  });

  it('matches every term across name, workstream, owner, message and PR', () => {
    expect(searchRows(home.rows, 'termag tui').map(r => r.key)).toEqual(['p1|termag-tui']);
    expect(searchRows(home.rows, 'ZANE').map(r => r.key)).toEqual(['p4|main']);
    expect(searchRows(home.rows, 'pnpm').map(r => r.key)).toEqual(['p2|main']);
    expect(searchRows(home.rows, '#312').map(r => r.key)).toEqual(['p7|main']);
    expect(searchRows(home.rows, '   ')).toEqual([]);
  });

  it("matches the box's name only when it is given one", () => {
    const boxOf = (r: { key: string }) => (r.key === 'p2|main' ? 'psecor-dev02' : null);
    expect(searchRows(home.rows, 'dev02')).toEqual([]);
    expect(searchRows(home.rows, 'dev02', boxOf).map(r => r.key)).toEqual(['p2|main']);
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
    // A desktop thread's Claude runs beside the pane: the pane's provider stays the configured one.
    expect(runningProviderForSource('t3:claude')).toBeUndefined();
    expect(runningProviderForSource(undefined)).toBeUndefined();
    expect(rowKey('p9', 'feat')).toBe('p9|feat');
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
    const { rows } = buildHome([termag], statusMap, 'ada', { cloudSessions: [
      cloud(),
      cloud({ key: 'cse_01Q', sessionId: 'cse_01Q', state: 'queued', current: null, queuedReason: 'no box', queuedSince: at(45), lastSeenAt: at(1) }),
      cloud({ key: 'cse_01E', sessionId: 'cse_01E', state: 'ended', exitReason: 'completed' }),
    ] });
    const needs = rows.filter(r => r.band === 'attention');
    expect(needs.map(r => r.key)).toEqual(['cloud|cse_01A']);
    expect(needs[0]).toMatchObject({ kind: 'cloud', projectName: 'Claude Cloud 3', url: 'https://claude.ai/code/session_01A', waitingReason: 'approval', provider: 'claude' });
    const idle = rows.filter(r => r.band === 'other');
    // The clock is time queued, not time since the latest re-offer.
    expect(idle.find(r => r.key === 'cloud|cse_01Q')).toMatchObject({ status: 'not_running', message: 'no box', updatedAt: at(45) });
    expect(idle.find(r => r.key === 'cloud|cse_01E')).toBeUndefined();
  });
  it('adds nothing without sessions', () => {
    const a = buildHome([termag], {}, 'ada');
    const b = buildHome([termag], {}, 'ada', { cloudSessions: [] });
    expect(a.rows.length).toEqual(b.rows.length);
  });
});

describe('statusMapFromSessions', () => {
  const session = (over: Partial<SessionRow>): SessionRow => ({
    projectId: 'p1', projectName: 'termag', owner: 'psecor', access: 'owner', workstream: 'main', role: 'agent',
    session: 'psecor-termag-agent', instanceId: 'box1', connected: true, alive: true, status: 'idle', contextTokens: null,
    updatedAt: null, waitingReason: null, rateLimited: null, provider: 'claude', lastActiveAt: at(30), ...over,
  });

  it('builds the rows buildRows would from the live map, for agent panes only', () => {
    const map = statusMapFromSessions([
      session({ status: 'working', updatedAt: at(1), contextTokens: 412_000 }),
      session({ session: 'psecor-termag-termag-tui-agent', workstream: 'termag-tui', status: 'waiting', waitingReason: 'user_input' }),
      session({ session: 'psecor-termag-ctrl', role: 'ctrl', status: 'working' }),
    ]);
    expect(Object.keys(map)).toEqual([statusKey('box1', 'psecor-termag-agent'), statusKey('box1', 'psecor-termag-termag-tui-agent')]);
    const rows = buildRows([termag], map, 'psecor');
    expect(rows.map(r => [r.workstream, r.status, r.waitingReason])).toEqual([['main', 'working', null], ['termag-tui', 'waiting', 'user_input']]);
    expect(rows[0].contextTokens).toBe(412_000);
    // No updatedAt: the session's last activity stands in.
    expect(rows[1].updatedAt).toBe(at(30));
  });
});
