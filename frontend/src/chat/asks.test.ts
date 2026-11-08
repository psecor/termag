import { describe, expect, it } from 'vitest';
import type { ChatItem } from './sdkChat';
import { NOTICE_POLL_FAST_FOR_MS, NOTICE_POLL_GIVE_UP_MS, NOTICE_POLL_SLOW_MS, askAgentName, askNoticePollMs, askCallOf, askCallsOf, askLine, askThreadIds, askViews, askWaitingText, asksSummary, callThreads, paneAskViews, paneKeptAsks, PANE_ASK_KEEP_MS, sendsOf, targetBox, type ChatAskMessage, type ChatAskThread } from './asks';

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

const T1 = 'cmvtr5x6r0i0lafsfuclk9ed5';
const T2 = 'cmvtr5y1k0i0qbm2pz7xw3d8c';
const M1 = 'a9525f4870115a431e32d6a46';
const M2 = 'c03e7d1a95b24f60e8d2a17bc';

const noWaitOut = (m: string, t: string, hop = 1) => `Asked termag-4/termag-4 (hop ${hop}). Nothing keeps the reply: only a \`termag ask --reply ${m}\` waiting when it finishes gets it.\nthread: ${t}`;

function bash(id: string, command: string, over: Partial<ToolItem> = {}): ToolItem {
  return { kind: 'tool', key: `tool:${id}`, id, name: 'Bash', input: { command, description: 'Fire ask' }, inputJson: '', result: '', isError: false, done: true, ...over };
}

function msg(over: Partial<ChatAskMessage> = {}): ChatAskMessage {
  return {
    id: M1, hop: 1, status: 'working', queued: false, error: null, reply: 'pending', notice: 'none', supersededBy: null, publish: null,
    createdAt: '2026-10-29T13:23:12.000Z', startedAt: '2026-10-29T13:23:18.000Z', completedAt: null, ...over,
  };
}

function thread(id: string, over: Partial<ChatAskThread> = {}): ChatAskThread {
  return { id, title: 'Titanic wreck: discovery', target: 'termag-4/termag-4', chat: { projectId: 'p4', workstream: `ask-${id}` }, prs: [], createdAt: '2026-10-29T13:23:12.000Z', messages: [msg()], ...over };
}

describe('askCallOf', () => {
  it('reads a --no-wait ask as Peter\'s session sent it', () => {
    const c = askCallOf(bash('1', `termag ask --no-wait termag-4/termag-4 --title "Titanic wreck: discovery" - < /tmp/tmp.RIEkyJjXXK/titanic-discovery.md 2>&1`, { result: noWaitOut(M1, T1) }));
    expect(c).toEqual({
      kind: 'send', noWait: true, followUp: null, title: 'Titanic wreck: discovery', target: 'termag-4/termag-4', names: null,
      sends: [{ thread: T1, message: M1 }], rejected: null,
    });
  });

  it('reads a waiting ask\'s ids from what it says before it polls', () => {
    const c = askCallOf(bash('1', `cd /tmp && termag ask box/proj@review:web 'What changed?'`, { result: `termag: waiting for box/proj@review:web (message ${M1}, thread ${T1})…\nIt changed.\nthread: ${T1}` }));
    expect(c).toMatchObject({ kind: 'send', noWait: false, target: 'box/proj@review:web', sends: [{ thread: T1, message: M1 }] });
  });

  it('reads a follow-up, a --reply and a --cancel', () => {
    expect(askCallOf(bash('1', `termag ask --no-wait termag-4/termag-4 --thread ${T1} - < f.md`, { result: noWaitOut(M2, T1, 2) }))).toMatchObject({ kind: 'send', followUp: T1, sends: [{ thread: T1, message: M2 }] });
    expect(askCallOf(bash('2', `termag ask --reply ${M1}`))).toMatchObject({ kind: 'reply', names: M1, target: null });
    expect(askCallOf(bash('3', `termag ask --cancel ${M1}`))).toMatchObject({ kind: 'cancel', names: M1 });
  });

  it('reads every ask a loop sent', () => {
    const c = askCallOf(bash('1', 'for f in a b; do termag ask --no-wait termag-4/termag-4 --title "$f" - < "$f.md"; done', { result: `${noWaitOut(M1, T1)}\n${noWaitOut(M2, T2)}` }));
    expect(c?.sends).toEqual([{ thread: T1, message: M1 }, { thread: T2, message: M2 }]);
    // A title from a shell variable isn't the title.
    expect(c?.title).toBeNull();
  });

  it('says what the orchestrator refused', () => {
    expect(askCallOf(bash('1', 'termag ask termag-4/termag-4 hi', { result: 'termag: rejected: too_many_asks', isError: true }))?.rejected).toBe('too_many_asks');
  });

  it('leaves the lookups and anything else alone', () => {
    expect(askCallOf(bash('1', 'termag ask --inbox'))).toBeNull();
    expect(askCallOf(bash('2', 'termag ask --targets --json'))).toBeNull();
    expect(askCallOf(bash('3', 'termag ask --find "light mode"'))).toBeNull();
    expect(askCallOf(bash('4', 'termag space put status.md light-mode-space:'))).toBeNull();
    expect(askCallOf(bash('5', 'echo "use termag ask later"'))).toBeNull();
    expect(askCallOf({ ...bash('6', 'termag ask x/y hi'), name: 'Read' })).toBeNull();
  });
});

