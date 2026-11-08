import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeRunStopped } from '../executor';
import { agentRuns, resetAgentThreadsForTests, setThreadBinding } from '../agentSession';
import { capFor, capRefusal, SPACE_TURNS_AT_ONCE } from './caps';
import { runTurn, type AgentTurn, type TurnContext, type TurnDriver } from './runTurn';

let seq = 0;

function fakeClient() {
  const calls: Array<{ method: string; args: any }> = [];
  const record = (method: string) => vi.fn(async (args: any) => { calls.push({ method, args }); return { ok: true, ts: '9.9' }; });
  return {
    calls,
    streamed: () => calls.filter(c => c.method === 'chat.startStream' || c.method === 'chat.appendStream' || c.method === 'chat.stopStream')
      .map(c => c.args.markdown_text ?? '').join(''),
    apiCall: vi.fn(async (method: string, args: any) => {
      calls.push({ method, args });
      return { ok: true, ts: method === 'chat.startStream' ? '5.5' : undefined };
    }),
    chat: { postMessage: record('chat.postMessage'), postEphemeral: record('chat.postEphemeral') },
    reactions: { add: record('reactions.add'), remove: record('reactions.remove') },
  };
}

function turn(client: ReturnType<typeof fakeClient>, over: Partial<AgentTurn> = {}): AgentTurn {
  const ts = `${++seq}.0`;
  return {
    client: client as any, say: vi.fn(async () => ({ ts: '1.1' })),
    channelId: `D${seq}`, threadTs: ts, messageTs: ts,
    message: 'hello', workingDir: '/work', userId: `U${seq}`, recipient: null, react: false,
    ...over,
  };
}

function driver(run: (ctx: TurnContext) => Promise<{ text: string; tags?: any }>): TurnDriver & { contexts: TurnContext[] } {
  const contexts: TurnContext[] = [];
  return { name: 'router-lite', contexts, run: (ctx) => { contexts.push(ctx); return run(ctx); } };
}

beforeEach(() => resetAgentThreadsForTests());

describe('runTurn with a fake driver', () => {
  it('gives the driver the turn, streams what it says, and delivers its answer', async () => {
    const client = fakeClient();
    const d = driver(async (ctx) => { ctx.onText('Hello '); ctx.onText('there'); return { text: 'Hello there' }; });
    const t = turn(client, { message: 'hi' });
    await runTurn(t, d);
    const [ctx] = d.contexts;
    expect(ctx).toMatchObject({ key: `${t.channelId}:${t.threadTs}`, scope: 'personal', spaceId: null, message: 'hi', label: null });
    expect(ctx.requester).toEqual({ slackId: t.userId, userId: null, role: null });
    expect(ctx.signal.aborted).toBe(false);
    expect(ctx.tempDir).toMatch(/termag-slack-run-/);
    expect(client.streamed()).toBe('Hello there');
    expect(agentRuns.size).toBe(0);
  });

  it('uses tags the driver already took out, and posts their choices', async () => {
    const client = fakeClient();
    const d = driver(async () => ({ text: 'ignored', tags: { reaction: null, choices: ['Yes', 'No'], attachments: [], text: 'Pick one' } }));
    await runTurn(turn(client, { userId: 'U-TAGS' }), d);
    expect(client.streamed()).toBe('Pick one');
    const buttons = client.calls.find(c => c.method === 'chat.postMessage' && c.args.blocks);
    expect(buttons?.args.blocks[0].elements.map((e: any) => e.text.text)).toEqual(['Yes', 'No']);
  });

  it('puts the label in front of the reply, streamed or whole', async () => {
    const streamedClient = fakeClient();
    await runTurn(turn(streamedClient, { label: '*payments* · ' }), driver(async (ctx) => { ctx.onText('All green.'); return { text: 'All green.' }; }));
    expect(streamedClient.streamed()).toBe('*payments* · All green.');
    const wholeClient = fakeClient();
    await runTurn(turn(wholeClient, { label: '*payments* · ' }), driver(async () => ({ text: 'All green.' })));
    expect(wholeClient.streamed()).toBe('*payments* · All green.');
  });

  it('says a driver\'s notice once, before the reply', async () => {
    const client = fakeClient();
    await runTurn(turn(client), driver(async (ctx) => { ctx.onNotice('_Fresh start._'); ctx.onNotice('_Again._'); return { text: 'Hi' }; }));
    expect(client.streamed()).toBe('_Fresh start._\n\nHi');
  });

  it('says Stopped. when the driver is stopped, and the error when it fails', async () => {
    const stopped = fakeClient();
    await runTurn(turn(stopped), driver(async () => { throw new ClaudeRunStopped(); }));
    expect(stopped.streamed()).toContain('_Stopped._');
    const failed = fakeClient();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runTurn(turn(failed), driver(async () => { throw new Error('box asleep'); }));
    errors.mockRestore();
    expect(failed.streamed()).toContain('**Error:** box asleep');
  });

  it('keeps "Working…" up when the driver says it is waking or queued', async () => {
    const client = fakeClient();
    await runTurn(turn(client), driver(async (ctx) => { ctx.onStatus('waking'); ctx.onStatus('queued'); return { text: 'ok' }; }));
    const processing = client.calls.filter(c => c.method === 'agents.sessions.setStatus' && c.args.status === 'processing');
    expect(processing.length).toBeGreaterThanOrEqual(3);
  });

  it('gives a space thread its binding, and refuses a run past the space\'s cap', async () => {
    const client = fakeClient();
    const releases: Array<() => void> = [];
    const d = driver((ctx) => new Promise(r => releases.push(() => r({ text: ctx.spaceId ?? '' }))));
    const turns = Array.from({ length: SPACE_TURNS_AT_ONCE + 1 }, () => turn(client));
    for (const t of turns) setThreadBinding(`${t.channelId}:${t.threadTs}`, { scope: 'space', spaceId: 'sp1', routeSeq: 0, frozenAt: null });
    const running = turns.slice(0, SPACE_TURNS_AT_ONCE).map(t => runTurn(t, d));
    await vi.waitFor(() => expect(d.contexts).toHaveLength(SPACE_TURNS_AT_ONCE));
    expect(d.contexts[0]).toMatchObject({ scope: 'space', spaceId: 'sp1' });
    const late = turns[SPACE_TURNS_AT_ONCE];
    await runTurn(late, d);
    expect(late.say).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('This space has as many conversations') }));
    expect(d.contexts).toHaveLength(SPACE_TURNS_AT_ONCE);
    releases.forEach(r => r());
    await Promise.all(running);
  });
});

