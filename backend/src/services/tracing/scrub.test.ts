import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ROOT_CONTEXT, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { describeError, ErrorDescriptionProcessor, reduceStack, ScrubbingExporter, scrubSpan } from './scrub';

const BACKEND = join(__dirname, '..', '..', '..');

// Every token shape deploy/termag-otelcol.yaml's transform/redact masks: none
// may leave the process through a span, whatever attribute it hides in. The
// JWT, the AWS key id and the database URL are assembled here, so the secret
// scanner doesn't take the fixture for a leak.
const TOKENS = [
  'tmag_abcdefghijklmnop',
  'Bearer abcdefghijklmnopqrstuvwxyz0123',
  ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlLXZhbHVl'].join('.'),
  'xoxb-1234567890-abcdefghij',
  'sdk-12345678-1234-1234-1234-123456789abc',
  'ghp_abcdefghijklmnopqrstuvwxyz0123',
  'sk-ant-abcdefghijklmnop',
  ['AKIA', 'ABCDEFGHIJKLMNOP'].join(''),
  ['postgres://app', 'hunter2secret@db.internal:5432/termag'].join(':'),
  '?token=querysecret123',
  // Preview links (SR11): a link token in the landing path, and a reverify ticket.
  '/termag/previews/my-app/abcdefghijklmnopqrstuv',
  '?ticket=ticketsecret123',
  // The landing page's next=, an app URL percent-encoded (its code= isn't a query name there).
  '?next=%2Fcb%3Fcode%3Dnextsecret123',
  'authorization: headersecret123',
  // A preview box confirmation's id in its two paths (the key to its sealed share URL).
  '/termag/previews/confirm/AbcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
];
const CHAT = 'please deploy with password correct-horse-battery-staple';

function provider() {
  const exporter = new InMemorySpanExporter();
  const p = new BasicTracerProvider({
    spanProcessors: [new ErrorDescriptionProcessor(), new SimpleSpanProcessor(new ScrubbingExporter(exporter))],
  });
  return { tracer: p.getTracer('test'), exported: () => exporter.getFinishedSpans() };
}

/** Everything a span would export, as one string, for "does X appear anywhere". */
const flatten = (s: ReadableSpan) => JSON.stringify({ name: s.name, attributes: s.attributes, events: s.events, status: s.status });

class PrismaClientValidationError extends Error {
  name = 'PrismaClientValidationError';
}