describe('sendsOf', () => {
  it('reads --json output too', () => {
    expect(sendsOf(`{"id":"${M1}","contextId":"${T1}","status":{"state":"TASK_STATE_WORKING"}}`)).toEqual([{ thread: T1, message: M1 }]);
  });
  it('names each thread once', () => {
    expect(sendsOf(`termag: waiting for a/b (message ${M1}, thread ${T1})…\nok\nthread: ${T1}`)).toEqual([{ thread: T1, message: M1 }]);
  });
});

describe('callThreads and askViews', () => {
  const peter = [
    bash('1', `termag ask --no-wait termag-4/termag-4 --title "Titanic wreck: discovery" - < a.md`, { result: noWaitOut(M1, T1) }),
    bash('2', `termag ask --no-wait termag-4/termag-4 --title "Titanic wreck: location" - < b.md`, { result: noWaitOut(M2, T2) }),
  ];
  const tools = new Map(peter.map(t => [t.id, t]));
  const calls = askCallsOf(peter);

  it('names the threads the calls sent', () => {
    expect(askThreadIds(calls.values())).toEqual([T1, T2]);
  });

  it('is what the calls printed until the orchestrator answers, and nobody is waiting on a --no-wait ask', () => {
    const views = askViews(calls, callThreads(calls, tools, new Map()), tools, new Map());
    expect([...views.values()].map(v => [v.thread, v.title, v.state, v.waiting, v.noWait, v.known])).toEqual([
      [T1, 'Titanic wreck: discovery', 'starting', 'nobody', true, false],
      [T2, 'Titanic wreck: location', 'starting', 'nobody', true, false],
    ]);
  });

  it('takes its state from the thread\'s newest turn a follow-up didn\'t join', () => {
    const threads = new Map([
      [T1, thread(T1, { messages: [msg({ status: 'superseded', supersededBy: M2, reply: 'follow-up' }), msg({ id: M2, hop: 2, status: 'completed', completedAt: '2026-10-29T13:25:48.000Z', reply: 'dropped', notice: 'sent' })] })],
      [T2, thread(T2, { title: null, messages: [msg({ id: 'm2a0000000', status: 'submitted', queued: true, startedAt: null })] })],
    ]);
    const views = askViews(calls, callThreads(calls, tools, threads), tools, threads);
    expect(views.get(T1)).toMatchObject({ state: 'done', turns: 2, reply: 'dropped', notice: 'sent', known: true, chat: { projectId: 'p4', workstream: `ask-${T1}` } });
    // Untitled on the orchestrator: the call's --title names it.
    expect(views.get(T2)).toMatchObject({ state: 'queued', title: 'Titanic wreck: location' });
  });

  it('is waited on while a call that waits for it still runs', () => {
    const waiting = [bash('1', 'termag ask termag-4/termag-4 hi', { done: false, result: null })];
    const wt = new Map(waiting.map(t => [t.id, t]));
    const wc = askCallsOf(waiting);
    // A background ask prints no ids: it is matched to the chat's thread made since it.
    const threads = new Map([[T1, thread(T1, { title: null })]]);
    const by = callThreads(wc, new Map([['1', { ...waiting[0], startedAt: '2026-10-29T13:23:00.000Z' }]]), threads);
    expect(by.get('1')).toEqual([T1]);
    expect(askViews(wc, by, wt, threads).get(T1)?.waiting).toBe('agent');
  });

  it('is still waited on when the ask has ended but the call waiting for it hasn\'t returned yet', () => {
    const waiting = [bash('1', 'termag ask termag-4/termag-4 hi', { done: false, result: null, startedAt: '2026-10-29T13:23:00.000Z' })];
    const wt = new Map(waiting.map(t => [t.id, t]));
    const wc = askCallsOf(waiting);
    const threads = new Map([[T1, thread(T1, { title: null, messages: [msg({ status: 'completed', completedAt: '2026-10-29T13:25:00.000Z', reply: 'dropped' })] })]]);
    const v = askViews(wc, callThreads(wc, wt, threads), wt, threads).get(T1)!;
    expect(v.waiting).toBe('agent');
    // So it never says the reply went to nobody while the call may still get it.
    expect(askWaitingText(v, 'Claude')).toBeNull();
  });

  it('matches a background ask by its --title, and never takes a thread another call printed', () => {
    const bg = [
      bash('1', `termag ask --no-wait termag-4/termag-4 --title "Titanic wreck: discovery" - < a.md`, { result: noWaitOut(M1, T1) }),
      bash('2', 'termag ask termag-4/termag-4 --title "Titanic wreck: location" - < b.md', { result: 'Command running in background with ID: b7x2', background: 'running' }),
    ];
    const threads = new Map([[T1, thread(T1)], [T2, thread(T2, { title: 'Titanic wreck: location' })]]);
    expect(callThreads(askCallsOf(bg), new Map(bg.map(t => [t.id, t])), threads).get('2')).toEqual([T2]);
  });
});

