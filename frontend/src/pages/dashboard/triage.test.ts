import { describe, it, expect } from 'vitest';
import { buildAttentionItems, liveSummary, TriageInput } from './triage';
import type { SessionRow, UsageDayData } from '../../services/api';
import type { Project } from '../../types';

const NOW = Date.parse('2026-09-18T12:00:00Z');
const H = 3_600_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    projectId: 'p1', projectName: 'termag', owner: 'psecor', access: 'owner', workstream: 'main', role: 'agent',
    session: 'psecor-termag-agent', instanceId: null, connected: true, alive: true, status: 'working',
    contextTokens: 10_000, updatedAt: iso(60_000), waitingReason: null, rateLimited: null, provider: 'claude',
    lastActiveAt: iso(60_000), ...over,
  };
}
function project(over: Partial<Project> = {}): Project {
  return { id: 'p1', name: 'termag', archived: false, workflows: [], workstreams: [], ...over } as Project;
}
function input(over: Partial<TriageInput> = {}): TriageInput {
  return {
    sessions: [], projects: [project()], usage: null, usageUnavailable: false, worktimeByProject: null,
    todayKeys: ['2026-09-18'], todayUTC: '2026-09-18',
    baselineUTC: ['2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08'], ...over,
  };
}
const day = (tokens: number, calls = 1): UsageDayData => ({ input: tokens, output: 0, cacheRead: 0, cacheCreate: 0, calls });
const kinds = (items: ReturnType<typeof buildAttentionItems>) => items.map(i => i.kind);

describe('buildAttentionItems — row selection', () => {
  it('ignores collaborator rows and non-agent roles', () => {
    const items = buildAttentionItems(input({ sessions: [
      row({ access: 'collaborator', contextTokens: 2_000_000 }),
      row({ role: 'ctrl', contextTokens: 2_000_000, session: 'x-ctrl' }),
    ] }), NOW);
    expect(items).toEqual([]);
  });
  it('empty input → no items', () => {
    expect(buildAttentionItems(input(), NOW)).toEqual([]);
  });
});

describe('context', () => {
  it('boundaries: 499_999 nothing, 500_000 warning, 1_000_000 critical', () => {
    expect(buildAttentionItems(input({ sessions: [row({ contextTokens: 499_999 })] }), NOW)).toEqual([]);
    expect(buildAttentionItems(input({ sessions: [row({ contextTokens: 500_000 })] }), NOW)[0])
      .toMatchObject({ kind: 'context', severity: 'warning', metric: 500_000 });
    expect(buildAttentionItems(input({ sessions: [row({ contextTokens: 1_000_000 })] }), NOW)[0])
      .toMatchObject({ kind: 'context', severity: 'critical' });
  });
});

describe('waiting', () => {
  it('under 30m nothing; 30m warning; 2h critical; null updatedAt never fires', () => {
    const w = (ago: number, updatedAt: string | null = iso(ago)) => buildAttentionItems(
      input({ sessions: [row({ status: 'waiting', waitingReason: 'approval', updatedAt })] }), NOW);
    expect(w(29 * 60_000)).toEqual([]);
    expect(w(30 * 60_000)[0]).toMatchObject({ kind: 'waiting', severity: 'warning' });
    expect(w(2 * H)[0]).toMatchObject({ kind: 'waiting', severity: 'critical' });
    expect(w(2 * H)[0].title).toMatch(/≥/);
    expect(w(5 * H, null)).toEqual([]);
  });
});

