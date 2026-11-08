import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from './context.js';
import { parseCommandLine } from './args.js';
import { parsePointer } from './environment.js';
import { run } from './main.js';
import { startFakeOrchestrator, type FakeOrchestrator } from './test/fakeOrchestrator.js';

// `termag environment`: every command
// over /api/cli/v1/environments, the definition from a file, stdin or a
// pointer, the orchestrator's refusals passed on, and the next step printed.

let home: string;
let orch: FakeOrchestrator;
let out: string[];
let err: string[];
let questions: string[];
let stdin = '';

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
    readStdin: async () => stdin,
    loginTimeoutMs: 5000,
    confirm: async (q) => { questions.push(q); return true; },
    ...overrides,
  };
}

const stdout = () => out.join('\n');
const stderr = () => err.join('\n');
const routes = () => orch.environments.calls.map(c => c.route);
const DEF = { $schema: 'https://github.com/example-org/termag/blob/main/docs/environment.schema.json', repos: [{ repo: 'acme/web' }, { repo: 'acme/api', path: 'api' }], resources: 'medium' };

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'termag-cli-environment-'));
  orch = await startFakeOrchestrator();
  questions = [];
  stdin = '';
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

describe('termag environment', () => {
  it('creates from a file, sending its text for the orchestrator to check, and prints the next step', async () => {
    const file = join(home, 'full-stack.json');
    writeFileSync(file, JSON.stringify(DEF));
    expect(await run(['environment', 'create', 'full-stack', '--file', file], ctx())).toBe(0);
    expect(orch.environments.calls[0]).toMatchObject({ route: 'POST /environments', body: { name: 'full-stack', kind: 'inline', definition: JSON.stringify(DEF) } });
    expect(stdout()).toContain('Created personal environment full-stack (inline).');
    expect(stdout()).toContain('Next: termag project create <box>/<name> --agent claude --new-box --environment full-stack');
  });

  it('creates from stdin with -, and with termag env as the alias', async () => {
    stdin = JSON.stringify(DEF);
    expect(await run(['env', 'create', 'web', '-'], ctx())).toBe(0);
    expect(orch.environments.envs.map(e => e.name)).toEqual(['web']);
  });

  it("passes the schema's error on, with its path and message, and makes nothing", async () => {
    stdin = JSON.stringify({ repos: ['acme/web'], resources: { vcpu: 16, memoryGiB: 32 } });
    expect(await run(['environment', 'create', 'big', '-'], ctx())).not.toBe(0);
    expect(stderr()).toContain('resources.vcpu must be <= 8 (docs/environment.schema.json)');
    expect(orch.environments.envs).toEqual([]);
  });

  it('creates a pointer, owner/name:branch:path, an empty branch the default', async () => {
    expect(await run(['environment', 'create', 'shop', '--pointer', 'acme/web:env:.termag/shop/environment.json'], ctx())).toBe(0);
    expect(orch.environments.calls[0].body).toEqual({ name: 'shop', kind: 'pointer', file: { repo: 'acme/web', branch: 'env', path: '.termag/shop/environment.json' }, visibility: 'personal' });
    expect(stdout()).toContain('Created personal environment shop (file acme/web:env:.termag/shop/environment.json).');
    expect(parsePointer('acme/web')).toEqual({ repo: 'acme/web' });
    expect(parsePointer('acme/web::x.json')).toEqual({ repo: 'acme/web', path: 'x.json' });
  });

  it('refuses a definition given no way or two ways, and a pointer that is not owner/name, before asking anything', async () => {
    expect(await run(['environment', 'create', 'x'], ctx())).toBe(2);
    expect(stderr()).toContain('Give the definition one way');
    expect(await run(['environment', 'create', 'x', '--file', 'a.json', '--pointer', 'a/b'], ctx())).toBe(2);
    expect(await run(['environment', 'create', 'x', '--pointer', 'nope'], ctx())).toBe(2);
    expect(stderr()).toContain('--pointer takes <owner/name>:<branch>:<path>');
    expect(routes()).toEqual([]);
  });

  it('lists, shows (with what it resolves to) and edits by name', async () => {
    stdin = JSON.stringify(DEF);
    await run(['environment', 'create', 'full-stack', '-'], ctx());
    orch.environments.resolved['full-stack'] = { repos: [{ repo: 'acme/web' }, { repo: 'acme/api', path: 'api' }], size: 'medium', warnings: [] };
    out = [];
    expect(await run(['environment', 'list'], ctx())).toBe(0);
    expect(stdout()).toMatch(/full-stack\s+personal\s+inline/);
    out = [];
    expect(await run(['environment', 'show', 'full-stack'], ctx())).toBe(0);
    expect(stdout()).toContain('"resources": "medium"');
    expect(stdout()).toContain('  acme/api (in api/)');
    expect(stdout()).toContain('Deploy: termag project create <box>/<name> --agent claude --new-box --environment full-stack');
    out = [];
    expect(await run(['environment', 'show', 'full-stack', '--json'], ctx())).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ name: 'full-stack', resolved: { size: 'medium' } });
    stdin = JSON.stringify({ ...DEF, resources: 'large' });
    out = [];
    expect(await run(['environment', 'edit', 'full-stack', '-'], ctx())).toBe(0);
    expect(routes().at(-1)).toBe('PUT /environments/full-stack');
    expect(stdout()).toContain('Saved environment full-stack.');
  });

  it("shows an environment's history, newest first, with who and what changed", async () => {
    stdin = JSON.stringify(DEF);
    await run(['environment', 'create', 'full-stack', '-'], ctx());
    stdin = JSON.stringify({ ...DEF, resources: 'large' });
    await run(['environment', 'edit', 'full-stack', '-'], ctx());
    out = [];
    expect(await run(['environment', 'history', 'full-stack'], ctx())).toBe(0);
    const text = stdout();
    expect(text.indexOf('Edited by Ada')).toBeLessThan(text.indexOf('Created by Ada'));
    expect(text).toContain('  resources: "medium" → "large"');
    expect(text).toContain('  inline (repos, resources)');
  });

  it('deletes after a confirm, or with --yes, and says when there is no such environment', async () => {
    stdin = JSON.stringify(DEF);
    await run(['environment', 'create', 'full-stack', '-'], ctx());
    expect(await run(['environment', 'delete', 'full-stack'], ctx())).toBe(0);
    expect(questions[0]).toContain('Delete environment full-stack (a shared one for everyone');
    expect(stdout()).toContain('Deleted environment full-stack.');
    expect(await run(['environment', 'delete', 'full-stack', '--yes'], ctx({ interactive: false }))).not.toBe(0);
    expect(stderr()).toContain('No such environment');
    expect(await run(['environment', 'delete', 'x'], ctx({ interactive: false, confirm: undefined }))).toBe(2);
    expect(stderr()).toContain('pass --yes');
  });

  it("reads with a box's own credentials, and says a box can't change one", async () => {
    stdin = JSON.stringify(DEF);
    expect(await run(['environment', 'create', 'full-stack', '-'], ctx())).toBe(0);
    const boxHome = join(home, 'box-home');
    orch.boxTokens.add('tmag_box');
    const dir = join(boxHome, 'src', 'termag', 'agent');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent.config.json'), JSON.stringify({ termag_url: orch.host.replace(/^http/, 'ws') + '/ws/agent', token: 'tmag_box' }));
    const onBox = () => ctx({ env: {}, home: boxHome, interactive: false });
    expect(await run(['environment', 'list'], onBox())).toBe(0);
    expect(await run(['environment', 'show', 'full-stack'], onBox())).toBe(0);
    stdin = JSON.stringify(DEF);
    expect(await run(['environment', 'create', 'from-box', '-'], onBox())).not.toBe(0);
    expect(stderr()).toContain('termag login');
    expect(orch.environments.envs.map(e => e.name)).toEqual(['full-stack']);
  });

  it('creates a personal one by default, and a shared one with --shared, passing on the rule when it breaks it', async () => {
    stdin = JSON.stringify(DEF);
    expect(await run(['environment', 'create', 'mine', '-', '--shared'], ctx())).not.toBe(0);
    expect(stderr()).toContain("a shared environment runs from a file on a repository's default branch, not inline JSON");
    expect(orch.environments.envs).toEqual([]);
    expect(await run(['environment', 'create', 'ours', '--pointer', 'acme/web::', '--shared'], ctx())).toBe(0);
    expect(orch.environments.calls.at(-1)!.body).toMatchObject({ visibility: 'shared' });
    expect(stdout()).toContain('Created shared environment ours');
    out = [];
    expect(await run(['environment', 'show', 'ours'], ctx())).toBe(0);
    expect(stdout()).toContain('ours · shared, owned by Ada');
  });

  it("shares and unshares by name, passing on the orchestrator's rule, each switch in the history", async () => {
    stdin = JSON.stringify(DEF);
    await run(['environment', 'create', 'inline-one', '-'], ctx());
    await run(['environment', 'create', 'on-feature', '--pointer', 'acme/web:feature:'], ctx());
    await run(['environment', 'create', 'on-default', '--pointer', 'acme/web'], ctx());
    err = [];
    expect(await run(['environment', 'share', 'inline-one'], ctx())).not.toBe(0);
    expect(stderr()).toContain('not inline JSON');
    expect(await run(['environment', 'share', 'on-feature'], ctx())).not.toBe(0);
    expect(stderr()).toContain("a shared environment runs from a file on acme/web's default branch; point it at .termag/environment.json on main");
    out = [];
    expect(await run(['env', 'share', 'on-default'], ctx())).toBe(0);
    expect(routes().at(-1)).toBe('POST /environments/on-default/visibility');
    expect(stdout()).toContain('Shared environment on-default');
    out = [];
    expect(await run(['environment', 'unshare', 'on-default'], ctx())).toBe(0);
    expect(stdout()).toContain('Environment on-default is personal');
    out = [];
    expect(await run(['environment', 'history', 'on-default'], ctx())).toBe(0);
    expect(stdout()).toMatch(/Switched by Ada\n  shared → personal[\s\S]*Switched by Ada\n  personal → shared/);
  });

  it('parses env as environment for every subcommand', () => {
    for (const sub of ['list', 'ls', 'show', 'create', 'edit', 'share', 'unshare', 'history', 'delete', 'rm']) {
      const cmd = parseCommandLine(['env', sub, ...(sub === 'list' || sub === 'ls' ? [] : ['x'])]).command;
      expect(cmd?.startsWith('environment ')).toBe(true);
    }
  });
});