describe('the words', () => {
  const at = (iso: string) => Date.parse(iso);
  it('say where an ask is', () => {
    expect(askLine({ state: 'working', startedAt: '2026-10-29T13:23:18.000Z', completedAt: null, turns: 1, error: null }, at('2026-10-29T13:24:22.000Z'))).toBe('working · 1m 4s');
    expect(askLine({ state: 'done', startedAt: '2026-10-29T13:23:18.000Z', completedAt: '2026-10-29T13:25:48.000Z', turns: 2, error: null }, 0)).toBe('finished in 2m 30s · 2 turns');
    expect(askLine({ state: 'failed', startedAt: null, completedAt: null, turns: 1, error: 'lost: the run was no longer running on the box' }, 0)).toBe('failed: lost: the run was no longer running on the box');
    expect(askLine({ state: 'queued', startedAt: null, completedAt: null, turns: 1, error: null }, 0)).toBe('queued');
  });

  it('say plainly when nobody is waiting for the reply', () => {
    expect(askWaitingText({ state: 'working', waiting: 'nobody', reply: 'pending' }, 'Claude')).toBe('Claude isn’t waiting for a reply');
    expect(askWaitingText({ state: 'done', waiting: 'nobody', reply: 'dropped' }, 'Claude')).toBe('Not sent back to Claude');
    expect(askWaitingText({ state: 'working', waiting: 'agent', reply: 'pending' }, 'Claude')).toBe('Claude is waiting');
    expect(askWaitingText({ state: 'done', waiting: 'nobody', reply: 'delivered' }, 'Claude')).toBe('Returned to Claude');
    expect(askWaitingText({ state: 'failed', waiting: 'nobody', reply: 'none' }, 'Claude')).toBeNull();
  });

  it('name the chat\'s agent: Codex, or the agent when it is unknown', () => {
    expect(askWaitingText({ state: 'working', waiting: 'agent', reply: 'pending' }, 'Codex')).toBe('Codex is waiting');
    expect(askWaitingText({ state: 'working', waiting: 'nobody', reply: 'pending', notice: 'due' }, 'Codex')).toBe('Codex is told when it finishes');
    expect(askWaitingText({ state: 'working', waiting: 'nobody', reply: 'pending' }, 'Codex')).toBe('Codex isn’t waiting for a reply');
    expect(askWaitingText({ state: 'done', waiting: 'nobody', reply: 'stored', notice: 'sent' }, 'Codex')).toBe('Codex was told it finished');
    expect(askWaitingText({ state: 'done', waiting: 'nobody', reply: 'stored', notice: 'due' }, 'Codex')).toBe('Telling Codex it finished');
    expect(askWaitingText({ state: 'done', waiting: 'nobody', reply: 'delivered' }, 'Codex')).toBe('Returned to Codex');
    expect(askWaitingText({ state: 'done', waiting: 'nobody', reply: 'dropped' }, 'Codex')).toBe('Not sent back to Codex');
    expect(askWaitingText({ state: 'working', waiting: 'agent', reply: 'pending' }, 'the agent')).toBe('The agent is waiting');
    expect(askWaitingText({ state: 'done', waiting: 'nobody', reply: 'dropped' }, 'the agent')).toBe('Not sent back to the agent');
  });

  it('take the agent\'s name from the provider registry', () => {
    expect(askAgentName('claude-chat')).toBe('Claude');
    expect(askAgentName('claude')).toBe('Claude');
    expect(askAgentName('codex')).toBe('Codex');
    expect(askAgentName('pi-chat')).toBe('pi');
    expect(askAgentName(null)).toBe('the agent');
    expect(askAgentName(undefined)).toBe('the agent');
    expect(askAgentName('no-such-provider')).toBe('the agent');
  });

  it('say when Claude is told of the finish instead', () => {
    expect(askWaitingText({ state: 'working', waiting: 'nobody', reply: 'pending', notice: 'due' }, 'Claude')).toBe('Claude is told when it finishes');
    expect(askWaitingText({ state: 'done', waiting: 'nobody', reply: 'stored', notice: 'due' }, 'Claude')).toBe('Telling Claude it finished');
    expect(askWaitingText({ state: 'done', waiting: 'nobody', reply: 'stored', notice: 'sent' }, 'Claude')).toBe('Claude was told it finished');
    expect(askWaitingText({ state: 'failed', waiting: 'nobody', reply: 'none', notice: 'sent' }, 'Claude')).toBe('Claude was told it ended');
    expect(askWaitingText({ state: 'done', waiting: 'nobody', reply: 'delivered', notice: 'sent' }, 'Claude')).toBe('Returned to Claude');
    expect(askWaitingText({ state: 'done', waiting: 'nobody', reply: 'stored', notice: 'unsent' }, 'Claude')).toBe('Not sent back to Claude');
    expect(askWaitingText({ state: 'working', waiting: 'agent', reply: 'pending', notice: 'due' }, 'Claude')).toBe('Claude is waiting');
  });

  it('sum up a list, and name a target\'s box', () => {
    expect(asksSummary([{ state: 'working' }, { state: 'working' }, { state: 'done' }])).toBe('2 working · 1 done');
    expect(asksSummary([{ state: 'queued' }, { state: 'failed' }])).toBe('1 starting · 1 failed');
    expect(targetBox('termag-4/termag-4@main')).toBe('termag-4');
    expect(targetBox(null)).toBeNull();
  });
});

