// TraceBufferProcessor: which recorded spans are exported, decided once per
// local entry span when it ends.
//
// An entry is a span with no local parent (no parent, or a remote one such as
// the browser's traceparent) of kind SERVER or named `termag.*`: one request,
// or one background run, in this process. Every other span belongs to its
// local parent's entry. Spans are buffered per entry, never per trace id, so
// two callers that send the same trace id are decided apart. When the entry
// ends, its route, status, duration and errors are known (Express sets the
// route only as the response closes), and one decision covers the whole
// buffer. The decision is kept for a while for children that end later.
//
// An error is the entry's own: a 5xx, or the entry span marked as an error or
// holding an exception. A child's error that the entry handled (an outbound
// 4xx, a caught Prisma P2002) doesn't keep the trace.
import { metrics, SpanKind, SpanStatusCode, type Attributes, type Context, type Counter, type MeterProvider } from '@opentelemetry/api';
import { hrTimeToMilliseconds } from '@opentelemetry/core';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { samplingConfig, type SamplingConfig, type SamplingRule } from './state';

export const ENTRY_CAP = 256;
export const TOTAL_CAP = 20_000;
export const BUFFER_MAX_AGE_MS = 2 * 60_000;
export const DECISION_CAP = 10_000;
export const DECISION_TTL_MS = 5 * 60_000;
// Span id → entry mappings. One per span, not per entry, and every span still
// buffered needs its own, so the map has to outgrow TOTAL_CAP: evicting an
// open entry's mapping would drop all of its spans as "no entry".
export const ENTRY_MAP_CAP = 2 * TOTAL_CAP + DECISION_CAP;

/** What an entry's decision is made from. */
export interface DecisionInput {
  name: string;
  /** http.route with BASE_PATH stripped, when the entry is a routed request. */
  route?: string;
  method?: string;
  poll: boolean;
  error: boolean;
  durationMs: number;
}

/** 0 drop, 1 keep, N keep 1 in N; `ratio` is the N a kept entry was kept at. */
export interface Decision {
  keep: boolean;
  ratio: number;
}

/** The first rule that matches the entry, if any. Pure. */
export function matchRule(input: DecisionInput, config: SamplingConfig): SamplingRule | undefined {
  for (const rule of config.rules) {
    if (rule.method !== undefined && rule.method !== (input.method ?? '').toUpperCase()) continue;
    if (rule.route !== undefined && rule.route !== input.route) continue;
    if (rule.routePrefix !== undefined && !(input.route ?? '').startsWith(rule.routePrefix)) continue;
    if (rule.name !== undefined && rule.name !== input.name) continue;
    if (rule.namePrefix !== undefined && !input.name.startsWith(rule.namePrefix)) continue;
    if (rule.poll !== undefined && rule.poll !== input.poll) continue;
    return rule;
  }
  return undefined;
}

/** The first matching rule's rate, else the default. Pure. */
export function rateFor(input: DecisionInput, config: SamplingConfig): number {
  return matchRule(input, config)?.rate ?? config.default;
}

/**
 * Errors, then slowness, then the rules and a draw. Pure but for `random`.
 * The matching rule's own slowMs, when it has one, replaces the top-level
 * one, so slow-by-design work (a sweep fanning out RPCs to every box) isn't
 * kept on every run.
 */
export function decide(input: DecisionInput, config: SamplingConfig, random: () => number = Math.random): Decision {
  if (input.error && config.keepErrors) return { keep: true, ratio: 1 };
  const rule = matchRule(input, config);
  const slowMs = rule?.slowMs ?? config.slowMs;
  if (slowMs > 0 && input.durationMs >= slowMs) return { keep: true, ratio: 1 };
  const rate = rule ? rule.rate : config.default;
  if (rate === 0) return { keep: false, ratio: 0 };
  return { keep: rate === 1 || random() < 1 / rate, ratio: rate };
}

