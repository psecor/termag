// What leaves the process. Two halves:
//
// - ErrorDescriptionProcessor, first in the provider's list, wraps each
//   span's recordException and setStatus as it starts. Then the recorded
//   message is a fixed description made from the error object itself (its
//   type, and a code from a field known to hold one), and the stack is
//   reduced to frames, before any text reaches the span.
// - ScrubbingExporter maps every exported span through scrubSpan: query
//   strings, URLs, paths, client addresses, SQL length, and, as the backstop,
//   any exception or status message the processor didn't describe.
//
// The host collector's transform/redact-spans repeats the token patterns
// (deploy/termag-otelcol.yaml); the container has no collector, so this side
// has to be complete on its own.
import { join, relative, sep } from 'path';
import type { Attributes, AttributeValue, Context, SpanStatus } from '@opentelemetry/api';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, Span, SpanExporter, SpanProcessor, TimedEvent } from '@opentelemetry/sdk-trace-base';
import { countDrop } from './buffer';

const BACKEND_ROOT = join(__dirname, '..', '..', '..');
const CODE = /^[A-Za-z0-9_.-]{1,48}$/;
const TYPE = /^[A-Za-z_$][A-Za-z0-9_$.]{0,63}$/;
const FUNCTION = /^[A-Za-z_$<][A-Za-z0-9_$.<>]{0,127}$/;
const MAX_FRAMES = 32;
/** The only query pairs kept in url.query, literally: a key's other values could carry anything. */
const QUERY_KEPT_PAIRS = new Set(['poll=1']);
/** Path segments an unrouted server path keeps, from its start; the first other segment and the rest become `:unrouted`. */
const UNROUTED_PREFIXES = new Set(['termag', 'api', 'auth', 'internal', 'mcp', 'oauth', 'p', 'files', 'cli', 'v1']);
/**
 * The one outbound path segment kept: the first, when it is a short plain
 * word (`repos`, `services`, `api`). Nothing tells an id, a key or a token in
 * a later segment (a Slack webhook's) from a word, so the rest is `:path`.
 */
const OUTBOUND_FIRST_SEGMENT = /^[a-z][a-z_-]{0,15}$/;
const CUID = /^c[a-z0-9]{20,31}$/;
/** The route parameters that name a termag object, by the path segment before them. */
const PARAM_ATTRIBUTES: Record<string, string> = {
  projects: 'termag.project', instances: 'termag.box', boxes: 'termag.box', workstreams: 'termag.workstream',
};

/** The error's type: its name, or its constructor's, when it looks like an identifier. */
function errorType(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { name?: unknown; constructor?: { name?: unknown } };
    for (const candidate of [e.name, e.constructor?.name]) {
      if (typeof candidate === 'string' && TYPE.test(candidate) && candidate !== 'Object') return candidate;
    }
  }
  return 'Error';
}

/** A code from a field known to hold one: Prisma's or Node's `code`, body-parser's `type`, an HTTP status. */
function errorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { code?: unknown; type?: unknown; status?: unknown; statusCode?: unknown; $metadata?: { httpStatusCode?: unknown } };
  const candidates = [
    e.code,
    e.type,
    typeof e.status === 'number' ? String(e.status) : undefined,
    typeof e.statusCode === 'number' ? String(e.statusCode) : undefined,
    typeof e.$metadata?.httpStatusCode === 'number' ? String(e.$metadata.httpStatusCode) : undefined,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && CODE.test(c)) return c;
  }
  return undefined;
}

/** `PrismaClientKnownRequestError P2002`, `Error ECONNRESET`, `SyntaxError entity.parse.failed`, `HttpError 404`, or the type alone. Never message text. */
export function describeError(err: unknown): string {
  const type = typeof err === 'string' ? 'Error' : errorType(err);
  const code = errorCode(err);
  return code ? `${type} ${code}` : type;
}

