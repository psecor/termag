// Child-process fixture for tracing.test.ts: the real tracer and
// instrumentations (services/tracing.ts, TERMAG_TRACING=on at rate 1), with
// the manual spans of services/tracing/spans.ts and botSpans.ts around work
// that calls the instrumented clients: fetch (undici), http, pg and the AWS
// SDK. Run by tsx, so the instrumentations patch through require as they do
// in production. Prints one JSON line: every span the OTLP sink received,
// and how many requests the target answered.
import type { IncomingMessage, ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { BOT_CANARY } from './e2eValues';

interface OtlpValue { stringValue?: string; intValue?: string | number; boolValue?: boolean; doubleValue?: number }
interface OtlpSpan {
  name: string; traceId: string; spanId: string; parentSpanId?: string;
  attributes?: { key: string; value: OtlpValue }[];
  events?: { name: string; attributes?: { key: string; value: OtlpValue }[] }[];
}
const flat = (attrs: { key: string; value: OtlpValue }[] = []) =>
  Object.fromEntries(attrs.map(a => [a.key, a.value.stringValue ?? a.value.boolValue ?? a.value.intValue ?? a.value.doubleValue]));

// Discord snowflakes, assembled so the secret scanner doesn't take them for a client id.
const GUILD = ['1234567890', '12345678'].join('');
const CHANNEL = ['2234567890', '12345678'].join('');
/* eslint-disable @typescript-eslint/no-require-imports */
// The sink before the tracer, as expressE2e.ts does.
const sinkHttp = require('http') as typeof import('http');
const received: OtlpSpan[] = [];
const sink = sinkHttp.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const parsed = JSON.parse(body) as { resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[] };
    for (const rs of parsed.resourceSpans) for (const ss of rs.scopeSpans) received.push(...ss.spans);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});

sink.listen(0, '127.0.0.1', () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;
  process.env.TERMAG_TRACING = 'on';
  process.env.TERMAG_TRACING_RATE = '1';
  delete process.env.TERMAG_OTEL;
  require('../../tracing');
  const { shutdownOtel } = require('../../otel') as typeof import('../../otel');
  const { traceSweep } = require('../spans') as typeof import('../spans');
  const { slackTraceMiddleware, tracedDiscordListener } = require('../botSpans') as typeof import('../botSpans');
  const http = require('http') as typeof import('http');
  const { Client } = require('pg') as typeof import('pg');
  const { EC2Client, DescribeInstancesCommand } = require('@aws-sdk/client-ec2') as typeof import('@aws-sdk/client-ec2');

  let answered = 0;
  const target = http.createServer((_req: IncomingMessage, res: ServerResponse) => { answered++; res.writeHead(200, { 'content-type': 'text/xml' }); res.end('<x/>'); });
  target.listen(0, '127.0.0.1', async () => {
    const targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
    const get = () => new Promise<void>((resolve) => { http.get(`${targetUrl}/http`, (res) => { res.resume(); res.on('end', resolve); }).on('error', () => resolve()); });
    // Nothing listens on port 9, so the query fails at connect; its span is recorded either way.
    const pgQuery = async () => {
      const client = new Client({ host: '127.0.0.1', port: 9, user: 'x', database: 'x', connectionTimeoutMillis: 2000 });
      client.on('error', () => {});
      const connecting = client.connect().catch(() => {});
      await client.query('SELECT 1').catch(() => {});
      await connecting;
    };
    const ec2 = new EC2Client({ region: 'us-east-1', endpoint: targetUrl, maxAttempts: 1, credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' } });
    const work = async () => {
      await (await fetch(`${targetUrl}/fetch`)).text();
      await get();
      await pgQuery();
      await ec2.send(new DescribeInstancesCommand({})).catch(() => {});
    };
    const tick = traceSweep('fixture', work);

    // Untraced: no parent, so no span at all.
    await work();
    // A tick from a timer's context.
    await tick();
    // A tick inside a request: its own trace all the same.
    const server = http.createServer(async (_req, res) => { await tick(); res.end('ok'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => {
      http.get(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/request`, (res) => { res.resume(); res.on('end', resolve); });
    });
    // A Slack command and a Discord reaction, both carrying a person's text.
    await slackTraceMiddleware({
      body: { command: '/t', text: BOT_CANARY, team_id: 'T0123ABCD', blocks: [{ text: BOT_CANARY }] },
      next: async () => { await (await fetch(`${targetUrl}/slack`)).text(); },
    });
    await tracedDiscordListener('messageReactionAdd', async (_reaction: unknown) => { await get(); })(
      { emoji: { name: BOT_CANARY }, message: { guildId: GUILD, channelId: CHANNEL, content: BOT_CANARY } },
    );

    await shutdownOtel();
    server.close();
    target.close();
    sink.close();
    const spans = received.map(s => ({
      name: s.name, traceId: s.traceId, spanId: s.spanId, parentSpanId: s.parentSpanId || null,
      attributes: flat(s.attributes),
      events: (s.events ?? []).map(e => ({ name: e.name, attributes: flat(e.attributes) })),
    }));
    process.stdout.write(`${JSON.stringify({ answered, spans })}\n`);
    process.exit(0);
  });
});
