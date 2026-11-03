// Child-process fixture for tracing.test.ts: the real tracer and
// instrumentations (services/tracing.ts, TERMAG_TRACING=on at rate 1) in
// front of a small Express app, exporting to an OTLP/HTTP sink in this
// process. Run by tsx, so the instrumentations patch through require as they
// do in production. Prints one JSON line: every span the sink received.
import { createServer, request, type IncomingHttpHeaders } from 'http';
import type { AddressInfo } from 'net';
import { BOX, CHAT, PROJECT, REMOTE_TRACE, SHARE_KEY, TOKEN, USER } from './e2eValues';
const traceparent = `00-${REMOTE_TRACE}-b7ad6b7169203331-01`;

interface OtlpValue { stringValue?: string; intValue?: string | number; boolValue?: boolean; doubleValue?: number }
interface OtlpSpan {
  name: string; traceId: string; spanId: string; parentSpanId?: string;
  attributes?: { key: string; value: OtlpValue }[];
  events?: { name: string; attributes?: { key: string; value: OtlpValue }[] }[];
  status?: { code?: number; message?: string };
}
const flat = (attrs: { key: string; value: OtlpValue }[] = []) =>
  Object.fromEntries(attrs.map(a => [a.key, a.value.stringValue ?? a.value.boolValue ?? a.value.intValue ?? a.value.doubleValue]));

const received: OtlpSpan[] = [];
const sink = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const parsed = JSON.parse(body) as { resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[] };
    for (const rs of parsed.resourceSpans) for (const ss of rs.scopeSpans) received.push(...ss.spans);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});

function call(port: number, method: string, path: string, headers: IncomingHttpHeaders = {}, body?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

sink.listen(0, '127.0.0.1', () => {
  const sinkPort = (sink.address() as AddressInfo).port;
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${sinkPort}`;
  process.env.TERMAG_TRACING = 'on';
  process.env.TERMAG_TRACING_RATE = '1';
  process.env.BASE_PATH = '/termag';
  delete process.env.TERMAG_OTEL;
  /* eslint-disable @typescript-eslint/no-require-imports */
  require('../../tracing');
  const { shutdownOtel } = require('../../otel') as typeof import('../../otel');
  const express = require('express') as typeof import('express');
  const { apiErrorHandler } = require('../../../middleware/errors') as typeof import('../../../middleware/errors');
  const { surfaceMiddleware } = require('../../requestSurface') as typeof import('../../requestSurface');
  const { serverSpanMiddleware, setServerSpanAttributes } = require('../requestSpan') as typeof import('../requestSpan');
  /* eslint-enable @typescript-eslint/no-require-imports */

  const app = express();
  app.use('/termag', serverSpanMiddleware);
  app.use('/termag', surfaceMiddleware);
  app.get('/termag/p/:key', (_req, res) => { res.send('shared'); });
  app.get('/termag/api/x', (_req, res) => { res.json({ ok: true }); });
  // A route-level step, like requireAuth: its active span is the handler's, the attribute must land on the server span.
  app.get('/termag/api/projects/:id', (req, _res, next) => { setServerSpanAttributes(req, { 'termag.user': USER }); next(); }, (_req, res) => { res.json({ ok: true }); });
  app.post('/termag/api/boom', express.json(), (_req, _res, next) => { next(new Error(`could not save: ${CHAT}\nsecond line ${TOKEN}`)); });
  // Routers sharing a prefix, as index.ts mounts them: a request falls
  // through the first CLI router into the second, and through an /api router
  // into one mounted below it.
  const ok = (_req: unknown, res: { json(b: unknown): void }) => { res.json({ ok: true }); };
  const cliFirst = express.Router();
  cliFirst.get('/whoami', ok);
  const cliSecond = express.Router();
  cliSecond.get('/boxes', ok);
  cliSecond.get('/boxes/:id', ok);
  const api = express.Router();
  api.get('/elsewhere', ok);
  const visits = express.Router();
  visits.get('/recent', ok);
  app.use('/termag/api/cli/v1', cliFirst);
  app.use('/termag/api/cli/v1', cliSecond);
  app.use('/termag/api', api);
  app.use('/termag/api/visits', visits);
  app.use(apiErrorHandler);
  const server = app.listen(0, '127.0.0.1', async () => {
    const port = (server.address() as AddressInfo).port;
    const statuses = {
      share: await call(port, 'GET', `/termag/p/${SHARE_KEY}?token=${TOKEN}`),
      poll: await call(port, 'GET', '/termag/api/x?poll=1', { 'x-termag-client': 'web/abcdef1' }),
      forged: await call(port, 'GET', `/termag/api/projects/${PROJECT}`, { traceparent }),
      credentialed: await call(port, 'GET', '/termag/api/x', { traceparent, authorization: 'Bearer whatever' }),
      boom: await call(port, 'POST', '/termag/api/boom', { 'content-type': 'application/json' }, JSON.stringify({ text: CHAT })),
      boxes: await call(port, 'GET', '/termag/api/cli/v1/boxes'),
      box: await call(port, 'GET', `/termag/api/cli/v1/boxes/${BOX}`),
      visits: await call(port, 'GET', '/termag/api/visits/recent'),
      asset: await call(port, 'GET', '/termag/assets/index.js'),
      probe: await call(port, 'GET', '/termag/health/serving'),
      preflight: await call(port, 'OPTIONS', '/termag/api/x'),
    };
    await shutdownOtel();
    server.close();
    sink.close();
    const spans = received.map(s => ({
      name: s.name, traceId: s.traceId, spanId: s.spanId, parentSpanId: s.parentSpanId || null,
      attributes: flat(s.attributes),
      events: (s.events ?? []).map(e => ({ name: e.name, attributes: flat(e.attributes) })),
      status: s.status ?? {},
    }));
    process.stdout.write(`${JSON.stringify({ statuses, spans })}\n`);
    process.exit(0);
  });
});
