import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../context.js';
import { run } from '../main.js';
import { startFakeOrchestrator, type FakeOrchestrator } from '../test/fakeOrchestrator.js';
import { suggestName } from './command.js';

let home: string;
let orch: FakeOrchestrator;
let out: string[];
let err: string[];
let questions: string[];

function ctx(overrides: Partial<Ctx> = {}): Ctx {
  return {
    env: { TERMAG_URL: orch.host },
    home,
    hostname: 'zane-mbp.local',
    interactive: true,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    fetch: globalThis.fetch,
    openBrowser: (url) => { void fetch(url).catch(() => {}); },
    readFile: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
    loginTimeoutMs: 5000,
    confirm: async (q) => { questions.push(q); return true; },
    ...overrides,
  };
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'termag-cli-preview-'));
  orch = await startFakeOrchestrator();
  orch.lifecycle.projects[0].workstreams = ['main', 'feature-x'];
  questions = [];
  out = [];
  err = [];
  expect(await run(['login'], ctx())).toBe(0);
  out = [];
  err = [];
});

afterEach(async () => {
  await orch.close();
  rmSync(home, { recursive: true, force: true });
});

describe('termag preview publish', () => {
  it('publishes the main workstream for its owner by default, the name suggested from the project', async () => {
    expect(await run(['preview', 'publish', 'devbox/webapp-fix', '5173'], ctx())).toBe(0);
    expect(orch.preview.posts).toEqual([{ project: 'p1', workstream: 'main', port: 5173, name: 'webapp-fix', audience: 'owner' }]);
    expect(out.join('\n')).toBe([
      "Published port 5173 of devbox/webapp-fix as webapp-fix, for you and the project's collaborators, until 2026-11-01 12:00 UTC.",
      'Share: https://termag.example/termag/previews/webapp-fix',
      'The app is served at https://webapp-fix.previews.example/',
    ].join('\n'));
  });

  it('takes main, named or implied, even when the project list shows only other workstreams; refuses one it lacks', async () => {
    orch.lifecycle.projects[0].workstreams = ['feature-x'];
    expect(await run(['preview', 'publish', 'devbox/webapp-fix@main', '5173'], ctx())).toBe(0);
    expect(await run(['preview', 'publish', 'devbox/webapp-fix', '5174', '--name', 'other-app'], ctx())).toBe(0);
    expect(orch.preview.posts.map(p => p.workstream)).toEqual(['main', 'main']);
    expect(await run(['preview', 'publish', 'devbox/webapp-fix@nope', '5175'], ctx())).not.toBe(0);
    expect(err.at(-1)).toBe('termag: No workstream "nope" in devbox/webapp-fix (it has feature-x)');
  });

  it('takes a workstream, a name, an audience with people, a lifetime and the public host', async () => {
    expect(await run([
      'preview', 'publish', 'devbox/webapp-fix@feature-x', '3000', '--name', 'my-app', '--audience', 'people',
      '--email', 'bob@example.com', '--email', 'carol@example.com', '--ttl', '48', '--public-host',
    ], ctx())).toBe(0);
    expect(orch.preview.posts[0]).toEqual({
      project: 'p1', workstream: 'feature-x', port: 3000, name: 'my-app', audience: 'people',
      emails: ['bob@example.com', 'carol@example.com'], ttlHours: 48, hostMode: 'public',
    });
  });

  it("prints a link audience's URL, with its token, once; a renew that keeps it says so", async () => {
    expect(await run(['preview', 'publish', 'devbox/webapp-fix', '5173', '--name', 'my-app', '--audience', 'link'], ctx())).toBe(0);
    expect(out.join('\n')).toContain("Share this link; it carries the link's token and is shown only now:\n  https://termag.example/termag/previews/my-app/AAAAAAAAAAAAAAAAAAAAAA");
    out = [];
    expect(await run(['preview', 'publish', 'devbox/webapp-fix', '5173', '--name', 'my-app', '--audience', 'link'], ctx())).toBe(0);
    expect(out[0]).toMatch(/^Renewed port 5173/);
    expect(out[1]).toBe('The link keeps its token; share the URL you were given when it was made');
  });

  it('refuses a bad command line before asking the orchestrator', async () => {
    for (const argv of [
      ['preview', 'publish', 'devbox/webapp-fix'],
      ['preview', 'publish', 'webapp-fix', '5173'],
      ['preview', 'publish', 'devbox/webapp-fix', '0'],
      ['preview', 'publish', 'devbox/webapp-fix', 'http'],
      ['preview', 'publish', 'devbox/webapp-fix', '5173', '--audience', 'public'],
      ['preview', 'publish', 'devbox/webapp-fix', '5173', '--audience', 'people'],
      ['preview', 'publish', 'devbox/webapp-fix', '5173', '--email', 'bob@example.com'],
      ['preview', 'publish', 'devbox/webapp-fix', '5173', '--ttl', '200'],
    ]) expect(await run(argv, ctx()), argv.join(' ')).toBe(2);
    expect(await run(['preview', 'publish', 'devbox/webapp-fix@nope', '5173'], ctx())).toBe(3);
    expect(orch.preview.posts).toEqual([]);
  });

  it("says why when the orchestrator refuses: the name is someone else's, or previews are off", async () => {
    orch.preview.refuse = { status: 409, error: '"my-app" is taken', code: 'name_taken' };
    expect(await run(['preview', 'publish', 'devbox/webapp-fix', '5173', '--name', 'my-app'], ctx())).toBe(1);
    expect(err).toEqual(['termag: "my-app" is taken']);
    err = [];
    orch.preview.refuse = { status: 404, error: 'Not found', code: 'not_found' };
    expect(await run(['preview', 'publish', 'devbox/webapp-fix', '5173', '--name', 'my-app'], ctx())).toBe(3);
    expect(err).toEqual(["termag: Preview links aren't available for devbox/webapp-fix (they're off, or it isn't your project or shared with you)"]);
  });
});