describe('idle', () => {
  it('needs alive + idle/not_running; 2h notice, 24h warning; one per project; metaterm excluded', () => {
    const idle = (ago: number, over: Partial<SessionRow> = {}) =>
      buildAttentionItems(input({ sessions: [row({ status: 'idle', lastActiveAt: iso(ago), ...over })] }), NOW);
    expect(idle(1 * H)).toEqual([]);
    expect(idle(3 * H)[0]).toMatchObject({ kind: 'idle', severity: 'notice' });
    expect(idle(25 * H)[0]).toMatchObject({ kind: 'idle', severity: 'warning' });
    expect(idle(25 * H, { alive: false })).toEqual([]);
    expect(idle(25 * H, { status: 'working' })).toEqual([]);
    const two = buildAttentionItems(input({ sessions: [
      row({ status: 'idle', lastActiveAt: iso(25 * H) }),
      row({ status: 'idle', lastActiveAt: iso(25 * H), workstream: 'feature', session: 'psecor-termag-feature-agent' }),
    ] }), NOW);
    expect(two.filter(i => i.kind === 'idle')).toHaveLength(1);
    const meta = buildAttentionItems(input({
      projects: [project({ kind: 'metaterm' })],
      sessions: [row({ status: 'idle', lastActiveAt: iso(48 * H) })],
    }), NOW);
    expect(meta).toEqual([]);
  });
});

describe('offline host', () => {
  it('yields one item per host and suppresses per-row rules on that host', () => {
    const items = buildAttentionItems(input({ sessions: [
      row({ connected: false, contextTokens: 5_000_000, status: 'waiting', updatedAt: iso(5 * H) }),
      row({ connected: false, projectId: 'p2', projectName: 'other', session: 'psecor-other-agent', contextTokens: 5_000_000 }),
      row({ connected: false, instanceId: 'box1', projectId: 'p3', projectName: 'boxed', session: 'psecor-boxed-agent' }),
    ] }), NOW);
    expect(kinds(items)).toEqual(['agent_offline', 'agent_offline']);
  });
});

