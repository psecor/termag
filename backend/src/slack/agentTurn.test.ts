import { beforeEach, describe, expect, it, vi } from 'vitest';

const exec = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('./executor', () => {
  class ClaudeRunStopped extends Error {
    constructor() { super('Stopped.'); }
  }
  return { ClaudeRunStopped, executeClaudeCommand: exec.run };
});

import { ClaudeRunStopped } from './executor';
import { runAgentTurn, type AgentTurn } from './agentTurn';
import { acceptAgentRuns, agentRuns, rememberClaudeSession, setAgentThreadStore, stopAgentRunsForRestart, type AgentThreadStore } from './agentSession';

let seq = 0;

function fakeClient(opts: { failStream?: boolean } = {}) {
  const calls: Array<{ method: string; args: any }> = [];
  const record = (method: string) => vi.fn(async (args: any) => {
    calls.push({ method, args });
    return { ok: true, ts: '9.9' };
  });
  return {
    calls,
    methods: () => calls.map(c => c.method),
    apiCall: vi.fn(async (method: string, args: any) => {
      calls.push({ method, args });
      if (opts.failStream && method === 'chat.startStream') throw new Error('internal_error');
      return { ok: true, ts: method === 'chat.startStream' ? '5.5' : undefined };
    }),
    chat: { postMessage: record('chat.postMessage'), postEphemeral: record('chat.postEphemeral') },
    reactions: { add: record('reactions.add'), remove: record('reactions.remove') },
  };
}

function turn(client: ReturnType<typeof fakeClient>, over: Partial<AgentTurn> = {}): AgentTurn {
  const ts = over.messageTs ?? `${++seq}.0`;
  return {
    client: client as any,
    say: vi.fn(async () => ({ ts: '1.1' })),
    channelId: 'D1', threadTs: ts, messageTs: ts,
    message: 'hello', workingDir: '/work', userId: 'U1', recipient: null,
    ...over,
  };
}

beforeEach(() => { exec.run.mockReset(); });

