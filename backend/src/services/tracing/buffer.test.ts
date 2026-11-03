import { describe, expect, it } from 'vitest';
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, TraceFlags, type Context } from '@opentelemetry/api';
import { BasicTracerProvider, type ReadableSpan, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { decide, DECISION_CAP, ENTRY_CAP, rateFor, stripBasePath, TraceBufferProcessor, BUFFER_MAX_AGE_MS, type DecisionInput } from './buffer';
import { DEFAULT_SAMPLING, parseSamplingConfig, type SamplingConfig } from './state';

// The tech spec's example config ("Sampling").
const SAMPLED = parseSamplingConfig({
  default: 10,
  keepErrors: true,
  slowMs: 3000,
  rules: [
    { poll: true, rate: 0 },
    { method: 'POST', route: '/api/status/heartbeat', rate: 0 },
    { method: 'POST', route: '/api/warp/sample', rate: 0 },
    { method: 'GET', route: '/api/visits/recent', rate: 0 },
    { method: 'GET', routePrefix: '/api/worktime', rate: 0 },
    { routePrefix: '/internal/', rate: 0 },
    { method: 'POST', route: '/api/status', rate: 100 },
    { method: 'GET', routePrefix: '/api/cli/v1/boxes', rate: 50 },
    { namePrefix: 'termag.sweep.', rate: 20 },
  ],
});

function setup(config: SamplingConfig, opts: { random?: () => number; now?: () => number } = {}) {
  // What the buffer hands on, kept past shutdown (an in-memory exporter forgets at shutdown).
  const spans: ReadableSpan[] = [];
  const next: SpanProcessor = {
    onStart() {}, onEnd(s) { spans.push(s); }, forceFlush: async () => {}, shutdown: async () => {},
  };
  const exporter = { getFinishedSpans: () => spans };
  const buffer = new TraceBufferProcessor({ next, basePath: '/termag', config: () => config, ...opts });
  const provider = new BasicTracerProvider({ spanProcessors: [buffer] });
  const tracer = provider.getTracer('test');
  const exported = () => exporter.getFinishedSpans().map(s => s.name);
  return { exporter, buffer, tracer, exported };
}

type Tracer = ReturnType<typeof setup>['tracer'];

/** A server entry, as the http instrumentation leaves it at the response's end. */
function request(tracer: Tracer, opts: { method?: string; route?: string; status?: number; poll?: boolean; parent?: Context } = {}) {
  const entry = tracer.startSpan('GET', { kind: SpanKind.SERVER }, opts.parent ?? ROOT_CONTEXT);
  const ctx = trace.setSpan(ROOT_CONTEXT, entry);
  const child = (name: string, parent: Context = ctx) => tracer.startSpan(name, {}, parent);
  const finish = () => {
    entry.setAttributes({
      'http.request.method': opts.method ?? 'GET',
      'http.response.status_code': opts.status ?? 200,
      ...(opts.route && { 'http.route': `/termag${opts.route}` }),
      ...(opts.poll && { 'termag.poll': true }),
    });
    entry.updateName(`${opts.method ?? 'GET'} /termag${opts.route ?? ''}`);
    entry.end();
  };
  return { entry, ctx, child, finish };
}

const input = (over: Partial<DecisionInput> = {}): DecisionInput => ({ name: 'GET', poll: false, error: false, durationMs: 5, ...over });

describe('rateFor and decide', () => {
  it('takes the first matching rule, else the default', () => {
    expect(rateFor(input({ route: '/api/status', method: 'POST' }), SAMPLED)).toBe(100);
    expect(rateFor(input({ route: '/api/status', method: 'GET' }), SAMPLED)).toBe(10);
    expect(rateFor(input({ route: '/internal/mcp-authz/c/:id', method: 'POST' }), SAMPLED)).toBe(0);
    expect(rateFor(input({ route: '/api/cli/v1/boxes/:id', method: 'GET' }), SAMPLED)).toBe(50);
    expect(rateFor(input({ name: 'termag.sweep.power' }), SAMPLED)).toBe(20);
    expect(rateFor(input({ route: '/api/projects/:id' }), SAMPLED)).toBe(10);
  });

  it('tells a poller from a person by poll, on the same route', () => {
    expect(rateFor(input({ route: '/api/prs', poll: true }), SAMPLED)).toBe(0);
    expect(rateFor(input({ route: '/api/prs', poll: false }), SAMPLED)).toBe(10);
  });

  it('drops the four pollers that send no poll=1 by their routes', () => {
    expect(rateFor(input({ route: '/api/status/heartbeat', method: 'POST' }), SAMPLED)).toBe(0);
    expect(rateFor(input({ route: '/api/warp/sample', method: 'POST' }), SAMPLED)).toBe(0);
    expect(rateFor(input({ route: '/api/visits/recent', method: 'GET' }), SAMPLED)).toBe(0);
    expect(rateFor(input({ route: '/api/worktime', method: 'GET' }), SAMPLED)).toBe(0);
  });

  it('keeps errors and slow entries whatever their rate, and slowMs 0 keeps no slow one', () => {
    const errorsOnly = parseSamplingConfig({ default: 0, keepErrors: true, slowMs: 0 });
    expect(decide(input({ error: true }), errorsOnly)).toEqual({ keep: true, ratio: 1 });
    expect(decide(input({ durationMs: 60_000 }), errorsOnly).keep).toBe(false);
    expect(decide(input({ durationMs: 3000 }), SAMPLED, () => 0.99)).toEqual({ keep: true, ratio: 1 });
    expect(decide(input({ error: true }), { ...SAMPLED, keepErrors: false }, () => 0.99).keep).toBe(false);
  });

  it('lets a rule\'s own slowMs replace the top-level one, after errors', () => {
    const config = parseSamplingConfig({
      default: 10, keepErrors: true, slowMs: 3000,
      rules: [
        { namePrefix: 'termag.sweep.software', rate: 20, slowMs: 0 },
        { namePrefix: 'termag.sweep.', rate: 20, slowMs: 30_000 },
      ],
    });
    const never = () => 0.99;
    // slowMs 0 on the rule: a slow sweep is decided by the rule's rate.
    expect(decide(input({ name: 'termag.sweep.software', durationMs: 120_000 }), config, never)).toEqual({ keep: false, ratio: 20 });
    // A higher slowMs: kept only beyond it.
    expect(decide(input({ name: 'termag.sweep.pr-ingest', durationMs: 8000 }), config, never)).toEqual({ keep: false, ratio: 20 });
    expect(decide(input({ name: 'termag.sweep.pr-ingest', durationMs: 30_000 }), config, never)).toEqual({ keep: true, ratio: 1 });
    // A request under no rule with slowMs still uses the top-level value.
    expect(decide(input({ route: '/api/projects/:id', durationMs: 3000 }), config, never)).toEqual({ keep: true, ratio: 1 });
    expect(decide(input({ route: '/api/projects/:id', durationMs: 2999 }), config, never)).toEqual({ keep: false, ratio: 10 });
    // Errors are kept first, whatever the rule says about slowness.
    expect(decide(input({ name: 'termag.sweep.software', error: true }), config, never)).toEqual({ keep: true, ratio: 1 });
  });

  it('uses a rule\'s slowMs at shutdown too', async () => {
    let now = 0;
    const config = parseSamplingConfig({ default: 0, slowMs: 1000, rules: [{ namePrefix: 'termag.sweep.', rate: 0, slowMs: 60_000 }] });
    const { tracer, buffer, exported } = setup(config, { now: () => now });
    const tick = tracer.startSpan('termag.sweep.lifecycle', {}, ROOT_CONTEXT);
    tracer.startSpan('scan', {}, trace.setSpan(ROOT_CONTEXT, tick)).end();
    now = 5000; // past the top-level 1 s, short of the rule's 60 s
    await buffer.shutdown();
    expect(exported()).toEqual([]);
  });

  it('draws 1 in N', () => {
    expect(decide(input(), SAMPLED, () => 0.05)).toEqual({ keep: true, ratio: 10 });
    expect(decide(input(), SAMPLED, () => 0.5)).toEqual({ keep: false, ratio: 10 });
    expect(decide(input(), { ...DEFAULT_SAMPLING, default: 1 }, () => 0.999)).toEqual({ keep: true, ratio: 1 });
  });

  it('matches routes with BASE_PATH stripped, and without one', () => {
    expect(stripBasePath('/termag/api/status', '/termag')).toBe('/api/status');
    expect(stripBasePath('/termag', '/termag')).toBe('/');
    expect(stripBasePath('/api/status', '')).toBe('/api/status');
    expect(stripBasePath('/termagx/api', '/termag')).toBe('/termagx/api');
  });
});

describe('TraceBufferProcessor', () => {
  it('decides when the entry ends, for every span under it', () => {
    const { tracer, exported } = setup({ ...DEFAULT_SAMPLING, default: 1 });
    const r = request(tracer, { route: '/api/projects/:id' });
    const db = r.child('pg.query');
    const grandchild = r.child('prisma', trace.setSpan(ROOT_CONTEXT, db));
    grandchild.end();
    db.end();
    expect(exported()).toEqual([]);
    r.finish();
    expect(exported()).toEqual(['prisma', 'pg.query', 'GET /termag/api/projects/:id']);
  });

  it('drops a whole entry its rule drops, children included', () => {
    const { tracer, exported } = setup(SAMPLED, { random: () => 0 });
    const r = request(tracer, { method: 'POST', route: '/internal/mcp-authz/c/:id' });
    r.child('pg.query').end();
    r.finish();
    expect(exported()).toEqual([]);
  });

  it('marks kept spans with the ratio they were kept at', () => {
    const { tracer, exporter } = setup(SAMPLED, { random: () => 0 });
    const r = request(tracer, { route: '/api/projects/:id' });
    r.child('pg.query').end();
    r.finish();
    expect(exporter.getFinishedSpans().map(s => s.attributes['termag.sampling.ratio'])).toEqual([10, 10]);
  });

  it('keeps an entry that failed itself or answered a 5xx, not one that handled a child\'s error', () => {
    const { tracer, exported } = setup(parseSamplingConfig({ default: 0, keepErrors: true, slowMs: 0 }));
    // A caught Prisma P2002 and an outbound 4xx: the request still answered 200.
    const handled = request(tracer, { route: '/api/handled' });
    const caught = handled.child('prisma:Project.create');
    caught.recordException(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));
    caught.setStatus({ code: SpanStatusCode.ERROR });
    caught.end();
    const outbound = handled.child('GET');
    outbound.setStatus({ code: SpanStatusCode.ERROR });
    outbound.end();
    handled.finish();
    const answered5xx = request(tracer, { route: '/api/b', status: 503 });
    answered5xx.finish();
    const threw = request(tracer, { route: '/api/c' });
    threw.entry.recordException(new Error('boom'));
    threw.finish();
    const quiet = request(tracer, { route: '/api/d' });
    quiet.finish();
    expect(exported()).toEqual(['GET /termag/api/b', 'GET /termag/api/c']);
  });

  it('neither buffers nor counts an Express router\'s span', () => {
    const { tracer, exported } = setup(parseSamplingConfig({ default: 1, keepErrors: true, slowMs: 0 }));
    const a = request(tracer, { route: '/api/a' });
    tracer.startSpan('router - /termag/api', { attributes: { 'express.type': 'router' } }, a.ctx).end();
    a.child('request handler - /termag/api/a').end();
    a.finish();
    expect(exported()).toEqual(['request handler - /termag/api/a', 'GET /termag/api/a']);
  });

  it('applies a decision to children that end after their entry', () => {
    const { tracer, exported } = setup({ ...DEFAULT_SAMPLING, default: 1 });
    const r = request(tracer, { route: '/api/x' });
    const late = r.child('after res.json');
    r.finish();
    late.end();
    expect(exported()).toEqual(['GET /termag/api/x', 'after res.json']);
  });

  it('decides two entries with the same remote trace id apart', () => {
    let draw = 0;
    const { tracer, exporter } = setup({ ...DEFAULT_SAMPLING, default: 2 }, { random: () => [0, 0.9][draw++] });
    const remote = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331', traceFlags: TraceFlags.SAMPLED, isRemote: true,
    });
    const kept = request(tracer, { route: '/api/mine', parent: remote });
    const other = request(tracer, { route: '/api/theirs', parent: remote });
    kept.child('mine').end();
    other.child('theirs').end();
    kept.finish();
    other.finish();
    const names = exporter.getFinishedSpans().map(s => s.name);
    expect(names).toEqual(['mine', 'GET /termag/api/mine']);
    expect(exporter.getFinishedSpans().every(s => s.spanContext().traceId === '0af7651916cd43dd8448eb211c80319c')).toBe(true);
  });

  it('marks an entry that continued a remote parent', () => {
    const { tracer, exporter } = setup({ ...DEFAULT_SAMPLING, default: 1 });
    const remote = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331', traceFlags: TraceFlags.SAMPLED, isRemote: true,
    });
    request(tracer, { route: '/api/x', parent: remote }).finish();
    request(tracer, { route: '/api/y' }).finish();
    expect(exporter.getFinishedSpans().map(s => s.attributes['termag.parent.remote'])).toEqual([true, undefined]);
  });

  it('drops spans with no entry: a root CLIENT span and its children', () => {
    const { tracer, exported } = setup({ ...DEFAULT_SAMPLING, default: 1 });
    const aws = tracer.startSpan('EC2.DescribeInstances', { kind: SpanKind.CLIENT }, ROOT_CONTEXT);
    tracer.startSpan('child', {}, trace.setSpan(ROOT_CONTEXT, aws)).end();
    aws.end();
    expect(exported()).toEqual([]);
  });

  it('takes a manual termag.* root as an entry', () => {
    const { tracer, exported } = setup({ ...DEFAULT_SAMPLING, default: 1 });
    const tick = tracer.startSpan('termag.sweep.power', {}, ROOT_CONTEXT);
    tracer.startSpan('EC2.DescribeInstances', { kind: SpanKind.CLIENT }, trace.setSpan(ROOT_CONTEXT, tick)).end();
    tick.end();
    expect(exported()).toEqual(['EC2.DescribeInstances', 'termag.sweep.power']);
  });

  it('drops an entry past its span cap', () => {
    const { tracer, exported } = setup({ ...DEFAULT_SAMPLING, default: 1 });
    const r = request(tracer, { route: '/api/x' });
    for (let i = 0; i <= ENTRY_CAP; i++) r.child(`q${i}`).end();
    r.finish();
    expect(exported()).toEqual([]);
  });

  it('keeps an open entry while more spans than DECISION_CAP start and end around it', () => {
    const { tracer, exported } = setup({ ...DEFAULT_SAMPLING, default: 1 });
    const long = request(tracer, { route: '/api/long' });
    for (let i = 0; i < DECISION_CAP; i++) {
      const r = request(tracer, { route: '/api/x' });
      r.child('q').end();
      r.finish();
    }
    long.child('late').end();
    long.finish();
    expect(exported().slice(-2)).toEqual(['late', 'GET /termag/api/long']);
  });

  it('drops a buffer older than its age cap', () => {
    let now = 0;
    const { tracer, exported } = setup({ ...DEFAULT_SAMPLING, default: 1 }, { now: () => now });
    const old = request(tracer, { route: '/api/stream' });
    old.child('chunk').end();
    now = BUFFER_MAX_AGE_MS + 1;
    request(tracer, { route: '/api/new' }).finish(); // any start sweeps
    old.finish();
    expect(exported()).toEqual(['GET /termag/api/new']);
  });

  it('decides open buffers at shutdown, before the next processor exports', async () => {
    let now = 0;
    const { tracer, buffer, exported } = setup(parseSamplingConfig({ default: 0, keepErrors: true, slowMs: 1000 }), { now: () => now });
    const threw = request(tracer, { route: '/api/a' });
    threw.entry.recordException(new Error('boom'));
    threw.child('pg.query').end();
    const slow = request(tracer, { route: '/api/b' });
    slow.child('chunk').end();
    now = 1500;
    // A child's error doesn't keep an open entry either; only the entry's own.
    const handled = request(tracer, { route: '/api/c' });
    const bad = handled.child('fast');
    bad.setStatus({ code: SpanStatusCode.ERROR });
    bad.end();
    await buffer.shutdown();
    expect(exported()).toEqual(['pg.query', 'chunk']);
  });

  it('leaves open buffers alone on forceFlush', async () => {
    const { tracer, buffer, exported } = setup({ ...DEFAULT_SAMPLING, default: 1 });
    const r = request(tracer, { route: '/api/x' });
    r.child('q').end();
    await buffer.forceFlush();
    expect(exported()).toEqual([]);
    r.finish();
    expect(exported()).toEqual(['q', 'GET /termag/api/x']);
  });
});
