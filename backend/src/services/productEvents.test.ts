import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { metrics } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { AggregationTemporality, MeterProvider, MetricReader, type DataPoint } from '@opentelemetry/sdk-metrics';
import { PRODUCT_EVENT_COUNTER, PRODUCT_EVENT_SCOPE, PRODUCT_EVENTS, productEventRecord, recordProductEvent, resetProductEventsForTests } from './productEvents';

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
  resetProductEventsForTests();
});

beforeEach(() => logExporter.reset());

async function points(name: string): Promise<DataPoint<unknown>[]> {
  const { resourceMetrics } = await reader.collect();
  return resourceMetrics.scopeMetrics.flatMap(s => s.metrics).filter(m => m.descriptor.name === name).flatMap(m => m.dataPoints as DataPoint<unknown>[]);
}

describe('productEventRecord', () => {
  it('carries the event name, the user and box keys and the detail under termag.', () => {
    expect(productEventRecord('project.created', { user: 'u1', box: 'b1' }, { provider: 'claude', repoSource: 'github', boxKind: 'box', warmClaimed: true }).attributes)
      .toEqual({
        'event.name': 'project.created', 'termag.user.id': 'u1', 'termag.box.id': 'b1',
        'termag.provider': 'claude', 'termag.repoSource': 'github', 'termag.boxKind': 'box', 'termag.warmClaimed': true,
      });
  });

  it('leaves out a missing box, null and undefined detail, and non-finite numbers', () => {
    expect(productEventRecord('agent.status.changed', { user: 'u1', box: null }, { status: 'waiting', waitingReason: null, previousStatusSeconds: undefined, bad: NaN }).attributes)
      .toEqual({ 'event.name': 'agent.status.changed', 'termag.user.id': 'u1', 'termag.status': 'waiting' });
  });

  it('cuts a long string value, so a message passed by mistake is never a record', () => {
    const { attributes } = productEventRecord('share.invited', { user: 'u1' }, { note: 'x'.repeat(500) });
    expect((attributes['termag.note'] as string).length).toBe(128);
  });

  it('names every event the vocabulary lists exactly once', () => {
    expect(new Set(PRODUCT_EVENTS).size).toBe(PRODUCT_EVENTS.length);
    expect(PRODUCT_EVENTS).toEqual(expect.arrayContaining([
      'project.created', 'agent.session.started', 'agent.session.ended', 'agent.status.changed', 'workstream.created',
      'share.invited', 'cloud.session.queued', 'cloud.session.placed', 'cloud.session.started', 'cloud.session.ended', 'box.provisioned',
    ]));
  });
});

describe('recordProductEvent', () => {
  it('emits one log record with event.name and increments the counter by name and box', async () => {
    recordProductEvent('box.provisioned', { user: 'u1', box: 'b1' }, { boxKind: 'ec2', warmClaimed: false });
    const [rec] = logExporter.getFinishedLogRecords();
    expect(rec.body).toBe('box.provisioned');
    expect(rec.instrumentationScope.name).toBe(PRODUCT_EVENT_SCOPE);
    expect(rec.attributes).toEqual({
      'event.name': 'box.provisioned', 'termag.user.id': 'u1', 'termag.box.id': 'b1',
      'termag.boxKind': 'ec2', 'termag.warmClaimed': false,
    });
    const [p] = await points(PRODUCT_EVENT_COUNTER);
    expect(p.value).toBe(1);
    expect(p.attributes).toEqual({ 'event.name': 'box.provisioned', 'termag.box.id': 'b1' });
  });

  it('never carries the detail on the counter, only on the record', async () => {
    recordProductEvent('cloud.session.ended', { user: 'u1', box: 'b1' }, { durationSec: 42, exitStatus: 0 });
    const [p] = await points(PRODUCT_EVENT_COUNTER);
    expect(Object.keys(p.attributes)).toEqual(['event.name', 'termag.box.id']);
  });
});
