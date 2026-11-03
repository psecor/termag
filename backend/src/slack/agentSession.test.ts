import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ackEmoji, agentPersona, AgentReplyStream, choiceBlocks, choiceLabels, claimThread, claudeSessionFor, isAgentApp,
  parseChoiceValue, publishSuggestedPrompts, ReplyTagGate, rememberClaudeSession, remainder,
  resetAgentCheck, resetAgentConversation, sessionTitle, splitMarkdown, stripTags, suggestedPrompts,
  acceptAgentRuns, agentRuns, hydrateAgentThreads, resetAgentThreadsForTests, setAgentThreadStore, stopAgentRunsForRestart,
  threadHistory, type AgentThreadStore,
} from './agentSession';

function fakeClient(scopes: string[] = ['chat:write', 'assistant:write']) {
  const calls: Array<{ method: string; args: Record<string, any> }> = [];
  const client = {
    calls,
    auth: { test: vi.fn(async () => ({ ok: true, response_metadata: { scopes } })) },
    apiCall: vi.fn(async (method: string, args: Record<string, any> = {}) => {
      calls.push({ method, args });
      return { ok: true, ts: method === 'chat.startStream' ? '111.222' : undefined };
    }),
  };
  return client;
}

describe('sessionTitle', () => {
  it('uses the first non-empty line', () => {
    expect(sessionTitle('\n  Fix the login bug  \nmore detail')).toBe('Fix the login bug');
  });
  it('truncates long prompts', () => {
    const t = sessionTitle('x'.repeat(200));
    expect(t).toHaveLength(60);
    expect(t.endsWith('…')).toBe(true);
  });
});

describe('remainder', () => {
  it('is everything when nothing streamed', () => {
    expect(remainder('', 'whole answer')).toBe('whole answer');
  });
  it('is the unstreamed tail', () => {
    expect(remainder('Hello wor', 'Hello world')).toBe('ld');
  });
  it('ignores whitespace the final text trimmed', () => {
    expect(remainder('\nHello world\n', 'Hello world')).toBe('');
  });
  it('never sends again blank space that already went out', () => {
    expect(remainder('Para one.\n\n', 'Para one.\n\nPara two.')).toBe('Para two.');
    expect(remainder('Para one.\n', 'Para one.\n\nPara two.')).toBe('\nPara two.');
    // The final text is trimmed at the end; what went out need not be.
    expect(remainder('Done.\n\n', 'Done.')).toBe('');
  });
  it('sends nothing more when the final text does not extend the stream', () => {
    expect(remainder('Something else', 'Hello world')).toBe('');
  });
});

describe('splitMarkdown', () => {
  it('splits at the limit', () => {
    expect(splitMarkdown('abcdefg', 3)).toEqual(['abc', 'def', 'g']);
    expect(splitMarkdown('')).toEqual([]);
  });
});

describe('isAgentApp', () => {
  beforeEach(() => resetAgentCheck());

  it('is true when the token has assistant:write', async () => {
    expect(await isAgentApp(fakeClient() as any)).toBe(true);
  });
  it('is false without it', async () => {
    expect(await isAgentApp(fakeClient(['chat:write']) as any)).toBe(false);
  });
  it('is false when auth.test fails', async () => {
    const client = fakeClient();
    client.auth.test.mockRejectedValueOnce(new Error('invalid_auth'));
    expect(await isAgentApp(client as any)).toBe(false);
  });
  it('caches the answer for five minutes', async () => {
    const client = fakeClient();
    await isAgentApp(client as any, 0);
    await isAgentApp(client as any, 60_000);
    expect(client.auth.test).toHaveBeenCalledTimes(1);
    await isAgentApp(client as any, 5 * 60_000 + 1);
    expect(client.auth.test).toHaveBeenCalledTimes(2);
  });
});

