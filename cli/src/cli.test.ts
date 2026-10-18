import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from './context.js';
import { DEFAULT_HOST } from './config.js';
import { run } from './main.js';
import { startFakeOrchestrator, type FakeOrchestrator } from './test/fakeOrchestrator.js';

let home: string;
let orch: FakeOrchestrator;
let out: string[];
let err: string[];
let opened: string[];

function ctx(overrides: Partial<Ctx> = {}): Ctx {
  return {
    env: { TERMAG_URL: orch.host },
    home,
    hostname: 'zane-mbp.local',
    interactive: true,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    fetch: globalThis.fetch,
    // The "browser": follow the authorize redirect to the CLI's loopback, as a real one would.
    openBrowser: (url) => { opened.push(url); void fetch(url).catch(() => {}); },
    readFile: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
    loginTimeoutMs: 5000,
    ...overrides,
  };
}

const credsFile = () => join(home, '.config', 'termag', 'credentials.json');
const allOutput = () => [...out, ...err].join('\n');
const deviceTokens = () => [...orch.tokens.keys()];

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'termag-cli-test-'));
  orch = await startFakeOrchestrator();
  out = [];
  err = [];
  opened = [];
});

afterEach(async () => {
  await orch.close();
  rmSync(home, { recursive: true, force: true });
});

describe('termag login', () => {
  it('signs in through the browser and stores the token owner-only', async () => {
    expect(await run(['login'], ctx())).toBe(0);
    expect(opened).toHaveLength(1);
    const authorize = new URL(opened[0]);
    expect(authorize.pathname).toBe('/termag/auth/cli/authorize');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('device_name')).toBe('zane-mbp.local');
    expect(out.join('\n')).toContain('Signed in to');
    expect(out.join('\n')).toContain('alice@example.com');

    const [token] = deviceTokens();
    const stored = JSON.parse(readFileSync(credsFile(), 'utf8'));
    expect(stored.hosts[orch.host].token).toBe(token);
    const [accessToken] = orch.accessTokens.keys();
    expect(stored.hosts[orch.host].accessToken).toBe(accessToken);
    expect(Date.parse(stored.hosts[orch.host].accessTokenExpiresAt) - Date.now()).toBeGreaterThan(3500_000);
    expect(statSync(credsFile()).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, '.config', 'termag')).mode & 0o777).toBe(0o700);
    expect(allOutput()).not.toContain(token);
    expect(allOutput()).not.toContain(accessToken);
  });

  it('exits 4, not as a usage error, when the orchestrator refuses the sign-in code', async () => {
    orch.override.set('/api/cli/v1/token', (res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: 'Invalid or expired code; run `termag login` again', code: 'invalid_grant' }));
    });
    expect(await run(['login'], ctx())).toBe(4);
    expect(err.join('\n')).toContain('Invalid or expired code');
  });

  it('uses --device as the device name', async () => {
    expect(await run(['login', '--device', 'work laptop'], ctx())).toBe(0);
    expect(new URL(opened[0]).searchParams.get('device_name')).toBe('work laptop');
  });

  it('never opens a browser without a terminal', async () => {
    expect(await run(['login'], ctx({ interactive: false }))).toBe(4);
    expect(opened).toHaveLength(0);
    expect(err.join('\n')).toMatch(/needs a person at a terminal/);
  });

  it('times out with web sign-in guidance for a custom host and closes the callback', async () => {
    const code = await run(['login'], ctx({ openBrowser: (u) => { opened.push(u); }, loginTimeoutMs: 200 }));
    expect(code).toBe(5);
    expect(err.join('\n')).toContain(`Open ${orch.host}`);
    expect(existsSync(credsFile())).toBe(false);
    const port = new URL(opened[0]).searchParams.get('port');
    await expect(fetch(`http://127.0.0.1:${port}/callback`)).rejects.toThrow();
  });

  it('preserves browser cancellation as an auth error instead of timeout guidance', async () => {
    let browser: Promise<Response> | undefined;
    const code = await run(['login'], ctx({
      env: { TERMAG_URL: DEFAULT_HOST },
      openBrowser: (u) => {
        opened.push(u);
        const authorize = new URL(u);
        const callback = new URL(`http://127.0.0.1:${authorize.searchParams.get('port')}/callback`);
        callback.searchParams.set('state', authorize.searchParams.get('state')!);
        callback.searchParams.set('error', 'access_denied');
        browser = fetch(callback);
      },
      fetch: async () => { throw new Error('Cancellation must not contact the hosted orchestrator'); },
    }));
    expect((await browser)?.status).toBe(200);
    expect(code).toBe(4);
    expect(err.join('\n')).toContain('Sign-in was cancelled in the browser');
    expect(err.join('\n')).not.toContain('Timed out');
    expect(err.join('\n')).not.toContain('error_description');
    expect(existsSync(credsFile())).toBe(false);
    const port = new URL(opened[0]).searchParams.get('port');
    await expect(fetch(`http://127.0.0.1:${port}/callback`)).rejects.toThrow();
  });

  it('on a box, reports the box credentials instead of opening a browser', async () => {
    orch.boxTokens.add('tmag_box');
    writeAgentConfig(orch.host.replace(/^http/, 'ws') + '/ws/agent', 'tmag_box');
    expect(await run(['login'], ctx({ env: {} }))).toBe(0);
    expect(opened).toHaveLength(0);
    expect(out.join('\n')).toContain("box's own credentials");
  });
});