function frameLocation(raw: string): string {
  const m = /^(.*):(\d+):(\d+)$/.exec(raw.trim());
  if (!m) return '<external>';
  let path = m[1];
  if (path.startsWith('file://')) path = path.slice('file://'.length);
  if (!path.startsWith('/')) return '<external>';
  const rel = relative(BACKEND_ROOT, path);
  if (rel.startsWith('..') || rel.startsWith(sep)) return '<external>';
  return `${rel.split(sep).join('/')}:${m[2]}:${m[3]}`;
}

/**
 * Frames only: the `<type>: <message>` header, and every message line before
 * the first frame, are dropped. Each frame keeps an identifier-like function
 * name and a location under backend/ (node_modules included), else
 * `<anonymous>` and `<external>`.
 */
export function reduceStack(stack: unknown): string | undefined {
  if (typeof stack !== 'string') return undefined;
  const frames: string[] = [];
  for (const line of stack.split('\n')) {
    const m = /^\s*at (.*)$/.exec(line);
    if (!m) continue;
    let body = m[1].trim().replace(/^async /, '').replace(/^new /, '');
    let fn = '<anonymous>';
    let loc = body;
    const paren = /^(.*?) \((.*)\)$/.exec(body);
    if (paren) {
      const name = paren[1].replace(/ \[as [A-Za-z0-9_$]+\]$/, '');
      fn = FUNCTION.test(name) ? name : '<anonymous>';
      loc = paren[2];
    }
    body = `at ${fn} (${frameLocation(loc)})`;
    frames.push(body);
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames.length ? frames.join('\n') : undefined;
}

/** The exception event attributes for an error: its description and its reduced stack, nothing else. */
export function exceptionAttributes(err: unknown): Attributes {
  const attrs: Attributes = {
    'exception.type': typeof err === 'string' ? 'Error' : errorType(err),
    'exception.message': describeError(err),
  };
  const stack = reduceStack(err && typeof err === 'object' ? (err as { stack?: unknown }).stack : undefined);
  if (stack) attrs['exception.stacktrace'] = stack;
  return attrs;
}

// Exception events whose attributes ErrorDescriptionProcessor made; any other
// is rebuilt from its type alone at export.
const described = new WeakSet<object>();
const statusDescription = new WeakMap<object, string>();

export class ErrorDescriptionProcessor implements SpanProcessor {
  onStart(span: Span, _ctx: Context): void {
    // The SDK's own recordException would copy the message and the raw stack.
    const setStatus = span.setStatus.bind(span);
    span.recordException = (exception, time) => {
      const attrs = exceptionAttributes(exception);
      statusDescription.set(span, attrs['exception.message'] as string);
      span.addEvent('exception', attrs, time);
      const events = (span as unknown as ReadableSpan).events;
      const last = events[events.length - 1];
      if (last) described.add(last);
    };
    span.setStatus = (status: SpanStatus) => {
      if (status.message !== undefined) status = { code: status.code, message: statusDescription.get(span) ?? 'Error' };
      return setStatus(status);
    };
  }
  onEnd(): void {}
  forceFlush(): Promise<void> { return Promise.resolve(); }
  shutdown(): Promise<void> { return Promise.resolve(); }
}

function scrubEvent(event: TimedEvent): TimedEvent {
  if (event.name !== 'exception' || described.has(event)) return event;
  const type = event.attributes?.['exception.type'];
  const t = typeof type === 'string' && TYPE.test(type) ? type : 'Error';
  return { ...event, attributes: { 'exception.type': t, 'exception.message': t } };
}

/** Only the literal pairs in QUERY_KEPT_PAIRS; nothing is decoded, so a malformed escape (`%ZZ`, which HTTP lets through) is just dropped. */
function scrubQuery(query: string): string | undefined {
  const kept = query.replace(/^\?/, '').split('&').filter(pair => QUERY_KEPT_PAIRS.has(pair));
  return kept.length ? kept.join('&') : undefined;
}

/** scheme://host[:port], its first path segment when that is a plain word, and `:path` for anything after; no credentials, query or fragment. */
function scrubUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const [first, ...rest] = u.pathname.split('/').filter(Boolean);
    if (first === undefined) return `${u.protocol}//${u.host}/`;
    if (!OUTBOUND_FIRST_SEGMENT.test(first)) return `${u.protocol}//${u.host}/:path`;
    return `${u.protocol}//${u.host}/${first}${rest.length ? '/:path' : ''}`;
  } catch {
    return '<invalid url>';
  }
}