describe('suggested prompts', () => {
  it('name the active project', () => {
    const p = suggestedPrompts('termag/review-fix');
    expect(p.title).toBe('Working in termag/review-fix');
    expect(p.prompts[0].title).toBe('Tour termag/review-fix');
    expect(p.prompts.length).toBeLessThanOrEqual(4);
  });
  it('say how to pick a project when there is none', () => {
    expect(suggestedPrompts(null, '/tdev').title).toContain('`/tdev switch <project>`');
  });
  it('are set on the Messages tab, never on a thread', async () => {
    const client = fakeClient();
    await publishSuggestedPrompts(client as any, 'D1', suggestedPrompts(null));
    expect(client.calls[0].method).toBe('assistant.threads.setSuggestedPrompts');
    expect(client.calls[0].args.channel_id).toBe('D1');
    expect(client.calls[0].args).not.toHaveProperty('thread_ts');
  });
});

describe('the agent turn timeout', () => {
  it('falls back to 30 minutes when SLACK_AGENT_TIMEOUT_MINUTES is not a number', async () => {
    const before = process.env.SLACK_AGENT_TIMEOUT_MINUTES;
    process.env.SLACK_AGENT_TIMEOUT_MINUTES = 'thirty';
    vi.resetModules();
    const fresh = await import('./agentSession');
    expect(fresh.AGENT_TIMEOUT_MS).toBe(30 * 60 * 1000);
    if (before === undefined) delete process.env.SLACK_AGENT_TIMEOUT_MINUTES;
    else process.env.SLACK_AGENT_TIMEOUT_MINUTES = before;
  });
});

describe('claude sessions per thread', () => {
  it('resumes only from the same working directory', () => {
    rememberClaudeSession('D1:1.0', 'sess-1', '/home/a/proj');
    expect(claudeSessionFor('D1:1.0', '/home/a/proj')).toEqual({ sessionId: 'sess-1', carried: false });
    expect(claudeSessionFor('D1:1.0', '/home/a/other')).toBeUndefined();
    expect(claudeSessionFor('D1:2.0', '/home/a/proj')).toBeUndefined();
  });

  it('carries the DM\'s last session into a new thread for half an hour', () => {
    rememberClaudeSession('D9:1.0', 'sess-9', '/p', 'D9', 0);
    expect(claudeSessionFor('D9:5.0', '/p', 'D9', 29 * 60_000)).toEqual({ sessionId: 'sess-9', carried: true });
    expect(claudeSessionFor('D9:5.0', '/p', 'D9', 31 * 60_000)).toBeUndefined();
    expect(claudeSessionFor('D9:5.0', '/other', 'D9', 60_000)).toBeUndefined();
    expect(claudeSessionFor('D8:5.0', '/p', 'D8', 60_000)).toBeUndefined();
  });

  it('prefers the thread\'s own session over the DM\'s last', () => {
    rememberClaudeSession('D7:1.0', 'old-thread', '/p', 'D7', 0);
    rememberClaudeSession('D7:2.0', 'newer', '/p', 'D7', 1000);
    expect(claudeSessionFor('D7:1.0', '/p', 'D7', 2000)).toEqual({ sessionId: 'old-thread', carried: false });
  });
});

describe('agentPersona', () => {
  it('warns about a shared channel only in one', () => {
    expect(agentPersona({ inChannel: true })).toContain('shared Slack channel');
    expect(agentPersona({ inChannel: false })).not.toContain('shared Slack channel');
  });
});

describe('ackEmoji', () => {
  it('picks a reaction from the subject', () => {
    expect(ackEmoji("what's on my calendar today?")).toBe('date');
    expect(ackEmoji('can you find some availability next week')).toBe('date');
    expect(ackEmoji('did the deploy go out?')).toBe('rocket');
    expect(ackEmoji('review PR 123 for me')).toBe('mag');
    expect(ackEmoji('why are the tests failing')).toBe('test_tube');
    expect(ackEmoji('check my inbox')).toBe('email');
  });
  it('is none for other subjects', () => {
    expect(ackEmoji('hey what do you think of this idea')).toBeNull();
  });
  it('matches whole words only', () => {
    expect(ackEmoji('our relationship with the vendor')).toBeNull();
  });
});

const stripReactions = (t: string) => { const r = stripTags(t); return { reaction: r.reaction, text: r.text }; };

