import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentFromEnv } from './bug.js';
import type { Ctx } from './context.js';
import { run } from './main.js';
import { startFakeOrchestrator, type FakeOrchestrator } from './test/fakeOrchestrator.js';

// `termag bug report` against the fake
// orchestrator. Secret-shaped fixtures are built at run time, never literals.
let home: string;
let orch: FakeOrchestrator;
let out: string[];
let err: string[];

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
    readStdin: async () => '## Repro\n`termag space put a.md improve-termag:x.md` over an existing file\n\nExpected: saved. Actual: 403.',
    ...overrides,
  };
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'termag-cli-bug-'));
  orch = await startFakeOrchestrator();
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

const title = 'space put over an existing file answers 403';

describe('termag bug report', () => {
  it('files the body from stdin with the versions, agent and session attached, and prints the id', async () => {
    const errFile = join(home, 'err.txt');
    writeFileSync(errFile, 'termag: 403 Forbidden: You may not write here\n');
    const env = {
      TERMAG_URL: orch.host, AI_AGENT: 'claude-code_2-1-312_agent', ANTHROPIC_MODEL: 'us.anthropic.claude-opus-5-5',
      TERMAG_PROJECT_ID: 'p1', TERMAG_WORKSTREAM: 'ask-cmvsovavv0wi0nyiwjj48ugzn',
    };
    expect(await run(['bug', 'report', '--title', title, '--severity', 'high', '--area', 'spaces',
      '--command', 'termag space put a.md improve-termag:x.md', '--error-file', errFile, '-'], ctx({ env }))).toBe(0);
    expect(orch.bugs.posts).toEqual([{
      isBox: false,
      body: {
        title, severity: 'high', area: 'spaces',
        body: expect.stringContaining('Expected: saved. Actual: 403.'),
        command: 'termag space put a.md improve-termag:x.md',
        errorOutput: 'termag: 403 Forbidden: You may not write here\n',
        cliVersion: expect.any(String),
        agentProvider: 'claude', agentModel: 'us.anthropic.claude-opus-5-5', agentVersion: 'claude-code 2.1.312',
        projectId: 'p1', workstream: 'ask-cmvsovavv0wi0nyiwjj48ugzn',
      },
    }]);
    expect(out).toEqual([
      'Filed bug report bug1.',
      'Mention bug1 in your handoff.',
    ]);
  });

  it('redacts secrets before sending and says what it replaced', async () => {
    const tok = `ghp_${'k'.repeat(36)}`;
    const readStdin = async () => `ran with GH_TOKEN=${tok}`;
    expect(await run(['bug', 'report', '--title', 'gh pr list --search fails through the broker', '--command', `GH_TOKEN=${tok} gh pr list --search x`, '-'], ctx({ readStdin }))).toBe(0);
    const sent = JSON.stringify(orch.bugs.posts[0].body);
    expect(sent).not.toContain(tok);
    expect(orch.bugs.posts[0].body).toMatchObject({ body: 'ran with GH_TOKEN=[redacted: GitHub token]', command: 'GH_TOKEN=[redacted: GitHub token] gh pr list --search x' });
    expect(err).toEqual(['Redacted before filing: GitHub token.']);
  });

  it('redacts a whole private key, even one whose header falls outside the error tail, before sending', async () => {
    const lines = ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'BKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj' + 'A'.repeat(20_000)];
    const key = [`-----BEGIN ${'PRIVATE'} KEY-----`, ...lines, `-----END ${'PRIVATE'} KEY-----`].join('\n');
    const errFile = join(home, 'err.txt');
    writeFileSync(errFile, `${key}\nPermission denied (publickey)\n`);
    const readStdin = async () => `the key:\n${key.replace(lines[1], 'short')}\nthen 403`;
    expect(await run(['bug', 'report', '--title', 'ssh to a box fails', '--error-file', errFile, '-'], ctx({ readStdin }))).toBe(0);
    const sent = orch.bugs.posts[0].body;
    expect(sent).toMatchObject({ body: 'the key:\n[redacted: private key]\nthen 403', errorOutput: '[redacted: private key]\nPermission denied (publickey)\n' });
    expect(JSON.stringify(sent)).not.toContain('AAAA');
    expect(err).toEqual(['Redacted before filing: private key.']);
  });

  it('lets --agent and --model override the environment, and --json prints the result', async () => {
    expect(await run(['bug', 'report', '--title', title, '--agent', 'codex', '--model', 'gpt-5', '-', '--json'], ctx())).toBe(0);
    expect(orch.bugs.posts[0].body).toMatchObject({ agentProvider: 'codex', agentModel: 'gpt-5' });
    expect(JSON.parse(out.at(-1)!)).toEqual({ id: 'bug1', status: 'new', redacted: [] });
  });

  it('refuses a missing title, a missing or empty body, and an unknown severity or area, before posting', async () => {
    expect(await run(['bug', 'report', '-'], ctx())).toBe(2);
    expect(await run(['bug', 'report', '--title', title], ctx())).toBe(2);
    expect(err.at(-1)).toMatch(/body on stdin/);
    expect(await run(['bug', 'report', '--title', title, '-'], ctx({ readStdin: async () => '  \n' }))).toBe(2);
    expect(await run(['bug', 'report', '--title', title, '--severity', 'urgent', '-'], ctx())).toBe(2);
    expect(await run(['bug', 'report', '--title', title, '--area', 'spaces,cli', '-'], ctx())).toBe(2);
    expect(await run(['bug', 'report', '--title', title, '--error-file', join(home, 'nope'), '-'], ctx())).toBe(3);
    expect(orch.bugs.posts).toEqual([]);
  });

  it("passes the orchestrator's refusal through", async () => {
    orch.bugs.refuse = { status: 429, error: 'At most 20 bug reports an hour from one box; try again later', code: 'rate_limited' };
    expect(await run(['bug', 'report', '--title', title, '-'], ctx())).toBe(1);
    expect(err.join('\n')).toMatch(/At most 20 bug reports an hour/);
  });

  it("files with the box's own credentials on a box", async () => {
    const boxHome = join(home, 'box-home');
    orch.boxTokens.add('tmag_box');
    const dir = join(boxHome, 'src', 'termag', 'agent');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent.config.json'), JSON.stringify({ termag_url: orch.host.replace(/^http/, 'ws') + '/ws/agent', token: 'tmag_box' }));
    expect(await run(['bug', 'report', '--title', title, '-'], ctx({ env: {}, home: boxHome, interactive: false }))).toBe(0);
    expect(orch.requests.at(-1)?.auth).toBe('Bearer tmag_box');
    expect(orch.bugs.posts[0].isBox).toBe(true);
  });
});

