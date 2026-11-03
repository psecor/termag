// Child-process fixture for sessionContext.integration.test.ts: does every
// span a request makes after the session stack (express-session over
// connect-pg-simple) land under that request's own server span? index.ts mounts surfaceMiddleware twice
// because the store "can resume a request in another one's async context";
// this checks that for the tracer's context, with production's shape: one pg
// pool shared by the session store and Prisma's driver adapter (db.ts), the
// real tracer and instrumentations (services/tracing.ts), and many requests
// at once on a small pool, so callbacks queue behind each other.
//
// Every request runs a pg query, a Prisma operation and an outbound HTTP call
// after the session stack. Writes the spans the OTLP sink got, as JSON, to
// FIXTURE_OUT.
import { writeFileSync } from 'fs';
import { createServer, request, type IncomingHttpHeaders } from 'http';
import type { AddressInfo } from 'net';

const REQUESTS = Number(process.env.FIXTURE_REQUESTS ?? '24');

interface OtlpValue { stringValue?: string; intValue?: string | number; boolValue?: boolean }
interface OtlpSpan { name: string; traceId: string; spanId: string; parentSpanId?: string; attributes?: { key: string; value: OtlpValue }[] }
const flat = (attrs: { key: string; value: OtlpValue }[] = []) =>
  Object.fromEntries(attrs.map(a => [a.key, a.value.stringValue ?? a.value.boolValue ?? a.value.intValue]));

const received: OtlpSpan[] = [];
function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const server = createServer(handler);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

function call(port: number, method: string, path: string, headers: IncomingHttpHeaders = {}): Promise<{ status: number; cookie?: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const sinkPort = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body) as { resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[] };
      for (const rs of parsed.resourceSpans) for (const ss of rs.scopeSpans) received.push(...ss.spans);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  // The outbound call each request makes: answered after a short wait, so requests overlap.
  const upstreamPort = await listen((_req, res) => { setTimeout(() => { res.writeHead(200); res.end('ok'); }, 5); });

  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${sinkPort}`;
  process.env.TERMAG_TRACING = 'on';
  process.env.TERMAG_TRACING_RATE = '1';
  process.env.BASE_PATH = '/termag';
  delete process.env.TERMAG_OTEL;
  /* eslint-disable @typescript-eslint/no-require-imports */
  require('../../tracing');
  const { shutdownOtel } = require('../../otel') as typeof import('../../otel');
  const { serverSpanMiddleware, setServerSpanAttributes } = require('../requestSpan') as typeof import('../requestSpan');
  const { installOperationSpans } = require('../prismaSpans') as typeof import('../prismaSpans');
  const express = require('express') as typeof import('express');
  const session = require('express-session') as typeof import('express-session');
  const connectPgSimple = require('connect-pg-simple') as typeof import('connect-pg-simple');
  const { Pool } = require('pg') as typeof import('pg');
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  const { PrismaPg } = require('@prisma/adapter-pg') as typeof import('@prisma/adapter-pg');
  /* eslint-enable @typescript-eslint/no-require-imports */
  if (process.env.FIXTURE_UNBOUND_POOL === '1') {
    // The control run: take PgPoolContextInstrumentation's wrapper off again
    // (it is the outermost), leaving the pg instrumentation's own, which
    // doesn't bind with connect spans off.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const PgPool = require('pg-pool') as { prototype: { connect: { __original?: unknown } } };
    const original = PgPool.prototype.connect.__original;
    if (typeof original !== 'function') throw new Error('pg-pool connect is not wrapped');
    (PgPool.prototype as { connect: unknown }).connect = original;
  }

  // One small pool for the store and Prisma, as db.ts and index.ts share it.
  const pool = new Pool({ connectionString: process.env.FIXTURE_DB_URL, max: 2 });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  installOperationSpans(prisma);
  const PgSession = connectPgSimple(session);

  const app = express();
  app.use('/termag', serverSpanMiddleware);
  app.use('/termag', session({
    store: new PgSession({ pool, createTableIfMissing: true }),
    name: 'termag.sid', secret: 'fixture', resave: false, saveUninitialized: false, rolling: true,
    cookie: { path: '/termag', httpOnly: true, sameSite: 'lax' },
  }));
  app.post('/termag/api/login/:n', (req, res) => {
    (req.session as unknown as { n: string }).n = req.params.n;
    res.json({ ok: true });
  });
  app.get('/termag/api/work', async (req, res) => {
    const n = (req.session as unknown as { n?: string }).n ?? 'none';
    // Which request this is, on its own server span (bound before the session stack).
    setServerSpanAttributes(req, { 'fixture.request': n });
    await pool.query(`SELECT ${Number(n)}::int AS fixture_request`);
    await prisma.$queryRawUnsafe('SELECT 1');
    await new Promise<void>((resolve, reject) => {
      const out = request({ host: '127.0.0.1', port: upstreamPort, path: `/upstream` }, (r) => { r.resume(); r.on('end', resolve); });
      out.on('error', reject);
      out.end();
    });
    res.json({ n });
  });

  const port = await listen(app);
  // A session per request number first, then every request at once.
  const cookies: string[] = [];
  for (let n = 0; n < REQUESTS; n++) {
    const r = await call(port, 'POST', `/termag/api/login/${n}`);
    cookies.push(r.cookie!);
  }
  const statuses = await Promise.all(cookies.map(cookie => call(port, 'GET', '/termag/api/work', { cookie }).then(r => r.status)));
  await shutdownOtel();
  await prisma.$disconnect();
  await pool.end();
  const spans = received.map(s => ({
    name: s.name, traceId: s.traceId, spanId: s.spanId, parentSpanId: s.parentSpanId || null, attributes: flat(s.attributes),
  }));
  // To a file: the output passes 64 KB, past what a pipe takes before process.exit.
  writeFileSync(process.env.FIXTURE_OUT!, JSON.stringify({ requests: REQUESTS, statuses, spans }));
  process.exit(0);
}

main().catch((err) => { process.stderr.write(`${(err as Error).stack}\n`); process.exit(1); });