/** The route as rules name it: `/termag/api/status` is `/api/status` under BASE_PATH `/termag`. */
export function stripBasePath(route: string | undefined, basePath: string): string | undefined {
  if (!route || !basePath) return route;
  if (route === basePath) return '/';
  return route.startsWith(`${basePath}/`) ? route.slice(basePath.length) : route;
}

const failed = (s: ReadableSpan) => s.status.code === SpanStatusCode.ERROR || s.events.some(e => e.name === 'exception');

/** An Express router's span: it ends as it starts and parents nothing (tracing.ts keeps routers instrumented for the route only). */
const isRouter = (s: { attributes: Attributes }) => s.attributes['express.type'] === 'router';

interface Buffer {
  entry: Span;
  startedAt: number;
  spans: ReadableSpan[];
}

export interface TraceBufferOptions {
  next: SpanProcessor;
  basePath?: string;
  config?: () => SamplingConfig;
  random?: () => number;
  now?: () => number;
}

export type DropReason = 'no-entry' | 'entry-cap' | 'total-cap' | 'expired' | 'shutdown' | 'scrub-failed' | 'no-endpoint';

let dropCounter: { provider: MeterProvider; counter: Counter } | null = null;
/** termag.tracing.dropped{reason}, through whatever meter provider otel.ts has registered by now; ScrubbingExporter counts here too. */
export function countDrop(reason: DropReason, n: number): void {
  const provider = metrics.getMeterProvider();
  if (dropCounter?.provider !== provider) {
    dropCounter = {
      provider,
      counter: provider.getMeter('termag-tracing').createCounter('termag.tracing.dropped', {
        description: 'Spans the trace buffer dropped before deciding them, by reason',
      }),
    };
  }
  dropCounter.counter.add(n, { reason });
}

/** A copy of `span` with extra attributes; the original is ended and can't take them. */
function withAttributes(span: ReadableSpan, extra: Attributes): ReadableSpan {
  return Object.create(span, { attributes: { value: { ...span.attributes, ...extra }, enumerable: true } }) as ReadableSpan;
}

export class TraceBufferProcessor implements SpanProcessor {
  private readonly next: SpanProcessor;
  private readonly basePath: string;
  private readonly config: () => SamplingConfig;
  private readonly random: () => number;
  private readonly now: () => number;
  /** Span id → its entry's span id. Insertion-ordered, so the oldest go first. */
  private readonly entryOf = new Map<string, { entry: string; at: number }>();
  /** Open buffers by entry span id, in the order the entries started. */
  private readonly buffers = new Map<string, Buffer>();
  /** Decided entries by span id. */
  private readonly decisions = new Map<string, { decision: Decision; at: number }>();
  private buffered = 0;
  private closed = false;

  constructor(opts: TraceBufferOptions) {
    this.next = opts.next;
    this.basePath = opts.basePath ?? '';
    this.config = opts.config ?? samplingConfig;
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
  }

  onStart(span: Span, parentContext: Context): void {
    this.next.onStart(span, parentContext);
    if (isRouter(span)) return;
    const id = span.spanContext().spanId;
    const now = this.now();
    this.expire(now);
    const parent = span.parentSpanContext;
    if (!parent || parent.isRemote) {
      if (span.kind !== SpanKind.SERVER && !span.name.startsWith('termag.')) return; // no entry: dropped at its end
      if (parent?.isRemote) span.setAttribute('termag.parent.remote', true);
      this.remember(id, id, now);
      this.buffers.set(id, { entry: span, startedAt: now, spans: [] });
      return;
    }
    const entry = this.entryOf.get(parent.spanId)?.entry;
    if (entry) this.remember(id, entry, now);
  }

