import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCommandLine } from './args.js';
import type { Ctx } from './context.js';
import { credentialsPath, saveLogin } from './credentials.js';
import { CliError } from './errors.js';
import { cmdTui, findTui, installTuiCommand, nodeMajor, runTui, tuiEnv, type TuiDeps } from './tui.js';

let home: string;
let ran: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }>;
let exitWith: number;

const HOST = 'https://orch.example/termag';
const DEVICE_TOKEN = 'tmcli_' + 'a'.repeat(64);
const BOX_TOKEN = 'tmag_' + 'b'.repeat(64);
const ACCESS_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.sig'; // gitleaks:allow

function ctx(env: NodeJS.ProcessEnv = {}, fetchImpl: typeof fetch = globalThis.fetch): Ctx {
  return {
    env,
    home,
    hostname: 'mbp',
    interactive: true,
    out: () => {},
    err: () => {},
    fetch: fetchImpl,
    openBrowser: () => {},
    readFile: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
  };
}

function deps(overrides: Partial<TuiDeps> = {}): TuiDeps {
  return {
    cliRoot: join(home, 'pkg', 'cli'),
    nodeVersion: '22.14.0',
    runForeground: async (cmd, args, env) => { ran.push({ cmd, args, env }); return exitWith; },
    ...overrides,
  };
}

function installSiblingTui(): string {
  const bin = join(home, 'pkg', 'tui', 'bin', 'termag-tui.js');
  mkdirSync(join(home, 'pkg', 'tui', 'bin'), { recursive: true });
  mkdirSync(join(home, 'pkg', 'tui', 'dist'), { recursive: true });
  writeFileSync(bin, '');
  writeFileSync(join(home, 'pkg', 'tui', 'dist', 'index.js'), '');
  return bin;
}

function signIn(host = HOST, accessTokenExpiresAt = new Date(Date.now() + 3600_000).toISOString()): void {
  saveLogin(credentialsPath({}, home), host, {
    token: DEVICE_TOKEN, accessToken: ACCESS_TOKEN, accessTokenExpiresAt,
    deviceName: 'mbp', email: 'alice@example.com', unixUsername: 'alice',
    expiresAt: '2026-10-12T00:00:00Z', maxExpiresAt: '2026-11-04T00:00:00Z',
  });
}

function onABox(): void {
  mkdirSync(join(home, 'src', 'termag', 'agent'), { recursive: true });
  writeFileSync(join(home, 'src', 'termag', 'agent', 'agent.config.json'),
    JSON.stringify({ termag_url: 'wss://orch.example/termag/ws/agent', token: BOX_TOKEN }));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'termag-tui-test-'));
  ran = [];
  exitWith = 0;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('termag tui arguments', () => {
  it('passes the TUI\'s own words through', () => {
    expect(parseCommandLine(['tui'])).toMatchObject({ command: 'tui', args: [] });
    expect(parseCommandLine(['tui', 'ls', 'sample'])).toMatchObject({ command: 'tui', args: ['ls', 'sample'] });
    expect(parseCommandLine(['tui', '--host', 'localhost:3040'])).toMatchObject({ command: 'tui', host: 'localhost:3040' });
  });
});

describe('findTui', () => {
  it('prefers $TERMAG_TUI, absolute and existing only', () => {
    const exists = (p: string) => p === '/opt/tui/bin/termag-tui.js' || p === '/opt/bin/tui';
    expect(findTui({ TERMAG_TUI: '/opt/tui/bin/termag-tui.js' }, '/x/cli', exists)).toEqual({ node: true, path: '/opt/tui/bin/termag-tui.js' });
    expect(findTui({ TERMAG_TUI: '/opt/bin/tui' }, '/x/cli', exists)).toEqual({ node: false, path: '/opt/bin/tui' });
    expect(findTui({ TERMAG_TUI: 'tui/bin/termag-tui.js' }, '/x/cli', () => true)).toBeNull();
    expect(findTui({ TERMAG_TUI: '/missing.js' }, '/x/cli', exists)).toBeNull();
  });

  it('then the built TUI beside this CLI, then termag-tui on PATH', () => {
    const files = new Set(['/x/tui/bin/termag-tui.js', '/usr/local/bin/termag-tui']);
    const exists = (p: string) => files.has(p);
    expect(findTui({ PATH: '/usr/local/bin' }, '/x/cli', exists)).toEqual({ node: false, path: '/usr/local/bin/termag-tui' });
    files.add('/x/tui/dist/index.js');
    expect(findTui({ PATH: '/usr/local/bin' }, '/x/cli', exists)).toEqual({ node: true, path: '/x/tui/bin/termag-tui.js' });
    expect(findTui({ PATH: '' }, '/y/cli', exists)).toBeNull();
  });
});

