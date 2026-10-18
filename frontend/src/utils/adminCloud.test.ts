import { describe, expect, it } from 'vitest';
import { adminCloudName, agentAgeLabel, cloudCountCell, cloudKpiNote, daysForRange, fmtBytesShort, fmtPercentiles, pipelineShare, pipelineVerdict, pollStale, pressureCell, pressureClass, reportChartRows, slotHours, stackKeys, tmuxLabel, updateOutcomeClass, POLL_STALE_MS } from './adminCloud';
import type { CloudReport, PipelineBox } from '../services/adminApi';

describe('adminCloud helpers', () => {
  it('prefixes the per-owner name with the owner', () => {
    expect(adminCloudName('ada', 'Claude Cloud 3')).toBe('ada · Claude Cloud 3');
  });
  it('tells a box that is offline from one that did not answer', () => {
    expect(tmuxLabel(true, true)).toBe('live');
    expect(tmuxLabel(false, true)).toBe('gone');
    expect(tmuxLabel(null, false)).toBe('box offline');
    expect(tmuxLabel(null, true)).toBe('no answer');
  });
  it('flags a stale last poll, and nothing when the body has none', () => {
    const now = Date.parse('2026-10-09T12:00:00Z');
    expect(pollStale('2026-10-09T11:59:30Z', now)).toBe(false);
    expect(pollStale(new Date(now - POLL_STALE_MS - 1000).toISOString(), now)).toBe(true);
    expect(pollStale(null, now)).toBe(false);
    expect(pollStale('not a date', now)).toBe(false);
  });
  it('formats counts for a cell and the KPI note', () => {
    expect(cloudCountCell({ running: 2, starting: 1 })).toBe('2 running · 1 starting');
    expect(cloudCountCell({ running: 0, starting: 0 })).toBe('');
    expect(cloudCountCell(null)).toBe('');
    expect(cloudKpiNote({ running: 2, starting: 1, queued: 3 })).toBe('1 starting · 3 queued');
  });
});

describe('history helpers', () => {
  it('maps the picker to the sessions route days and seconds to tenths of hours', () => {
    expect([daysForRange('today'), daysForRange('7d'), daysForRange('30d')]).toEqual([1, 7, 30]);
    expect(slotHours(3600)).toBe(1);
    expect(slotHours(5400)).toBe(1.5);
    expect(slotHours(0)).toBe(0);
  });
  it('orders stack keys by total and flattens a report into chart rows', () => {
    expect(stackKeys([{ completed: 2, lost: 1 }, { interrupted: 3 }])).toEqual(['interrupted', 'completed', 'lost']);
    const report = {
      range: { since: '2026-10-01', until: '2026-10-07', days: 7 }, groupBy: 'day', refusals: {}, eventHorizonDays: 30, generatedAt: 'x',
      prior: { sessions: 0, runs: 0, slotSeconds: 0, lost: 0 },
      totals: { sessions: 1, runs: 1, slotSeconds: 3600, ends: { completed: 1 }, lost: 0, refusals: {}, queueWait: { p50: null, p95: null, samples: 0 }, spawn: { p50: null, p95: null, samples: 0 }, tokens: 0 },
      rows: [{ key: '2026-10-02', label: '2026-10-02', sessions: 1, runs: 1, slotSeconds: 3600, ends: { completed: 1 }, lost: 0, refusals: { 'no-box': 2 }, queueWait: { p50: null, p95: null, samples: 0 }, spawn: { p50: null, p95: null, samples: 0 }, tokens: 0 }],
    } as CloudReport;
    expect(reportChartRows(report)).toEqual([{ label: '2026-10-02', sessions: 1, runs: 1, slotHours: 1, completed: 1, 'refusal:no-box': 2 }]);
  });
  it('formats percentiles and reads a pipeline row', () => {
    expect(fmtPercentiles({ p50: null, p95: null, samples: 0 }, String)).toBe('no samples');
    expect(fmtPercentiles({ p50: 42, p95: 190, samples: 7 }, s => `${s}s`)).toBe('p50 42s · p95 190s (7)');
    const box = (over: Partial<PipelineBox>): PipelineBox => ({ instanceId: 'i', boxName: 'b', owner: 'ada', connected: true, agentCommit: null, runs: 4, withStarted: 4, withEnded: 3, withPlatform: 4, withTitle: 2, lost: 0, open: 1, ...over });
    expect(pipelineShare(box({}), 'withEnded')).toBe('75%');
    expect(pipelineShare(box({ runs: 0 }), 'withEnded')).toBe('—');
    expect(pipelineVerdict(box({}))).toBe('ok');
    expect(pipelineVerdict(box({ withStarted: 0 }))).toContain('never posts started');
    expect(pipelineVerdict(box({ withEnded: 0, lost: 3 }))).toContain('never posts ended');
    expect(pipelineVerdict(box({ lost: 1 }))).toBe('1 lost');
    expect(pipelineVerdict(box({ withTitle: 0 }))).toContain('no titles');
    expect(pipelineVerdict(box({ runs: 0 }))).toBe('no runs');
  });
});

describe('pressure helpers', () => {
  it('formats a sample and grades it', () => {
    const h = { diskUsedPct: 93, memUsedPct: 14, load1: 11.8, keptCheckouts: 0, sampledAt: 'x' };
    expect(pressureCell(h)).toBe('93% disk · 14% mem · load 11.8');
    expect(pressureCell(null)).toBe('');
    expect(pressureClass(h)).toBe('admin-warn');
    expect(pressureClass({ ...h, diskUsedPct: 96 })).toBe('admin-bad');
    expect(pressureClass({ ...h, diskUsedPct: 40, memUsedPct: 91 })).toBe('admin-warn');
    expect(pressureClass({ ...h, diskUsedPct: 40 })).toBe('');
    expect(pressureClass(null)).toBe('');
  });
  it('formats bytes', () => {
    expect(fmtBytesShort(8_000_000_000)).toBe('8.0 GB');
    expect(fmtBytesShort(512_000_000)).toBe('512 MB');
    expect(fmtBytesShort(null)).toBe('—');
  });
});

describe('agent age and update outcome', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  const target = { commit: 'b'.repeat(40), imageCreatedAt: '2026-10-10T06:00:00Z' };
  it('labels an agent by how far behind the current image it is', () => {
    expect(agentAgeLabel(null, null, target, now)).toBe('unknown');
    expect(agentAgeLabel('b'.repeat(40), '2026-10-09T00:00:00Z', target, now)).toBe('current');
    expect(agentAgeLabel('a'.repeat(40), '2026-10-07T05:00:00Z', target, now)).toBe('3d behind');
    expect(agentAgeLabel('a'.repeat(40), null, target, now)).toBe('behind');
    expect(agentAgeLabel('a'.repeat(40), '2026-10-05T12:00:00Z', { commit: null, imageCreatedAt: null }, now)).toBe('5d old');
  });
  it('grades an update outcome', () => {
    expect(updateOutcomeClass('updated')).toBe('admin-ok');
    expect(updateOutcomeClass('failed')).toBe('admin-bad');
    expect(updateOutcomeClass('deferred')).toBe('admin-warn');
    expect(updateOutcomeClass('current')).toBe('');
    expect(updateOutcomeClass(null)).toBe('');
  });
});