describe('asks kept in view', () => {
  const v = (thread: string, over: Partial<import('./asks').AskView> = {}): import('./asks').AskView => ({
    thread, title: thread, target: 'termag-4/termag-4', chat: null, state: 'done', turns: 1, error: null, startedAt: '2026-10-29T13:23:18.000Z',
    completedAt: '2026-10-29T13:25:48.000Z', waiting: 'nobody', noWait: true, reply: 'dropped', notice: 'none', prs: [], known: true, ...over,
  });
  const items: ChatItem[] = [
    { kind: 'tool', key: 'tool:a', id: 'a', name: 'Bash', input: {}, inputJson: '', result: null, isError: false, done: true },
    { kind: 'user', key: 'u', text: 'Next?' },
    { kind: 'tool', key: 'tool:b', id: 'b', name: 'Bash', input: {}, inputJson: '', result: null, isError: false, done: true },
  ];
  const byCall = new Map([['a', [T1]], ['b', [T2]]]);

  it('are those still going, and those sent since the last message', async () => {
    const { recentAsks } = await import('./asks');
    expect(recentAsks(items, byCall, new Map([[T1, v(T1)], [T2, v(T2)]])).map(x => x.thread)).toEqual([T2]);
    expect(recentAsks(items, byCall, new Map([[T1, v(T1, { state: 'working' })], [T2, v(T2)]])).map(x => x.thread)).toEqual([T1, T2]);
  });

  it('say where each is and whether Claude is waiting, mid-line', async () => {
    const { askRowSub, askElapsed } = await import('./asks');
    expect(askRowSub(v(T1, { state: 'working', reply: 'pending' }), 'Claude')).toBe('Working · Claude isn’t waiting for a reply');
    expect(askRowSub(v(T1, { turns: 2 }), 'Claude')).toBe('Finished · 2 turns · not sent back to Claude');
    expect(askRowSub(v(T1, { state: 'starting', reply: 'pending' }), 'Claude')).toBe('Starting on termag-4 · Claude isn’t waiting for a reply');
    expect(askRowSub(v(T1, { state: 'failed', reply: 'none', error: 'box_offline' }), 'Claude')).toBe('Failed: box_offline');
    // Mid-line, an agent's name keeps its capital, and "the agent" doesn't take one.
    expect(askRowSub(v(T1, { state: 'working', reply: 'pending' }), 'Codex')).toBe('Working · Codex isn’t waiting for a reply');
    expect(askRowSub(v(T1), 'Codex')).toBe('Finished · not sent back to Codex');
    expect(askRowSub(v(T1, { state: 'working', reply: 'pending' }), 'the agent')).toBe('Working · the agent isn’t waiting for a reply');
    expect(askElapsed(v(T1), 0)).toBe(150_000);
    expect(askElapsed(v(T1, { state: 'working', completedAt: null }), Date.parse('2026-10-29T13:24:18.000Z'))).toBe(60_000);
  });
});

