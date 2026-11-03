import { beforeEach, describe, expect, it, vi } from 'vitest';
import { context, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, type ReadableSpan, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { Prisma } from '@prisma/client';
import { TraceBufferProcessor } from './buffer';
import { DEFAULT_SAMPLING, parseSamplingConfig, type SamplingConfig } from './state';

// Whether a tracer counts as registered, per test (services/tracing.ts sets it once in production).
const registered = vi.hoisted(() => ({ value: true }));
vi.mock('./state', async (orig) => ({ ...(await orig<typeof import('./state')>()), tracingRegistered: () => registered.value }));

const { failRoot, rootSpan, setSweepLeaderProbe, traceSweep, withSpan } = await import('./spans');
const { installOperationSpans } = await import('./prismaSpans');

// One global provider for the file, with the real buffer in front of a
// recorder: the helpers and prismaSpans.ts take their tracers from the
// global API (trace.disable() would orphan prismaSpans.ts's).
const exported: ReadableSpan[] = [];
let config: SamplingConfig = { ...DEFAULT_SAMPLING, default: 1 };
let draw = 0.5;
const recorder: SpanProcessor = { onStart() {}, onEnd(s) { exported.push(s); }, forceFlush: async () => {}, shutdown: async () => {} };
const provider = new BasicTracerProvider({
  spanProcessors: [new TraceBufferProcessor({ next: recorder, config: () => config, random: () => draw })],
});
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
trace.setGlobalTracerProvider(provider);
const tracer = provider.getTracer('test');

beforeEach(() => {
  exported.length = 0;
  config = { ...DEFAULT_SAMPLING, default: 1 };
  draw = 0.5;
  registered.value = true;
  setSweepLeaderProbe(null);
});

const names = () => exported.map(s => s.name);
const byName = (name: string) => exported.filter(s => s.name === name);

describe('traceSweep', () => {
  it('makes each tick an entry of its own, decided apart: an error kept, a quiet tick dropped at rate 0', async () => {
    config = parseSamplingConfig({ default: 1, keepErrors: true, slowMs: 0, rules: [{ namePrefix: 'termag.sweep.', rate: 0 }] });
    let n = 0;
    const tick = traceSweep('lifecycle', async () => {
      tracer.startSpan('EC2.DescribeInstances', { kind: SpanKind.CLIENT }).end();
      if (++n === 1) throw new Error('describe failed');
    });
    await expect(tick()).rejects.toThrow('describe failed');
    await tick();
    expect(names()).toEqual(['EC2.DescribeInstances', 'termag.sweep.lifecycle']);
    const [, sweep] = exported;
    expect(sweep.parentSpanContext).toBeUndefined();
    expect(sweep.status.code).toBe(SpanStatusCode.ERROR);
    expect(sweep.events.map(e => e.name)).toEqual(['exception']);
  });

  it('samples ticks by the flag\'s namePrefix rule, one draw per tick', async () => {
    config = parseSamplingConfig({ default: 1, keepErrors: true, slowMs: 0, rules: [{ namePrefix: 'termag.sweep.', rate: 20 }] });
    const tick = traceSweep('lifecycle', async () => {});
    draw = 0.01; await tick();
    draw = 0.9; await tick();
    expect(names()).toEqual(['termag.sweep.lifecycle']);
    expect(exported[0].attributes['termag.sampling.ratio']).toBe(20);
  });

  it('starts a new trace when the tick runs inside a request, and its spans are the tick\'s, not the request\'s', async () => {
    let middleware: Prisma.Middleware | null = null;
    installOperationSpans({ $use: (mw: Prisma.Middleware) => { middleware = mw; } } as never);
    const tick = traceSweep('provisioning', async () => {
      await middleware!({ model: 'Instance', action: 'updateMany', args: {}, dataPath: [], runInTransaction: false }, async () => {
        tracer.startSpan('pg.query:UPDATE termag', { kind: SpanKind.CLIENT }).end(); // what pg would record under Prisma's span
        return { count: 0 };
      });
      tracer.startSpan('EC2.DescribeInstances', { kind: SpanKind.CLIENT }).end();
    });
    const request = tracer.startSpan('GET /api/x', { kind: SpanKind.SERVER }, ROOT_CONTEXT);
    await context.with(trace.setSpan(ROOT_CONTEXT, request), () => tick());
    request.end();

    const [sweep] = byName('termag.sweep.provisioning');
    const [server] = byName('GET /api/x');
    expect(sweep.parentSpanContext).toBeUndefined();
    expect(sweep.spanContext().traceId).not.toBe(server.spanContext().traceId);
    const [prisma] = byName('prisma:Instance.updateMany');
    const [pg] = byName('pg.query:UPDATE termag');
    const [aws] = byName('EC2.DescribeInstances');
    expect(prisma.parentSpanContext?.spanId).toBe(sweep.spanContext().spanId);
    expect(pg.parentSpanContext?.spanId).toBe(prisma.spanContext().spanId);
    expect(aws.parentSpanContext?.spanId).toBe(sweep.spanContext().spanId);
    for (const s of [prisma, pg, aws]) expect(s.spanContext().traceId).toBe(sweep.spanContext().traceId);
    // The request was decided on its own, with nothing of the tick's in it.
    expect(exported.filter(s => s.spanContext().traceId === server.spanContext().traceId).map(s => s.name)).toEqual(['GET /api/x']);
  });

  it('says whether this process held the lease, when index.ts has said how to tell', async () => {
    await traceSweep('ask', async () => {})();
    setSweepLeaderProbe(() => true);
    await traceSweep('ask', async () => {})();
    setSweepLeaderProbe(() => { throw new Error('no drain yet'); });
    await traceSweep('ask', async () => {})();
    expect(exported.map(s => s.attributes['termag.leader'])).toEqual([undefined, true, undefined]);
  });

  it('keeps a synchronous tick synchronous, and its throw a throw', () => {
    const value = traceSweep('chat-status', () => 3)();
    expect(value).toBe(3);
    expect(() => traceSweep('chat-status', () => { throw new Error('sync'); })()).toThrow('sync');
    expect(names()).toEqual(['termag.sweep.chat-status', 'termag.sweep.chat-status']);
    expect(exported[1].status.code).toBe(SpanStatusCode.ERROR);
  });

  it('passes the tick\'s arguments through', async () => {
    const seen: unknown[] = [];
    await traceSweep('x', async (a: number, b: string) => { seen.push(a, b); })(1, 'b');
    expect(seen).toEqual([1, 'b']);
  });
});

describe('failRoot', () => {
  it('keeps a tick whose step failed and was only logged, even from under a child span', async () => {
    config = parseSamplingConfig({ default: 0, keepErrors: true, slowMs: 0 });
    const quiet = traceSweep('quiet', async () => {
      await Promise.reject(new Error('handled')).catch(() => {});
    });
    const logged = traceSweep('logged', async () => {
      await withSpan('termag.box.rpc', {}, async () => {
        await Promise.reject(new Error('step failed')).catch(err => failRoot(err));
      });
    });
    await quiet();
    await logged();
    expect(names()).toEqual(['termag.box.rpc', 'termag.sweep.logged']);
    expect(byName('termag.sweep.logged')[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(byName('termag.box.rpc')[0].status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('does nothing outside a root span', () => {
    expect(() => failRoot(new Error('no sweep'))).not.toThrow();
    const span = tracer.startSpan('GET', { kind: SpanKind.SERVER });
    context.with(trace.setSpan(ROOT_CONTEXT, span), () => failRoot(new Error('in a request')));
    span.end();
    expect(byName('GET')[0].status.code).not.toBe(SpanStatusCode.ERROR);
  });
});

describe('rootSpan and withSpan', () => {
  it('rootSpan is a root even under an active span, and leaves none of the old context behind', async () => {
    const request = tracer.startSpan('GET /api/x', { kind: SpanKind.SERVER }, ROOT_CONTEXT);
    const key = Symbol('left by the request');
    const outer = trace.setSpan(ROOT_CONTEXT, request).setValue(key, 'x');
    let inner: unknown = 'unset';
    await context.with(outer, () => rootSpan('termag.slack.command', {}, async () => { inner = context.active().getValue(key); }));
    request.end();
    expect(inner).toBeUndefined();
    const [root] = byName('termag.slack.command');
    expect(root.parentSpanContext).toBeUndefined();
    expect(root.spanContext().traceId).not.toBe(request.spanContext().traceId);
  });

  it('withSpan is a child of the active span and records a rejection', async () => {
    await rootSpan('termag.sweep.box-update', {}, async () => {
      await expect(withSpan('termag.box.rpc', { 'termag.rpc.method': 'box-update' }, async () => { throw new Error('no'); })).rejects.toThrow('no');
    });
    const [rpc] = byName('termag.box.rpc');
    const [sweep] = byName('termag.sweep.box-update');
    expect(rpc.parentSpanContext?.spanId).toBe(sweep.spanContext().spanId);
    expect(rpc.status.code).toBe(SpanStatusCode.ERROR);
    expect(rpc.attributes['termag.rpc.method']).toBe('box-update');
  });

  it('withSpan opens nothing without an active span: it would be an entry of its own', async () => {
    expect(await withSpan('termag.box.rpc', {}, async () => 7)).toBe(7);
    expect(names()).toEqual([]);
  });
});

describe('with no tracer registered', () => {
  it('runs every helper\'s fn and exports nothing', async () => {
    registered.value = false;
    const calls: string[] = [];
    expect(await traceSweep('lifecycle', async () => { calls.push('tick'); return 1; })()).toBe(1);
    expect(traceSweep('chat-status', () => { calls.push('sync'); return 2; })()).toBe(2);
    expect(await rootSpan('termag.slack.event', {}, async (span) => { calls.push('root'); return span.isRecording(); })).toBe(false);
    await rootSpan('termag.sweep.x', {}, async () => {
      expect(await withSpan('termag.box.rpc', {}, async () => { calls.push('rpc'); return 3; })).toBe(3);
    });
    await expect(traceSweep('y', async () => { throw new Error('still thrown'); })()).rejects.toThrow('still thrown');
    expect(calls).toEqual(['tick', 'sync', 'root', 'rpc']);
    expect(names()).toEqual([]);
  });
});