  onEnd(span: ReadableSpan): void {
    if (this.closed || isRouter(span)) return;
    const id = span.spanContext().spanId;
    const entry = this.entryOf.get(id)?.entry;
    if (!entry) {
      countDrop('no-entry', 1);
      return;
    }
    const decided = this.decisions.get(entry);
    if (decided) {
      if (decided.decision.keep) this.forward(span, decided.decision);
      return;
    }
    const buffer = this.buffers.get(entry);
    if (!buffer) {
      // Its buffer was dropped by a cap; that decision covers this span too.
      countDrop('expired', 1);
      return;
    }
    if (buffer.spans.length >= ENTRY_CAP) {
      this.drop(entry, buffer, 'entry-cap', 1);
      return;
    }
    if (this.buffered >= TOTAL_CAP) {
      this.drop(entry, buffer, 'total-cap', 1);
      return;
    }
    buffer.spans.push(span);
    this.buffered++;
    if (id === entry) this.settle(entry, buffer, this.inputFor(span, span.duration ? hrTimeToMilliseconds(span.duration) : 0));
  }

  /** Spans already decided go out; open buffers stay, since their requests are still running. */
  forceFlush(): Promise<void> {
    return this.next.forceFlush();
  }

  /** Decide every open buffer as though its entry ended now, hand the kept spans on, then shut the next processor down. */
  async shutdown(): Promise<void> {
    const now = this.now();
    for (const [entry, buffer] of [...this.buffers]) {
      const e = buffer.entry as unknown as ReadableSpan;
      this.settle(entry, buffer, this.inputFor(e, now - buffer.startedAt));
    }
    this.closed = true;
    await this.next.shutdown();
  }

  private inputFor(entry: ReadableSpan, durationMs: number): DecisionInput {
    const a = entry.attributes;
    const status = a['http.response.status_code'];
    const route = typeof a['http.route'] === 'string' ? stripBasePath(a['http.route'], this.basePath) : undefined;
    const method = typeof a['http.request.method'] === 'string' ? a['http.request.method'] : undefined;
    return {
      name: entry.name,
      route,
      method,
      poll: a['termag.poll'] === true,
      error: (typeof status === 'number' && status >= 500) || failed(entry),
      durationMs,
    };
  }

  private settle(entry: string, buffer: Buffer, input: DecisionInput): void {
    const decision = decide(input, this.config(), this.random);
    this.buffers.delete(entry);
    this.buffered -= buffer.spans.length;
    this.decisions.set(entry, { decision, at: this.now() });
    if (this.decisions.size > DECISION_CAP) this.decisions.delete(this.decisions.keys().next().value!);
    if (decision.keep) for (const s of buffer.spans) this.forward(s, decision);
  }

  private forward(span: ReadableSpan, decision: Decision): void {
    this.next.onEnd(withAttributes(span, { 'termag.sampling.ratio': decision.ratio }));
  }

  private drop(entry: string, buffer: Buffer, reason: DropReason, extra: number): void {
    this.buffers.delete(entry);
    this.buffered -= buffer.spans.length;
    this.decisions.set(entry, { decision: { keep: false, ratio: 0 }, at: this.now() });
    countDrop(reason, buffer.spans.length + extra);
  }

  private remember(id: string, entry: string, now: number): void {
    this.entryOf.set(id, { entry, at: now });
    if (this.entryOf.size > ENTRY_MAP_CAP) this.entryOf.delete(this.entryOf.keys().next().value!);
  }

  /** Drops buffers past their age and forgets old mappings and decisions; all three maps are in age order. */
  private expire(now: number): void {
    for (const [entry, buffer] of this.buffers) {
      if (now - buffer.startedAt < BUFFER_MAX_AGE_MS) break;
      this.drop(entry, buffer, 'expired', 0);
    }
    for (const [id, { at }] of this.decisions) {
      if (now - at < DECISION_TTL_MS) break;
      this.decisions.delete(id);
    }
    for (const [id, { at }] of this.entryOf) {
      if (now - at < DECISION_TTL_MS) break;
      this.entryOf.delete(id);
    }
  }
}
