import { describe, expect, it } from 'vitest';
import { COLLECTOR_CONFIG, COLLECTOR_ENDPOINT, otelConfigFromEnv } from './otel';

const none = () => false;
const collectorHere = (p: string) => p === COLLECTOR_CONFIG;

describe('otelConfigFromEnv', () => {
  it('is off with nowhere to send', () => {
    expect(otelConfigFromEnv({}, none)).toBeNull();
  });

  it('pushes to the host collector when it is configured here', () => {
    expect(otelConfigFromEnv({}, collectorHere)).toEqual({ endpoint: COLLECTOR_ENDPOINT, source: 'collector', exportIntervalMs: 60_000 });
  });

  it('prefers an explicit endpoint, without a trailing slash', () => {
    expect(otelConfigFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example/' }, collectorHere))
      .toMatchObject({ endpoint: 'https://otel.example', source: 'env' });
  });

  it('refuses an endpoint that is not http(s), and TERMAG_OTEL=off wins over everything', () => {
    expect(otelConfigFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'grpc://x:4317' }, none)).toBeNull();
    expect(otelConfigFromEnv({ TERMAG_OTEL: 'off', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://x' }, collectorHere)).toBeNull();
  });

  it('takes a sane export interval and a moved collector config', () => {
    expect(otelConfigFromEnv({ OTEL_METRIC_EXPORT_INTERVAL: '15000' }, collectorHere)?.exportIntervalMs).toBe(15_000);
    expect(otelConfigFromEnv({ OTEL_METRIC_EXPORT_INTERVAL: '5' }, collectorHere)?.exportIntervalMs).toBe(60_000);
    expect(otelConfigFromEnv({ TERMAG_OTELCOL_OUT: '/tmp/x.yaml' }, p => p === '/tmp/x.yaml')?.source).toBe('collector');
  });
});
