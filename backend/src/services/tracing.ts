/**
 * The backend's OpenTelemetry traces. Imported second
 * in index.ts, right after dotenv: the instrumentations patch express, pg,
 * undici and the AWS SDK as those load, so this module, and everything it
 * imports, must load none of them (tracing.test.ts checks).
 *
 *   where           otel.ts's otelSetup(): the same endpoint, resource and
 *                   TERMAG_OTEL=off as the metrics and logs
 *   TERMAG_TRACING  off: no tracer at all (metrics and logs carry on);
 *                   on: where no flag source is wired in, record, with
 *                   TERMAG_TRACING_RATE (default 1) as the sampling default
 *   otherwise       server-tracing-enabled and server-tracing-sampling decide,
 *                   once a flag source has read them; nothing is
 *                   recorded before
 *
 * Every span is recorded while the kill switch is on; TraceBufferProcessor
 * decides per entry (one request or background run) which are exported, and
 * ScrubbingExporter rewrites what leaves the process.
 */
import { context, propagation, trace, createNoopMeter, type MeterProvider } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import { ExpressInstrumentation, ExpressLayerType } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { IncomingMessage } from 'http';
import { collectorExpected, otelResource, otelSetup, onOtelShutdown } from './otel';
import { TraceBufferProcessor } from './tracing/buffer';
import { DeferredTraceExporter } from './tracing/exporter';
import { PgPoolContextInstrumentation } from './tracing/pgPoolContext';
import { CredentialedParentPropagator } from './tracing/propagator';
import { KillSwitchSampler } from './tracing/sampler';
import { ErrorDescriptionProcessor, ScrubbingExporter } from './tracing/scrub';
import { initTracingState, markTracingRegistered, tracingEnvFromEnv, tracingSource } from './tracing/state';

const IMDS_HOST = '169.254.169.254';
/** First path segments (under BASE_PATH) the API answers on; any other GET is the SPA or a static file. */
const API_PREFIXES = new Set(['api', 'auth', 'internal', 'mcp', 'oauth', 'p', 'files']);

/** The path relative to BASE_PATH, without the query. */
export function appPath(url: string | undefined, basePath: string): string {
  const path = (url ?? '/').split('?')[0] || '/';
  if (!basePath) return path;
  if (path === basePath) return '/';
  return path.startsWith(`${basePath}/`) ? path.slice(basePath.length) : path;
}

/** Requests never traced: probes, the version check, static files and the SPA, preflights. */
export function ignoredRequest(method: string | undefined, url: string | undefined, basePath: string): boolean {
  if (method === 'OPTIONS') return true;
  const path = appPath(url, basePath);
  if (path === '/health' || path.startsWith('/health/') || path === '/api/version') return true;
  if (method !== 'GET' && method !== 'HEAD') return false;
  return !API_PREFIXES.has(path.split('/')[1] ?? '');
}

/** `poll=1` in the query: the browser's pollers send it where their route has person-triggered neighbours. */
export function isPoll(url: string | undefined): boolean {
  const query = (url ?? '').split('?')[1];
  return query !== undefined && new URLSearchParams(query).get('poll') === '1';
}

const noopMeterProvider: MeterProvider = { getMeter: () => createNoopMeter() };

let provider: NodeTracerProvider | null = null;

/** Register the tracer provider and the instrumentations, once, before the instrumented modules load. Never throws. */
export function initTracing(env: NodeJS.ProcessEnv = process.env): boolean {
  if (provider) return true;
  const tracingEnv = tracingEnvFromEnv(env);
  if (tracingEnv.mode === 'off') return false;
  // No endpoint yet is fine where the host collector is installed but
  // termag-otelcol-env hasn't rendered its config: the exporter waits for it
  // (tracing/exporter.ts). Anywhere else, no endpoint means no tracer.
  const setup = otelSetup(env);
  if (!setup && !collectorExpected(env)) return false;
  const basePath = env.BASE_PATH ?? '';
  try {
    initTracingState(tracingEnv);
    const exporter = new ScrubbingExporter(new DeferredTraceExporter(
      () => otelSetup(env)?.config.endpoint,
      (endpoint) => new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    ));
    provider = new NodeTracerProvider({
      resource: otelResource(env),
      sampler: new KillSwitchSampler(),
      spanProcessors: [
        new ErrorDescriptionProcessor(),
        new TraceBufferProcessor({
          basePath,
          next: new BatchSpanProcessor(exporter, {
            maxQueueSize: 2048, maxExportBatchSize: 512, scheduledDelayMillis: 5000, exportTimeoutMillis: 10_000,
          }),
        }),
      ],
      spanLimits: { attributeValueLengthLimit: 2048, attributeCountLimit: 64, eventCountLimit: 64 },
    });
    // Trace context only, no baggage: an incoming baggage header would be
    // forwarded to GitHub, Slack and AWS.
    provider.register({ propagator: new CredentialedParentPropagator(new W3CTraceContextPropagator()) });
    registerInstrumentations({
      tracerProvider: provider,
      // The instrumentations' own duration metrics stay off on purpose, not
      // because otel.ts happens to register its meter provider later.
      meterProvider: noopMeterProvider,
      instrumentations: [
        new HttpInstrumentation({
          ignoreIncomingRequestHook: (req) => ignoredRequest(req.method, req.url, basePath),
          ignoreOutgoingRequestHook: (opts) => opts.hostname === IMDS_HOST || opts.host === IMDS_HOST,
          requireParentforOutgoingSpans: true,
          startIncomingSpanHook: (req: IncomingMessage) => (isPoll(req.url) ? { 'termag.poll': true } : {}),
        }),
        // Routers stay instrumented: an ignored router's mount path stays in
        // the route when a request falls through it, so routers sharing a
        // prefix doubled or lost http.route. TraceBufferProcessor drops their
        // spans, which end as they start.
        new ExpressInstrumentation({ ignoreLayersType: [ExpressLayerType.MIDDLEWARE] }),
        new PgInstrumentation({ enhancedDatabaseReporting: false, requireParentSpan: true, ignoreConnectSpans: true }),
        // With connect spans off, pg's instrumentation leaves a queued connect
        // callback in the releaser's context; this binds it to the caller's.
        new PgPoolContextInstrumentation(),
        new UndiciInstrumentation({ requireParentforSpans: true, ignoreRequestHook: (req) => req.origin.includes(IMDS_HOST) }),
        new AwsInstrumentation({ suppressInternalInstrumentation: true }),
      ],
    });
    markTracingRegistered();
    onOtelShutdown(() => provider?.shutdown());
    const decidedBy = tracingSource() === 'env' ? `TERMAG_TRACING, rate ${tracingEnv.rate}` : 'flags, recording nothing until they answer';
    const where = setup ? `${setup.config.endpoint} (${setup.config.source})` : 'the host collector, once termag-otelcol has rendered its config';
    console.log(`[TRACING] tracer registered, exporting to ${where}; decided by ${decidedBy}`);
    return true;
  } catch (err) {
    console.warn('[TRACING] could not start the tracer; continuing without:', (err as Error).message);
    provider = null;
    trace.disable();
    context.disable();
    propagation.disable();
    return false;
  }
}

initTracing();