describe('resetting a conversation', () => {
  it('forgets a DM thread\'s session and what a new thread would carry over', () => {
    rememberClaudeSession('D50:1.0', 's-dm', '/p', 'D50');
    expect(resetAgentConversation({ channel: 'D50', threadTs: '1.0', userId: 'U1', inDM: true })).toEqual({ reset: true });
    expect(claudeSessionFor('D50:1.0', '/p', 'D50')).toBeUndefined();
    expect(claudeSessionFor('D50:2.0', '/p', 'D50')).toBeUndefined();
  });
  it('lets only a channel thread\'s owner reset it', () => {
    claimThread('C50:1.0', 'UA');
    rememberClaudeSession('C50:1.0', 's-ch', '/p');
    expect(resetAgentConversation({ channel: 'C50', threadTs: '1.0', userId: 'UB', inDM: false })).toEqual({ reset: false, owner: 'UA' });
    expect(claudeSessionFor('C50:1.0', '/p')?.sessionId).toBe('s-ch');
    expect(resetAgentConversation({ channel: 'C50', threadTs: '1.0', userId: 'UA', inDM: false })).toEqual({ reset: true });
    expect(claudeSessionFor('C50:1.0', '/p')).toBeUndefined();
  });
});

describe('thread owners', () => {
  it('evict idle threads first, and a thread that loses its owner loses its session', () => {
    claimThread('E:old', 'UA');
    rememberClaudeSession('E:old', 's-old', '/p');
    claimThread('E:busy', 'UB');
    rememberClaudeSession('E:busy', 's-busy', '/p');
    for (let i = 0; i < 500; i++) {
      if (i === 250) claimThread('E:busy', 'UB');
      claimThread(`E:${i}`, 'UX');
    }
    // Whoever reaches the evicted thread next owns it, and starts fresh.
    expect(claudeSessionFor('E:old', '/p')).toBeUndefined();
    expect(claimThread('E:old', 'UZ')).toBe('UZ');
    // The busy thread was used recently, so it keeps its owner and its session.
    expect(claimThread('E:busy', 'UZ')).toBe('UB');
    expect(claudeSessionFor('E:busy', '/p')?.sessionId).toBe('s-busy');
  });
});

describe('stripTags: reactions', () => {
  it('takes a tag off the front', () => {
    expect(stripReactions('[react:+1]\nOn it.')).toEqual({ reaction: '+1', text: 'On it.' });
    expect(stripReactions('[react: :white_check_mark: ]')).toEqual({ reaction: 'white_check_mark', text: '' });
  });
  it('takes a tag out after a tool call, with its line', () => {
    expect(stripReactions('Reviewing PR #421 now.\n\n[react:mag]\nReview of #421: 10 findings.'))
      .toEqual({ reaction: 'mag', text: 'Reviewing PR #421 now.\n\nReview of #421: 10 findings.' });
  });
  it('takes a tag out of the middle or end of a line', () => {
    expect(stripReactions('Shipped! [react:tada]')).toEqual({ reaction: 'tada', text: 'Shipped! ' });
    expect(stripReactions('Sure [react:+1] doing it')).toEqual({ reaction: '+1', text: 'Sure doing it' });
  });
  it('keeps the first tag as the reaction and drops the rest', () => {
    expect(stripReactions('[react:eyes]\nHi\n[react:+1]\nBye')).toEqual({ reaction: 'eyes', text: 'Hi\nBye' });
  });
  it('leaves other brackets alone', () => {
    expect(stripReactions('See [the docs](https://x.y) and [react to this]')).toEqual({
      reaction: null, text: 'See [the docs](https://x.y) and [react to this]',
    });
  });
});

