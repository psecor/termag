import { describe, expect, it, vi } from 'vitest';
import { ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { DeferredTraceExporter, ENDPOINT_RECHECK_MS } from './exporter';

const spans = [{ name: 'GET' }] as unknown as ReadableSpan[];

function setup() {
  let endpoint: string | undefined;
  let now = 0;
  const inner = { export: vi.fn((_s: ReadableSpan[], done: (r: { code: number }) => void) => done({ code: ExportResultCode.SUCCESS })), shutdown: vi.fn(async () => {}) };
  const make = vi.fn((_e: string) => inner as unknown as SpanExporter);
  const exporter = new DeferredTraceExporter(() => endpoint, make, () => now);
  return { exporter, inner, make, setEndpoint: (e: string) => { endpoint = e; }, advance: (ms: number) => { now += ms; } };
}

describe('DeferredTraceExporter', () => {
  it('drops spans, reporting success, while there is no endpoint, and starts exporting once one appears', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { exporter, inner, make, setEndpoint, advance } = setup();
    const results: number[] = [];
    exporter.export(spans, r => results.push(r.code));
    expect(results).toEqual([ExportResultCode.SUCCESS]);
    expect(make).not.toHaveBeenCalled();

    setEndpoint('http://127.0.0.1:4318');
    // Looked up again at most every ENDPOINT_RECHECK_MS.
    exporter.export(spans, () => {});
    expect(make).not.toHaveBeenCalled();
    advance(ENDPOINT_RECHECK_MS);
    exporter.export(spans, () => {});
    expect(make).toHaveBeenCalledWith('http://127.0.0.1:4318');
    expect(inner.export).toHaveBeenCalledTimes(1);

    exporter.export(spans, () => {});
    expect(make).toHaveBeenCalledTimes(1);
    expect(inner.export).toHaveBeenCalledTimes(2);
  });

  it('shuts down cleanly with or without an exporter', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const none = setup();
    await expect(none.exporter.shutdown()).resolves.toBeUndefined();
    const some = setup();
    some.setEndpoint('http://127.0.0.1:4318');
    some.exporter.export(spans, () => {});
    await some.exporter.shutdown();
    expect(some.inner.shutdown).toHaveBeenCalled();
  });
});