describe('termag whoami', () => {
  it('needs a sign-in (exit 4)', async () => {
    expect(await run(['whoami'], ctx())).toBe(4);
    expect(err.join('\n')).toContain('run `termag login`');
  });

  it('describes the device sign-in, as text and as JSON', async () => {
    await run(['login'], ctx());
    out = [];
    expect(await run(['whoami'], ctx())).toBe(0);
    expect(out.join('\n')).toContain('alice@example.com (alice)');
    expect(out.join('\n')).toContain('device sign-in "zane-mbp.local"');
    out = [];
    expect(await run(['whoami', '--json'], ctx())).toBe(0);
    expect(JSON.parse(out.join(''))).toMatchObject({ host: orch.host, credential: { kind: 'device' } });
  });

  it('uses a box agent token automatically', async () => {
    orch.boxTokens.add('tmag_box');
    writeAgentConfig(orch.host.replace(/^http/, 'ws') + '/ws/agent', 'tmag_box');
    expect(await run(['whoami'], ctx({ env: {} }))).toBe(0);
    expect(out.join('\n')).toContain("this box's own credentials");
    expect(orch.requests.at(-1)?.auth).toBe('Bearer tmag_box');
  });

  it('prefers a device sign-in over the box token for the same orchestrator', async () => {
    orch.boxTokens.add('tmag_box');
    writeAgentConfig(orch.host.replace(/^http/, 'ws') + '/ws/agent', 'tmag_box');
    await run(['login', '--device', 'mbp'], ctx());
    expect(await run(['whoami'], ctx())).toBe(0);
    expect(orch.requests.at(-1)?.auth).toBe(`Bearer ${[...orch.accessTokens.keys()][0]}`);
  });
});

describe('access tokens', () => {
  it('are what the CLI sends as a bearer; the device token never is', async () => {
    await run(['login'], ctx());
    await run(['whoami'], ctx());
    await run(['logout'], ctx());
    const bearers = orch.requests.map(r => r.auth).filter(Boolean);
    expect(bearers.length).toBeGreaterThan(0);
    expect(bearers.join(' ')).not.toContain('tmcli_');
  });

  it('are refreshed with the device token before they lapse', async () => {
    orch.accessTtlS = 30;
    await run(['login'], ctx());
    const first = JSON.parse(readFileSync(credsFile(), 'utf8')).hosts[orch.host].accessToken;
    const tokenPosts = () => orch.requests.filter(r => r.method === 'POST' && r.path === '/api/cli/v1/token').length;
    const afterLogin = tokenPosts();
    expect(await run(['whoami'], ctx())).toBe(0);
    const stored = JSON.parse(readFileSync(credsFile(), 'utf8')).hosts[orch.host];
    expect(stored.accessToken).not.toBe(first);
    expect(stored.token).toBe(deviceTokens()[0]);
    expect(tokenPosts()).toBe(afterLogin + 1);
    expect(orch.requests.at(-1)?.auth).toBe(`Bearer ${stored.accessToken}`);
  });

  it('a refresh refused because the device was signed out fails with exit 4', async () => {
    orch.accessTtlS = 30;
    await run(['login'], ctx());
    for (const t of orch.tokens.values()) t.revoked = true;
    err = [];
    expect(await run(['whoami'], ctx())).toBe(4);
    expect(err.join('\n')).toContain('run `termag login`');
  });

  it('an access token the edge refuses (HTML 401) fails with exit 4', async () => {
    await run(['login'], ctx());
    orch.override.set('/api/cli/v1/whoami', (res) => {
      res.writeHead(401, { 'Content-Type': 'text/html' }).end('<html>401 Authorization Required</html>');
    });
    err = [];
    expect(await run(['whoami'], ctx())).toBe(4);
    expect(err.join('\n')).toContain("refused the CLI's credential");
  });
});