describe('ReplyTagGate', () => {
  function run(chunks: string[]) {
    const reactions: string[] = [];
    let text = '';
    const gate = new ReplyTagGate((kind, v) => { if (kind === 'react') reactions.push(v); }, t => { text += t; });
    chunks.forEach(c => gate.push(c));
    gate.end();
    return { reactions, text };
  }

  it('reacts on a tag split across chunks and streams the rest', () => {
    expect(run(['[re', 'act:+', '1]', '\n', 'Sent ', 'it.'])).toEqual({ reactions: ['+1'], text: 'Sent it.' });
  });
  it('passes text with no tag straight through', () => {
    expect(run(['Hey', ' there'])).toEqual({ reactions: [], text: 'Hey there' });
  });
  it('streams nothing for a tag alone', () => {
    expect(run(['[react:pray]'])).toEqual({ reactions: ['pray'], text: '' });
  });
  it('lets go of a held bracket that never became a tag', () => {
    expect(run(['Array is ', '[re'])).toEqual({ reactions: [], text: 'Array is [re' });
  });
  it('gives the same tags and text however a reply with code is chunked', () => {
    const reply = 'Here `[react:+1]` is code.\n```\n[choices: X | Y]\n```\n[react:tada]\nDone [attach: q.md] here\n[choices: Post | Skip]\n[attach: out/r.png]';
    const tagsOf = (chunks: string[]) => {
      const tags: string[] = [];
      let text = '';
      const gate = new ReplyTagGate((k, v) => tags.push(`${k}:${v}`), t => { text += t; });
      chunks.forEach(c => gate.push(c));
      gate.end();
      return { tags, text };
    };
    const whole = tagsOf([reply]);
    expect(whole.tags).toEqual(['react:tada', 'choices:Post | Skip', 'attach:out/r.png']);
    for (let size = 1; size <= 9; size++) {
      expect(tagsOf(reply.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g'))!)).toEqual(whole);
    }
  });
  it('gives the same text however the reply is chunked', () => {
    const reply = 'Reviewing termag PR #421 now.\n\n[react:mag]\nReview of #421:\n- **Crash risk** [see](x)';
    const whole = stripReactions(reply);
    for (let size = 1; size <= 7; size++) {
      const chunks = reply.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g'))!;
      expect(run(chunks)).toEqual({ reactions: [whole.reaction], text: whole.text });
    }
  });
});

describe('stripTags: choices and attachments', () => {
  it('turns a choices tag into button labels and hides it', () => {
    const r = stripTags('10 findings. Want me to post them as inline comments?\n[choices: Post them | Not now]');
    expect(r.choices).toEqual(['Post them', 'Not now']);
    expect(r.text).toBe('10 findings. Want me to post them as inline comments?\n');
  });
  it('collects every attachment and keeps the first choice list', () => {
    const r = stripTags('Here:\n[attach: /tmp/a.png]\n[attach: out/b.csv]\n[choices: A | B]\n[choices: C | D]');
    expect(r.attachments).toEqual(['/tmp/a.png', 'out/b.csv']);
    expect(r.choices).toEqual(['A', 'B']);
    expect(r.text).toBe('Here:\n');
  });
  it('ignores a reaction that is not an emoji name', () => {
    expect(stripTags('[react: thumbs up!]\nOk').reaction).toBeNull();
  });
});

describe('stripTags: code and lines', () => {
  it('leaves tags in inline code alone', () => {
    const reply = 'Add `[attach: <path>]` on its own line, or `[react:+1]` to react.';
    expect(stripTags(reply)).toEqual({ reaction: null, choices: [], attachments: [], text: reply });
  });
  it('leaves tags in a fenced block alone', () => {
    const reply = 'Like this:\n```\n[choices: Post them | Not now]\n[attach: notes.md]\n```\nThat is all.';
    expect(stripTags(reply)).toEqual({ reaction: null, choices: [], attachments: [], text: reply });
  });
  it('takes choices and attach only alone on a line', () => {
    const quoted = 'The PR body says: [attach: notes.md] and [choices: A | B].';
    expect(stripTags(quoted)).toEqual({ reaction: null, choices: [], attachments: [], text: quoted });
    const mixed = '[attach: a.png] see above';
    expect(stripTags(mixed).attachments).toEqual([]);
    expect(stripTags(mixed).text).toBe(mixed);
  });
  it('allows spaces around a tag that is alone on its line', () => {
    const r = stripTags('Pick one:\n  [choices: A | B]  \nOr ask.');
    expect(r.choices).toEqual(['A', 'B']);
    expect(r.text).toBe('Pick one:\nOr ask.');
  });
  it('acts again once a fence closes', () => {
    const r = stripTags('```\n[attach: x.png]\n```\n[attach: y.png]');
    expect(r.attachments).toEqual(['y.png']);
    expect(r.text).toBe('```\n[attach: x.png]\n```\n');
  });
});

describe('choices', () => {
  it('caps the number and length of labels', () => {
    expect(choiceLabels(' a | | b |c|d|e|f ')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(choiceLabels('x'.repeat(100))[0]).toHaveLength(75);
  });
  it('round-trips who may answer through the button value', () => {
    const [block] = choiceBlocks(['Post them', 'Not now'], 'U1');
    expect(block.elements.map(e => e.action_id)).toEqual(['agent_choice_0', 'agent_choice_1']);
    expect(parseChoiceValue(block.elements[1].value)).toEqual({ forUser: 'U1', choice: 'Not now' });
    expect(parseChoiceValue('not json')).toBeNull();
  });
});

describe('AgentReplyStream', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts with the first text, batches the rest, and stops with the unstreamed tail', async () => {
    const client = fakeClient();
    const stream = new AgentReplyStream(client as any, 'D1', '1.0', null, 1000);
    stream.append('Hel');
    await vi.advanceTimersByTimeAsync(0);
    stream.append('lo ');
    stream.append('wor');
    await vi.advanceTimersByTimeAsync(1000);
    await stream.finish('Hello world');

    expect(client.calls.map(c => [c.method, c.args.markdown_text])).toEqual([
      ['chat.startStream', 'Hel'],
      ['chat.appendStream', 'lo wor'],
      ['chat.stopStream', 'ld'],
    ]);
    expect(client.calls[0].args).toMatchObject({ channel: 'D1', thread_ts: '1.0' });
    expect(client.calls[2].args).toMatchObject({ channel: 'D1', ts: '111.222' });
  });

  it('names the recipient when streaming into a channel', async () => {
    const client = fakeClient();
    await new AgentReplyStream(client as any, 'C1', '1.0', { userId: 'U1', teamId: 'T1' }).finish('Hi all');
    expect(client.calls[0]).toMatchObject({
      method: 'chat.startStream',
      args: { channel: 'C1', thread_ts: '1.0', recipient_user_id: 'U1', recipient_team_id: 'T1' },
    });
  });

  it('sends no recipient in a DM', async () => {
    const client = fakeClient();
    await new AgentReplyStream(client as any, 'D1', '1.0').finish('Hi');
    expect(client.calls[0].args).not.toHaveProperty('recipient_user_id');
  });

  it('adds no blank lines when a flush ended on a paragraph break', async () => {
    const client = fakeClient();
    const stream = new AgentReplyStream(client as any, 'D1', '1.0', null, 1000);
    stream.append('Para one.\n\n');
    await vi.advanceTimersByTimeAsync(0);
    stream.append('Para two.');
    await stream.finish('Para one.\n\nPara two.');
    const text = client.calls.map(c => c.args.markdown_text ?? '').join('');
    expect(text).toBe('Para one.\n\nPara two.');
  });

  it('sends the whole answer when nothing streamed', async () => {
    const client = fakeClient();
    await new AgentReplyStream(client as any, 'D1', '1.0').finish('All at once');
    expect(client.calls.map(c => c.method)).toEqual(['chat.startStream', 'chat.stopStream']);
    expect(client.calls[0].args.markdown_text).toBe('All at once');
  });

  it('puts a note after the text', async () => {
    const client = fakeClient();
    const stream = new AgentReplyStream(client as any, 'D1', '1.0', null, 1000);
    stream.append('Partial');
    await vi.advanceTimersByTimeAsync(0);
    await stream.finish(null, '_Stopped._');
    expect(client.calls.at(-1)).toMatchObject({ method: 'chat.stopStream', args: { markdown_text: '\n\n_Stopped._' } });
  });

  it('continues in a new message when Slack has closed the stream', async () => {
    const client = fakeClient();
    const real = client.apiCall.getMockImplementation()!;
    client.apiCall.mockImplementation(async (method: string, args: Record<string, any> = {}) => {
      if (method === 'chat.appendStream') {
        client.calls.push({ method, args });
        throw new Error('message_not_in_streaming_state');
      }
      return real(method, args);
    });
    const stream = new AgentReplyStream(client as any, 'D1', '1.0', null, 1000);
    stream.append('Pulling up the PR now.');
    await vi.advanceTimersByTimeAsync(0);
    stream.append('\n\nLooks good.');
    await vi.advanceTimersByTimeAsync(1000);
    await stream.finish('Pulling up the PR now.\n\nLooks good.');
    expect(client.calls.map(c => [c.method, c.args.markdown_text])).toEqual([
      ['chat.startStream', 'Pulling up the PR now.'],
      ['chat.appendStream', '\n\nLooks good.'],
      ['chat.startStream', 'Looks good.'],
      ['chat.stopStream', undefined],
    ]);
  });

  it('keeps buffered text for the fallback when the stream cannot start on Stop', async () => {
    const client = fakeClient();
    client.apiCall.mockImplementation(async (method: string, args: Record<string, any> = {}) => {
      client.calls.push({ method, args });
      if (method === 'chat.startStream') throw new Error('internal_error');
      return { ok: true };
    });
    const stream = new AgentReplyStream(client as any, 'D1', '1.0', null, 1000);
    stream.append('Partial answer');
    await expect(stream.finish(null, '_Stopped._')).rejects.toThrow('internal_error');
    expect(stream.unsent(null, '_Stopped._')).toBe('Partial answer\n\n_Stopped._');
  });

  it('only settles the status when the stream is gone and nothing is left to say', async () => {
    const client = fakeClient();
    const real = client.apiCall.getMockImplementation()!;
    client.apiCall.mockImplementation(async (method: string, args: Record<string, any> = {}) => {
      if (method === 'chat.stopStream') throw new Error('message_not_in_streaming_state');
      return real(method, args);
    });
    const stream = new AgentReplyStream(client as any, 'D1', '1.0', null, 1000);
    stream.append('Done.');
    await vi.advanceTimersByTimeAsync(0);
    await stream.finish('Done.');
    expect(client.calls.at(-1)).toMatchObject({ method: 'agents.sessions.setStatus', args: { status: 'active' } });
  });

  it('only clears the status when there is nothing to say', async () => {
    const client = fakeClient();
    await new AgentReplyStream(client as any, 'D1', '1.0').finish(null);
    expect(client.calls).toEqual([
      { method: 'agents.sessions.setStatus', args: { channel_id: 'D1', thread_ts: '1.0', status: 'active' } },
    ]);
  });

  it('spreads an answer over several streams, since one holds 12,000 characters in all', async () => {
    const client = fakeClient();
    await new AgentReplyStream(client as any, 'D1', '1.0').finish('x'.repeat(25_000));
    expect(client.calls.map(c => [c.method, c.args.markdown_text?.length, c.args.session_status])).toEqual([
      ['chat.startStream', 12_000, undefined],
      // Ended mid-reply, the session stays "Working…".
      ['chat.stopStream', undefined, 'processing'],
      ['chat.startStream', 12_000, undefined],
      ['chat.stopStream', undefined, 'processing'],
      ['chat.startStream', 1_000, undefined],
      ['chat.stopStream', undefined, undefined],
    ]);
  });

  it('starts a new stream before an append would take it past the total limit', async () => {
    const client = fakeClient();
    const stream = new AgentReplyStream(client as any, 'D1', '1.0', null, 1000);
    stream.append('x'.repeat(11_000));
    await vi.advanceTimersByTimeAsync(0);
    stream.append('y'.repeat(2_000));
    await vi.advanceTimersByTimeAsync(1000);
    await stream.finish('x'.repeat(11_000) + 'y'.repeat(2_000));
    expect(client.calls.map(c => c.method)).toEqual([
      'chat.startStream', 'chat.stopStream', 'chat.startStream', 'chat.stopStream',
    ]);
    expect(client.calls[2].args.markdown_text).toBe('y'.repeat(2_000));
  });

  it('does not repost an append that failed for another reason', async () => {
    const client = fakeClient();
    const real = client.apiCall.getMockImplementation()!;
    client.apiCall.mockImplementation(async (method: string, args: Record<string, any> = {}) => {
      if (method === 'chat.appendStream') {
        client.calls.push({ method, args });
        throw Object.assign(new Error('An API error occurred: internal_error'), { data: { error: 'internal_error' } });
      }
      return real(method, args);
    });
    const stream = new AgentReplyStream(client as any, 'D1', '1.0', null, 1000);
    stream.append('One. ');
    await vi.advanceTimersByTimeAsync(0);
    stream.append('Two.');
    await vi.advanceTimersByTimeAsync(1000);
    // Only one stream was ever started: the failed append was not retried as a new message.
    expect(client.calls.filter(c => c.method === 'chat.startStream')).toHaveLength(1);
    // And the text it carried is still there for whatever ends the reply.
    expect(stream.unsent(null)).toBe('Two.');
  });

  it('keeps blank space that went out just before a stream closed', async () => {
    const client = fakeClient();
    const real = client.apiCall.getMockImplementation()!;
    let failNext = false;
    client.apiCall.mockImplementation(async (method: string, args: Record<string, any> = {}) => {
      if (method === 'chat.appendStream' && failNext) {
        failNext = false;
        client.calls.push({ method, args });
        throw Object.assign(new Error('message_not_in_streaming_state'), { data: { error: 'message_not_in_streaming_state' } });
      }
      return real(method, args);
    });
    const stream = new AgentReplyStream(client as any, 'D1', '1.0', null, 1000);
    stream.append('Pulling up the PR.');
    await vi.advanceTimersByTimeAsync(0);
    failNext = true;
    stream.append('\n\n');
    await vi.advanceTimersByTimeAsync(1000);
    stream.append('Looks good.');
    await vi.advanceTimersByTimeAsync(1000);
    await stream.finish('Pulling up the PR.\n\nLooks good.');
    expect(client.calls.map(c => [c.method, c.args.markdown_text])).toEqual([
      ['chat.startStream', 'Pulling up the PR.'],
      ['chat.appendStream', '\n\n'],
      ['chat.startStream', 'Looks good.'],
      // Nothing is left over to repeat.
      ['chat.stopStream', undefined],
    ]);
  });
});

