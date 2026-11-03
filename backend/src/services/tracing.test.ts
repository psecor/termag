import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { appPath, ignoredRequest, initTracing, isPoll } from './tracing';
import { resetOtelSetupForTests } from './otel';
import { BOT_CANARY, BOX, PROJECT, REMOTE_TRACE, SHARE_KEY, TOKEN, USER } from './tracing/fixtures/e2eValues';

const backend = join(__dirname, '..', '..');
const tsx = join(backend, 'node_modules', '.bin', 'tsx');

/** A fixture under services/tracing/fixtures in a child process, through tsx: the instrumentations patch through require, which vitest's loader bypasses. */
function runFixture(name: string): unknown {
  const r = spawnSync(tsx, [join(__dirname, 'tracing', 'fixtures', name)], {
    cwd: backend,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DOTENV_CONFIG_PATH: '/dev/null' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout.trim().split('\n').pop()!);
}

describe('which requests are traced', () => {
  it('reads the path under BASE_PATH, without the query', () => {
    expect(appPath('/termag/api/x?poll=1', '/termag')).toBe('/api/x');
    expect(appPath('/termag', '/termag')).toBe('/');
    expect(appPath('/api/x', '')).toBe('/api/x');
  });

  it('ignores probes, the version check, static files, the SPA and preflights', () => {
    for (const base of ['', '/termag']) {
      expect(ignoredRequest('GET', `${base}/health`, base)).toBe(true);
      expect(ignoredRequest('GET', `${base}/health/serving`, base)).toBe(true);
      expect(ignoredRequest('GET', `${base}/api/version`, base)).toBe(true);
      expect(ignoredRequest('GET', `${base}/assets/index-abc.js`, base)).toBe(true);
      expect(ignoredRequest('GET', `${base}/projects/abc`, base)).toBe(true);
      expect(ignoredRequest('GET', `${base}/sound-garden/x.mp3`, base)).toBe(true);
      expect(ignoredRequest('OPTIONS', `${base}/api/x`, base)).toBe(true);
      expect(ignoredRequest('GET', `${base}/api/projects`, base)).toBe(false);
      expect(ignoredRequest('POST', `${base}/api/status`, base)).toBe(false);
      expect(ignoredRequest('GET', `${base}/p/abc`, base)).toBe(false);
      expect(ignoredRequest('GET', `${base}/auth/okta/callback`, base)).toBe(false);
      expect(ignoredRequest('POST', `${base}/internal/mcp-authz/c/x`, base)).toBe(false);
      expect(ignoredRequest('POST', `${base}/anything`, base)).toBe(false);
    }
  });

  it('tells a poller by poll=1', () => {
    expect(isPoll('/api/prs?poll=1')).toBe(true);
    expect(isPoll('/api/prs?x=1&poll=1')).toBe(true);
    expect(isPoll('/api/prs')).toBe(false);
    expect(isPoll('/api/prs?poll=0')).toBe(false);
  });
});

describe('initTracing', () => {
  it('starts nothing with TERMAG_TRACING=off, TERMAG_OTEL=off, or nowhere to send', () => {
    resetOtelSetupForTests();
    expect(initTracing({ TERMAG_TRACING: 'off', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9' })).toBe(false);
    resetOtelSetupForTests();
    expect(initTracing({ TERMAG_OTEL: 'off', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9', TERMAG_OTELCOL_OUT: '/nonexistent' })).toBe(false);
    resetOtelSetupForTests();
    expect(initTracing({ TERMAG_OTELCOL_OUT: '/nonexistent', TERMAG_OTELCOL_INSTALLED: '/nonexistent' })).toBe(false);
    resetOtelSetupForTests();
  });
});

describe('the import order', () => {
  it('imports tracing second in index.ts, right after dotenv', () => {
    const src = readFileSync(join(backend, 'src', 'index.ts'), 'utf8');
    const imports = [...src.matchAll(/^import [^;]*;/gm)].map(m => m[0]);
    expect(imports.slice(0, 2)).toEqual(["import 'dotenv/config';", "import './services/tracing';"]);
  });

  it('loads none of the instrumented modules from tracing.ts', () => {
    const loaded = runFixture('loadTracing.ts') as string[];
    const forbidden = ['express', 'pg', 'pg-pool', 'ws', '@prisma/client', '@aws-sdk', '@slack/bolt', 'discord.js'];
    for (const name of forbidden) {
      const hit = loaded.find(path => path.includes(`${join('node_modules', name)}/`) || path.includes(`${join('node_modules', name)}\\`));
      expect(hit, `services/tracing.ts loads ${name}`).toBeUndefined();
    }
  });
});

describe('the pinned OpenTelemetry line', () => {
  const pkg = JSON.parse(readFileSync(join(backend, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  const lock = JSON.parse(readFileSync(join(backend, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> };

  it('resolves exactly one @opentelemetry/core', () => {
    const versions = new Set(Object.entries(lock.packages)
      .filter(([path]) => path.endsWith('node_modules/@opentelemetry/core'))
      .map(([, p]) => p.version));
    expect([...versions]).toHaveLength(1);
  });

  it('pins the trace SDK and its instrumentations exactly', () => {
    const traced = Object.entries(pkg.dependencies).filter(([name]) =>
      /^@opentelemetry\/(sdk-trace|exporter-trace|instrumentation|core$)/.test(name));
    expect(traced.length).toBeGreaterThanOrEqual(10);
    for (const [name, version] of traced) expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

interface E2eSpan {
  name: string; traceId: string; spanId: string; parentSpanId: string | null;
  attributes: Record<string, unknown>;
  events: { name: string; attributes: Record<string, unknown> }[];
  status: { code?: number; message?: string };
}

describe('end to end, with the real instrumentations', () => {
  const { statuses, spans } = runFixture('expressE2e.ts') as { statuses: Record<string, number>; spans: E2eSpan[] };
  const servers = spans.filter(s => s.parentSpanId === null || s.attributes['termag.parent.remote'] === true);
  const named = (name: string) => spans.filter(s => s.name === name);

  it('answered every request', () => {
    expect(statuses).toMatchObject({ share: 200, poll: 200, forged: 200, credentialed: 200, boom: 500, boxes: 200, box: 200, visits: 200 });
  });

  it('names server spans by their route template, never the path', () => {
    expect(servers.map(s => s.name).sort()).toEqual([
      'GET /termag/api/cli/v1/boxes', 'GET /termag/api/cli/v1/boxes/:id', 'GET /termag/api/projects/:id',
      'GET /termag/api/visits/recent', 'GET /termag/api/x', 'GET /termag/api/x', 'GET /termag/p/:key', 'POST /termag/api/boom',
    ]);
  });

  it('keeps the route right through routers that share a prefix, and exports no router span', () => {
    const routes = servers.map(s => s.attributes['http.route']);
    expect(routes).toContain('/termag/api/cli/v1/boxes');
    expect(routes).toContain('/termag/api/cli/v1/boxes/:id');
    expect(routes).toContain('/termag/api/visits/recent');
    expect(named('GET /termag/api/cli/v1/boxes/:id')[0].attributes['termag.box']).toBe(BOX);
    expect(spans.some(s => s.attributes['express.type'] === 'router')).toBe(false);
  });

  it('exports no share key, token, chat text or client address, anywhere', () => {
    const text = JSON.stringify(spans);
    expect(text).not.toContain(SHARE_KEY);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('correct-horse');
    expect(text).not.toContain('second line');
    expect(text).not.toContain('client.address');
    expect(text).not.toContain('network.peer.address');
  });

  it('keeps poll=1 and marks the poller', () => {
    const poll = servers.find(s => s.attributes['url.query'] === 'poll=1');
    expect(poll?.attributes['termag.poll']).toBe(true);
  });

  it('puts the surface and the user on the server span, not the handler\'s', () => {
    expect(servers.find(s => s.attributes['url.query'] === 'poll=1')?.attributes['termag.surface']).toBe('web');
    const [server] = named('GET /termag/api/projects/:id');
    expect(server.attributes['termag.user']).toBe(USER);
    expect(spans.filter(s => s.attributes['express.type'] === 'request_handler').some(s => s.attributes['termag.user'])).toBe(false);
  });

  it('names the project in a routed path', () => {
    expect(named('GET /termag/api/projects/:id')[0].attributes['termag.project']).toBe(PROJECT);
  });

  it('starts a new trace for a traceparent without a credential, and continues one with', () => {
    const [forged] = named('GET /termag/api/projects/:id');
    expect(forged.traceId).not.toBe(REMOTE_TRACE);
    expect(forged.attributes['termag.parent.remote']).toBeUndefined();
    const continued = named('GET /termag/api/x').find(s => s.traceId === REMOTE_TRACE);
    expect(continued?.attributes['termag.parent.remote']).toBe(true);
  });

  it('describes the error by its type, with the request kept', () => {
    const boom = spans.filter(s => s.traceId === named('POST /termag/api/boom')[0].traceId);
    const events = boom.flatMap(s => s.events).filter(e => e.name === 'exception');
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.attributes['exception.message']).toBe('Error');
    for (const s of boom) if (s.status.message !== undefined) expect(s.status.message).toBe('Error');
  });

  it('traces no probe, static file or preflight', () => {
    expect(spans.some(s => /assets|health|OPTIONS/.test(s.name))).toBe(false);
  });

  it('exports each request\'s handler span under its server span, routers between them or not', () => {
    for (const server of servers) {
      const handlers = spans.filter(s => s.attributes['express.type'] === 'request_handler' && s.traceId === server.traceId);
      expect(handlers.length, server.name).toBeGreaterThan(0);
      for (const h of handlers) expect(h.parentSpanId, server.name).toBe(server.spanId);
    }
  });
});

describe('background work, with the real instrumentations', () => {
  const { answered, spans } = runFixture('backgroundE2e.ts') as { answered: number; spans: (E2eSpan & { spanId: string })[] };
  const byId = new Map(spans.map(s => [s.spanId, s]));
  const ticks = spans.filter(s => s.name === 'termag.sweep.fixture');
  const under = (root: { spanId: string }) => spans.filter(s => s.parentSpanId === root.spanId);

  it('ran the work every time: untraced, from a timer, inside a request, and for each bot', () => {
    // fetch, http and EC2 for each of three runs of the work, then one fetch (Slack) and one http (Discord).
    expect(answered).toBe(11);
  });

  it('makes each tick a root of its own trace, even inside a request', () => {
    expect(ticks).toHaveLength(2);
    for (const t of ticks) expect(t.parentSpanId).toBeNull();
    expect(new Set(ticks.map(t => t.traceId)).size).toBe(2);
    const request = spans.find(s => s.name === 'GET' && s.parentSpanId === null && under(s).length === 0 && !ticks.some(t => t.traceId === s.traceId));
    expect(request).toBeDefined();
  });

  it('puts a tick\'s fetch, http, pg and AWS calls under it', () => {
    for (const t of ticks) {
      const children = under(t).map(s => s.name).sort();
      expect(children).toEqual(['EC2.DescribeInstances', 'GET', 'GET', 'pg.query:SELECT x']);
      for (const c of under(t)) expect(c.traceId).toBe(t.traceId);
    }
  });

  it('records no client span for the same work outside any span', () => {
    const clients = spans.filter(s => ['EC2.DescribeInstances', 'pg.query:SELECT x'].includes(s.name));
    expect(clients.every(s => byId.get(s.parentSpanId ?? '')?.name === 'termag.sweep.fixture')).toBe(true);
    expect(clients).toHaveLength(4);
  });

  it('makes a Slack command and a Discord listener root entries, with their calls under them', () => {
    const [slack] = spans.filter(s => s.name === 'termag.slack.command');
    const [discord] = spans.filter(s => s.name === 'termag.discord.messageReactionAdd');
    expect(slack.parentSpanId).toBeNull();
    expect(discord.parentSpanId).toBeNull();
    expect(under(slack).map(s => s.name)).toEqual(['GET']);
    expect(under(discord).map(s => s.name)).toEqual(['GET']);
    expect(slack.attributes).toMatchObject({ 'slack.command': '/t', 'slack.team.id': 'T0123ABCD' });
  });

  it('exports no text a person typed into Slack or Discord, anywhere', () => {
    expect(JSON.stringify(spans)).not.toContain(BOT_CANARY);
  });
});