describe('token burn (user-wide)', () => {
  const usageWith = (today: number, baseline: number[]) => {
    const days: Record<string, UsageDayData> = { '2026-09-18': day(today) };
    baseline.forEach((t, i) => { days[`2026-09-0${4 + i}`] = day(t, t > 0 ? 1 : 0); });
    return { days };
  };
  it('needs ≥3 active baseline days and the 1M floor', () => {
    expect(buildAttentionItems(input({ usage: usageWith(9_000_000, [1_000_000, 1_000_000]) }), NOW)).toEqual([]);
    expect(buildAttentionItems(input({ usage: usageWith(900_000, [100_000, 100_000, 100_000]) }), NOW)).toEqual([]);
  });
  it('2× warning, 3× critical; zero-call days excluded from the baseline', () => {
    expect(buildAttentionItems(input({ usage: usageWith(2_000_000, [1_000_000, 1_000_000, 1_000_000, 0, 0]) }), NOW)[0])
      .toMatchObject({ kind: 'token_burn', severity: 'warning' });
    expect(buildAttentionItems(input({ usage: usageWith(3_000_000, [1_000_000, 1_000_000, 1_000_000]) }), NOW)[0])
      .toMatchObject({ kind: 'token_burn', severity: 'critical' });
    expect(buildAttentionItems(input({ usage: usageWith(1_900_000, [1_000_000, 1_000_000, 1_000_000]) }), NOW)).toEqual([]);
  });
  it('usage unavailable → notice, unless the legacy agent is already reported offline', () => {
    expect(buildAttentionItems(input({ usageUnavailable: true }), NOW)[0]).toMatchObject({ kind: 'usage_unavailable' });
    const items = buildAttentionItems(input({ usageUnavailable: true, sessions: [row({ connected: false })] }), NOW);
    expect(kinds(items)).toEqual(['agent_offline']);
  });
  it('deep-links to the project owning ≥50% of today\'s attributed tokens; stays user-wide otherwise', () => {
    const proj = (id: string, t: number) => ({ projectId: id, name: id, color: null, workstream: 'main', days: { '2026-09-18': day(t) } });
    const base = usageWith(3_000_000, [1_000_000, 1_000_000, 1_000_000]);
    const dominant = buildAttentionItems(input({ usage: { ...base, projects: [proj('big', 2_000_000), proj('small', 1_000_000)] } }), NOW)[0];
    expect(dominant).toMatchObject({ kind: 'token_burn', projectId: 'big', projectName: 'big', action: 'open the project' });
    expect(dominant.detail).toMatch(/67% of today's attributed tokens are on big/);
    const split = buildAttentionItems(input({ usage: { ...base, projects: [proj('a', 1_000_000), proj('b', 1_000_000), proj('c', 1_000_000)] } }), NOW)[0];
    expect(split.projectId).toBeUndefined();
    expect(split.action).toBe('see which pane is burning');
    const noProjects = buildAttentionItems(input({ usage: base }), NOW)[0];
    expect(noProjects.projectId).toBeUndefined();
  });
  it('staleSince → a stale notice (suppressed when the legacy host is offline)', () => {
    const stale = { days: {}, staleSince: iso(3 * H) };
    expect(buildAttentionItems(input({ usage: stale }), NOW)[0]).toMatchObject({ kind: 'usage_unavailable', id: 'tokens:stale' });
    expect(buildAttentionItems(input({ usage: stale }), NOW)[0].title).toMatch(/3h ago/);
    expect(kinds(buildAttentionItems(input({ usage: stale, sessions: [row({ connected: false })] }), NOW))).toEqual(['agent_offline']);
  });
});

describe('effort', () => {
  it('sums agent (not human) ms for today per project: 4h notice, 8h warning', () => {
    const wt = (ms: number) => [
      { projectId: 'p1', projectName: 'termag', workstream: 'main', provider: 'claude', date: '2026-09-18', totalMs: ms / 2, sessions: 1 },
      { projectId: 'p1', projectName: 'termag', workstream: 'feature', provider: 'codex', date: '2026-09-18', totalMs: ms / 2, sessions: 1 },
      { projectId: 'p1', projectName: 'termag', workstream: 'main', provider: 'human', date: '2026-09-18', totalMs: 9 * H, sessions: 1 },
      { projectId: 'p1', projectName: 'termag', workstream: 'main', provider: 'claude', date: '2026-09-17', totalMs: 9 * H, sessions: 1 },
    ];
    expect(buildAttentionItems(input({ worktimeByProject: wt(3 * H) }), NOW)).toEqual([]);
    expect(buildAttentionItems(input({ worktimeByProject: wt(4 * H) }), NOW)[0]).toMatchObject({ kind: 'effort', severity: 'notice' });
    expect(buildAttentionItems(input({ worktimeByProject: wt(8 * H) }), NOW)[0]).toMatchObject({ kind: 'effort', severity: 'warning' });
  });
});

describe('ordering', () => {
  it('critical before warning before notice, then by metric desc', () => {
    const items = buildAttentionItems(input({ sessions: [
      row({ contextTokens: 600_000, session: 'a' }),
      row({ contextTokens: 1_500_000, session: 'b', projectId: 'p2', projectName: 'b' }),
      row({ contextTokens: 900_000, session: 'c', projectId: 'p3', projectName: 'c' }),
      row({ status: 'idle', lastActiveAt: iso(3 * H), session: 'd', projectId: 'p4', projectName: 'd' }),
    ] }), NOW);
    expect(items.map(i => `${i.severity}:${i.metric}`)).toEqual([
      'critical:1500000', 'warning:900000', 'warning:600000', `notice:${3 * H}`,
    ]);
  });
});

describe('liveSummary', () => {
  it('counts own agent rows on connected hosts', () => {
    const s = liveSummary([
      row({ status: 'working' }), row({ status: 'waiting', session: 'b' }), row({ status: 'idle', session: 'c' }),
      row({ status: 'not_running', session: 'd' }), row({ connected: false, instanceId: 'box1', session: 'e' }),
      row({ access: 'collaborator', session: 'f' }),
    ]);
    expect(s).toEqual({ working: 1, waiting: 1, idle: 1, notRunning: 1, offlineHosts: 1 });
  });
});
