import { describe, expect, it } from 'vitest';
import {
  DEBOUNCE_MS, FIREWORKS, SOURCE, brokerRemedy, initialState, keepalivePost, piAgent, reduce, toArgv,
  type PiEventLike, type Post, type State,
} from '../../../deploy/pi-ext/termag-status-core';

const T0 = 1_000_000;
const assistant = (text: string, stopReason = 'stop', usage?: Record<string, number>) => ({
  role: 'assistant', stopReason, content: [{ type: 'text', text }], usage,
});

/** Run a sequence of events through the reducer; returns every post in order. */
function run(events: Array<PiEventLike | [PiEventLike, number]>, start: State = initialState()) {
  let state = start;
  const posts: Post[] = [];
  let now = T0;
  for (const e of events) {
    const [ev, at] = Array.isArray(e) ? e : [e, now + 1];
    now = at;
    const r = reduce(state, ev, now);
    state = r.state;
    posts.push(...r.posts);
  }
  return { state, posts };
}
const statuses = (posts: Post[]) => posts.filter(p => p.kind === 'status').map(p => (p as { status: string }).status);

describe('termag pi status reducer', () => {
  it('session_start → idle (so later metadata is accepted), agent_start → working', () => {
    const { posts } = run([{ type: 'session_start' }, { type: 'agent_start' }]);
    expect(statuses(posts)).toEqual(['idle', 'working']);
  });

  it('debounces working on tool/turn events: once per minute while already working', () => {
    const { posts } = run([
      [{ type: 'agent_start' }, T0],
      [{ type: 'turn_start' }, T0 + 1_000],
      [{ type: 'tool_execution_start' }, T0 + 2_000],
      [{ type: 'tool_execution_end' }, T0 + DEBOUNCE_MS + 2_000],
    ]);
    expect(statuses(posts)).toEqual(['working', 'working']);
  });

  it('tool events outside a run post nothing', () => {
    expect(run([{ type: 'tool_execution_start' }]).posts).toEqual([]);
  });

  it('posts contextTokens once per changed value, on turn_end only; prefers ctx.getContextUsage()', () => {
    const { posts } = run([
      { type: 'agent_start' },
      // message_end carries the same message first (live: both fire per reply) — no meta from it
      { type: 'message_end', message: assistant('hi', 'stop', { input: 1000, cacheRead: 200, cacheWrite: 50, output: 10 }) },
      { type: 'turn_end', message: assistant('hi', 'stop', { input: 1000, cacheRead: 200, cacheWrite: 50, output: 10 }) },
      { type: 'turn_end', message: assistant('hi again', 'stop', { input: 1000, cacheRead: 200, cacheWrite: 50, output: 10 }) },
      { type: 'turn_end', message: assistant('more', 'stop', { input: 5 }), contextTokens: 42_000 },
    ]);
    const metas = posts.filter(p => p.kind === 'meta');
    expect(metas).toEqual([{ kind: 'meta', contextTokens: 1250 }, { kind: 'meta', contextTokens: 42_000 }]);
  });

  it('a plain finished run → idle without notify', () => {
    const { posts } = run([{ type: 'agent_start' }, { type: 'turn_end', message: assistant('Done.') }, { type: 'agent_end' }]);
    const last = posts[posts.length - 1];
    expect(last).toEqual({ kind: 'status', status: 'idle' });
  });

  it('a run ending in a question → waiting (user_input, notify, last 200 chars)', () => {
    const long = 'x'.repeat(300) + ' Should I continue?';
    const { posts } = run([{ type: 'agent_start' }, { type: 'turn_end', message: assistant(long) }, { type: 'agent_end' }]);
    const last = posts[posts.length - 1] as Extract<Post, { kind: 'status' }>;
    expect(last.status).toBe('waiting');
    expect(last.waitingReason).toBe('user_input');
    expect(last.notify).toBe(true);
    expect(last.message).toHaveLength(200);
    expect(last.message!.endsWith('Should I continue?')).toBe(true);
  });

  it('an aborted run (Esc) → idle even if the last text ended with ?', () => {
    const { posts } = run([{ type: 'agent_start' }, { type: 'turn_end', message: assistant('Why?', 'aborted') }, { type: 'agent_end' }]);
    expect(statuses(posts).pop()).toBe('idle');
  });

  it('model endpoint 502 → waiting with the credentials remedy and a rateLimited badge; next 2xx clears the badge', () => {
    const r1 = run([{ type: 'agent_start' }, { type: 'after_provider_response', status: 502 }, { type: 'agent_end' }]);
    const last = r1.posts[r1.posts.length - 1] as Extract<Post, { kind: 'status' }>;
    expect(last.status).toBe('waiting');
    expect(last.notify).toBe(true);
    expect(last.message).toMatch(/check the model provider's credentials/);
    expect(last.rateLimited).toBe('pi: model endpoint HTTP 502');
    expect(r1.state.flagged).toBe(true);

    const r2 = run([{ type: 'agent_start' }, { type: 'after_provider_response', status: 200 }], r1.state);
    expect(r2.posts).toContainEqual({ kind: 'meta', rateLimited: null });
    expect(r2.state.flagged).toBe(false);
  });

  it('a restarted pi clears a badge the previous process left behind', () => {
    // Process 1: the request times out → waiting + badge. The user quits pi.
    const p1 = run([
      { type: 'session_start' }, { type: 'agent_start' },
      { type: 'turn_end', message: assistant('', 'error') },
      { type: 'agent_end' },
      { type: 'session_shutdown', reason: 'quit' },
    ]);
    expect(p1.posts.at(-2)).toMatchObject({ kind: 'status', status: 'waiting', rateLimited: 'pi: model error' });
    // Process 2 starts from initialState(): it never saw the badge, so a later
    // 2xx would not clear it. session_start must clear it unconditionally.
    const p2 = run([{ type: 'session_start' }]);
    expect(p2.posts).toEqual([{ kind: 'status', status: 'idle', rateLimited: null }]);
    expect(toArgv(p2.posts[0])).toEqual(['idle', '--source', SOURCE, '--rate-limited', 'null']);
    expect(p2.state.flagged).toBe(false);
  });

  it('model endpoint 404 → the model-settings remedy; stopReason error without an HTTP code → generic message', () => {
    expect(brokerRemedy(404)).toMatch(/model or deployment may have changed/);
    const { posts } = run([{ type: 'agent_start' }, { type: 'turn_end', message: assistant('', 'error') }, { type: 'agent_end' }]);
    const last = posts[posts.length - 1] as Extract<Post, { kind: 'status' }>;
    expect(last.status).toBe('waiting');
    expect(last.rateLimited).toBe('pi: model error');
  });

  it('a new run clears the previous error state', () => {
    const r1 = run([{ type: 'agent_start' }, { type: 'after_provider_response', status: 502 }, { type: 'agent_end' }]);
    const r2 = run([{ type: 'agent_start' }, { type: 'turn_end', message: assistant('ok') }, { type: 'agent_end' }], r1.state);
    expect(statuses(r2.posts)).toEqual(['working', 'idle']);
  });

  it('session_shutdown quit → not_running; reload while idle → nothing', () => {
    expect(statuses(run([{ type: 'session_shutdown', reason: 'quit' }]).posts)).toEqual(['not_running']);
    expect(run([{ type: 'session_shutdown', reason: 'reload' }]).posts).toEqual([]);
  });

  it('a /reload, /new or /resume mid-run ends the run: idle is posted and the keepalive stops', () => {
    for (const reason of ['reload', 'new', 'resume', 'fork']) {
      const r = run([{ type: 'agent_start' }, { type: 'session_shutdown', reason }]);
      expect(statuses(r.posts), reason).toEqual(['working', 'idle']);
      expect(r.state.inRun, reason).toBe(false);
      expect(keepalivePost(r.state), reason).toBeNull();
      // the session_start that follows must not inherit run state either
      const r2 = run([{ type: 'session_start' }], { ...r.state, inRun: true, brokerError: 502 });
      expect(r2.state.inRun).toBe(false);
      expect(r2.state.brokerError).toBeNull();
      expect(statuses(r2.posts)).toEqual(['idle']);
    }
  });

  it('keepalive posts working only while a run is in flight', () => {
    const running = run([{ type: 'agent_start' }]).state;
    expect(keepalivePost(running)).toEqual({ kind: 'status', status: 'working' });
    const settled = run([{ type: 'agent_end' }], running).state;
    expect(keepalivePost(settled)).toBeNull();
  });
});

describe('toArgv', () => {
  it('every post carries --source (the backend books source-less posts as Claude)', () => {
    const posts: Post[] = [
      { kind: 'status', status: 'working' },
      { kind: 'status', status: 'waiting', waitingReason: 'user_input', notify: true, message: 'hm?', rateLimited: 'pi: model endpoint HTTP 502' },
      { kind: 'meta', contextTokens: 1234 },
      { kind: 'meta', rateLimited: null },
    ];
    for (const p of posts) {
      const argv = toArgv(p);
      expect(argv.indexOf('--source')).toBeGreaterThan(0);
      expect(argv[argv.indexOf('--source') + 1]).toBe(SOURCE);
    }
    expect(toArgv(posts[0])).toEqual(['working', '--source', SOURCE]);
    expect(toArgv(posts[1])).toEqual(['waiting', '--source', SOURCE, '--reason', 'user_input', '--notify', '--message', 'hm?', '--rate-limited', 'pi: model endpoint HTTP 502']);
    expect(toArgv(posts[2])).toEqual(['meta', '--source', SOURCE, '--context-tokens', '1234']);
    expect(toArgv(posts[3])).toEqual(['meta', '--source', SOURCE, '--rate-limited', 'null']);
  });
});

describe('pi on Fireworks (TERMAG_PI_AGENT=fireworks)', () => {
  it('picks the agent by name, pi by default', () => {
    expect(piAgent('fireworks')).toBe(FIREWORKS);
    expect(piAgent(undefined).label).toBe('pi');
    expect(piAgent('anything-else').label).toBe('pi');
  });

  it('posts under the harness source on any backend, so its working time stays pi\'s', () => {
    expect(toArgv({ kind: 'status', status: 'working' })).toEqual(['working', '--source', SOURCE]);
  });

  it("names the gateway, not pi's broker or SSO, when a call fails", () => {
    let state = initialState();
    const posts: Post[] = [];
    for (const ev of [{ type: 'agent_start' }, { type: 'after_provider_response', status: 403 }, { type: 'agent_end' }] as PiEventLike[]) {
      const r = reduce(state, ev, T0, FIREWORKS);
      state = r.state;
      posts.push(...r.posts);
    }
    const last = posts.at(-1) as Extract<Post, { kind: 'status' }>;
    expect(last).toMatchObject({ status: 'waiting', notify: true, rateLimited: 'Fireworks: gateway HTTP 403' });
    expect(last.message).toMatch(/termag gateway refused this box.*termag-credentials status/);
    expect(last.message).not.toMatch(/sso|pi/i);
  });
});
