import { describe, expect, it } from 'vitest';
import type { SoftwareCell, SoftwareUpdateRun } from '../../services/adminApi';
import { cellBadges, isStale, runBadge } from './cellBadges';

const now = Date.parse('2026-11-10T12:00:00Z');
const policy = { mode: 'auto' as const, floor: '2.1.308', target: '2.1.314', reference: '2.1.314' };
const cell = (over: Partial<SoftwareCell> = {}): SoftwareCell => ({ version: '2.1.240', raw: null, path: '/usr/bin/claude', state: 'below-floor', observedAt: '2026-11-10T10:00:00Z', policy, ...over });
const run = (over: Partial<SoftwareUpdateRun> = {}): SoftwareUpdateRun => ({
  id: 'r1', hostKey: 'i-1', instanceId: null, component: 'claude', trigger: 'floor', requestedById: null, restart: 'idle',
  status: 'done', outcome: 'updated', target: '2.1.314', fromVersion: '2.1.240', toVersion: '2.1.314', detail: null, sessions: null,
  requestedAt: '2026-11-10T09:00:00Z', startedAt: '2026-11-10T09:00:05Z', finishedAt: '2026-11-10T09:02:00Z', ...over,
});
const texts = (c: SoftwareCell, r?: SoftwareUpdateRun, offline = false) => cellBadges(c, r, offline, now).map(b => b.text);

