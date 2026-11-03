// Manual spans for the work that isn't a request: a sweep's tick, a Slack or Discord listener,
// an awaited box agent RPC.
//
// rootSpan starts a trace of its own, over a context with no span in it: a
// timer, a Bolt socket or a discord.js gateway runs in whatever context it
// was created in, which can be an old request's, and the tick must not join
// that trace. Its name is `termag.*`, so TraceBufferProcessor takes it as an
// entry and decides it on its own when it ends; the pg, Prisma, AWS and HTTP
// calls under it are traced as its children (their instrumentations record
// nothing without a parent).
//
// withSpan is a child of the active span, and nothing where there is none:
// a `termag.*` span with no parent would be an entry of its own, and an
// unwrapped caller's RPC would become a trace of one span.
//
// failRoot marks the running root span (a sweep's tick, a bot listener) as
// failed, for an error the code catches and logs instead of throwing:
// TraceBufferProcessor keeps an entry for its own error only, not a child's.
//
// Every helper just runs `fn` when no tracer is registered (dev, tests, e2e,
// TERMAG_TRACING=off), and keeps `fn`'s shape: a synchronous `fn` stays
// synchronous, a throw stays a throw, a promise is returned as one. The
// attributes pass ScrubbingExporter unchanged, so callers give ids and enums
// only, never user text.
import { context, createContextKey, INVALID_SPAN_CONTEXT, ROOT_CONTEXT, SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';
import { tracingRegistered } from './state';

const TRACER = 'termag';
const NOOP_SPAN: Span = trace.wrapSpanContext(INVALID_SPAN_CONTEXT);
const ROOT_SPAN = createContextKey('termag.tracing.root-span');

// Looked up per span rather than held: a tracer from the global API outlives
// a trace.disable() and would stay a no-op after (prismaSpans.test.ts).
const tracer = () => trace.getTracer(TRACER);

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  v !== null && (typeof v === 'object' || typeof v === 'function') && typeof (v as { then?: unknown }).then === 'function';

function fail(span: Span, err: unknown): void {
  span.recordException(err instanceof Error ? err : String(err));
  span.setStatus({ code: SpanStatusCode.ERROR });
}

/** Run `fn` in `span`, ending it when `fn` returns or settles; a throw or rejection is recorded and passed on. */
function run<T>(span: Span, fn: (span: Span) => T): T {
  let result: T;
  try {
    result = fn(span);
  } catch (err) {
    fail(span, err);
    span.end();
    throw err;
  }
  if (!isThenable(result)) {
    span.end();
    return result;
  }
  return Promise.resolve(result).then(
    (value) => { span.end(); return value; },
    (err: unknown) => { fail(span, err); span.end(); throw err; },
  ) as T;
}

/** A child of the active span around `fn`; just `fn` with no active span or no tracer. */
export function withSpan<T>(name: string, attrs: Attributes, fn: (span: Span) => T): T {
  if (!tracingRegistered() || !trace.getActiveSpan()) return fn(NOOP_SPAN);
  return tracer().startActiveSpan(name, { attributes: attrs }, (span) => run(span, fn));
}

/** A new trace around `fn`, whatever context the caller is in. Name it `termag.*`, or the trace buffer drops it as "no entry". */
export function rootSpan<T>(name: string, attrs: Attributes, fn: (span: Span) => T): T {
  if (!tracingRegistered()) return fn(NOOP_SPAN);
  // ROOT_CONTEXT, not context.active() with the span deleted: nothing a
  // request left in the context (its RPC metadata) carries over either.
  return tracer().startActiveSpan(name, { root: true, attributes: attrs }, ROOT_CONTEXT, (span) =>
    context.with(context.active().setValue(ROOT_SPAN, span), () => run(span, fn)));
}

/** Mark the running rootSpan as failed for an error that is caught and logged, not thrown; nothing outside one. */
export function failRoot(err: unknown): void {
  const span = context.active().getValue(ROOT_SPAN) as Span | undefined;
  if (span?.isRecording()) fail(span, err);
}

let leaderProbe: (() => boolean) | null = null;

/** Whether this process holds the orchestrator lease (index.ts: the drain's isServing), for `termag.leader` on each tick. */
export function setSweepLeaderProbe(probe: (() => boolean) | null): void {
  leaderProbe = probe;
}

/**
 * `tick` with each call in a root span `termag.sweep.<name>`, the name the
 * sampling flag's `namePrefix: termag.sweep.` rule matches. For the loops
 * that tick every 30 s or slower; the faster ones stay untraced (the tech
 * spec's volume estimate).
 */
export function traceSweep<A extends unknown[], R>(name: string, tick: (...args: A) => R): (...args: A) => R {
  const spanName = `termag.sweep.${name}`;
  return (...args: A) => {
    if (!tracingRegistered()) return tick(...args);
    let leader: boolean | undefined;
    try { leader = leaderProbe?.(); } catch { leader = undefined; }
    return rootSpan(spanName, leader === undefined ? {} : { 'termag.leader': leader }, () => tick(...args));
  };
}