describe('describeError', () => {
  it('is the type and a code from a known field, never the message', () => {
    expect(describeError(Object.assign(new Error(`Unique constraint failed: ${CHAT}`), { name: 'PrismaClientKnownRequestError', code: 'P2002' }))).toBe('PrismaClientKnownRequestError P2002');
    expect(describeError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', syscall: 'read' }))).toBe('Error ECONNRESET');
    expect(describeError(Object.assign(new SyntaxError(`Unexpected token in JSON at position 3: ${CHAT}`), { type: 'entity.parse.failed', status: 400 }))).toBe('SyntaxError entity.parse.failed');
    expect(describeError(Object.assign(new Error(`Not Found: ${CHAT}`), { name: 'HttpError', status: 404 }))).toBe('HttpError 404');
    expect(describeError(Object.assign(new Error('x'), { name: 'ThrottlingException', $metadata: { httpStatusCode: 429 } }))).toBe('ThrottlingException 429');
    expect(describeError(new PrismaClientValidationError(`Argument data: ${CHAT}`))).toBe('PrismaClientValidationError');
    expect(describeError(CHAT)).toBe('Error');
  });

  it('drops a code that is not code-shaped, and a type that is not an identifier', () => {
    expect(describeError(Object.assign(new Error('x'), { code: 'has spaces in it' }))).toBe('Error');
    expect(describeError(Object.assign(new Error('x'), { name: 'Error: chat text' }))).toBe('Error');
  });
});

describe('reduceStack', () => {
  it('keeps frames only, reduced, without the header or message lines', () => {
    const stack = [
      `Error: ${CHAT}`,
      `second line of the message ${TOKENS[0]}`,
      `    at handler (${join(BACKEND, 'src', 'routes', 'chat.ts')}:12:5)`,
      `    at async Layer.handle [as handle_request] (${join(BACKEND, 'node_modules', 'express', 'lib', 'router', 'layer.js')}:95:5)`,
      '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
      `    at weird name (${CHAT}) (/etc/passwd:1:1)`,
      `    at ${join(BACKEND, 'dist', 'index.js')}:1:2`,
    ].join('\n');
    expect(reduceStack(stack)).toBe([
      'at handler (src/routes/chat.ts:12:5)',
      'at Layer.handle (node_modules/express/lib/router/layer.js:95:5)',
      'at process.processTicksAndRejections (<external>)',
      'at <anonymous> (<external>)',
      'at <anonymous> (dist/index.js:1:2)',
    ].join('\n'));
  });

  it('keeps at most 32 frames', () => {
    const stack = ['Error: x', ...Array.from({ length: 50 }, (_, i) => `    at f${i} (${BACKEND}/src/a.ts:${i}:1)`)].join('\n');
    expect(reduceStack(stack)!.split('\n')).toHaveLength(32);
  });
});

describe('ErrorDescriptionProcessor and ScrubbingExporter', () => {
  it('exports no message text from an exception or a status', () => {
    const { tracer, exported } = provider();
    const span = tracer.startSpan('POST /api/x', { kind: SpanKind.SERVER }, ROOT_CONTEXT);
    const errors = [
      new PrismaClientValidationError(`Invalid \`prisma.chatMessage.create()\` invocation:\n{ data: { body: "${CHAT}" } }`),
      Object.assign(new SyntaxError(`Unexpected token } in JSON at position 10: {"text":"${CHAT}"}`), { type: 'entity.parse.failed' }),
      Object.assign(new Error(`Validation Failed: {"title":"${CHAT}"}`), { name: 'HttpError', status: 422 }),
      new Error(`line one ${CHAT}\nline two ${TOKENS.join(' ')}`),
    ];
    for (const err of errors) span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: errors[3].message });
    span.end();
    const [out] = exported();
    const text = flatten(out);
    expect(text).not.toContain('correct-horse');
    expect(text).not.toContain('line two');
    for (const t of TOKENS) expect(text).not.toContain(t);
    expect(out.events.map(e => e.attributes?.['exception.message'])).toEqual([
      'PrismaClientValidationError', 'SyntaxError entity.parse.failed', 'HttpError 422', 'Error',
    ]);
    expect(out.status).toEqual({ code: SpanStatusCode.ERROR, message: 'Error' });
    expect(String(out.events[0].attributes?.['exception.stacktrace'])).toMatch(/^at /);
  });

  it('rebuilds an exception event it did not describe from its type alone', () => {
    const span = {
      name: 'x', attributes: {}, status: { code: SpanStatusCode.ERROR, message: CHAT },
      events: [{ name: 'exception', time: [0, 0], attributes: { 'exception.type': 'TypeError', 'exception.message': CHAT, 'exception.stacktrace': `TypeError: ${CHAT}` } }],
    } as unknown as ReadableSpan;
    const out = scrubSpan(span);
    expect(out.events[0].attributes).toEqual({ 'exception.type': 'TypeError', 'exception.message': 'TypeError' });
    expect(out.status).toEqual({ code: SpanStatusCode.ERROR });
  });
});

