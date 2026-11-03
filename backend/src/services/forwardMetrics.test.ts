import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { metrics } from '@opentelemetry/api';
import { AggregationTemporality, MeterProvider, MetricReader, type DataPoint } from '@opentelemetry/sdk-metrics';
import { recordForwardClose, recordForwardOpen, recordForwardRefusal, resetForwardMetricsForTests } from './forwardMetrics';

class TestReader extends MetricReader {
  constructor() { super({ aggregationTemporalitySelector: () => AggregationTemporality.DELTA }); }
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

const reader = new TestReader();
let lines: string[];

beforeAll(() => {
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
  resetForwardMetricsForTests();
});

beforeEach(async () => {
  await reader.collect();
  lines = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
});
afterEach(() => vi.restoreAllMocks());

async function points(name: string): Promise<DataPoint<unknown>[]> {
  const { resourceMetrics } = await reader.collect();
  return resourceMetrics.scopeMetrics.flatMap(s => s.metrics).filter(m => m.descriptor.name === name).flatMap(m => m.dataPoints as DataPoint<unknown>[]);
}

const who = { 'context.contextKeys.user': 'u1', 'termag.box': 'b1', 'termag.forward.port': 3000 };

describe('forward telemetry', () => {
  it('counts a refusal by its code, with ids only', async () => {
    recordForwardRefusal({ userId: 'u1', boxId: 'b1', port: 3000, status: 403, code: 'port_refused' });
    const [p] = await points('termag.forward.refusals');
    expect(p.value).toBe(1);
    expect(p.attributes).toEqual({ ...who, 'termag.forward.code': 'port_refused', 'termag.forward.probe': 'false' });
    expect(lines).toEqual(['[FORWARD] refused user=u1 box=b1 port=3000 status=403 code=port_refused']);
  });

  it('records an open with its setup time and subprotocol, and a close with bytes each way, duration and code', async () => {
    recordForwardOpen({ userId: 'u1', boxId: 'b1', port: 3000, setupMs: 250, protocol: 'v1' });
    expect((await points('termag.forward.opens'))[0]).toMatchObject({ value: 1, attributes: { ...who, 'termag.forward.protocol': 'v1' } });
    recordForwardClose({ userId: 'u1', boxId: 'b1', port: 3000, setupMs: 250, protocol: 'v1', bytesIn: 10, bytesOut: 5000, durationMs: 4000, code: 1000 });
    const { resourceMetrics } = await reader.collect();
    const byName = Object.fromEntries(resourceMetrics.scopeMetrics.flatMap(s => s.metrics).map(m => [m.descriptor.name, m.dataPoints as DataPoint<unknown>[]]));
    expect(byName['termag.forward.closes'][0]).toMatchObject({ value: 1, attributes: { ...who, 'termag.forward.code': '1000' } });
    expect(byName['termag.forward.bytes'].map(p => [p.attributes['termag.forward.direction'], p.value]).sort()).toEqual([['down', 5000], ['up', 10]]);
    expect(byName['termag.forward.duration'][0].attributes).toEqual({ 'termag.forward.code': '1000' });
    expect(lines).toEqual([
      '[FORWARD] open user=u1 box=b1 port=3000 protocol=v1 setupMs=250',
      '[FORWARD] close user=u1 box=b1 port=3000 bytesIn=10 bytesOut=5000 durationMs=4000 code=1000',
    ]);
  });

  it('says - for what it does not know yet, as for a refusal before the bearer', () => {
    recordForwardRefusal({ userId: null, boxId: 'b1', port: null, status: 401, code: 'auth_required', probe: true });
    expect(lines).toEqual(['[FORWARD] refused probe user=- box=b1 port=- status=401 code=auth_required']);
  });
});
