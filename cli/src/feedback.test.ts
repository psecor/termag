import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from './context.js';
import { run } from './main.js';
import { startFakeOrchestrator, type FakeOrchestrator } from './test/fakeOrchestrator.js';

// `termag feedback` against the fake orchestrator.
// Secret-shaped fixtures are built at run time, never literals.
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
    readStdin: async () => 'The sidebar is confusing: I never find my asks.\n',
    ...overrides,
  };
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'termag-cli-feedback-'));
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

describe('termag feedback', () => {
  it('logs the text with the kind, versions, agent and session attached, and prints the id', async () => {
    const env = {
      TERMAG_URL: orch.host, AI_AGENT: 'claude-code_2-1-312_agent', ANTHROPIC_MODEL: 'us.anthropic.claude-opus-5-5',
      TERMAG_PROJECT_ID: 'p1', TERMAG_WORKSTREAM: 'main',
    };
    expect(await run(['feedback', '--kind', 'idea', 'I wish asks showed progress'], ctx({ env }))).toBe(0);
    expect(orch.feedback.posts).toEqual([{
      isBox: false,
      body: {
        body: 'I wish asks showed progress', kind: 'idea', cliVersion: expect.any(String),
        agentProvider: 'claude', agentModel: 'us.anthropic.claude-opus-5-5', agentVersion: 'claude-code 2.1.312',
        projectId: 'p1', workstream: 'main',
      },
    }]);
    expect(out).toEqual(["Logged feedback fb1. Thanks: termag's admins read every piece."]);
  });

  it('reads the text from stdin with -, and leaves the kind to the orchestrator', async () => {
    expect(await run(['feedback', '-'], ctx())).toBe(0);
    expect(orch.feedback.posts[0].body).toMatchObject({ body: 'The sidebar is confusing: I never find my asks.' });
    expect(orch.feedback.posts[0].body).not.toHaveProperty('kind');
  });

  it('redacts secrets before sending and says what it replaced', async () => {
    const tok = `ghp_${'k'.repeat(36)}`;
    expect(await run(['feedback', '--kind', 'problem', `my token ${tok} showed in the chat`], ctx())).toBe(0);
    expect(JSON.stringify(orch.feedback.posts[0].body)).not.toContain(tok);
    expect(orch.feedback.posts[0].body).toMatchObject({ body: 'my token [redacted: GitHub token] showed in the chat' });
    expect(err).toEqual(['Redacted before logging: GitHub token.']);
  });

  it('lets --agent and --model override the environment, and --json prints the result', async () => {
    expect(await run(['feedback', '--agent', 'codex', '--model', 'gpt-5', 'love spaces', '--json'], ctx())).toBe(0);
    expect(orch.feedback.posts[0].body).toMatchObject({ agentProvider: 'codex', agentModel: 'gpt-5' });
    expect(JSON.parse(out.at(-1)!)).toEqual({ id: 'fb1', status: 'new', redacted: [] });
  });

  it('refuses no text, empty or overlong text, two arguments and an unknown kind, before posting', async () => {
    expect(await run(['feedback'], ctx())).toBe(2);
    expect(err.at(-1)).toMatch(/one argument, or `-`/);
    expect(await run(['feedback', '  '], ctx())).toBe(2);
    expect(await run(['feedback', '-'], ctx({ readStdin: async () => '\n' }))).toBe(2);
    expect(await run(['feedback', 'x'.repeat(5_001)], ctx())).toBe(2);
    expect(await run(['feedback', 'the', 'sidebar'], ctx())).toBe(2);
    expect(await run(['feedback', '--kind', 'rant', 'meh'], ctx())).toBe(2);
    expect(orch.feedback.posts).toEqual([]);
  });

  it('checks the length of the text it sends, after redaction, so a near-limit message with a token is refused here', async () => {
    const tok = `tmag_${'a'.repeat(16)}`;
    const text = 'x'.repeat(5_000 - tok.length - 1) + ' ' + tok;
    expect(text.length).toBe(5_000);
    expect(await run(['feedback', text], ctx())).toBe(2);
    expect(err.at(-1)).toMatch(/at most 5000 characters once secrets are replaced/);
    expect(orch.feedback.posts).toEqual([]);
    // Short enough after redaction: sent, and within the orchestrator's limit.
    expect(await run(['feedback', 'x'.repeat(4_900) + ' ' + tok], ctx())).toBe(0);
    expect((orch.feedback.posts[0].body.body as string).length).toBeLessThanOrEqual(5_000);
  });

  it('takes text that starts with a dash after --, and says so in its help', async () => {
    expect(await run(['feedback', '--kind', 'problem', '--', '- the sidebar is confusing'], ctx())).toBe(0);
    expect(orch.feedback.posts[0].body).toMatchObject({ body: '- the sidebar is confusing', kind: 'problem' });
    expect(await run(['feedback', '--help'], ctx())).toBe(0);
    expect(out.join('\n')).toContain('termag feedback -- "- the sidebar is confusing"');
  });

  it("passes the orchestrator's refusal through", async () => {
    orch.feedback.refuse = { status: 429, error: 'At most 20 pieces of feedback an hour from one box; try again later', code: 'rate_limited' };
    expect(await run(['feedback', 'great'], ctx())).toBe(1);
    expect(err.join('\n')).toMatch(/At most 20 pieces of feedback an hour/);
  });

  it("logs with the box's own credentials on a box", async () => {
    const boxHome = join(home, 'box-home');
    orch.boxTokens.add('tmag_box');
    const dir = join(boxHome, 'src', 'termag', 'agent');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent.config.json'), JSON.stringify({ termag_url: orch.host.replace(/^http/, 'ws') + '/ws/agent', token: 'tmag_box' }));
    expect(await run(['feedback', 'great'], ctx({ env: {}, home: boxHome, interactive: false }))).toBe(0);
    expect(orch.requests.at(-1)?.auth).toBe('Bearer tmag_box');
    expect(orch.feedback.posts[0].isBox).toBe(true);
  });
});