describe('a pane chat\'s asks', () => {
  const later = thread(T2, { title: null, createdAt: '2026-10-29T13:30:00.000Z', messages: [msg({ id: M2, status: 'completed', reply: 'delivered', completedAt: '2026-10-29T13:31:00.000Z' })] });
  const views = paneAskViews(new Map([[T2, later], [T1, thread(T1, { messages: [msg({ notice: 'due' })] })]]));

  it('are a view per thread the pane sent, oldest first, with no row in the transcript', () => {
    expect([...views.keys()]).toEqual([T1, T2]);
    expect(views.get(T1)).toMatchObject({ title: 'Titanic wreck: discovery', state: 'working', waiting: 'nobody', noWait: false, notice: 'due', known: true, noRow: true, chat: { projectId: 'p4' } });
    expect(views.get(T2)).toMatchObject({ title: `ask-${T2}`, state: 'done', reply: 'delivered', completedAt: '2026-10-29T13:31:00.000Z' });
  });

  it('say what the notice and the reply say, never that a command waits', () => {
    expect(askWaitingText(views.get(T1)!, 'Claude')).toBe('Claude is told when it finishes');
    expect(askWaitingText(views.get(T2)!, 'Claude')).toBe('Returned to Claude');
    expect(askWaitingText({ ...views.get(T1)!, notice: 'none' }, 'Claude')).toBeNull();
  });

  it('are kept in view while going, and for an hour after they end', () => {
    const end = Date.parse('2026-10-29T13:31:00.000Z');
    expect(paneKeptAsks(views, end + 60_000).map(v => v.thread)).toEqual([T1, T2]);
    expect(paneKeptAsks(views, end + PANE_ASK_KEEP_MS + 1).map(v => v.thread)).toEqual([T1]);
  });
});

describe('askNoticePollMs', () => {
  const now = Date.parse('2026-10-29T14:00:00.000Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const of = (...messages: ChatAskMessage[]) => [thread(T1, { messages })];
  it('keeps reading a finished ask while its notice is due: often at first, then once a minute, for the sweep\'s day', () => {
    expect(askNoticePollMs(of(msg({ status: 'completed', completedAt: ago(10_000), notice: 'due' })), now, 5000)).toBe(5000);
    expect(askNoticePollMs(of(msg({ status: 'completed', completedAt: ago(NOTICE_POLL_FAST_FOR_MS + 1), notice: 'due' })), now, 5000)).toBe(NOTICE_POLL_SLOW_MS);
    expect(askNoticePollMs(of(msg({ status: 'failed', completedAt: ago(NOTICE_POLL_GIVE_UP_MS + 1), notice: 'due' })), now, 5000)).toBeNull();
  });
  it('stops once every finished message\'s notice is settled', () => {
    for (const notice of ['sent', 'none', 'unsent'] as const) {
      expect(askNoticePollMs(of(msg({ status: 'completed', completedAt: ago(10_000), notice })), now, 5000)).toBeNull();
    }
    expect(askNoticePollMs([], now, 5000)).toBeNull();
  });
  it('leaves a message still going to the ordinary poll', () => {
    expect(askNoticePollMs(of(msg({ status: 'working', notice: 'due' })), now, 5000)).toBeNull();
  });
});
