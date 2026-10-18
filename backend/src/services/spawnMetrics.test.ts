import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { metrics } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { AggregationTemporality, MeterProvider, MetricReader, type DataPoint } from '@opentelemetry/sdk-metrics';
import { emitSpawnEvent, registerSpawnGauges, resetSpawnMetricsForTests, setGaugeSnapshot, timedSweep, type GaugeSnapshot } from './spawnMetrics';

class TestReader extends MetricReader {
  constructor() { super({ aggregationTemporalitySelector: () => AggregationTemporality.DELTA }); }
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

const reader = new TestReader();
const logExporter = new InMemoryLogRecordExporter();

beforeAll(() => {
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
  logs.setGlobalLoggerProvider(new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter: logExporter })] }));
  resetSpawnMetricsForTests();
  registerSpawnGauges();
});

beforeEach(() => {
  logExporter.reset();
  setGaugeSnapshot(null);
});

/** Every data point of the named metric in the next collection. */
async function points(name: string): Promise<DataPoint<unknown>[]> {
  const { resourceMetrics } = await reader.collect();
  return resourceMetrics.scopeMetrics.flatMap(s => s.metrics).filter(m => m.descriptor.name === name).flatMap(m => m.dataPoints as DataPoint<unknown>[]);
}

describe('emitSpawnEvent', () => {
  it('counts a created spawn with its user, box, agent and target', async () => {
    emitSpawnEvent({ kind: 'created', userId: 'u1', instanceId: 'b1', spawnId: 'ck1', detail: { provider: 'claude', relationship: 'delegate', target: 'workstream', depth: 1 } });
    const [p] = await points('termag.spawn.requests');
    expect(p.value).toBe(1);
    expect(p.attributes).toEqual({
      'termag.user.id': 'u1', 'termag.box': 'b1', 'termag.spawn.outcome': 'created',
      'termag.spawn.target': 'workstream', 'termag.agent': 'claude', 'termag.spawn.relationship': 'delegate',
    });
  });

  it('counts a refusal by reason', async () => {
    emitSpawnEvent({ kind: 'refused', userId: 'u1', reason: 'box_busy', detail: { target: 'workstream', status: 409 } });
    const [p] = await points('termag.spawn.requests');
    expect(p.attributes).toMatchObject({ 'termag.spawn.outcome': 'refused', 'termag.spawn.reason': 'box_busy' });
  });

  it('records time to report only for the first report', async () => {
    emitSpawnEvent({ kind: 'reported', userId: 'u1', reason: 'blocked', detail: { provider: 'claude', relationship: 'delegate', first: true, secondsSinceCreated: 120 } });
    emitSpawnEvent({ kind: 'reported', userId: 'u1', reason: 'done', detail: { provider: 'claude', relationship: 'delegate', first: false, secondsSinceCreated: 300 } });
    const { resourceMetrics } = await reader.collect();
    const all = resourceMetrics.scopeMetrics.flatMap(s => s.metrics);
    const hist = all.find(m => m.descriptor.name === 'termag.spawn.time_to_report')!;
    expect((hist.dataPoints[0].value as { count: number; sum: number })).toMatchObject({ count: 1, sum: 120 });
    const reports = all.find(m => m.descriptor.name === 'termag.spawn.reports')!;
    expect(reports.dataPoints.map(p => p.attributes['termag.spawn.report_status']).sort()).toEqual(['blocked', 'done']);
  });

  it('records lifetime and nudge delay in seconds', async () => {
    emitSpawnEvent({ kind: 'ended', userId: 'u1', reason: 'killed', detail: { lifetimeSeconds: 3600 } });
    emitSpawnEvent({ kind: 'nudged', userId: 'u1', detail: { secondsAfterReport: 45 } });
    const { resourceMetrics } = await reader.collect();
    const all = resourceMetrics.scopeMetrics.flatMap(s => s.metrics);
    expect(all.find(m => m.descriptor.name === 'termag.spawn.lifetime')!.descriptor.unit).toBe('s');
    expect((all.find(m => m.descriptor.name === 'termag.spawn.nudge_delay')!.dataPoints[0].value as { sum: number }).sum).toBe(45);
  });

  it('emits a log record per event, with ids and counts only', async () => {
    emitSpawnEvent({ kind: 'created', userId: 'u1', spawnId: 'ck1', rootSpawnId: 'ck0', parentProjectId: 'p1', parentWorkstream: 'main', detail: { depth: 2, provider: 'claude' } });
    await new Promise(r => setTimeout(r, 10));
    const records = logExporter.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    const [r] = records;
    expect(r.eventName).toBe('termag.spawn.created');
    expect(r.attributes).toMatchObject({
      'event.name': 'termag.spawn.created', 'termag.spawn.id': 'ck1', 'termag.spawn.root_id': 'ck0',
      'termag.parent.project_id': 'p1', 'termag.spawn.depth': 2, 'termag.user.id': 'u1',
    });
    expect(String(r.body)).toBe('spawn created');
  });

  it('never throws on odd input', () => {
    expect(() => emitSpawnEvent({ kind: 'reported', userId: 'u1', detail: { secondsSinceCreated: -5, first: true } })).not.toThrow();
  });
});

describe('gauges', () => {
  const snap: GaugeSnapshot = {
    running: [{ userId: 'u1', instanceId: 'b1', value: 3 }],
    finishedRunning: [{ userId: 'u1', value: 2 }],
    limits: [{ userId: 'u1', limit: 'running', used: 6, value: 8 }],
    boxes: [{ instanceId: 'b1', ownerId: 'u1', memoryUtilization: 0.91, diskUtilization: 0.4, loadPerCore: 0.5, liveAgents: 3, capacity: null, hot: true }],
  };

  it('report the leader\'s snapshot', async () => {
    setGaugeSnapshot(snap);
    const { resourceMetrics } = await reader.collect();
    const byName = new Map(resourceMetrics.scopeMetrics.flatMap(s => s.metrics).map(m => [m.descriptor.name, m.dataPoints]));
    expect(byName.get('termag.spawn.running')![0]).toMatchObject({ value: 3, attributes: { 'termag.user.id': 'u1', 'termag.box': 'b1' } });
    expect(byName.get('termag.spawn.limit.utilization')![0]).toMatchObject({ value: 0.75, attributes: { 'termag.spawn.limit': 'running' } });
    expect(byName.get('termag.box.memory.utilization')![0].value).toBe(0.91);
    expect(byName.get('termag.box.hot')![0].value).toBe(1);
    // No cap set: no capacity series at all, rather than a misleading 0.
    expect(byName.get('termag.box.agents.capacity') ?? []).toEqual([]);
  });

  it('report nothing without a snapshot (a process that is not the leader)', async () => {
    expect(await points('termag.spawn.running')).toEqual([]);
    expect(await points('termag.box.hot')).toEqual([]);
  });
});

describe('timedSweep', () => {
  it('times a sweep and counts one that throws, rethrowing it', async () => {
    await expect(timedSweep('end', async () => { throw new Error('db down'); })).rejects.toThrow('db down');
    const [e] = await points('termag.spawn.sweep.errors');
    expect(e).toMatchObject({ value: 1, attributes: { 'termag.sweep': 'end' } });
    await timedSweep('nudge', async () => 1);
    const durations = await points('termag.spawn.sweep.duration');
    expect(durations.map(d => d.attributes['termag.sweep'])).toEqual(['nudge']);
  });
});