describe('termag preview list and revoke', () => {
  it('lists your live links, a project\'s links and its pending agent requests', async () => {
    await run(['preview', 'publish', 'devbox/webapp-fix', '5173', '--name', 'my-app'], ctx());
    orch.preview.requests.push({ id: 'creq1', port: 6006, note: 'storybook for the PR', createdAt: '2026-10-31T11:00:00.000Z' });
    out = [];
    expect(await run(['preview', 'list'], ctx())).toBe(0);
    expect(out[0].split('\n')[0]).toMatch(/^NAME\s+PORT\s+WORKSTREAM\s+AUDIENCE\s+EXPIRES\s+VIEWERS\s+URL$/);
    expect(out[0].split('\n')[1]).toMatch(/^my-app\s+5173\s+main\s+owner\s+2026-11-01 12:00 UTC\s+0\s+https:\/\/termag.example\/termag\/previews\/my-app$/);
    out = [];
    expect(await run(['preview', 'ls', 'devbox/webapp-fix'], ctx())).toBe(0);
    expect(out.join('\n')).toContain('Pending agent requests (publish one in the web UI):\n  port 6006: "storybook for the PR" (2026-10-31 11:00 UTC)');
    expect(orch.requests.at(-1)?.path).toBe('/api/cli/v1/preview-links');
  });

  it('revokes your link by name, after asking', async () => {
    await run(['preview', 'publish', 'devbox/webapp-fix', '5173', '--name', 'my-app'], ctx());
    out = [];
    expect(await run(['preview', 'revoke', 'my-app'], ctx())).toBe(0);
    expect(questions).toEqual(['Revoke my-app (port 5173), ending it for everyone using it? [y/N] ']);
    expect(orch.preview.deleted).toEqual(['clink1']);
    expect(out).toEqual(['Revoked my-app. The name stays yours for 30 days.']);
    expect(await run(['preview', 'revoke', 'my-app', '--yes'], ctx())).toBe(3);
  });
});

describe("on a box, with the box's own credentials", () => {
  it('is refused: publishing takes a person\'s device sign-in (SR5)', async () => {
    const boxHome = join(home, 'box-home');
    orch.boxTokens.add('tmag_box');
    const dir = join(boxHome, 'src', 'termag', 'agent');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent.config.json'), JSON.stringify({ termag_url: orch.host.replace(/^http/, 'ws') + '/ws/agent', token: 'tmag_box' }));
    const onBox = ctx({ env: {}, home: boxHome, interactive: false });
    expect(await run(['preview', 'publish', 'devbox/webapp-fix', '5173'], onBox)).toBe(1);
    expect(orch.requests.at(-1)?.auth).toBe('Bearer tmag_box');
    expect(err.at(-1)).toMatch(/^termag: A box's own credentials can't publish a preview link; sign in on the box with `termag login --device <name>`/);
    expect(orch.preview.links).toEqual([]);
  });
});

describe('suggestName', () => {
  it('is the backend\'s rule: <project>-<workstream>, main left off, a DNS label or nothing', () => {
    expect(suggestName('webapp', 'main')).toBe('webapp');
    expect(suggestName('My_App', 'feature/X')).toBe('my-app-feature-x');
    expect(suggestName('x', 'main')).toBeNull();
  });
});

