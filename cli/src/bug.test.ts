import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentFromEnv } from './bug.js';
import type { Ctx } from './context.js';
import { run } from './main.js';
import { startFakeOrchestrator, type FakeOrchestrator } from './test/fakeOrchestrator.js';

// `termag bug report`, and an admin's `bug list`, `show` and `triage`,
// against the fake orchestrator. Secret-shaped fixtures are built at run time, never literals.
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

describe('reading and triage on an admin\'s box', () => {
  let boxHome: string;
  const onBox = () => ctx({ env: {}, home: boxHome, interactive: false });
  const summary = {
    id: 'bug7', title: 'space put over an existing file answers 403', status: 'new', severity: 'high', area: 'spaces',
    createdAt: '2026-10-30T09:15:00.000Z', reporter: 'ana@example.com', box: 'ana-box', linkUrl: null, duplicateOfId: null, agentProvider: 'claude',
  };
  const detail = {
    report: {
      ...summary, body: '## Repro\n`termag space put` over an existing path\n\nExpected: saved. Actual: 403.',
      command: 'termag space put a.md improve-termag:x.md', errorOutput: 'termag: 403 Forbidden\n', triagedAt: '2026-10-30T10:00:00.000Z',
      workstream: 'main', credential: 'box', agentModel: 'opus', agentVersion: 'claude-code 2.1.312', cliVersion: '0.9.0',
      boxAgentCommit: 'abc123def4567890', boxAgentCapabilities: ['ask-v1', 'disk-grow-v1'], boxImage: 'termag-box-2026-10-29', redacted: [],
    },
    reporter: { user: 'ana@example.com', box: 'ana-box', project: 'termag' },
    events: [
      { actor: 'root@example.com', createdAt: '2026-10-30T10:00:00.000Z', status: 'triaged', duplicateOfId: null, linkUrl: null, note: 'reproduced' },
      { actor: 'root@example.com', createdAt: '2026-10-30T10:05:00.000Z', status: null, duplicateOfId: null, linkUrl: '', note: null },
    ],
    duplicateOf: null,
    duplicates: [{ id: 'bug9', title: 'put 403 again', status: 'duplicate' }],
  };

  beforeEach(() => {
    boxHome = join(home, 'box-home');
    orch.boxTokens.add('tmag_box');
    const dir = join(boxHome, 'src', 'termag', 'agent');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent.config.json'), JSON.stringify({ termag_url: orch.host.replace(/^http/, 'ws') + '/ws/agent', token: 'tmag_box' }));
    orch.bugs.admin = true;
    orch.bugs.list = [summary, { ...summary, id: 'bug9', title: 'put 403 again', status: 'duplicate', duplicateOfId: 'bug7', box: null }];
    orch.bugs.details = { bug7: detail };
  });

  it('lists with the box token, passing the filters, open as new and triaged', async () => {
    expect(await run(['bug', 'list', '--status', 'open', '--area', 'spaces,broker', '--severity', 'high', '--q', 'space put'], onBox())).toBe(0);
    expect(orch.requests.at(-1)?.auth).toBe('Bearer tmag_box');
    expect(new URLSearchParams(orch.bugs.queries[0]).toString()).toBe('status=new%2Ctriaged&area=spaces%2Cbroker&severity=high&q=space+put&limit=50');
    expect(out.join('\n').split('\n')[0]).toMatch(/^ID\s+STATUS\s+SEV\s+AREA\s+FILED\s+REPORTER\s+TITLE$/);
    expect(out.join('\n')).toMatch(/bug7\s+new\s+high\s+spaces\s+2026-10-30 09:15 UTC\s+ana@example.com \(ana-box\)\s+space put over an existing file answers 403/);
    expect(out.join('\n')).toMatch(/bug9\s+dup of bug7/);
  });

  it('prints the list as JSON, and says when nothing matches', async () => {
    expect(await run(['bug', 'list', '--json', '--limit', '5'], onBox())).toBe(0);
    expect(JSON.parse(out.join('\n'))).toHaveLength(2);
    expect(orch.bugs.queries[0]).toBe('limit=5');
    out = [];
    orch.bugs.list = [];
    expect(await run(['bug', 'list'], onBox())).toBe(0);
    expect(out).toEqual(['No bug reports match.']);
  });

  it('shows one report with its context, body and history', async () => {
    expect(await run(['bug', 'show', 'bug7'], onBox())).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/^Report:\s+bug7$/m);
    expect(text).toMatch(/^Filed:\s+2026-10-30 09:15 UTC by ana@example.com with a box token$/m);
    expect(text).toMatch(/^Project:\s+termag \(main\)$/m);
    expect(text).toMatch(/^Duplicates:\s+bug9$/m);
    expect(text).toContain('  termag space put a.md improve-termag:x.md');
    expect(text).toContain('Expected: saved. Actual: 403.');
    expect(text).toContain('  2026-10-30 10:00 UTC  root@example.com: status triaged, "reproduced"');
    expect(text).toContain('  2026-10-30 10:05 UTC  root@example.com: cleared the link');
    expect(text).toMatch(/^Box agent:\s+abc123def4567890$/m);
    expect(text).toMatch(/^Capabilities:\s+ask-v1 disk-grow-v1$/m);
    expect(text).toMatch(/^Box image:\s+termag-box-2026-10-29$/m);
    out = [];
    expect(await run(['bug', 'show', 'bug7', '--json'], onBox())).toBe(0);
    expect(JSON.parse(out.join('\n'))).toEqual(detail);
    expect(await run(['bug', 'show', 'bug404'], onBox())).toBe(3);
  });

  it('triages with status, duplicate, link and note', async () => {
    expect(await run(['bug', 'triage', 'bug7', '--status', 'triaged', '--link', 'https://github.com/example-org/termag/issues/12', '--note', 'on it'], onBox())).toBe(0);
    expect(orch.bugs.patches).toEqual([{ id: 'bug7', body: { status: 'triaged', link: 'https://github.com/example-org/termag/issues/12', note: 'on it' } }]);
    expect(out).toEqual(['Triaged bug7: status triaged, link https://github.com/example-org/termag/issues/12.']);
    out = [];
    expect(await run(['bug', 'triage', 'bug7', '--duplicate-of', 'bug3', '--json'], onBox())).toBe(0);
    expect(orch.bugs.patches[1].body).toEqual({ duplicateOf: 'bug3' });
    expect(JSON.parse(out.join('\n'))).toMatchObject({ id: 'bug7', status: 'duplicate', duplicateOfId: 'bug3' });
  });

  it('refuses the box of a non-admin with the orchestrator\'s reason', async () => {
    orch.bugs.admin = false;
    for (const argv of [['bug', 'list'], ['bug', 'show', 'bug7'], ['bug', 'triage', 'bug7', '--status', 'fixed']]) {
      err = [];
      expect(await run(argv, onBox())).toBe(1);
      expect(err.join('\n')).toMatch(/Only termag admins can read or triage bug reports/);
    }
    expect(orch.bugs.patches).toEqual([]);
  });

  it('uses the box token even when the box also has a device sign-in', async () => {
    // The beforeEach `termag login` went to orch.host under `home`; sign this box's HOME in too.
    expect(await run(['login', '--device', 'box-1'], ctx({ env: { TERMAG_URL: orch.host }, home: boxHome }))).toBe(0);
    out = []; err = [];
    for (const argv of [['bug', 'list'], ['bug', 'show', 'bug7'], ['bug', 'triage', 'bug7', '--status', 'fixed']]) {
      expect(await run(argv, onBox())).toBe(0);
      expect(orch.requests.at(-1)?.auth).toBe('Bearer tmag_box');
    }
  });

  it('refuses a laptop sign-in: an admin box only', async () => {
    expect(await run(['bug', 'list'], ctx())).toBe(1);
    expect(err.join('\n')).toMatch(/admin's box credential only; on a laptop, open \/admin\/bugs/);
  });

  it('refuses bad options before asking the orchestrator', async () => {
    const before = orch.requests.length;
    for (const argv of [
      ['bug', 'list', '--status', 'closed'], ['bug', 'list', '--area', 'nope'], ['bug', 'list', '--limit', '0'],
      ['bug', 'show'], ['bug', 'show', '../x'], ['bug', 'triage', 'bug7'], ['bug', 'triage', 'bug7', '--status', 'done'],
    ]) {
      expect(await run(argv, onBox())).toBe(2);
    }
    expect(orch.requests.length).toBe(before);
  });

  it('lists the four bug commands in the help', async () => {
    expect(await run(['help'], ctx())).toBe(0);
    const help = out.join('\n');
    for (const c of ['bug report', 'bug list', 'bug show', 'bug triage']) expect(help).toContain(c);
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
