import { describe, expect, it } from 'vitest';
import { DEFAULT_CLAUDE_UPDATE_POLICY } from '../claudeUpdatePolicy';
import {
  RUN_EXPIRE_MS, RUN_STALE_MS, isExpired, isInFlight, isRunId, parseToolUpdateReport, policyAnswer, reportCreate, reportUpdate,
  statusForOutcome, type ToolUpdateReport, type RunFacts,
} from './run';

const T0 = Date.parse('2026-10-29T12:00:00Z');
const RUN = 'ckz9v1q2w0000abcd1234efgh';
const run = (over: Partial<RunFacts> = {}): RunFacts => ({
  id: RUN, hostKey: 'box-a', component: 'claude', status: 'requested', restart: 'force', target: '2.1.312',
  requestedAt: new Date(T0), startedAt: null, ...over,
});

describe('run ids', () => {
  it('takes a cuid and nothing a shell or a unit name would read', () => {
    expect(isRunId(RUN)).toBe(true);
    for (const bad of ['short', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', `${RUN};reboot`, 'a'.repeat(41), '../../etc/passwd-aaaaaaaaaa', 42, null]) expect(isRunId(bad)).toBe(false);
  });
});

describe('expiry and in flight', () => {
  it('expires a request 15 minutes after it was asked, and nothing else', () => {
    expect(isExpired(run(), T0 + RUN_EXPIRE_MS - 1)).toBe(false);
    expect(isExpired(run(), T0 + RUN_EXPIRE_MS)).toBe(true);
    expect(isExpired(run({ status: 'running' }), T0 + 10 * RUN_EXPIRE_MS)).toBe(false);
  });

  it('holds the host while requested and fresh, or running and not stale', () => {
    expect(isInFlight(run(), T0 + 60_000)).toBe(true);
    expect(isInFlight(run(), T0 + RUN_EXPIRE_MS)).toBe(false);
    const started = run({ status: 'running', startedAt: new Date(T0 + 60_000) });
    expect(isInFlight(started, T0 + RUN_STALE_MS)).toBe(true);
    expect(isInFlight(started, T0 + 60_000 + RUN_STALE_MS)).toBe(false);
    for (const status of ['done', 'failed', 'refused', 'expired']) expect(isInFlight(run({ status }), T0)).toBe(false);
  });
});

describe('policyAnswer', () => {
  const base = { component: 'claude' as const, hostKey: 'box-a', enabled: true, policy: DEFAULT_CLAUDE_UPDATE_POLICY, now: T0 + 60_000 };
  const none = { floor: '2.1.308', target: 'latest', drainSec: 600, restart: 'none', run: null };

  it('starts this box\'s requested run with the flag on: its restart and target', () => {
    expect(policyAnswer({ ...base, asked: RUN, run: run() })).toEqual({
      status: 200, start: true, expire: false,
      body: { floor: '2.1.308', target: '2.1.312', drainSec: 600, restart: 'force', run: { id: RUN, component: 'claude' } },
    });
  });

  it('is restart none for the boot and guard paths (no run asked)', () => {
    expect(policyAnswer({ ...base, asked: null, run: null })).toEqual({ status: 200, start: false, expire: false, body: none });
  });

  it('is restart none with the flag off, and does not start the run', () => {
    expect(policyAnswer({ ...base, enabled: false, asked: RUN, run: run() })).toEqual({ status: 200, start: false, expire: false, body: none });
  });

  it('is restart none for a run long running or ended', () => {
    for (const status of ['running', 'done', 'failed', 'refused', 'expired']) {
      expect(policyAnswer({ ...base, asked: RUN, run: run({ status }) })).toMatchObject({ status: 200, start: false, body: { restart: 'none', run: null } });
    }
  });

  it('gives a retry from the box the same run while it started under 5 minutes ago and has not reported', () => {
    const started = run({ status: 'running', startedAt: new Date(T0) });
    const again = { status: 200, start: false, expire: false, body: { floor: '2.1.308', target: '2.1.312', drainSec: 600, restart: 'force', run: { id: RUN, component: 'claude' } } };
    expect(policyAnswer({ ...base, now: T0 + 4 * 60_000, asked: RUN, run: started })).toEqual(again);
    expect(policyAnswer({ ...base, now: T0 + 5 * 60_000, asked: RUN, run: started })).toMatchObject({ body: { restart: 'none', run: null } });
    expect(policyAnswer({ ...base, now: T0 + 60_000, asked: RUN, run: run({ status: 'done', startedAt: new Date(T0) }) })).toMatchObject({ body: { restart: 'none', run: null } });
    expect(policyAnswer({ ...base, enabled: false, now: T0 + 60_000, asked: RUN, run: started })).toMatchObject({ body: { restart: 'none', run: null } });
    expect(policyAnswer({ ...base, now: T0 + 60_000, asked: RUN, run: { ...started, hostKey: 'box-b' } })).toEqual({ status: 404, body: { code: 'no_such_run' } });
  });

  it('expires a request fetched too late, restart none', () => {
    expect(policyAnswer({ ...base, now: T0 + RUN_EXPIRE_MS, asked: RUN, run: run() })).toEqual({ status: 200, start: false, expire: true, body: none });
  });

  it('is 404 no_such_run for an unknown run, another box\'s, or another tool\'s', () => {
    expect(policyAnswer({ ...base, asked: RUN, run: null })).toEqual({ status: 404, body: { code: 'no_such_run' } });
    expect(policyAnswer({ ...base, asked: RUN, run: run({ hostKey: 'box-b' }) })).toEqual({ status: 404, body: { code: 'no_such_run' } });
    expect(policyAnswer({ ...base, asked: RUN, run: run({ component: 'gh' }) })).toEqual({ status: 404, body: { code: 'no_such_run' } });
  });

  it('falls back to the policy target for a run with none, and to none for a stored restart it does not know', () => {
    expect(policyAnswer({ ...base, asked: RUN, run: run({ target: null, restart: 'reboot' }) })).toMatchObject({ body: { target: 'latest', restart: 'none' } });
  });
});

describe('parseToolUpdateReport', () => {
  const ok = {
    component: 'claude', trigger: 'manual', outcome: 'updated', run: RUN, target: 'latest', fromVersion: '2.1.300', toVersion: '2.1.312', detail: 'npm ok',
    sessions: { stopped: 3, resumed: 2, fresh: 1, cut: 0, typed: 1, other: 1, runnersLeft: 0 },
    panes: [
      { session: 'ada-web-agent', role: 'agent', sessionId: '0d9c4b8e-1f2a-4c3b-9d8e-7f6a5b4c3d2e', hadConversation: true },
      { session: 'ada-web-feature_x-agent', role: 'agent', hadConversation: false },
      { session: 'ada-web-ctrl', role: 'other', sessionId: 'abc-123', hadConversation: true },
    ],
  };

  it('takes the contract\'s body', () => {
    const r = parseToolUpdateReport(ok) as ToolUpdateReport;
    expect(r).toMatchObject({ component: 'claude', trigger: 'manual', outcome: 'updated', run: RUN, fromVersion: '2.1.300', toVersion: '2.1.312', sessions: ok.sessions });
    expect(r.panes).toEqual([
      { session: 'ada-web-agent', role: 'agent', sessionId: '0d9c4b8e-1f2a-4c3b-9d8e-7f6a5b4c3d2e', hadConversation: true },
      { session: 'ada-web-feature_x-agent', role: 'agent', sessionId: null, hadConversation: false },
      { session: 'ada-web-ctrl', role: 'other', sessionId: 'abc-123', hadConversation: true },
    ]);
  });

  it('lets a boot or guard report come without a run, panes or sessions, and fills missing counts with 0', () => {
    expect(parseToolUpdateReport({ component: 'claude', trigger: 'boot', outcome: 'current' })).toMatchObject({ run: null, panes: [], sessions: null });
    expect(parseToolUpdateReport({ component: 'claude', trigger: 'guard', outcome: 'updated', sessions: { stopped: 1 } })).toMatchObject({ sessions: { stopped: 1, resumed: 0, runnersLeft: 0 } });
  });

  it('wants a run for every other trigger', () => {
    for (const trigger of ['manual', 'floor', 'resume', 'nightly']) expect(parseToolUpdateReport({ component: 'claude', trigger, outcome: 'updated' })).toEqual({ error: `a ${trigger} report names its run` });
  });

  it('caps the detail at 2000 characters', () => {
    expect((parseToolUpdateReport({ ...ok, detail: 'x'.repeat(5000) }) as ToolUpdateReport).detail).toHaveLength(2000);
  });

  it('names an unknown component with its code', () => {
    expect(parseToolUpdateReport({ ...ok, component: 'python' })).toEqual({ error: 'component is not a tool termag updates', code: 'unknown_component' });
  });

  it('refuses what is malformed', () => {
    const bad: Array<[unknown, RegExp]> = [
      [null, /object/], [[], /object/],
      [{ ...ok, component: 'nope' }, /component/], [{ ...ok, component: undefined }, /component/],
      [{ ...ok, trigger: 'cron' }, /trigger/], [{ ...ok, outcome: 'ok' }, /outcome/], [{ ...ok, run: 'nope' }, /run/],
      [{ ...ok, toVersion: '2.1.312 && reboot' }, /toVersion/], [{ ...ok, target: '' }, /target/],
      [{ ...ok, detail: 7 }, /detail/],
      [{ ...ok, sessions: { stopped: -1 } }, /sessions.stopped/], [{ ...ok, sessions: [] }, /sessions/],
      [{ ...ok, panes: {} }, /panes/], [{ ...ok, panes: Array(201).fill(ok.panes[0]) }, /at most/],
      [{ ...ok, panes: [{ ...ok.panes[0], session: 'a b' }] }, /session/], [{ ...ok, panes: [{ ...ok.panes[0], session: 'a:1.0' }] }, /session/],
      [{ ...ok, panes: [{ ...ok.panes[0], role: 'ctrl' }] }, /role/],
      [{ ...ok, panes: [{ ...ok.panes[0], hadConversation: 'yes' }] }, /hadConversation/],
      [{ ...ok, panes: [{ ...ok.panes[0], sessionId: '../x' }] }, /sessionId/],
    ];
    for (const [body, err] of bad) expect((parseToolUpdateReport(body) as { error: string }).error).toMatch(err);
  });
});

describe('what a report writes', () => {
  const report = parseToolUpdateReport({ component: 'claude', trigger: 'manual', outcome: 'partial', run: RUN, fromVersion: '2.1.300', toVersion: '2.1.312', sessions: { cut: 1 } }) as ToolUpdateReport;
  const now = new Date(T0 + 600_000);

  it('ends the run: failed only for a failed outcome', () => {
    expect(statusForOutcome('updated')).toBe('done');
    expect(statusForOutcome('current')).toBe('done');
    expect(statusForOutcome('partial')).toBe('done');
    expect(statusForOutcome('failed')).toBe('failed');
  });

  it('keeps when it started, or takes now for a run the box never fetched for', () => {
    const started = new Date(T0 + 60_000);
    expect(reportUpdate({ startedAt: started }, report, now)).toMatchObject({ status: 'done', outcome: 'partial', startedAt: started, finishedAt: now, toVersion: '2.1.312' });
    expect(reportUpdate({ startedAt: null }, report, now).startedAt).toBe(now);
    expect(reportUpdate({ startedAt: null }, report, now)).not.toHaveProperty('target');
  });

  it('creates a finished row for a boot run', () => {
    const boot = parseToolUpdateReport({ component: 'claude', trigger: 'boot', outcome: 'updated', toVersion: '2.1.312' }) as ToolUpdateReport;
    expect(reportCreate('box-a', 'box-a', boot, now)).toMatchObject({
      hostKey: 'box-a', instanceId: 'box-a', component: 'claude', trigger: 'boot', restart: 'none', status: 'done',
      requestedAt: now, startedAt: now, finishedAt: now,
    });
  });
});