describe('saving threads', () => {
  function fakeStore() {
    const calls: Array<[string, ...unknown[]]> = [];
    const store: AgentThreadStore = {
      saveThread: (...a) => { calls.push(['saveThread', ...a]); },
      saveDmLast: (...a) => { calls.push(['saveDmLast', ...a]); },
      deleteDmLast: (...a) => { calls.push(['deleteDmLast', ...a]); },
      flush: async () => {}, flushAll: async () => {},
      claimRun: async () => true, renewRun: () => {}, releaseRun: async () => {},
    };
    return { store, calls };
  }
  beforeEach(() => resetAgentThreadsForTests());
  afterEach(() => setAgentThreadStore(null));

  it('writes sessions, a DM\'s carry-over, owners and resets through to the store', () => {
    const { store, calls } = fakeStore();
    setAgentThreadStore(store);
    rememberClaudeSession('D70:1.0', 's1', '/p', 'D70', 1000);
    claimThread('C70:2.0', 'UA');
    claimThread('C70:2.0', 'UB');
    resetAgentConversation({ channel: 'D70', threadTs: '1.0', userId: 'U1', inDM: true });
    expect(calls).toEqual([
      ['saveThread', 'D70', '1.0', { claudeSessionId: 's1', workingDir: '/p', resetAt: null }],
      ['saveDmLast', 'D70', { claudeSessionId: 's1', workingDir: '/p', at: new Date(1000) }],
      // Only the first claim saves an owner, and it clears any saved conversation.
      ['saveThread', 'C70', '2.0', { ownerSlackId: 'UA', claudeSessionId: null, workingDir: null }],
      ['saveThread', 'D70', '1.0', { claudeSessionId: null, workingDir: null, resetAt: expect.any(Date) }],
      ['deleteDmLast', 'D70'],
    ]);
  });

  it('brings saved sessions, owners and resets back after a restart', () => {
    const at = (ms: number) => new Date(ms);
    hydrateAgentThreads([
      { channelId: 'C71', threadTs: '1.0', ownerSlackId: 'UA', claudeSessionId: 's-ch', workingDir: '/p', resetAt: null, updatedAt: at(10) },
      { channelId: 'D71', threadTs: '2.0', ownerSlackId: null, claudeSessionId: null, workingDir: null, resetAt: at(20), updatedAt: at(20) },
    ], [
      { channelId: 'D71', claudeSessionId: 's-dm', workingDir: '/p', at: at(3_000_000) },
      { channelId: 'D72', claudeSessionId: 's-old', workingDir: '/p', at: at(0) },
    ], 3_000_000 + 60_000);
    expect(claudeSessionFor('C71:1.0', '/p')).toEqual({ sessionId: 's-ch', carried: false });
    expect(claimThread('C71:1.0', 'UB')).toBe('UA');
    expect(threadHistory('D71:2.0', '/p')).toBe('reset');
    // A DM's carry-over comes back only while it is under half an hour old.
    expect(claudeSessionFor('D71:3.0', '/p', 'D71', 3_000_000 + 60_000)).toEqual({ sessionId: 's-dm', carried: true });
    // 51 minutes old when the process came back: not loaded.
    expect(claudeSessionFor('D72:3.0', '/p', 'D72', 3_000_000 + 60_000)).toBeUndefined();
  });

  it('never hands a saved conversation to someone who claimed the thread before the load', () => {
    // The load failed at start; UB @mentions in UA's thread and claims it.
    expect(claimThread('C76:1.0', 'UB')).toBe('UB');
    // The retried load then brings back UA's row.
    hydrateAgentThreads([
      { channelId: 'C76', threadTs: '1.0', ownerSlackId: 'UA', claudeSessionId: 's-ua', workingDir: '/p', resetAt: null, updatedAt: new Date(0) },
    ], []);
    expect(claimThread('C76:1.0', 'UB')).toBe('UB');
    expect(claudeSessionFor('C76:1.0', '/p')).toBeUndefined();
  });

  it('never lets a saved row replace what this process set since', () => {
    rememberClaudeSession('C73:1.0', 'live', '/p');
    hydrateAgentThreads([
      { channelId: 'C73', threadTs: '1.0', ownerSlackId: null, claudeSessionId: 'stale', workingDir: '/p', resetAt: null, updatedAt: new Date(0) },
    ], []);
    expect(claudeSessionFor('C73:1.0', '/p')?.sessionId).toBe('live');
  });

  it('says what is known of a thread', () => {
    rememberClaudeSession('D74:1.0', 's', '/p');
    expect(threadHistory('D74:1.0', '/p')).toBe('resumable');
    expect(threadHistory('D74:1.0', '/other')).toBe('moved');
    expect(threadHistory('D74:9.0', '/p')).toBe('none');
  });
});

describe('stopping runs for a restart', () => {
  it('stops every run with the restart reason and waits for them to finish', async () => {
    const order: string[] = [];
    let settle!: () => void;
    const finished = new Promise<void>(r => { settle = r; });
    const controller = new AbortController();
    controller.signal.addEventListener('abort', () => { order.push('aborted'); setTimeout(() => { order.push('finished'); settle(); }, 10); });
    agentRuns.set('D75:1.0', { controller, userId: 'U1', keepAlive: () => {}, finished });
    expect(await stopAgentRunsForRestart(2000)).toBe(1);
    expect(agentRuns.get('D75:1.0')?.stopReason).toBe('restart');
    expect(order).toEqual(['aborted', 'finished']);
    agentRuns.delete('D75:1.0');
    acceptAgentRuns();
  });
});

