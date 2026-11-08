import { describe, expect, it, vi } from 'vitest';
import { AgentReplyStream, postableText } from './session/stream';
import { countingGate, retryAfterSeconds, StreamBudget } from './streamBudget';

function fakeClient(opts: { rateLimitStart?: boolean } = {}) {
  const calls: Array<{ method: string; args: any }> = [];
  return {
    calls,
    methods: () => calls.map(c => c.method),
    apiCall: vi.fn(async (method: string, args: any) => {
      calls.push({ method, args });
      if (opts.rateLimitStart && method === 'chat.startStream') {
        throw Object.assign(new Error('rate limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 30 });
      }
      return { ok: true, ts: method === 'chat.startStream' ? '5.5' : undefined };
    }),
    auth: {} as any,
  };
}

describe('StreamBudget', () => {
  it('allows perMinute starts in any minute, and more as the window slides', () => {
    let t = 0;
    const b = new StreamBudget(2, () => t);
    expect([b.take(), b.take(), b.take()]).toEqual([true, true, false]);
    t = 59_999;
    expect(b.take()).toBe(false);
    t = 60_000;
    expect(b.take()).toBe(true);
  });

  it('takes nothing while a Retry-After is pending', () => {
    let t = 0;
    const b = new StreamBudget(5, () => t);
    b.pause(30);
    expect(b.take()).toBe(false);
    t = 30_000;
    expect(b.take()).toBe(true);
  });

  it('counts an operator\'s starts without refusing them', () => {
    const b = new StreamBudget(1, () => 0);
    const gate = countingGate(b);
    expect([gate.take(), gate.take()]).toEqual([true, true]);
    expect(gate.enforcing).toBe(false);
    expect(b.take()).toBe(false);
  });

  it('reads Slack\'s rate-limit errors', () => {
    expect(retryAfterSeconds({ code: 'slack_webapi_rate_limited_error', retryAfter: 12 })).toBe(12);
    expect(retryAfterSeconds({ data: { error: 'ratelimited' } })).toBe(60);
    expect(retryAfterSeconds(new Error('internal_error'))).toBeNull();
  });
});

describe('AgentReplyStream with a stream budget', () => {
  it('posts the answer whole when there is no budget, and streams nothing', async () => {
    const client = fakeClient();
    const empty = new StreamBudget(1, () => 0);
    empty.take();
    const stream = new AgentReplyStream(client as any, 'C1', '1.0', null, 1000, empty);
    stream.append('Hello ');
    stream.append('there');
    await new Promise(r => setTimeout(r, 10));
    expect(client.methods()).not.toContain('chat.startStream');
    await stream.finish('Hello there');
    expect(client.calls.filter(c => c.method === 'chat.postMessage').map(c => c.args)).toEqual([
      { channel: 'C1', thread_ts: '1.0', markdown_text: 'Hello there' },
    ]);
    // The session settles once the answer is out.
    expect(client.calls.at(-1)).toMatchObject({ method: 'agents.sessions.setStatus', args: { status: 'active' } });
    expect(client.methods()).not.toContain('chat.startStream');
  });

  it('splits a long whole answer at the stream limit, and adds the note', async () => {
    const client = fakeClient();
    const empty = new StreamBudget(1, () => 0);
    empty.take();
    const stream = new AgentReplyStream(client as any, 'C1', '1.0', null, 1000, empty);
    await stream.finish('x'.repeat(13_000), '_Stopped._');
    const posts = client.calls.filter(c => c.method === 'chat.postMessage').map(c => c.args.markdown_text as string);
    expect(posts.map(p => p.length)).toEqual([12_000, 1_000 + '\n\n_Stopped._'.length]);
    expect(posts.join('')).toBe('x'.repeat(13_000) + '\n\n_Stopped._');
  });

  it('streams while there is budget', async () => {
    const client = fakeClient();
    const stream = new AgentReplyStream(client as any, 'C1', '1.0', null, 1000, new StreamBudget(5, () => 0));
    stream.append('Hi');
    await stream.finish('Hi');
    expect(client.methods()).toContain('chat.startStream');
    expect(client.methods()).not.toContain('chat.postMessage');
  });

  it('honours a rate-limited start: pauses the budget and posts whole', async () => {
    const client = fakeClient({ rateLimitStart: true });
    let t = 0;
    const budget = new StreamBudget(5, () => t);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stream = new AgentReplyStream(client as any, 'C1', '1.0', null, 1000, budget);
    stream.append('Hi there');
    await stream.finish('Hi there');
    errors.mockRestore();
    expect(client.calls.filter(c => c.method === 'chat.postMessage').map(c => c.args.markdown_text)).toEqual(['Hi there']);
    expect(budget.take()).toBe(false);
    t = 30_000;
    expect(budget.take()).toBe(true);
  });

  it('keeps streaming an operator\'s reply through a counting gate, even with the budget spent', async () => {
    const client = fakeClient();
    const spent = new StreamBudget(1, () => 0);
    spent.take();
    const stream = new AgentReplyStream(client as any, 'C1', '1.0', null, 1000, countingGate(spent));
    stream.append('Hi');
    await stream.finish('Hi');
    expect(client.methods()).toContain('chat.startStream');
    expect(client.methods()).not.toContain('chat.postMessage');
  });
});

describe('posting the rest of a reply whole', () => {
  it('keeps the indentation a continuation starts with', () => {
    expect(postableText('\n    make test\n')).toBe('    make test');
    expect(postableText('\n\n  \n\tcode')).toBe('\tcode');
    expect(postableText(' \n ')).toBe('');
  });

  it('posts an indented continuation as is when the next stream gets no budget', async () => {
    const client = fakeClient();
    const one = new StreamBudget(1, () => 0);
    const stream = new AgentReplyStream(client as any, 'C1', '1.0', null, 1000, one);
    const answer = 'x'.repeat(12_000) + '\n    make test';
    await stream.finish(answer);
    expect(client.calls.filter(c => c.method === 'chat.startStream')).toHaveLength(1);
    expect(client.calls.filter(c => c.method === 'chat.postMessage').map(c => c.args.markdown_text)).toEqual(['    make test']);
  });
});

describe('a refused start in the middle of a streamed reply', () => {
  it('posts the continuation with its paragraph break and indented code, through append and flush', async () => {
    const client = fakeClient();
    // One start: the reply's first stream takes it, and the one after it is refused.
    const budget = new StreamBudget(1, () => 0);
    const stream = new AgentReplyStream(client as any, 'C1', '1.0', null, 1, budget);
    const first = 'x'.repeat(12_000);
    const rest = '\n\n    make test\n    make lint\n\nBoth pass.';
    stream.append(first);
    await vi.waitFor(() => expect(client.methods()).toContain('chat.startStream'));
    // The full stream is ended to make room, and the next start is refused.
    stream.append(rest);
    await vi.waitFor(() => expect(client.methods()).toContain('chat.stopStream'));
    await new Promise(r => setTimeout(r, 10));
    await stream.finish(first + rest);
    expect(client.calls.filter(c => c.method === 'chat.startStream')).toHaveLength(1);
    expect(client.calls.filter(c => c.method === 'chat.postMessage').map(c => c.args.markdown_text))
      .toEqual(['    make test\n    make lint\n\nBoth pass.']);
  });

  it('leaves the continuation unsent, indentation included, when a restart fails outright', async () => {
    const client = fakeClient();
    let starts = 0;
    const apiCall = client.apiCall.getMockImplementation()!;
    client.apiCall.mockImplementation(async (method: string, args: any) => {
      if (method === 'chat.startStream' && ++starts > 1) { client.calls.push({ method, args }); throw new Error('internal_error'); }
      return apiCall(method, args);
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // No budget: an operator's stream, whose fallback is deliver() posting unsent().
    const stream = new AgentReplyStream(client as any, 'C1', '1.0', null, 1);
    const first = 'x'.repeat(12_000);
    const rest = '\n\n    make test\n\nDone.';
    stream.append(first);
    await vi.waitFor(() => expect(starts).toBe(1));
    stream.append(rest);
    await vi.waitFor(() => expect(starts).toBe(2));
    await new Promise(r => setTimeout(r, 10));
    await expect(stream.finish(first + rest)).rejects.toThrow('internal_error');
    errors.mockRestore();
    expect(postableText(stream.unsent(first + rest))).toBe('    make test\n\nDone.');
  });
});