describe('runTui', () => {
  it('starts the TUI with the device sign-in for the chosen orchestrator', async () => {
    const bin = installSiblingTui();
    signIn();
    onABox();
    expect(await runTui(ctx({ TERMAG_URL: 'orch.example' }), parseCommandLine(['tui', 'ls']), deps())).toBe(0);
    expect(ran).toHaveLength(1);
    expect(ran[0].cmd).toBe(process.execPath);
    expect(ran[0].args).toEqual([bin, 'ls']);
    expect(ran[0].env).toMatchObject({
      TERMAG_URL: HOST, TERMAG_TOKEN: ACCESS_TOKEN, TERMAG_REFRESH_TOKEN: DEVICE_TOKEN, TERMAG_CREDENTIAL: 'termag login',
    });
    expect(Date.parse(ran[0].env.TERMAG_TOKEN_EXPIRES_AT!)).toBeGreaterThan(Date.now());
  });

  it('refreshes an access token about to lapse before starting the TUI', async () => {
    installSiblingTui();
    signIn(HOST, new Date(Date.now() + 30_000).toISOString());
    const requests: Array<{ url: string; body: unknown }> = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({
        accessToken: 'eyJfresh.payload.sig', accessTokenExpiresIn: 3600,
        expiresAt: '2026-10-13T00:00:00Z', maxExpiresAt: '2026-11-04T00:00:00Z',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    await runTui(ctx({ TERMAG_URL: HOST }, fakeFetch), parseCommandLine(['tui']), deps());
    expect(requests).toEqual([{ url: `${HOST}/api/cli/v1/token`, body: { grant_type: 'refresh_token', refresh_token: DEVICE_TOKEN } }]);
    expect(ran[0].env.TERMAG_TOKEN).toBe('eyJfresh.payload.sig');
    const stored = JSON.parse(readFileSync(credentialsPath({}, home), 'utf8')).hosts[HOST];
    expect(stored).toMatchObject({ token: DEVICE_TOKEN, accessToken: 'eyJfresh.payload.sig', expiresAt: '2026-10-13T00:00:00Z' });
  });

  it('uses the box\'s own credential when there is no sign-in', async () => {
    installSiblingTui();
    onABox();
    await runTui(ctx(), parseCommandLine(['tui']), deps());
    expect(ran[0].env).toMatchObject({ TERMAG_URL: HOST, TERMAG_TOKEN: BOX_TOKEN, TERMAG_CREDENTIAL: "this box's credentials" });
    expect(ran[0].env.TERMAG_REFRESH_TOKEN).toBeUndefined();
  });

  it('asks for a sign-in before looking for the TUI', async () => {
    const err = await runTui(ctx({ TERMAG_URL: HOST }), parseCommandLine(['tui']), deps()).catch(e => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(4);
    expect((err as CliError).message).toContain('termag login');
    expect(ran).toEqual([]);
  });

  it('names the one command that builds the TUI, in the checkout this CLI runs from', async () => {
    signIn();
    const err = await runTui(ctx({ TERMAG_URL: HOST, PATH: '' }), parseCommandLine(['tui']), deps()).catch(e => e);
    expect((err as CliError).message).toBe(`The TUI is not built yet; run: make -C ${join(home, 'pkg')} install-tui`);
    expect(ran).toEqual([]);
  });

  it('names the clone the launcher points at, quoted for the shell', async () => {
    signIn();
    const env = { TERMAG_URL: HOST, PATH: '', TERMAG_CLI_CHECKOUT: "/home/al/it's here" };
    const err = await runTui(ctx(env), parseCommandLine(['tui']), deps()).catch(e => e);
    expect((err as CliError).message).toBe(`The TUI is not built yet; run: make -C '/home/al/it'\\''s here' install-tui`);
    expect(installTuiCommand({ TERMAG_CLI_CHECKOUT: '/home/al/src/termag' }, '/x/cli')).toBe('make -C /home/al/src/termag install-tui');
  });

  it('says a missing TERMAG_TUI is the problem rather than the build', async () => {
    signIn();
    const err = await runTui(ctx({ TERMAG_URL: HOST, PATH: '', TERMAG_TUI: '/nope.js' }), parseCommandLine(['tui']), deps()).catch(e => e);
    expect((err as CliError).message).toMatch(/^TERMAG_TUI=\/nope\.js does not exist/);
  });

  it('refuses a Node older than the TUI supports', async () => {
    installSiblingTui();
    signIn();
    const err = await runTui(ctx({ TERMAG_URL: HOST }), parseCommandLine(['tui']), deps({ nodeVersion: '20.11.1' })).catch(e => e);
    expect((err as CliError).message).toBe(
      `\`termag tui\` needs Node.js 22 or newer; this CLI runs on 20.11.1. With Node 22 on PATH, run: make -C ${join(home, 'pkg')} install-cli`);
  });

  it('runs an installed termag-tui directly, whatever this Node is', async () => {
    signIn();
    mkdirSync(join(home, 'bin'));
    writeFileSync(join(home, 'bin', 'termag-tui'), '');
    await runTui(ctx({ TERMAG_URL: HOST, PATH: join(home, 'bin') }), parseCommandLine(['tui']), deps({ nodeVersion: '20.0.0' }));
    expect(ran[0]).toMatchObject({ cmd: join(home, 'bin', 'termag-tui'), args: [] });
  });

  it('maps the TUI\'s exit status onto the CLI\'s codes', async () => {
    installSiblingTui();
    signIn();
    for (const [tui, cli] of [[0, 0], [1, 1], [2, 2], [130, 1]]) {
      exitWith = tui;
      expect(await runTui(ctx({ TERMAG_URL: HOST }), parseCommandLine(['tui']), deps())).toBe(cli);
    }
  });
});

describe('cmdTui', () => {
  it('hands a real TUI process its environment and arguments', async () => {
    signIn();
    const out = join(home, 'seen.json');
    // An installed termag-tui, so this runs on the CLI's Node 20 as well.
    const fake = join(home, 'termag-tui');
    writeFileSync(fake, `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), url: process.env.TERMAG_URL, token: process.env.TERMAG_TOKEN }));
process.exitCode = 2;\n`);
    chmodSync(fake, 0o755);
    const code = await cmdTui(ctx({ TERMAG_URL: HOST, TERMAG_TUI: fake }), parseCommandLine(['tui', 'ls', 'x']));
    expect(code).toBe(2);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ argv: ['ls', 'x'], url: HOST, token: ACCESS_TOKEN });
  });
});

describe('helpers', () => {
  it('nodeMajor and tuiEnv', () => {
    expect(nodeMajor('v22.3.0')).toBe(22);
    expect(nodeMajor('20.11.1')).toBe(20);
    const stale = { HOME: '/h', TERMAG_TOKEN: 'stale', TERMAG_REFRESH_TOKEN: 'stale', TERMAG_TOKEN_EXPIRES_AT: 'stale' };
    expect(tuiEnv(stale, HOST, { kind: 'box', token: 'tok' }))
      .toEqual({ HOME: '/h', TERMAG_URL: HOST, TERMAG_TOKEN: 'tok', TERMAG_CREDENTIAL: "this box's credentials" });
    expect(tuiEnv(stale, HOST, { kind: 'device', accessToken: 'a', accessTokenExpiresAt: 'e', refreshToken: 'r' })).toEqual({
      HOME: '/h', TERMAG_URL: HOST, TERMAG_TOKEN: 'a', TERMAG_TOKEN_EXPIRES_AT: 'e', TERMAG_REFRESH_TOKEN: 'r',
      TERMAG_CREDENTIAL: 'termag login',
    });
  });
});