describe('scrubSpan', () => {
  const span = (attributes: Record<string, unknown>) => ({ name: 'GET', attributes, events: [], status: { code: 0 } }) as unknown as ReadableSpan;

  it('keeps only the literal poll=1 of a query', () => {
    expect(scrubSpan(span({ 'url.query': `poll=1&token=${TOKENS[0]}` })).attributes['url.query']).toBe('poll=1');
    expect(scrubSpan(span({ 'url.query': `code=abc&state=def` })).attributes).not.toHaveProperty('url.query');
    // An allowlisted key with any other value carries that value nowhere.
    expect(scrubSpan(span({ 'url.query': 'poll=hunter2secret' })).attributes).not.toHaveProperty('url.query');
    expect(scrubSpan(span({ 'url.query': 'poll=1x&poll=1' })).attributes['url.query']).toBe('poll=1');
  });

  it('drops a query pair whose key is a malformed escape, rather than throwing', () => {
    expect(scrubSpan(span({ 'url.query': '%ZZ=1&poll=1' })).attributes['url.query']).toBe('poll=1');
    expect(scrubSpan(span({ 'url.query': '%E0%A4%A=secret' })).attributes).not.toHaveProperty('url.query');
  });

  it('exports the rest of a batch when one span cannot be scrubbed, and never that span as it was', () => {
    const sent: ReadableSpan[][] = [];
    const inner = { export: (spans: ReadableSpan[], done: (r: { code: number }) => void) => { sent.push(spans); done({ code: 0 }); }, shutdown: async () => {} };
    const broken = { name: 'GET', events: [], status: { code: 0 }, get attributes(): never { throw new Error('unreadable'); } } as unknown as ReadableSpan;
    const results: number[] = [];
    new ScrubbingExporter(inner).export([span({ 'url.query': '%ZZ=1' }), broken, span({ 'url.query': 'poll=1' })], r => results.push(r.code));
    expect(sent).toHaveLength(1);
    expect(sent[0].map(s => s.attributes['url.query'])).toEqual([undefined, 'poll=1']);
    expect(results).toEqual([0]);
  });

  it('cuts outbound URLs to scheme, host and a plain first segment, with no credentials, query or later path', () => {
    expect(scrubSpan(span({ 'url.full': `https://user:pw@api.github.com/repos/x?access_token=${TOKENS[5]}#frag` })).attributes['url.full']).toBe('https://api.github.com/repos/:path');
    expect(scrubSpan(span({ 'url.full': 'https://api.github.com/user' })).attributes['url.full']).toBe('https://api.github.com/user');
    expect(scrubSpan(span({ 'url.full': 'https://api.github.com' })).attributes['url.full']).toBe('https://api.github.com/');
    // A token in the path itself, even an all-lowercase one: a Slack incoming webhook.
    const webhook = scrubSpan(span({ 'http.url': 'https://hooks.slack.com/services/T0ABC/B0DEF/abcdefghijklmnopqrstuvwx' }));
    expect(webhook.attributes['http.url']).toBe('https://hooks.slack.com/services/:path');
    // A token as the first segment (a bot API's /bot<token>/…).
    expect(scrubSpan(span({ 'url.full': 'https://api.example.test/bot123456:AbCdEf/sendMessage' })).attributes['url.full']).toBe('https://api.example.test/:path');
  });

  it('replaces a routed path with its template, and names the termag objects in it', () => {
    const out = scrubSpan(span({
      'url.path': '/termag/api/projects/cmvuuymwg1wyhf932tow0rw5x/workstreams/cmvuuymwg1wyhf932tow0rw5y',
      'http.route': '/termag/api/projects/:id/workstreams/:wid',
    }));
    expect(out.attributes['url.path']).toBe('/termag/api/projects/:id/workstreams/:wid');
    expect(out.attributes['termag.project']).toBe('cmvuuymwg1wyhf932tow0rw5x');
    expect(out.attributes['termag.workstream']).toBe('cmvuuymwg1wyhf932tow0rw5y');
    const share = scrubSpan(span({ 'url.path': '/termag/p/sharekey-abcdefghijklmnopqrstuvwxyz', 'http.route': '/termag/p/:key' }));
    expect(flatten(share)).not.toContain('sharekey');
  });

  it('keeps only the known leading segments of an unrouted path, whatever follows', () => {
    expect(scrubSpan(span({ 'url.path': '/termag/p/sharekey-abcdefghijklmnopqrstuvwxyz/x' })).attributes['url.path']).toBe('/termag/p/:unrouted');
    // A short credential is no safer than a long one.
    expect(scrubSpan(span({ 'url.path': '/termag/api/shortkey9/projects' })).attributes['url.path']).toBe('/termag/api/:unrouted');
    expect(scrubSpan(span({ 'url.path': '/termag/api/projects/cmvuuymwg1wyhf932tow0rw5x' })).attributes['url.path']).toBe('/termag/api/:unrouted');
    expect(scrubSpan(span({ 'url.path': '/' })).attributes['url.path']).toBe('/');
  });

  it('removes client addresses and truncates SQL', () => {
    const out = scrubSpan(span({ 'client.address': '10.0.0.1', 'network.peer.address': '10.0.0.2', 'db.query.text': 'x'.repeat(3000) }));
    expect(out.attributes).not.toHaveProperty('client.address');
    expect(out.attributes).not.toHaveProperty('network.peer.address');
    expect(String(out.attributes['db.query.text'])).toHaveLength(2048);
  });

  it('carries no token shape the collector redacts, in any attribute it rewrites', () => {
    const out = scrubSpan(span({
      'url.query': TOKENS.map((t, i) => `k${i}=${encodeURIComponent(t)}`).join('&'),
      'url.full': `https://example.test/x?${TOKENS.map((t, i) => `k${i}=${encodeURIComponent(t)}`).join('&')}`,
      'url.path': `/termag/api/${encodeURIComponent(TOKENS[2])}`,
    }));
    const text = flatten(out);
    for (const t of TOKENS) expect(text).not.toContain(encodeURIComponent(t));
  });

  it('covers every pattern the collector redacts with the token fixture', () => {
    // A pattern added to transform/redact needs a token here too.
    const yaml = readFileSync(join(BACKEND, '..', 'deploy', 'termag-otelcol.yaml'), 'utf8');
    const patterns = [...yaml.matchAll(/replace_pattern\(log\.body, "((?:[^"\\]|\\.)*)"/g)].map(m => m[1]);
    expect(patterns.length).toBeGreaterThanOrEqual(10);
    for (const raw of patterns) {
      const source = raw.replace(/\\(.)/g, '$1');
      const insensitive = source.startsWith('(?i)');
      const re = new RegExp(source.replace(/^\(\?i\)/, ''), insensitive ? 'i' : '');
      expect(TOKENS.some(t => re.test(t)), `no token in the fixture matches ${raw}`).toBe(true);
    }
  });
});
