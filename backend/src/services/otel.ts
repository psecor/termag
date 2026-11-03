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
 *
 * The resource carries service.version, the full 40-character termag commit
 * (services/termagVersion.ts, what GET /api/version serves), so backend logs
 * and metrics join the same version key as the browser's BUILD_SHA prefix.
 * The commit resolves asynchronously (a `git rev-parse` at worst), so it goes
 * in as a promised attribute: the SDK holds every export until it settles,
 * and nothing waits for it at startup. OTEL_RESOURCE_ATTRIBUTES overrides any
 * attribute set here.
 */
import { existsSync } from 'fs';
import { hostname } from 'os';
import { metrics } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { detectResources, envDetector, resourceFromAttributes, type Resource } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { ATTR_DEPLOYMENT_ENVIRONMENT_NAME, ATTR_SERVICE_INSTANCE_ID, ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { termagVersion } from './termagVersion';

/** Where termag-otelcol-env writes the collector's destination half; present = the collector is configured here. */
export const COLLECTOR_CONFIG = '/run/termag-otelcol/destination.yaml';
/** The collector's own config, baked into the orchestrator image with it (packer/scripts/orchestrator-setup.sh): present = a collector will be configured here. */
export const COLLECTOR_INSTALLED = '/usr/local/lib/termag/otelcol/termag-otelcol.yaml';
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

/** The older semantic-conventions name, kept beside deployment.environment.name for queries written against it. */
const ATTR_DEPLOYMENT_ENVIRONMENT = 'deployment.environment';

/** production on the host and the container (NODE_ENV=production), else NODE_ENV (stage and e2e say development). */
export function deploymentEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  return (env.NODE_ENV ?? '').trim().toLowerCase() || 'development';
}

/**
 * The orchestrator's resource. `version` is the running commit, or null when
 * it can't be known (then service.version is left out). Merged with
 * OTEL_RESOURCE_ATTRIBUTES, which wins.
 */
export function orchestratorResource(
  env: NodeJS.ProcessEnv = process.env,
  version: Promise<string | null> = termagVersion().then(v => v.sha),
): Resource {
  const environment = deploymentEnvironment(env);
  return resourceFromAttributes({
    [ATTR_SERVICE_NAME]: 'termag-orchestrator',
    [ATTR_SERVICE_INSTANCE_ID]: `${hostname()}:${process.pid}`,
    [ATTR_SERVICE_VERSION]: version.then(sha => sha ?? undefined, () => undefined),
    [ATTR_DEPLOYMENT_ENVIRONMENT]: environment,
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: environment,
  }).merge(detectResources({ detectors: [envDetector] }));
}

let sharedConfig: OtelConfig | undefined;
let sharedResource: Resource | undefined;

/** The one Resource, and its one promised service.version, for the three signals. */
export function otelResource(env: NodeJS.ProcessEnv = process.env): Resource {
  sharedResource ??= orchestratorResource(env);
  return sharedResource;
}

/**
 * Where to send and the resource, shared by the three signals: the tracer
 * (services/tracing.ts, at import) and the metrics and logs (initOtel, at
 * listen). Only a config that names somewhere is kept: at boot the collector's
 * config can appear after the backend starts (termag-otelcol-env runs beside
 * it), so "nowhere" is looked up again on the next call, as initOtel always did.
 */
export function otelSetup(env: NodeJS.ProcessEnv = process.env): { config: OtelConfig; resource: Resource } | null {
  sharedConfig ??= otelConfigFromEnv(env) ?? undefined;
  return sharedConfig ? { config: sharedConfig, resource: otelResource(env) } : null;
}

/**
 * Whether this host will have a collector endpoint though otelConfigFromEnv
 * has none yet: the collector is installed here, and nothing set overrides it
 * (TERMAG_OTEL=off, an explicit OTLP endpoint). The tracer, which has to
 * register at import, then waits for the endpoint rather than staying off.
 */
export function collectorExpected(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): boolean {
  if ((env.TERMAG_OTEL ?? '').trim().toLowerCase() === 'off') return false;
  if ((env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '').trim()) return false;
  return exists(env.TERMAG_OTELCOL_INSTALLED || COLLECTOR_INSTALLED);
}

/** Test hook: forget the shared setup. */
export function resetOtelSetupForTests(): void {
  sharedConfig = undefined;
  sharedResource = undefined;
}

const shutdownHooks: Array<() => Promise<void> | undefined> = [];

/** Run `hook` in shutdownOtel, beside the meter and logger providers' shutdown (the tracer provider's, from tracing.ts). */
export function onOtelShutdown(hook: () => Promise<void> | undefined): void {
  shutdownHooks.push(hook);
}

let meterProvider: MeterProvider | null = null;
let loggerProvider: LoggerProvider | null = null;

/** Register the providers once, at startup, before anything records. Never throws. */
export function initOtel(env: NodeJS.ProcessEnv = process.env): OtelConfig | null {
  if (meterProvider) return null;
  const setup = otelSetup(env);
  if (!setup) return null;
  const { config, resource } = setup;
  try {
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

/** Flush what is queued, on shutdown: the tracer decides its open entries first (TraceBufferProcessor.shutdown). */
export async function shutdownOtel(): Promise<void> {
  await Promise.all([
    meterProvider?.shutdown().catch(() => {}),
    loggerProvider?.shutdown().catch(() => {}),
    ...shutdownHooks.map(hook => Promise.resolve(hook()).catch(() => {})),
  ]);
  meterProvider = null;
  loggerProvider = null;
}
