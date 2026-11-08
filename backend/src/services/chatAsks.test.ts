import { describe, expect, it } from 'vitest';
import { MAX_CHAT_ASK_MESSAGES, MAX_CHAT_ASK_THREADS, chatAskThreadView, noticeState, parseThreadIds, replyState, type ChatAskMessageRow, type ChatAskThreadRow } from './chatAsks';

const at = (s: string) => new Date(`2026-10-29T13:${s}Z`);

function message(over: Partial<ChatAskMessageRow> = {}): ChatAskMessageRow {
  return {
    id: 'a9525f4870115a431e32d6a46', hop: 1, status: 'working', error: null, replyBytes: null, publish: null, publishDetail: null,
    createdAt: at('23:12'), startedAt: at('23:18'), completedAt: null, readAt: null, queuedPrompt: null, supersededById: null,
    ...over,
  };
}

function thread(over: Partial<ChatAskThreadRow> = {}): ChatAskThreadRow {
  return {
    id: 'cmvtr5x6r0i0lafsfuclk9ed5', title: 'Titanic wreck: discovery', hopCount: 1, branch: null, prNumber: null, prUrl: null, prs: [],
    projectId: 'p4', workstream: 'main', repoName: null, instanceId: 'i4', createdAt: at('23:12'),
    project: { name: 'termag-4', instance: { name: 'termag-4' } },
    chatWorkstream: { name: 'ask-cmvtr5x6r0i0lafsfuclk9ed5' },
    messages: [message()],
    ...over,
  };
}

describe('parseThreadIds', () => {
  it('reads comma-separated ids, dropping repeats and blanks', () => {
    expect(parseThreadIds('cmvtr5x6r0i0lafsfuclk9ed5, cmvtr5y1k0i0qbm2pz7xw3d8c,,cmvtr5x6r0i0lafsfuclk9ed5'))
      .toEqual(['cmvtr5x6r0i0lafsfuclk9ed5', 'cmvtr5y1k0i0qbm2pz7xw3d8c']);
  });
  it('treats an absent or empty list as none', () => {
    expect(parseThreadIds(undefined)).toEqual([]);
    expect(parseThreadIds('')).toEqual([]);
  });
  it('refuses the whole list for anything that is not an id, a repeated param, or too many', () => {
    expect(parseThreadIds('cmvtr5x6r0i0lafsfuclk9ed5,../etc')).toBeNull();
    expect(parseThreadIds(['a', 'b'])).toBeNull();
    expect(parseThreadIds(Array.from({ length: MAX_CHAT_ASK_THREADS + 1 }, (_, i) => `cmvtr5x6r0i0lafsfuclk${String(i).padStart(4, '0')}`).join(','))).toBeNull();
  });
});

describe('replyState', () => {
  it('is pending until the message finishes', () => {
    expect(replyState({ status: 'submitted', replyBytes: null, readAt: null })).toBe('pending');
    expect(replyState({ status: 'working', replyBytes: null, readAt: null })).toBe('pending');
  });
  it('says whether a poll got a finished reply', () => {
    expect(replyState({ status: 'completed', replyBytes: 120, readAt: at('25:00') })).toBe('delivered');
    expect(replyState({ status: 'completed', replyBytes: 120, readAt: null })).toBe('dropped');
    expect(replyState({ status: 'failed', replyBytes: null, readAt: null })).toBe('none');
    expect(replyState({ status: 'canceled', replyBytes: null, readAt: null })).toBe('none');
  });
  it('points a superseded message at its follow-up', () => {
    expect(replyState({ status: 'superseded', replyBytes: null, readAt: null })).toBe('follow-up');
  });
});

describe('noticeState', () => {
  const chat = { projectId: 'p1', workstream: 'main' };
  const on = { flagOn: true, chat };
  const to = (over: Record<string, unknown>) => ({ notifyVia: 'chat', notifyProjectId: 'p1', notifyWorkstream: 'main', notice: null, ...over });

  it('is due while the reading chat is to be told and the flag is on for it', () => {
    expect(noticeState(to({}), on)).toBe('due');
    expect(noticeState(to({ notifyVia: 'pane' }), on)).toBe('due');
  });
  it('is none for --no-notify, no sender, the flag off, or a poll that got the finish', () => {
    expect(noticeState(to({ notifyVia: null }), on)).toBe('none');
    expect(noticeState({}, on)).toBe('none');
    expect(noticeState(to({}), { flagOn: false, chat })).toBe('none');
    expect(noticeState(to({ notice: 'off' }), on)).toBe('none');
    expect(noticeState(to({ notice: 'waiter' }), on)).toBe('none');
  });
  it('is sent once the chat or pane was told', () => {
    for (const n of ['chat', 'pane']) expect(noticeState(to({ notice: n }), { flagOn: false, chat })).toBe('sent');
  });
  it('is unsent when one was due and did not go', () => {
    for (const n of ['gone', 'skipped', 'expired', 'failed']) expect(noticeState(to({ notice: n }), on)).toBe('unsent');
  });
  it('is none for a notice that tells another chat: a follow-up another session sent', () => {
    expect(noticeState(to({ notifyProjectId: 'p9' }), on)).toBe('none');
    expect(noticeState(to({ notifyWorkstream: 'review', notice: 'chat' }), on)).toBe('none');
  });
  it('is none for a reader that is no termag chat (the desktop)', () => {
    expect(noticeState(to({}), { flagOn: true, chat: null })).toBe('none');
    expect(noticeState(to({ notice: 'chat' }), { flagOn: true, chat: null })).toBe('none');
  });
  it('takes a message answered together with its follow-up from the follow-up\'s own notice', () => {
    const follow = (n: string | null) => (id: string) => (id === 'b' ? to({ notice: n }) : undefined);
    const a = to({ notice: 'together', supersededById: 'b' });
    expect(noticeState(a, on, follow('chat'))).toBe('sent');
    expect(noticeState(a, on, follow('failed'))).toBe('unsent');
    expect(noticeState(a, on, follow('waiter'))).toBe('none');
    expect(noticeState(a, on, follow(null))).toBe('due');
    expect(noticeState(a, on, () => undefined)).toBe('none');
    expect(noticeState(a, on)).toBe('none');
  });
});

