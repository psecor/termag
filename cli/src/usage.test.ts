import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMMANDS, type ParsedArgs } from './args.js';
import type { Ctx } from './context.js';
import { credentialsPath, saveLogin } from './credentials.js';
import { run } from './main.js';
import type { BackgroundRequest } from './backgroundPost.js';
import { AWAITED_AT_START, REPORTED_AT_START, countRequests, usageBearer, usageOptedOut, usageReporter, type UsageReport } from './usage.js';

const HOST = 'https://termag.example.com/termag';
let home: string;
let requests: Array<{ url: string; auth: string | null; body: unknown }>;

function ctx(overrides: Partial<Ctx> = {}): Ctx {
  return {
    env: { TERMAG_URL: HOST },
    home,
    hostname: 'mbp.local',
    interactive: false,
    out: () => {},
    err: () => {},
    fetch: (async (url: string, init: RequestInit) => {
      requests.push({ url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) });
      return new Response(null, { status: 204 });
    }) as typeof fetch,
    openBrowser: () => {},
    readFile: () => null,
    ...overrides,
  };
}

function signIn(): void {
  const later = new Date(Date.now() + 3600_000).toISOString();
  saveLogin(credentialsPath({}, home), HOST, {
    token: 'tmcli_device', accessToken: 'eyJ.access', accessTokenExpiresAt: later,
    deviceName: 'mbp', email: 'a@example.com', unixUsername: 'a', expiresAt: later, maxExpiresAt: later,
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'termag-usage-test-'));
  requests = [];
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('run reports usage', () => {
  it('reports a finished command by name, with its exit code, and nothing of its arguments', async () => {
    const reports: UsageReport[] = [];
    const code = await run(['whoami', '--json'], ctx({ env: { TERMAG_URL: HOST, CLAUDECODE: '1' } }), { report: async (_a, r) => { reports.push(r); } });
    expect(reports).toEqual([expect.objectContaining({ command: 'whoami', phase: 'finished', exitCode: code, interactive: false, claudeCode: true })]);
    expect(reports[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports nothing for help, the version or a command line that does not parse', async () => {
    const reports: UsageReport[] = [];
    const report = async (_a: ParsedArgs, r: UsageReport) => { reports.push(r); };
    for (const argv of [['--help'], ['--version'], ['box', 'list', '--nope'], ['nope']]) await run(argv, ctx(), { report });
    expect(reports).toEqual([]);
  });

  it('reports only commands the CLI has at start', () => {
    for (const command of REPORTED_AT_START) expect(COMMANDS).toHaveProperty([command]);
    for (const command of AWAITED_AT_START) expect(REPORTED_AT_START.has(command)).toBe(true);
  });

  it('reports every command that runs until Ctrl-C at start', () => {
    const untilCtrlC = Object.entries(COMMANDS).filter(([, spec]) => /until Ctrl-C/.test(spec.summary)).map(([name]) => name);
    expect(untilCtrlC).toEqual(expect.arrayContaining(['forward', 'events']));
    for (const command of untilCtrlC) expect(REPORTED_AT_START.has(command)).toBe(true);
  });

  it('sends logout\'s report before the sign-in is revoked', async () => {
    const order: string[] = [];
    await run(['logout'], ctx({ fetch: (async () => { order.push('logout'); return new Response(null, { status: 204 }); }) as typeof fetch }), {
      report: async (_a, r) => { await new Promise(resolve => setTimeout(resolve, 20)); order.push(`report:${r.phase}`); },
    });
    expect(order[0]).toBe('report:started');
  });
});

describe('usageReporter', () => {
  const args = { command: 'box list' } as ParsedArgs;
  const report: UsageReport = { command: 'box list', phase: 'finished', version: '1', exitCode: 0, durationMs: 5, interactive: true, claudeCode: false };

  it('posts the report with the device sign-in', async () => {
    signIn();
    await usageReporter(ctx())(args, report);
    expect(requests).toEqual([{ url: `${HOST}/api/cli/v1/usage`, auth: 'Bearer eyJ.access', body: report }]);
  });

  it('sends nothing without a credential, and never throws', async () => {
    await expect(usageReporter(ctx())(args, report)).resolves.toBeUndefined();
    expect(requests).toEqual([]);
  });

  it('swallows a failed request', async () => {
    signIn();
    const failing = ctx({ fetch: (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch });
    await expect(usageReporter(failing)(args, report)).resolves.toBeUndefined();
  });

  it('sends nothing rather than refresh a lapsed access token', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    saveLogin(credentialsPath({}, home), HOST, {
      token: 'tmcli_device', accessToken: 'eyJ.old', accessTokenExpiresAt: past,
      deviceName: 'mbp', email: 'a@example.com', unixUsername: 'a', expiresAt: past, maxExpiresAt: past,
    });
    await usageReporter(ctx())(args, report);
    expect(requests).toEqual([]);
  });

  it('refreshes a lapsed access token for a report at start', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const later = new Date(Date.now() + 3600_000).toISOString();
    saveLogin(credentialsPath({}, home), HOST, {
      token: 'tmcli_device', accessToken: 'eyJ.old', accessTokenExpiresAt: past,
      deviceName: 'mbp', email: 'a@example.com', unixUsername: 'a', expiresAt: later, maxExpiresAt: later,
    });
    const refreshing = ctx({
      fetch: (async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        if (url.endsWith('/token')) {
          return Response.json({ accessToken: 'eyJ.new', accessTokenExpiresIn: 3600, expiresAt: later, maxExpiresAt: later });
        }
        requests.push({ url, auth: new Headers(init.headers).get('authorization'), body });
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    await usageReporter(refreshing)({ command: 'tui' } as ParsedArgs, { ...report, command: 'tui', phase: 'started', exitCode: undefined, durationMs: undefined });
    expect(requests).toEqual([expect.objectContaining({ url: `${HOST}/api/cli/v1/usage`, auth: 'Bearer eyJ.new' })]);
  });

  it('takes a good access token, else the box token only without a sign-in', () => {
    const now = Date.parse('2026-10-29T12:00:00Z');
    const good = { accessToken: 'eyJ.a', accessTokenExpiresAt: '2026-10-29T12:30:00Z' };
    const lapsing = { accessToken: 'eyJ.a', accessTokenExpiresAt: '2026-10-29T12:00:30Z' };
    expect(usageBearer(good, 'tmag_box', now)).toBe('eyJ.a');
    expect(usageBearer(lapsing, 'tmag_box', now)).toBeNull();
    expect(usageBearer(null, 'tmag_box', now)).toBe('tmag_box');
    expect(usageBearer(null, undefined, now)).toBeNull();
  });

  it('hands a finished report to the background when the run made no request', async () => {
    signIn();
    const sent: BackgroundRequest[] = [];
    await usageReporter(ctx({ postInBackground: (r) => { sent.push(r); } }), { requests: () => 0 })(args, report);
    expect(requests).toEqual([]);
    expect(sent).toEqual([{
      url: `${HOST}/api/cli/v1/usage`,
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer eyJ.access', 'Content-Type': 'application/json' }),
      body: JSON.stringify(report),
      timeoutMs: 1500,
    }]);
  });

  it('sends the report itself once the run has made a request', async () => {
    signIn();
    const sent: BackgroundRequest[] = [];
    await usageReporter(ctx({ postInBackground: (r) => { sent.push(r); } }), { requests: () => 1 })(args, report);
    expect(sent).toEqual([]);
    expect(requests).toEqual([{ url: `${HOST}/api/cli/v1/usage`, auth: 'Bearer eyJ.access', body: report }]);
  });

  it('keeps every report at start in this process, logout\'s included', async () => {
    signIn();
    const sent: BackgroundRequest[] = [];
    const reporter = usageReporter(ctx({ postInBackground: (r) => { sent.push(r); } }), { requests: () => 0 });
    for (const command of ['tui', 'logout']) {
      await reporter({ command } as ParsedArgs, { ...report, command, phase: 'started', exitCode: undefined, durationMs: undefined });
    }
    expect(sent).toEqual([]);
    expect(requests.map(r => (r.body as UsageReport).command)).toEqual(['tui', 'logout']);
  });

  it('hands nothing to the background without a credential, or when opted out', async () => {
    const sent: BackgroundRequest[] = [];
    await usageReporter(ctx({ postInBackground: (r) => { sent.push(r); } }), { requests: () => 0 })(args, report);
    signIn();
    const optedOut = ctx({ env: { TERMAG_URL: HOST, TERMAG_TELEMETRY: '0' }, postInBackground: (r) => { sent.push(r); } });
    await usageReporter(optedOut, { requests: () => 0 })(args, report);
    expect(sent).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('sends nothing when opted out', async () => {
    signIn();
    for (const env of [{ TERMAG_TELEMETRY: '0' }, { TERMAG_TELEMETRY: 'off' }, { DO_NOT_TRACK: '1' }]) {
      expect(usageOptedOut(env)).toBe(true);
      await usageReporter(ctx({ env: { TERMAG_URL: HOST, ...env } }))(args, report);
    }
    expect(requests).toEqual([]);
    expect(usageOptedOut({ DO_NOT_TRACK: '0' })).toBe(false);
  });
});

describe('countRequests', () => {
  it('counts what goes through ctx.fetch from then on, and passes it on', async () => {
    const c = ctx();
    const count = countRequests(c);
    expect(count()).toBe(0);
    await c.fetch(`${HOST}/api/cli/v1/whoami`, { method: 'GET', body: '{}' });
    await c.fetch(`${HOST}/api/cli/v1/boxes`, { method: 'GET', body: '{}' });
    expect(count()).toBe(2);
    expect(requests.map(r => r.url)).toEqual([`${HOST}/api/cli/v1/whoami`, `${HOST}/api/cli/v1/boxes`]);
  });
});