describe('runAgentTurn', () => {
  it('answers only the person who started a channel thread', async () => {
    const client = fakeClient();
    exec.run.mockResolvedValue('Hi A');
    const channel = `C${++seq}`;
    await runAgentTurn(turn(client, { channelId: channel, threadTs: '1.0', messageTs: '1.0', recipient: { userId: 'UA', teamId: 'T' }, userId: 'UA' }));
    await runAgentTurn(turn(client, { channelId: channel, threadTs: '1.0', messageTs: '2.0', recipient: { userId: 'UB', teamId: 'T' }, userId: 'UB' }));

    expect(exec.run).toHaveBeenCalledTimes(1);
    const note = client.calls.find(c => c.method === 'chat.postEphemeral');
    expect(note?.args).toMatchObject({ user: 'UB', thread_ts: '1.0' });
    expect(note?.args.text).toContain('<@UA>');
  });

  it('refuses a second message while the thread is still working', async () => {
    const client = fakeClient();
    let release!: (v: string) => void;
    exec.run.mockReturnValueOnce(new Promise<string>(r => { release = r; }));
    const first = turn(client, { threadTs: '7.0', messageTs: '7.0', channelId: `D${++seq}` });
    const running = runAgentTurn(first);
    const second = turn(client, { channelId: first.channelId, threadTs: '7.0', messageTs: '8.0' });
    await runAgentTurn(second);
    expect(second.say).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Still working') }));
    release('done');
    await running;
  });

  it('says Stopped. when the run is stopped', async () => {
    const client = fakeClient();
    exec.run.mockRejectedValue(new ClaudeRunStopped());
    await runAgentTurn(turn(client));
    const stop = client.calls.filter(c => c.method === 'chat.startStream' || c.method === 'chat.stopStream');
    expect(stop.map(c => c.args.markdown_text).join('')).toContain('_Stopped._');
  });

  it('swaps the topical ack for Claude\'s own reaction', async () => {
    const client = fakeClient();
    exec.run.mockResolvedValue('[react:+1]');
    const t = turn(client, { message: "what's on my calendar today?" });
    await runAgentTurn(t);
    const reactions = client.calls.filter(c => c.method.startsWith('reactions.')).map(c => [c.method, c.args.name]);
    expect(reactions).toEqual([['reactions.add', 'date'], ['reactions.add', '+1'], ['reactions.remove', 'date']]);
    // A reaction alone posts no reply, only settles the session.
    expect(client.methods()).not.toContain('chat.startStream');
  });

  it('posts choice buttons after the reply', async () => {
    const client = fakeClient();
    exec.run.mockResolvedValue('Post the findings?\n[choices: Post them | Not now]');
    await runAgentTurn(turn(client, { userId: 'U7' }));
    const methods = client.methods();
    const buttons = client.calls.find(c => c.method === 'chat.postMessage');
    expect(methods.indexOf('chat.stopStream')).toBeLessThan(methods.indexOf('chat.postMessage'));
    expect(buttons?.args.blocks[0].elements.map((e: any) => e.text.text)).toEqual(['Post them', 'Not now']);
    expect(JSON.parse(buttons?.args.blocks[0].elements[0].value)).toEqual({ u: 'U7', c: 'Post them' });
  });

  it('reacts to nothing for a button click', async () => {
    const client = fakeClient();
    exec.run.mockResolvedValue('[react:tada]\nDone, posted on the PR.');
    await runAgentTurn(turn(client, { message: 'Post them', react: false }));
    expect(client.methods().some(m => m.startsWith('reactions.'))).toBe(false);
  });

  it('forks a DM\'s recent session into a new thread, never a channel\'s', async () => {
    const client = fakeClient();
    exec.run.mockImplementation(async (_msg: string, opts: any) => { opts.onSessionId?.('sess-1'); return 'ok'; });
    const dm = `D${++seq}`;
    await runAgentTurn(turn(client, { channelId: dm }));
    await runAgentTurn(turn(client, { channelId: dm }));
    expect(exec.run.mock.calls[1][1]).toMatchObject({ resumeSessionId: 'sess-1', forkSession: true });

    const channel = `C${++seq}`;
    const inChannel = { channelId: channel, recipient: { userId: 'U1', teamId: 'T' } };
    await runAgentTurn(turn(client, inChannel));
    await runAgentTurn(turn(client, inChannel));
    expect(exec.run.mock.calls[3][1].resumeSessionId).toBeUndefined();
  });

  it('falls back to an ordinary markdown message when streaming fails', async () => {
    const client = fakeClient({ failStream: true });
    exec.run.mockResolvedValue('**Three** things to know.');
    await runAgentTurn(turn(client));
    const post = client.calls.find(c => c.method === 'chat.postMessage');
    // Markdown as the stream would have sent it, not wrapped in a code block.
    expect(post?.args.markdown_text).toBe('**Three** things to know.');
    expect(client.calls.at(-1)).toMatchObject({ method: 'agents.sessions.setStatus', args: { status: 'active' } });
  });

  it('refuses a fourth conversation while one person has three running', async () => {
    const client = fakeClient();
    const releases: Array<(v: string) => void> = [];
    exec.run.mockImplementation(() => new Promise<string>(r => { releases.push(r); }));
    const dm = `D${++seq}`;
    const running = [1, 2, 3].map(() => runAgentTurn(turn(client, { channelId: dm, userId: 'U-CAP' })));
    await vi.waitFor(() => expect(exec.run).toHaveBeenCalledTimes(3));
    const fourth = turn(client, { channelId: dm, userId: 'U-CAP' });
    await runAgentTurn(fourth);
    expect(exec.run).toHaveBeenCalledTimes(3);
    expect(fourth.say).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('3 conversations') }));
    releases.forEach(r => r('done'));
    await Promise.all(running);
  });

  it('never puts a finished turn back on Working…', async () => {
    const client = fakeClient();
    let release!: (v: string) => void;
    exec.run.mockReturnValueOnce(new Promise<string>(r => { release = r; }));
    const t = turn(client, { channelId: `D${++seq}` });
    const running = runAgentTurn(t);
    await vi.waitFor(() => expect(exec.run).toHaveBeenCalled());
    const run = agentRuns.get(`${t.channelId}:${t.threadTs}`)!;
    release('Done.');
    await running;
    const before = client.calls.length;
    // An ignored Stop arriving after the reply has ended.
    run.keepAlive();
    await new Promise(r => setTimeout(r, 0));
    expect(client.calls.slice(before)).toEqual([]);
  });

  const replyText = (client: ReturnType<typeof fakeClient>) => client.calls
    .filter(c => c.method === 'chat.startStream' || c.method === 'chat.appendStream' || c.method === 'chat.stopStream')
    .map(c => c.args.markdown_text ?? '').join('');

  it('says so when a reply in a DM thread has lost its earlier conversation', async () => {
    const client = fakeClient();
    exec.run.mockResolvedValue('Sure.');
    const dm = `D${++seq}`;
    await runAgentTurn(turn(client, { channelId: dm, threadTs: '1.0', messageTs: '2.0' }));
    expect(replyText(client)).toBe("_I don't have this thread's earlier conversation any more, so I'm starting fresh._\n\nSure.");
  });

  it('says so when the active project changed since the thread began', async () => {
    const client = fakeClient();
    exec.run.mockResolvedValue('Okay.');
    const dm = `D${++seq}`;
    rememberClaudeSession(`${dm}:1.0`, 's-old', '/other');
    await runAgentTurn(turn(client, { channelId: dm, threadTs: '1.0', messageTs: '2.0', workingDir: '/work' }));
    expect(exec.run.mock.calls[0][1].resumeSessionId).toBeUndefined();
    expect(replyText(client)).toContain('Your active project changed since this thread began');
  });

  it('says nothing about a thread that was reset on purpose, or a new one', async () => {
    const client = fakeClient();
    exec.run.mockResolvedValue('Fresh.');
    await runAgentTurn(turn(client));
    expect(replyText(client)).toBe('Fresh.');
  });

  it('says so when Claude could not resume and started fresh', async () => {
    const client = fakeClient();
    exec.run.mockImplementation(async (_m: string, opts: any) => { opts.onFreshStart?.(); return 'Back again.'; });
    const dm = `D${++seq}`;
    rememberClaudeSession(`${dm}:1.0`, 's-gone', '/work');
    await runAgentTurn(turn(client, { channelId: dm, threadTs: '1.0', messageTs: '2.0' }));
    expect(replyText(client)).toBe("_I couldn't pick up this thread's earlier conversation, so I'm starting fresh._\n\nBack again.");
  });

  it('does not carry a DM\'s latest conversation into an older thread', async () => {
    const client = fakeClient();
    exec.run.mockResolvedValue('ok');
    const dm = `D${++seq}`;
    rememberClaudeSession(`${dm}:9.0`, 's-latest', '/work', dm);
    await runAgentTurn(turn(client, { channelId: dm, threadTs: '1.0', messageTs: '2.0' }));
    expect(exec.run.mock.calls[0][1].resumeSessionId).toBeUndefined();
  });

  it('tells the thread termag is restarting when a shutdown or handover stops its run', async () => {
    const client = fakeClient();
    exec.run.mockImplementation((_m: string, opts: any) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new ClaudeRunStopped()));
    }));
    const running = runAgentTurn(turn(client, { channelId: `D${++seq}` }));
    await vi.waitFor(() => expect(exec.run).toHaveBeenCalled());
    expect(await stopAgentRunsForRestart(2000)).toBe(1);
    await running;
    expect(replyText(client)).toContain('termag is restarting, so I stopped');

    // Until this process holds the connection again, an event already on its
    // way in starts nothing the stop would miss.
    const late = turn(client, { channelId: `D${++seq}` });
    await runAgentTurn(late);
    expect(exec.run).toHaveBeenCalledTimes(1);
    expect(late.say).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('termag is restarting') }));
    acceptAgentRuns();
  });

  it('runs nothing in a thread another process still holds, and says to try again', async () => {
    const client = fakeClient();
    const released: string[] = [];
    const store: AgentThreadStore = {
      saveThread: () => {}, saveDmLast: () => {}, deleteDmLast: () => {}, flush: async () => {}, flushAll: async () => {},
      claimRun: async () => false, renewRun: () => {}, releaseRun: async (c, t) => { released.push(`${c}:${t}`); },
    };
    setAgentThreadStore(store);
    try {
      const t = turn(client, { channelId: `D${++seq}` });
      await runAgentTurn(t);
      expect(exec.run).not.toHaveBeenCalled();
      expect(t.say).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('still finishing your last message') }));
      expect(agentRuns.has(`${t.channelId}:${t.threadTs}`)).toBe(false);
      // It never held the claim, so it releases nothing.
      expect(released).toEqual([]);
    } finally {
      setAgentThreadStore(null);
    }
  });

  it('releases its claim when the turn ends', async () => {
    const client = fakeClient();
    const calls: string[] = [];
    const store: AgentThreadStore = {
      saveThread: () => {}, saveDmLast: () => {}, deleteDmLast: () => {}, flushAll: async () => {},
      claimRun: async (c, t, h) => { calls.push(`claim ${c}:${t} ${h ? 'by this process' : ''}`); return true; },
      renewRun: () => {}, releaseRun: async (c, t) => { await new Promise(r => setTimeout(r, 20)); calls.push(`release ${c}:${t}`); },
      flush: async (c, t, dm) => { await new Promise(r => setTimeout(r, 10)); calls.push(`flush ${c}:${t} ${dm ?? ''}`.trim()); },
    };
    setAgentThreadStore(store);
    exec.run.mockResolvedValue('Done.');
    try {
      const t = turn(client, { channelId: `D${++seq}` });
      await runAgentTurn(t);
      // Its queued writes land, then the claim is released, before the turn returns.
      expect(calls).toEqual([
        `claim ${t.channelId}:${t.threadTs} by this process`,
        `flush ${t.channelId}:${t.threadTs} ${t.channelId}`,
        `release ${t.channelId}:${t.threadTs}`,
      ]);
    } finally {
      setAgentThreadStore(null);
    }
  });

  it('offers a file a reply attaches instead of uploading it', async () => {
    const { mkdtemp, writeFile } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = await mkdtemp(join(tmpdir(), 'turn-attach-'));
    await writeFile(join(dir, 'report.md'), '# report');
    const client: any = fakeClient();
    client.filesUploadV2 = vi.fn();
    exec.run.mockResolvedValue('Here it is.\n[attach: report.md]');
    await runAgentTurn(turn(client, { workingDir: dir, userId: 'U-OFFER' }));
    expect(client.filesUploadV2).not.toHaveBeenCalled();
    const offer = client.calls.find((c: any) => c.method === 'chat.postMessage' && c.args.blocks);
    expect(offer.args.blocks[1].elements[0].action_id).toBe('agent_attach_share');
  });

  it('calls onStart once the turn is really running, and not when it refuses', async () => {
    const client = fakeClient();
    let release!: (v: string) => void;
    exec.run.mockReturnValueOnce(new Promise<string>(r => { release = r; }));
    const dm = `D${++seq}`;
    const started = vi.fn();
    const first = runAgentTurn(turn(client, { channelId: dm, threadTs: '1.0', messageTs: '1.0', onStart: started }));
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1));
    const refused = vi.fn();
    // The thread is busy, so this one refuses before it would start.
    await runAgentTurn(turn(client, { channelId: dm, threadTs: '1.0', messageTs: '2.0', onStart: refused }));
    expect(refused).not.toHaveBeenCalled();
    release('done');
    await first;
  });
});