describe('termag preview publish <port>, in a checkout on its box (P6)', () => {
  let boxHome: string;
  function onBox(cwd: string): Ctx {
    return ctx({ env: {}, home: boxHome, cwd: () => cwd });
  }
  beforeEach(async () => {
    boxHome = join(home, 'box-home');
    orch.boxTokens.add('tmag_box');
    const dir = join(boxHome, 'src', 'termag', 'agent');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent.config.json'), JSON.stringify({ termag_url: orch.host.replace(/^http/, 'ws') + '/ws/agent', token: 'tmag_box' }));
    for (const d of ['termag/projects/webapp-fix/web', 'termag/projects/webapp-fix/.worktrees/feature-x/src', 'elsewhere']) mkdirSync(join(boxHome, d), { recursive: true });
    // A person signs this box in as themselves (a box's own credential can't publish).
    expect(await run(['login', '--device', 'devbox'], ctx({ env: {}, home: boxHome }))).toBe(0);
    out = []; err = [];
  });

  it('records the sign-in as made on this box, by sending its credential with the exchange', () => {
    expect([...orch.tokens.values()].at(-1)).toMatchObject({ deviceName: 'devbox', onBox: true });
  });

  it('asks for a confirm in the browser before sharing beyond "only me", waits for it, then prints the link', async () => {
    expect(await run(['preview', 'publish', '5173', '--name', 'wide-app', '--audience', 'link'], { ...onBox(join(boxHome, 'termag/projects/webapp-fix')), pollIntervalMs: 5 })).toBe(0);
    expect(out[0]).toBe(`Open this link to confirm sharing with anyone signed in to termag with the link: https://termag.example/termag/previews/confirm/${'C'.repeat(43)}`);
    expect(out.at(-2)).toMatch(/^Published port 5173 of devbox\/webapp-fix as wide-app, for anyone signed in to termag with the link/);
    expect(out.at(-1)).toBe("Share this link; it carries the link's token and is shown only now:\n  https://termag.example/termag/previews/wide-app/AAAAAAAAAAAAAAAAAAAAAA");
    expect(orch.preview.polls).toBe(2);
  });

  it('says what happened when the confirm is declined or expires: nothing was published', async () => {
    orch.preview.confirmStates = ['pending', 'declined'];
    expect(await run(['preview', 'publish', '5173', '--audience', 'link'], { ...onBox(join(boxHome, 'termag/projects/webapp-fix')), pollIntervalMs: 5 })).toBe(1);
    expect(err.at(-1)).toBe('termag: Declined in the browser; nothing was published');
    orch.preview.confirmStates = ['expired']; orch.preview.polls = 0;
    expect(await run(['preview', 'publish', '5173', '--audience', 'link'], { ...onBox(join(boxHome, 'termag/projects/webapp-fix')), pollIntervalMs: 5 })).toBe(5);
    expect(err.at(-1)).toMatch(/^termag: The confirm link expired after 10 minutes; nothing was published/);
  });

  it('publishes the main checkout it runs in', async () => {
    expect(await run(['preview', 'publish', '5173'], onBox(join(boxHome, 'termag/projects/webapp-fix/web')))).toBe(0);
    expect(orch.preview.posts).toEqual([{ project: 'p1', workstream: 'main', port: 5173, name: 'webapp-fix', audience: 'owner' }]);
    // The publish itself goes on the person's sign-in, not the box's token.
    expect(orch.requests.at(-1)?.auth).not.toBe('Bearer tmag_box');
    expect(out[0]).toMatch(/^Published port 5173 of devbox\/webapp-fix as webapp-fix/);
  });

  it("publishes the main checkout of a project whose list has other workstreams but no main row, as the orchestrator allows", async () => {
    orch.lifecycle.projects[0].workstreams = ['feature-x'];
    expect(await run(['preview', 'publish', '5173'], onBox(join(boxHome, 'termag/projects/webapp-fix')))).toBe(0);
    expect(orch.preview.posts[0]).toMatchObject({ project: 'p1', workstream: 'main', port: 5173 });
  });

  it("publishes a workstream's worktree, from anywhere inside it", async () => {
    expect(await run(['preview', 'publish', '3000', '--name', 'fx-app'], onBox(join(boxHome, 'termag/projects/webapp-fix/.worktrees/feature-x/src')))).toBe(0);
    expect(orch.preview.posts[0]).toMatchObject({ project: 'p1', workstream: 'feature-x', port: 3000, name: 'fx-app' });
  });

  it('says what to do outside a checkout, and asks nothing', async () => {
    expect(await run(['preview', 'publish', '5173'], onBox(join(boxHome, 'elsewhere')))).toBe(2);
    expect(err).toEqual(["termag: This isn't a termag checkout: run it in a workstream's checkout on its box (~/termag/projects/<project>), or name the project: termag preview publish <box>/<project>[@<workstream>] <port>"]);
    expect(orch.preview.posts).toEqual([]);
  });

  it('off a box, a bare port is no checkout either', async () => {
    expect(await run(['preview', 'publish', '5173'], ctx({ cwd: () => join(home, 'termag/projects/webapp-fix') }))).toBe(2);
    expect(err[0]).toMatch(/isn't a termag checkout/);
  });
});

describe('checkoutOf', () => {
  it('reads the project and workstream from a path under ~/termag/projects', async () => {
    const { checkoutOf } = await import('./checkout.js');
    expect(checkoutOf('/home/a/termag/projects/app', '/home/a')).toEqual({ project: 'app', workstream: 'main' });
    expect(checkoutOf('/home/a/termag/projects/app/src/x', '/home/a')).toEqual({ project: 'app', workstream: 'main' });
    expect(checkoutOf('/home/a/termag/projects/app/.worktrees/fx/y', '/home/a')).toEqual({ project: 'app', workstream: 'fx' });
    for (const dir of ['/home/a', '/home/a/termag/projects', '/home/a/termag/projects/app/.worktrees', '/home/a/termag/projects/.cache', '/elsewhere/termag/projects/app']) {
      expect(checkoutOf(dir, '/home/a'), dir).toBeNull();
    }
  });
});