describe('reading bug reports', () => {
  // Write-only from the CLI: admins read and triage them at /admin/bugs.
  it('has no bug list or bug ls, and asks the orchestrator for nothing', async () => {
    for (const argv of [['bug', 'list'], ['bug', 'ls', '--mine'], ['bug', 'list', '--search', 'space put']]) {
      expect(await run(argv, ctx())).toBe(2);
    }
    expect(orch.requests.filter(r => r.path.includes('bug-reports'))).toEqual([]);
  });

  it('lists only bug report in the help', async () => {
    expect(await run(['help'], ctx())).toBe(0);
    const help = out.join('\n');
    expect(help).toMatch(/bug report/);
    expect(help).not.toMatch(/bug list/);
  });
});

describe('agentFromEnv', () => {
  it('reads Claude Code and Codex from their environment', () => {
    expect(agentFromEnv({ AI_AGENT: 'claude-code_2-1-312_agent', ANTHROPIC_MODEL: 'opus' })).toEqual({ provider: 'claude', version: 'claude-code 2.1.312', model: 'opus' });
    expect(agentFromEnv({ CLAUDECODE: '1' })).toEqual({ provider: 'claude', version: null, model: null });
    expect(agentFromEnv({ CODEX_SANDBOX: 'seatbelt' })).toEqual({ provider: 'codex', version: null, model: null });
    expect(agentFromEnv({})).toEqual({ provider: null, version: null, model: null });
  });
});
