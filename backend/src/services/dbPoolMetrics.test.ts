import { beforeAll, describe, expect, it } from 'vitest';
import { metrics } from '@opentelemetry/api';
import { AggregationTemporality, MeterProvider, MetricReader, type DataPoint } from '@opentelemetry/sdk-metrics';
import { registerDbPoolGauges, resetDbPoolGaugesForTests } from './dbPoolMetrics';

class TestReader extends MetricReader {
  constructor() { super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE }); }
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

const reader = new TestReader();
let pool: { totalCount: number; idleCount: number; waitingCount: number } | null = null;

beforeAll(() => {
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
  resetDbPoolGaugesForTests();
  registerDbPoolGauges(() => pool);
  registerDbPoolGauges(() => pool); // a second call registers nothing more
});

async function values(): Promise<Record<string, number[]>> {
  const { resourceMetrics } = await reader.collect();
  const out: Record<string, number[]> = {};
  for (const m of resourceMetrics.scopeMetrics.flatMap(s => s.metrics)) {
    out[m.descriptor.name] = (m.dataPoints as DataPoint<number>[]).map(p => p.value);
  }
  return out;
}

describe('db pool gauges', () => {
  it('report nothing without a pool of ours (DATABASE_URL mode)', async () => {
    pool = null;
    const v = await values();
    expect(v['termag.db.pool.total'] ?? []).toEqual([]);
  });

  it('report the pool\'s total, idle and waiting counts at each collection', async () => {
    pool = { totalCount: 20, idleCount: 0, waitingCount: 37 };
    expect(await values()).toMatchObject({ 'termag.db.pool.total': [20], 'termag.db.pool.idle': [0], 'termag.db.pool.waiting': [37] });
    pool = { totalCount: 4, idleCount: 3, waitingCount: 0 };
    expect(await values()).toMatchObject({ 'termag.db.pool.total': [4], 'termag.db.pool.idle': [3], 'termag.db.pool.waiting': [0] });
  });
});