describe('lists', () => {
  beforeEach(async () => {
    await run(['login'], ctx());
    out = [];
    err = [];
  });

  it('box list prints a table and warns about names the CLI cannot address', async () => {
    expect(await run(['box', 'list'], ctx())).toBe(0);
    const text = out.join('\n');
    expect(text.split('\n')[0]).toMatch(/^BOX\s+STATE\s+AGENT\s+PROJECTS$/);
    expect(text).toMatch(/devbox\s+running\s+connected\s+webapp-fix/);
    expect(text).toMatch(/old box\s+stopped\s+-\s+-/);
    expect(err.join('\n')).toContain('"old box"');
  });

  it('box ls --json passes the boxes through', async () => {
    expect(await run(['box', 'ls', '--json'], ctx())).toBe(0);
    expect(JSON.parse(out.join('')).boxes.map((b: { name: string }) => b.name)).toEqual(['devbox', 'old box']);
  });

  it('project list addresses projects as <box>/<project>', async () => {
    expect(await run(['project', 'list'], ctx())).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/devbox\/webapp-fix\s+claude\s+waiting \(approval\)/);
    expect(text).toMatch(/devbox\/flaky-test\s+codex\s+not running/);
  });

  it('a revoked sign-in fails with exit 4', async () => {
    for (const t of orch.tokens.values()) t.revoked = true;
    expect(await run(['project', 'list', '--json'], ctx())).toBe(4);
    expect(JSON.parse(err.join(''))).toMatchObject({ error: { code: 'auth_required' } });
  });
});

describe('termag logout', () => {
  it('revokes the token server-side and removes it locally', async () => {
    await run(['login'], ctx());
    const [token] = deviceTokens();
    expect(await run(['logout'], ctx())).toBe(0);
    expect(orch.tokens.get(token)?.revoked).toBe(true);
    expect(JSON.parse(readFileSync(credsFile(), 'utf8')).hosts).toEqual({});
    expect(await run(['whoami'], ctx())).toBe(4);
  });

  it('still forgets the token locally when the orchestrator is unreachable', async () => {
    await run(['login'], ctx());
    await orch.close();
    expect(await run(['logout'], ctx())).toBe(0);
    expect(err.join('\n')).toContain('sign "zane-mbp.local" out in the web UI');
    expect(JSON.parse(readFileSync(credsFile(), 'utf8')).hosts).toEqual({});
    orch = await startFakeOrchestrator();
  });

  it('is a no-op when not signed in', async () => {
    expect(await run(['logout'], ctx())).toBe(0);
    expect(out.join('\n')).toContain('Not signed in');
  });
});

describe('errors', () => {
  it('explains an edge that redirects to a browser sign-in', async () => {
    await run(['login'], ctx());
    orch.override.set('/api/cli/v1/whoami', (res) => {
      res.writeHead(302, { Location: 'https://example.okta.com/oauth2/v1/authorize?x=1' }).end();
    });
    err = [];
    expect(await run(['whoami'], ctx())).toBe(1);
    expect(err.join('\n')).toContain('redirected the CLI to example.okta.com');
  });

  it('explains an orchestrator that predates the CLI API', async () => {
    await run(['login'], ctx());
    orch.override.set('/api/cli/v1/boxes', (res) => { res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>'); });
    err = [];
    expect(await run(['box', 'list'], ctx())).toBe(1);
    expect(err.join('\n')).toContain('may predate the CLI');
  });

  it('exits 2 on usage errors', async () => {
    expect(await run(['frobnicate'], ctx())).toBe(2);
    expect(await run(['box'], ctx())).toBe(2);
    expect(await run(['whoami', '--device', 'x'], ctx())).toBe(2);
    expect(await run(['whoami', 'extra'], ctx())).toBe(2);
    expect(await run([], ctx())).toBe(2);
  });

  it('prints help and the version with exit 0', async () => {
    expect(await run(['--help'], ctx())).toBe(0);
    expect(out.join('\n')).toContain('project list');
    expect(await run(['help', 'box', 'list'], ctx())).toBe(0);
    expect(await run(['--version'], ctx())).toBe(0);
    expect(out.at(-1)).toMatch(/^termag \d+\.\d+\.\d+$/);
  });
});

function writeAgentConfig(termagUrl: string, token: string): void {
  const dir = join(home, 'src', 'termag', 'agent');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'agent.config.json'), JSON.stringify({ termag_url: termagUrl, token }));
}