/** The route template's parameters that name a termag object, as attributes, when their value is a cuid. */
function paramAttributes(path: string, route: string): Attributes {
  const attrs: Attributes = {};
  const p = path.split('/');
  const r = route.split('/');
  if (p.length !== r.length) return attrs;
  for (let i = 1; i < r.length; i++) {
    const name = PARAM_ATTRIBUTES[r[i - 1]];
    if (name && r[i].startsWith(':') && CUID.test(p[i])) attrs[name] = p[i];
  }
  return attrs;
}

/**
 * A path with no route: only its known leading segments (UNROUTED_PREFIXES)
 * are kept, and everything from the first other one is `:unrouted`. Any
 * segment past them could be a credential, however short.
 */
function scrubPath(path: string): string {
  const kept: string[] = [];
  for (const s of path.split('/').filter(Boolean)) {
    if (!UNROUTED_PREFIXES.has(s)) {
      kept.push(':unrouted');
      break;
    }
    kept.push(s);
  }
  return `/${kept.join('/')}`;
}

/** A copy of `span` safe to export. Pure. */
export function scrubSpan(span: ReadableSpan): ReadableSpan {
  const attributes: Record<string, AttributeValue | undefined> = { ...span.attributes };
  delete attributes['client.address'];
  delete attributes['network.peer.address'];
  delete attributes['net.peer.ip'];
  delete attributes['http.client_ip'];
  if (typeof attributes['url.query'] === 'string') {
    const q = scrubQuery(attributes['url.query']);
    if (q) attributes['url.query'] = q;
    else delete attributes['url.query'];
  }
  for (const key of ['url.full', 'http.url']) {
    if (typeof attributes[key] === 'string') attributes[key] = scrubUrl(attributes[key] as string);
  }
  if (typeof attributes['url.path'] === 'string') {
    const route = attributes['http.route'];
    if (typeof route === 'string') {
      Object.assign(attributes, paramAttributes(attributes['url.path'] as string, route));
      attributes['url.path'] = route;
    } else {
      attributes['url.path'] = scrubPath(attributes['url.path'] as string);
    }
  }
  if (typeof attributes['db.query.text'] === 'string' && (attributes['db.query.text'] as string).length > 2048) {
    attributes['db.query.text'] = (attributes['db.query.text'] as string).slice(0, 2048);
  }
  const events = span.events.map(scrubEvent);
  // A status message is kept only when it is one of this span's exception descriptions.
  let status = span.status;
  if (status.message !== undefined) {
    const descriptions = new Set(events.filter(e => e.name === 'exception').map(e => e.attributes?.['exception.message']));
    status = descriptions.has(status.message) ? status : { code: status.code };
  }
  return Object.create(span, {
    attributes: { value: attributes as Attributes, enumerable: true },
    events: { value: events, enumerable: true },
    status: { value: status, enumerable: true },
  }) as ReadableSpan;
}

export class ScrubbingExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  // A span scrubSpan can't rewrite is never exported as it was; it's dropped
  // and counted, and the rest of its batch goes out.
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const safe: ReadableSpan[] = [];
    let failed = 0;
    for (const span of spans) {
      try {
        safe.push(scrubSpan(span));
      } catch {
        failed++;
      }
    }
    if (failed) countDrop('scrub-failed', failed);
    this.inner.export(safe, resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}
