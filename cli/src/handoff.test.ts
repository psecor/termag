import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from './context.js';
import { run } from './main.js';
import { startFakeOrchestrator, type FakeOrchestrator } from './test/fakeOrchestrator.js';

let home: string;
let orch: FakeOrchestrator;
let out: string[];
let err: string[];
let questions: string[];
let answer: boolean;

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
    confirm: async (q) => { questions.push(q); return answer; },
    pollIntervalMs: 5,
    ...overrides,
  };
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'termag-cli-handoff-'));
  orch = await startFakeOrchestrator();
  questions = [];
  answer = true;
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

describe('termag handoff', () => {
  it('asks first, then hands off the main workstream in clear mode by default', async () => {
    expect(await run(['handoff', 'devbox/webapp-fix'], ctx())).toBe(0);
    expect(questions).toEqual(['Hand off the agent in devbox/webapp-fix (clear)? [y/N] ']);
    expect(orch.handoff.posts).toEqual([{ projectId: 'p1', body: { mode: 'clear', workstream: 'main', surface: 'cli' } }]);
    expect(out.join('\n')).toMatch(/Handing off devbox\/webapp-fix \(clear, handoff handoff1\)/);
  });

  it('restarts on another agent with --agent, and carries the note', async () => {
    expect(await run(['handoff', 'devbox/webapp-fix', '--agent', 'cursor', '--note', 'focus on the flaky test', '--yes'], ctx())).toBe(0);
    expect(questions).toEqual([]);
    expect(orch.handoff.posts[0].body).toEqual({ mode: 'restart', workstream: 'main', surface: 'cli', provider: 'cursor', note: 'focus on the flaky test' });
  });

  it('follows the handoff to the end with --wait', async () => {
    expect(await run(['handoff', 'devbox/webapp-fix', '--yes', '--wait'], ctx())).toBe(0);
    expect(err).toEqual([
      'waiting for the agent to finish its turn',
      'the agent is writing its handoff',
      'handoff saved; waiting for the agent to be at its prompt',
      'resetting the pane',
      'done: the next agent is starting on the handoff',
    ]);
  });

  it('fails with the reason when the handoff is aborted, and --json prints the final state', async () => {
    orch.handoff.states = ['writing', 'aborted'];
    orch.handoff.reason = 'the agent did not call handoff_written within 10 minutes; nothing was reset';
    expect(await run(['handoff', 'devbox/webapp-fix', '--yes', '--wait', '--json'], ctx())).toBe(1);
    expect(JSON.parse(out.at(-1)!).handoff).toMatchObject({ id: 'handoff1', state: 'aborted' });
    expect(err.join('\n')).toMatch(/aborted: the agent did not call handoff_written/);
  });

  it('refuses a workstream the project does not have, a bad mode, and --agent without restart, before posting', async () => {
    expect(await run(['handoff', 'devbox/webapp-fix@nope', '--yes'], ctx())).toBe(3);
    expect(await run(['handoff', 'devbox/webapp-fix', '--mode', 'exit', '--yes'], ctx())).toBe(2);
    expect(await run(['handoff', 'devbox/webapp-fix', '--mode', 'clear', '--agent', 'cursor', '--yes'], ctx())).toBe(2);
    expect(await run(['handoff', 'devbox/webapp-fix', '--timeout', '60', '--yes'], ctx())).toBe(2);
    expect(err.at(-1)).toMatch(/--timeout limits --wait/);
    expect(orch.handoff.posts).toEqual([]);
  });

  it('needs --yes when nobody is there to ask', async () => {
    expect(await run(['handoff', 'devbox/webapp-fix'], ctx({ interactive: false }))).toBe(2);
    expect(orch.handoff.posts).toEqual([]);
  });

  it('follows the handoff already under way when there is one and --wait is given', async () => {
    orch.handoff.refuse = { status: 409, error: 'a handoff of this agent is already writing (handoff1)', code: 'handoff_open', handoffId: 'handoff1' };
    expect(await run(['handoff', 'devbox/webapp-fix', '--yes', '--wait'], ctx())).toBe(0);
    expect(err[0]).toBe('A handoff of devbox/webapp-fix is already under way (handoff1); following it.');
    expect(err.at(-1)).toBe('done: the next agent is starting on the handoff');
    // Without --wait it is a refusal, as before.
    expect(await run(['handoff', 'devbox/webapp-fix', '--yes'], ctx())).toBe(1);
  });

  it('passes the orchestrator\'s refusal through', async () => {
    orch.handoff.refuse = { status: 403, error: 'agent handoff is not enabled for you on this box', code: 'handoff_disabled' };
    expect(await run(['handoff', 'devbox/webapp-fix', '--yes'], ctx())).toBe(1);
    expect(err.join('\n')).toMatch(/agent handoff is not enabled for you on this box/);
  });
});