describe('chatAskThreadView', () => {
  const reader = { flagOn: true, chat: { projectId: 'p1', workstream: 'main' } };
  it('says whether each message\'s notice tells the reading chat when it finishes', () => {
    const t = thread({ messages: [message({ notifyVia: 'chat', notifyProjectId: 'p1', notifyWorkstream: 'main', notice: null })] });
    expect(chatAskThreadView(t, reader).messages[0].notice).toBe('due');
    expect(chatAskThreadView(t, { ...reader, flagOn: false }).messages[0].notice).toBe('none');
    expect(chatAskThreadView(t, { ...reader, chat: { projectId: 'p1', workstream: 'review' } }).messages[0].notice).toBe('none');
    expect(chatAskThreadView(t).messages[0].notice).toBe('none');
  });

  it('resolves a superseded message\'s `together` through the follow-up that answered it', () => {
    const notify = { notifyVia: 'chat', notifyProjectId: 'p1', notifyWorkstream: 'main' };
    const t = thread({
      messages: [
        message({ id: 'a', status: 'superseded', supersededById: 'b', notice: 'together', completedAt: at('24:00'), ...notify }),
        message({ id: 'b', status: 'completed', createdAt: at('24:00'), completedAt: at('25:00'), notice: 'failed', ...notify }),
      ],
    });
    expect(chatAskThreadView(t, reader).messages.map(m => m.notice)).toEqual(['unsent', 'unsent']);
  });

  it('names the target as a follow-up would, and the thread\'s own chat', () => {
    const v = chatAskThreadView(thread());
    expect(v).toMatchObject({
      id: 'cmvtr5x6r0i0lafsfuclk9ed5',
      title: 'Titanic wreck: discovery',
      target: 'termag-4/termag-4',
      chat: { projectId: 'p4', workstream: 'ask-cmvtr5x6r0i0lafsfuclk9ed5' },
      prs: [],
      createdAt: '2026-10-29T13:23:12.000Z',
    });
    expect(chatAskThreadView(thread({ workstream: 'review', repoName: 'web' })).target).toBe('termag-4/termag-4@review:web');
  });

  it('falls back to the box id for a removed box, and has no chat for a headless thread', () => {
    const v = chatAskThreadView(thread({ project: { name: 'termag-4', instance: null }, chatWorkstream: null }));
    expect(v.target).toBe('i4/termag-4');
    expect(v.chat).toBeNull();
  });

  it('answers each message\'s state, oldest first, and never a prompt', () => {
    const v = chatAskThreadView(thread({
      messages: [
        message({ id: 'c03e7d1a95b24f60e8d2a17bc', hop: 2, status: 'submitted', createdAt: at('25:21'), startedAt: null, queuedPrompt: 'Add who found it.' }),
        message({ status: 'completed', completedAt: at('25:00'), replyBytes: 210, publish: 'none' }),
      ],
    }));
    expect(v.messages.map(m => m.id)).toEqual(['a9525f4870115a431e32d6a46', 'c03e7d1a95b24f60e8d2a17bc']);
    expect(v.messages[0]).toEqual({
      id: 'a9525f4870115a431e32d6a46', hop: 1, status: 'completed', queued: false, error: null, reply: 'dropped', notice: 'none', supersededBy: null,
      publish: { status: 'none', detail: null },
      createdAt: '2026-10-29T13:23:12.000Z', startedAt: '2026-10-29T13:23:18.000Z', completedAt: '2026-10-29T13:25:00.000Z',
    });
    expect(v.messages[1]).toMatchObject({ hop: 2, status: 'submitted', queued: true, reply: 'pending' });
    expect(JSON.stringify(v)).not.toContain('Add who found it.');
  });

  it('keeps a long thread\'s newest messages', () => {
    const messages = Array.from({ length: MAX_CHAT_ASK_MESSAGES + 5 }, (_, i) => message({ id: `m${String(i).padStart(10, '0')}`, hop: i + 1, createdAt: new Date(Date.UTC(2026, 9, 29, 13, 0, i)) }));
    const v = chatAskThreadView(thread({ messages }));
    expect(v.messages).toHaveLength(MAX_CHAT_ASK_MESSAGES);
    expect(v.messages[0].hop).toBe(6);
    expect(v.messages[v.messages.length - 1].hop).toBe(MAX_CHAT_ASK_MESSAGES + 5);
  });

  it('lists the thread\'s PRs, its own first', () => {
    const v = chatAskThreadView(thread({
      branch: 'termag-jsmith/cmvtr5x6', prNumber: 812, prUrl: 'https://github.com/o/r/pull/812',
      prs: [{ key: 'docs', branch: 'termag-jsmith/cmvtr5x6-docs', prNumber: 813, prUrl: 'https://github.com/o/r/pull/813' }],
    }));
    expect(v.prs.map(p => p.number)).toEqual([812, 813]);
  });
});