describe('cellBadges', () => {
  it('says nothing for a fresh cell with no run, or a run that worked', () => {
    expect(texts(cell({ state: 'current', version: '2.1.314' }))).toEqual([]);
    expect(texts(cell({ state: 'current', version: '2.1.314' }), run())).toEqual([]);
  });
  it('shows a run on its way from the matrix\'s inFlight (runActive), never from the runs list', () => {
    expect(texts(cell({ inFlight: { id: 'r', status: 'running', requestedAt: '2026-11-10T11:58:00Z' } }))).toEqual(['updating']);
    expect(texts(cell({ inFlight: { id: 'r', status: 'requested', requestedAt: '2026-11-10T11:58:00Z' } }))).toEqual(['updating']);
    expect(texts(cell({ inFlight: { id: 'r', status: 'requested', requestedAt: '2026-11-07T12:00:00Z', atStart: true } }))).toEqual(['queued for next start']);
    // The orchestrator's own update, as its host panel shows it: the same badge as a box's (Devin on #1608).
    expect(texts(cell({ refusal: 'orchestrator', inFlight: { id: 'r-orch', status: 'running', requestedAt: '2026-11-10T11:55:00Z' } }))).toEqual(['updating']);
    expect(texts(cell({ refusal: 'orchestrator_panel_off', inFlight: { id: 'r-orch', status: 'running', requestedAt: '2026-11-10T11:55:00Z' } }))).toEqual(['updating']);
    // A run the runs list still has at running, but the backend no longer counts: nothing about it.
    expect(texts(cell(), run({ status: 'running', outcome: null, finishedAt: null }))).toEqual([]);
  });
  it('says why the newest run failed, unless the cell is current since', () => {
    const failed = run({ status: 'failed', outcome: 'failed', detail: 'claude=2.1.240->FAILED:digest' });
    expect(cellBadges(cell(), failed, false, now)).toEqual([{ text: 'failed: digest mismatch', className: 'admin-bad' }]);
    expect(texts(cell({ state: 'current' }), failed)).toEqual([]);
    expect(cellBadges(cell({ state: 'behind' }), run({ outcome: 'partial', detail: 'runners_left=1' }), false, now)).toEqual([{ text: 'partial: runners left draining', className: 'admin-warn' }]);
  });
  it('shows what blocks the sweep', () => {
    expect(texts(cell({ sweep: { why: 'floor-failing', at: '2026-11-10T11:45:00Z' } }))).toEqual(['floor runs failing']);
    expect(texts(cell({ state: 'behind', sweep: { why: 'backing-off', at: '2026-11-10T11:45:00Z' } }))).toEqual(['backing off']);
    expect(texts(cell({ sweep: { why: 'current', at: '2026-11-10T11:45:00Z' } }))).toEqual([]);
  });
  it('drops the last pass\'s block only while the matrix says a run is in flight (Bugbot and Devin on #1608)', () => {
    const sweep = (why: string) => ({ sweep: { why, at: '2026-11-10T11:45:00Z' } });
    // A Docker run queued 3 days, waiting for the box's next start: runActive keeps it (its expiry is longer),
    // whether or not it is among the last 50 runs the tab read.
    const docker = { inFlight: { id: 'r-docker', status: 'requested' as const, requestedAt: '2026-11-07T12:00:00Z', atStart: true as const } };
    // A normal run in flight.
    const normal = { inFlight: { id: 'r-node', status: 'running' as const, requestedAt: '2026-11-10T11:58:00Z' } };
    for (const why of ['floor-failing', 'backing-off', 'not-capable']) {
      expect(texts(cell({ ...docker, ...sweep(why) }))).toEqual(['queued for next start']);
      expect(texts(cell({ state: 'behind', ...normal, ...sweep(why) }))).toEqual(['updating']);
    }
    // A run at running for 2 hours: runActive no longer counts it, so the matrix sends no inFlight, and the
    // sweep's floor-failing stays, whatever the runs list says.
    const stuck = run({ status: 'running', outcome: null, requestedAt: '2026-11-10T10:00:00Z', startedAt: '2026-11-10T10:00:00Z', finishedAt: null });
    expect(texts(cell(sweep('floor-failing')), stuck)).toEqual(['floor runs failing']);
    // Once a run ends, the block shows again if the next pass still skips the box.
    expect(texts(cell(sweep('floor-failing')), run({ status: 'failed', outcome: 'failed' }))).toEqual(['failed', 'floor runs failing']);
  });
  it('drops the last pass\'s block once the cell is current or ahead (Bugbot on #1608)', () => {
    for (const why of ['floor-failing', 'backing-off', 'not-capable']) {
      expect(texts(cell({ state: 'current', version: '2.1.314', sweep: { why, at: '2026-11-10T11:45:00Z' } }))).toEqual([]);
      expect(texts(cell({ state: 'ahead', version: '2.1.320', sweep: { why, at: '2026-11-10T11:45:00Z' } }))).toEqual([]);
    }
  });
  it('says when nothing here would update a tool below its floor, and why, once', () => {
    expect(texts(cell({ refusal: 'claude_update_off', policy: { ...policy, mode: 'off' } }))).toEqual(['not updated here: mode off']);
    expect(texts(cell({ refusal: 'not_capable', sweep: { why: 'not-capable', at: '2026-11-10T11:45:00Z' } }))).toEqual(['not updated here: its agent can’t run this update']);
    // A run in flight already says updating.
    expect(texts(cell({ refusal: 'run_in_flight', inFlight: { id: 'r', status: 'running', requestedAt: '2026-11-10T11:58:00Z' } }))).toEqual(['updating']);
    expect(texts(cell({ refusal: null }))).toEqual([]);
  });
  it('shows a failed run on every state but current: an ahead tool\'s failure too (Devin on #1608)', () => {
    const failed = run({ status: 'failed', outcome: 'failed', detail: 'claude=2.1.320->FAILED:digest' });
    expect(texts(cell({ state: 'ahead', version: '2.1.320' }), failed)).toEqual(['failed: digest mismatch']);
    expect(texts(cell({ state: 'held', policy: { ...policy, mode: 'off' } }), failed)).toEqual(['failed: digest mismatch', 'held: mode off']);
    expect(texts(cell({ state: 'missing', version: null }), failed)).toEqual(['failed: digest mismatch']);
    expect(texts(cell({ state: 'current', version: '2.1.314' }), failed)).toEqual([]);
  });
  it('says why the update skips a behind tool too, and only where nothing else says it', () => {
    expect(texts(cell({ state: 'behind', refusal: 'not_capable' }))).toEqual(['not updated here: its agent can’t run this update']);
    // The host's "offline" and the stale badge already say these.
    expect(texts(cell({ refusal: 'offline' }), undefined, true)).toEqual([]);
    expect(texts(cell({ refusal: 'no_inventory', observedAt: '2026-11-09T06:00:00Z' }))).toEqual(['stale 1d 6h']);
    // The orchestrator has its own action, named in its hover.
    expect(texts(cell({ refusal: 'orchestrator' }))).toEqual([]);
    // Nothing due, nothing to skip.
    expect(texts(cell({ state: 'current', version: '2.1.314', refusal: 'not_capable' }))).toEqual([]);
  });
  it('names why a cell is held', () => {
    expect(texts(cell({ state: 'held', policy: { ...policy, mode: 'off' } }))).toEqual(['held: mode off']);
    expect(texts(cell({ state: 'held', policy: undefined }))).toEqual(['held: no owner']);
    // Devin on #1608: an owned box whose policy read failed is not one without an owner.
    expect(texts(cell({ state: 'held', policy: undefined, policyUnavailable: true }))).toEqual(['held: policy unavailable']);
  });
  it('is stale past a day on a connected host; an offline host\'s cells are dimmed without a badge each', () => {
    const old = cell({ observedAt: '2026-11-08T10:00:00Z' });
    expect(texts(old)).toEqual(['stale 2d 2h']);
    expect(isStale(old, false, now)).toBe(true);
    expect(texts(cell(), undefined, true)).toEqual([]);
    expect(isStale(cell(), true, now)).toBe(true);
    expect(isStale(cell(), false, now)).toBe(false);
  });
});

describe('runBadge, for a host with no inventory row for the tool', () => {
  it('shows a finished run that went wrong, and nothing for one that worked or one not finished', () => {
    // On its way or not is the matrix's inFlight to say, not the runs list's.
    expect(runBadge(run({ status: 'running', outcome: null, finishedAt: null }), false)).toBeNull();
    expect(runBadge(run({ status: 'refused', outcome: null }), false)?.className).toBe('admin-bad');
    expect(runBadge(run(), false)).toBeNull();
    expect(runBadge(undefined, false)).toBeNull();
  });
});