describe('capFor', () => {
  it('caps every scope per person and globally, and space turns per space too', () => {
    expect(capFor('personal')).toMatchObject({ perRequester: 3, perSpace: null });
    expect(capFor('router')).toMatchObject({ perRequester: 3, perSpace: null });
    expect(capFor('space')).toMatchObject({ perRequester: 3, perSpace: SPACE_TURNS_AT_ONCE });
    expect(capFor('space').global).toBe(capFor('personal').global);
  });

  it('says nothing while under every cap', () => {
    expect(capRefusal(capFor('space'), { userId: 'U-none', spaceId: 'sp-empty' })).toBeNull();
  });
});

describe('runTurn when the stream cannot finish', () => {
  it('posts what the user has not seen with its indentation', async () => {
    const client = fakeClient();
    const apiCall = client.apiCall.getMockImplementation()!;
    client.apiCall.mockImplementation(async (method: string, args: any) => {
      if (method === 'chat.stopStream') { client.calls.push({ method, args }); throw new Error('internal_error'); }
      return apiCall(method, args);
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runTurn(turn(client), driver(async (ctx) => {
      ctx.onText('Run:\n');
      await new Promise(r => setTimeout(r, 20));
      return { text: 'Run:\n    make test' };
    }));
    errors.mockRestore();
    const posted = client.calls.filter(c => c.method === 'chat.postMessage').map(c => c.args.markdown_text);
    expect(posted).toEqual(['    make test']);
  });
});

// Last in the file: it spends the shared stream budget.
describe('runTurn and the stream budget', () => {
  it('posts a space turn\'s answer whole once the budget is spent, while an operator\'s still streams', async () => {
    const { streamBudget } = await import('../streamBudget');
    while (streamBudget.take()) { /* spend it */ }
    const space = fakeClient();
    const t = turn(space);
    setThreadBinding(`${t.channelId}:${t.threadTs}`, { scope: 'space', spaceId: 'sp-budget', routeSeq: 0, frozenAt: null });
    await runTurn(t, driver(async (ctx) => { ctx.onText('Done.'); return { text: 'Done.' }; }));
    expect(space.calls.map(c => c.method)).not.toContain('chat.startStream');
    expect(space.calls.find(c => c.method === 'chat.postMessage')?.args.markdown_text).toBe('Done.');

    const operator = fakeClient();
    await runTurn(turn(operator), driver(async (ctx) => { ctx.onText('Done.'); return { text: 'Done.' }; }));
    expect(operator.streamed()).toBe('Done.');
  });
});
