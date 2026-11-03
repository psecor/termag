// The OTLP trace exporter, made once the endpoint is known (services/otel.ts,
// otelSetup). On an orchestrator host, termag-otelcol-env renders the
// collector's config while the backend starts, so it can be missing when
// services/tracing.ts registers at import. Until it appears, spans are dropped
// and counted, and the endpoint is looked up again at most every 10 s.
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { countDrop } from './buffer';

export const ENDPOINT_RECHECK_MS = 10_000;

export class DeferredTraceExporter implements SpanExporter {
  private inner: SpanExporter | null = null;
  private nextCheck = 0;

  constructor(
    private readonly endpoint: () => string | undefined,
    private readonly make: (endpoint: string) => SpanExporter,
    private readonly now: () => number = Date.now,
  ) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const inner = this.resolve();
    if (!inner) {
      countDrop('no-endpoint', spans.length);
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }
    inner.export(spans, resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner?.shutdown() ?? Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return this.inner?.forceFlush?.() ?? Promise.resolve();
  }

  private resolve(): SpanExporter | null {
    if (this.inner || this.now() < this.nextCheck) return this.inner;
    this.nextCheck = this.now() + ENDPOINT_RECHECK_MS;
    const endpoint = this.endpoint();
    if (endpoint) {
      this.inner = this.make(endpoint);
      console.log(`[TRACING] exporting traces to ${endpoint}`);
    }
    return this.inner;
  }
}
