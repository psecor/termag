/**
 * The backend's own OpenTelemetry metrics and logs. Off unless there is somewhere to send them:
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT   the OTLP/HTTP base URL (the container sets
 *                                 the collector's, plus OTEL_RESOURCE_ATTRIBUTES
 *                                 with telemetry.project_id)
 *   else the host collector       when termag-otelcol has rendered its
 *                                 destination config on this host, the backend
 *                                 pushes to its loopback receiver, which adds
 *                                 the project, host ids, redaction and a disk
 *                                 queue (deploy/termag-otelcol.yaml)
 *   TERMAG_OTEL=off               neither, whatever is set
 *
 * With neither, no provider is registered and the API stays a no-op, so dev,
 * tests and the e2e stack send nothing. Instruments are looked up through the
 * global API (services/spawnMetrics.ts), so nothing else imports the SDK.
 */
import { existsSync } from 'fs';
import { hostname } from 'os';
import { metrics } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { detectResources, envDetector, resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { ATTR_SERVICE_INSTANCE_ID, ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

/** Where termag-otelcol-env writes the collector's destination half; present = the collector is configured here. */
export const COLLECTOR_CONFIG = '/run/termag-otelcol/destination.yaml';
export const COLLECTOR_ENDPOINT = 'http://127.0.0.1:4318';
const DEFAULT_EXPORT_INTERVAL_MS = 60_000;

export interface OtelConfig {
  endpoint: string;
  source: 'env' | 'collector';
  exportIntervalMs: number;
}

/** Where to send, or null for nowhere. Pure apart from the injected file check. */
export function otelConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): OtelConfig | null {
  if ((env.TERMAG_OTEL ?? '').trim().toLowerCase() === 'off') return null;
  const interval = Number(env.OTEL_METRIC_EXPORT_INTERVAL);
  const exportIntervalMs = Number.isInteger(interval) && interval >= 1000 ? interval : DEFAULT_EXPORT_INTERVAL_MS;
  const explicit = (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '').trim().replace(/\/+$/, '');
  if (explicit) {
    if (!/^https?:\/\//.test(explicit)) {
      console.warn(`[OTEL] OTEL_EXPORTER_OTLP_ENDPOINT is not an http(s) URL; not exporting`);
      return null;
    }
    return { endpoint: explicit, source: 'env', exportIntervalMs };
  }
  const collectorConfig = env.TERMAG_OTELCOL_OUT || COLLECTOR_CONFIG;
  return exists(collectorConfig) ? { endpoint: COLLECTOR_ENDPOINT, source: 'collector', exportIntervalMs } : null;
}

let meterProvider: MeterProvider | null = null;
let loggerProvider: LoggerProvider | null = null;

/** Register the providers once, at startup, before anything records. Never throws. */
export function initOtel(env: NodeJS.ProcessEnv = process.env): OtelConfig | null {
  if (meterProvider) return null;
  const config = otelConfigFromEnv(env);
  if (!config) return null;
  try {
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: 'termag-orchestrator',
      [ATTR_SERVICE_INSTANCE_ID]: `${hostname()}:${process.pid}`,
    }).merge(detectResources({ detectors: [envDetector] }));
    meterProvider = new MeterProvider({
      resource,
      readers: [new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${config.endpoint}/v1/metrics` }),
        exportIntervalMillis: config.exportIntervalMs,
      })],
    });
    loggerProvider = new LoggerProvider({
      resource,
      processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: `${config.endpoint}/v1/logs` }) })],
    });
    metrics.setGlobalMeterProvider(meterProvider);
    logs.setGlobalLoggerProvider(loggerProvider);
    console.log(`[OTEL] exporting metrics and logs to ${config.endpoint} (${config.source})`);
    return config;
  } catch (err) {
    console.warn('[OTEL] could not start the exporters; continuing without:', (err as Error).message);
    meterProvider = null;
    loggerProvider = null;
    return null;
  }
}

/** Flush what is queued, on shutdown. */
export async function shutdownOtel(): Promise<void> {
  await Promise.all([
    meterProvider?.shutdown().catch(() => {}),
    loggerProvider?.shutdown().catch(() => {}),
  ]);
  meterProvider = null;
  loggerProvider = null;
}
