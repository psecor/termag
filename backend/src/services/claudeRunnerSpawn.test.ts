import { describe, it, expect } from 'vitest';
import {
  AUTO_BOX_FAILURE_HOLD_MS, MAX_RUNNERS_PER_BOX, PROVISIONING_FAILURE_WINDOW_MS, REFUSAL, REFUSAL_CODES, allocateSlot, autoBoxName, autoBoxPlan, bearerToken, githubGate,
  parseRunnerSessions, parseSpawnBody, placeRunner, refusalStatus, runnerBoxes, runnerLaunch, runnerSessionName, serializeByKey,
  tmuxSafe, tokensEqual, isRunnerSessionOf, isOwnRunnerSessionStatus, isRunnerSessionShaped,
} from './claudeRunnerSpawn';

const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcmRlciJ9.c2lnbmF0dXJl'; // gitleaks:allow
const valid = { orderId: 'ord-1a2b', sessionId: 'sess_1', accountEmail: 'Ada@Example.com', workOrder: `${jwt}\n`, attempt: '1' };

describe('parseSpawnBody', () => {
  it('accepts a well-formed order, trims the JWT and keeps only what the route uses', () => {
    expect(parseSpawnBody(valid)).toEqual({ orderId: 'ord-1a2b', sessionId: 'sess_1', accountEmail: 'Ada@Example.com', workOrder: jwt, accountId: null, attempt: 1 });
  });

  it('reads the creator account id and the attempt when the hook sends them, and treats a malformed one as absent', () => {
    expect(parseSpawnBody({ ...valid, accountId: 'user_01HXYZ', attempt: 3 })).toMatchObject({ accountId: 'user_01HXYZ', attempt: 3 });
    expect(parseSpawnBody({ ...valid, accountId: 'ada@example.com' })).toMatchObject({ accountId: null });
    expect(parseSpawnBody({ ...valid, accountId: 'user_' })).toMatchObject({ accountId: null });
    expect(parseSpawnBody({ ...valid, attempt: 'many' })).toMatchObject({ attempt: null });
    expect(parseSpawnBody({ ...valid, attempt: undefined })).toMatchObject({ attempt: null });
  });

  it('rejects an order id that is not safe for a file or tmux name', () => {
    expect(parseSpawnBody({ ...valid, orderId: '../etc' })).toHaveProperty('error');
    expect(parseSpawnBody({ ...valid, orderId: 'a b' })).toHaveProperty('error');
    expect(parseSpawnBody({ ...valid, orderId: '' })).toHaveProperty('error');
  });

  it('rejects pre-warming orders (no session) and agent-owned sessions (no email)', () => {
    expect(parseSpawnBody({ ...valid, sessionId: '' })).toMatchObject({ error: expect.stringContaining('pre-warming') });
    expect(parseSpawnBody({ ...valid, accountEmail: '' })).toMatchObject({ error: expect.stringContaining('agent-owned') });
  });

  it('rejects a work order that is not a JWT', () => {
    expect(parseSpawnBody({ ...valid, workOrder: 'not a token' })).toHaveProperty('error');
    expect(parseSpawnBody({ ...valid, workOrder: undefined })).toHaveProperty('error');
  });

  it('rejects a non-object body', () => {
    expect(parseSpawnBody(null)).toHaveProperty('error');
    expect(parseSpawnBody('x')).toHaveProperty('error');
  });
});

describe('runnerBoxes', () => {
  const box = (over: Partial<Parameters<typeof runnerBoxes>[0][number]> & { id: string }) => ({
    kind: 'ec2', status: 'ready', hostHome: '/home/ada', hostUnixUser: 'ada',
    lastConnectedAt: new Date('2026-10-06T10:00:00Z'), connected: true, capable: true, ...over,
  });

  it('drops boxes that cannot run a runner now', () => {
    expect(runnerBoxes([])).toEqual([]);
    expect(runnerBoxes([
      box({ id: 'a', connected: false }), box({ id: 'b', status: 'stopped' }), box({ id: 'c', kind: 'external' }),
      box({ id: 'd', hostHome: null }), box({ id: 'e', hostUnixUser: null }),
    ])).toEqual([]);
  });

  it('drops a box whose agent predates tmux-create commands', () => {
    expect(runnerBoxes([box({ id: 'old-agent', capable: false })])).toEqual([]);
  });

  it('orders the rest most recently connected first', () => {
    const older = box({ id: 'old', lastConnectedAt: new Date('2026-10-01T00:00:00Z') });
    const newer = box({ id: 'new', lastConnectedAt: new Date('2026-10-06T00:00:00Z') });
    const down = box({ id: 'down', connected: false, lastConnectedAt: new Date('2026-10-07T00:00:00Z') });
    expect(runnerBoxes([older, down, newer]).map(b => b.id)).toEqual(['new', 'old']);
  });
});

describe('runnerLaunch', () => {
  it('derives every path, name and the command from the order id, the slot and the box home', () => {
    expect(runnerLaunch('/home/ada/', 'ada', 'ord-1a2b', 3)).toEqual({
      workOrderPath: '/home/ada/.termag/claude-runner/ord-1a2b.work-order',
      workOrderMode: 0o600,
      sessionName: 'ada-claude-runner-s3-ord-1a2b-r',
      command: ['/home/ada/.local/bin/termag-claude-runner', 'ord-1a2b', '3'],
      cwd: '/home/ada/.termag/claude-runner',
      gitInit: false,
      slot: 3,
    });
  });

  it('appends the telemetry destination as flags only when the orchestrator has one', () => {
    const dest = { project: 'termag-prod', endpoint: 'https://otel.example.com' };
    expect(runnerLaunch('/home/ada', 'ada', 'ord.1', 2, dest).command).toEqual([
      '/home/ada/.local/bin/termag-claude-runner', 'ord.1', '2',
      '--otel-project', 'termag-prod', '--otel-endpoint', 'https://otel.example.com',
    ]);
    expect(runnerLaunch('/home/ada', 'ada', 'ord.1', 2, null).command).toEqual(['/home/ada/.local/bin/termag-claude-runner', 'ord.1', '2']);
  });

  it('appends the context keys after the destination, and only with one', () => {
    const dest = { project: 'termag-prod', endpoint: 'https://otel.example.com' };
    const keys = { user: 'u1', box: 'box-a' };
    expect(runnerLaunch('/home/ada', 'ada', 'ord.1', 2, dest, keys).command.slice(3)).toEqual([
      '--otel-project', 'termag-prod', '--otel-endpoint', 'https://otel.example.com',
      '--user-key', 'u1', '--box-key', 'box-a',
    ]);
    expect(runnerLaunch('/home/ada', 'ada', 'ord.1', 2, null, keys).command).toEqual(['/home/ada/.local/bin/termag-claude-runner', 'ord.1', '2']);
  });

  it('appends the git flags after the telemetry ones, only when asked, and never --github for an unknown state', () => {
    const dest = { project: '5f0c1e2d3a4b5c6d7e8f9a0b', endpoint: 'https://otel.example.test' };
    expect(runnerLaunch('/home/ada', 'ada', 'ord.1', 2, dest, null, { anthropicGit: true, github: 'absent' }).command).toEqual([
      '/home/ada/.local/bin/termag-claude-runner', 'ord.1', '2',
      '--otel-project', '5f0c1e2d3a4b5c6d7e8f9a0b', '--otel-endpoint', 'https://otel.example.test',
      '--anthropic-git', '--github', 'absent',
    ]);
    expect(runnerLaunch('/home/ada', 'ada', 'ord.1', 2, null, null, { anthropicGit: true, github: 'connected' }).command.slice(3)).toEqual(['--anthropic-git', '--github', 'connected']);
    expect(runnerLaunch('/home/ada', 'ada', 'ord.1', 2, null, null, { anthropicGit: true, github: 'unknown' }).command.slice(3)).toEqual(['--anthropic-git']);
    expect(runnerLaunch('/home/ada', 'ada', 'ord.1', 2, null, null, { anthropicGit: false, github: 'absent' }).command.slice(3)).toEqual(['--github', 'absent']);
    expect(runnerLaunch('/home/ada', 'ada', 'ord.1', 2, null, null, null).command.slice(3)).toEqual([]);
  });

  it('passes the raw order id to the runner and never starts the session in the home itself', () => {
    const l = runnerLaunch('/home/ada', 'ada', 'ord.1', 2);
    expect(l.command[1]).toBe('ord.1');
    expect(l.cwd).not.toBe('/home/ada');
    expect(l.cwd.startsWith('/home/ada/')).toBe(true);
    expect(l.gitInit).toBe(false);
  });
});

describe('runner session names', () => {
  it('names a session no project poller matches, and that parses back', () => {
    const name = runnerSessionName('ada', 2, 'x1');
    expect(name).toBe('ada-claude-runner-s2-x1-r');
    expect(parseRunnerSessions([name], 'ada')).toEqual([{ slot: 2, orderId: 'x1', sessionName: name }]);
    // An order id ending in -agent cannot make the name look like a project agent pane.
    expect(runnerSessionName('ada', 2, 'ord-agent')).not.toMatch(/-agent$/);
  });

  it('escapes dots reversibly, so distinct order ids never share a session', () => {
    expect(tmuxSafe('ord.1.a')).toBe('ord_d1_da');
    expect(tmuxSafe('a_b')).toBe('a__b');
    expect(tmuxSafe('a.b')).not.toBe(tmuxSafe('a_b'));
    expect(tmuxSafe('a_db')).not.toBe(tmuxSafe('a.b'));
    const name = runnerSessionName('ada', 2, 'ord.1');
    expect(name).toBe('ada-claude-runner-s2-ord_d1-r');
    expect(allocateSlot(parseRunnerSessions([name], 'ada'), 'ord.1')).toEqual({ kind: 'existing', slot: 2 });
    expect(allocateSlot(parseRunnerSessions([name], 'ada'), 'ord_1')).toEqual({ kind: 'new', slot: 3 });
  });

  it('escapes a dotted unix user too, so tmux keeps the name the agent then addresses', () => {
    const name = runnerSessionName('first.last', 2, 'ord-1');
    expect(name).toBe('first_dlast-claude-runner-s2-ord-1-r');
    expect(name).not.toContain('.');
    expect(parseRunnerSessions([name], 'first.last')).toEqual([{ slot: 2, orderId: 'ord-1', sessionName: name }]);
    expect(parseRunnerSessions([name], 'first_last')).toEqual([]);
  });

  it('anchors on the user, so an order id that looks like a runner name still parses', () => {
    const name = runnerSessionName('ada', 2, 'x-claude-runner-s3-y');
    expect(parseRunnerSessions([name], 'ada')).toEqual([{ slot: 2, orderId: 'x-claude-runner-s3-y', sessionName: name }]);
    expect(allocateSlot(parseRunnerSessions([name], 'ada'), 'x-claude-runner-s3-y')).toEqual({ kind: 'existing', slot: 2 });
  });

  it("keeps only this user's runner sessions", () => {
    const sessions = [
      'ada-webapp-agent', 'ada-webapp-ctrl', 'ada-MetaTerm-agent',
      'ada-claude-runner-s2-ord-a-r', 'ada-claude-runner-s4-ord-b-r',
      'bob-claude-runner-s2-ord-c-r', 'ada-claude-runner-sX-ord-d-r', 'ada-claude-runner-ord-old',
      'ada-claude-runner-s3-ord-e',
    ];
    expect(parseRunnerSessions(sessions, 'ada').map(s => [s.slot, s.orderId])).toEqual([[2, 'ord-a'], [4, 'ord-b']]);
    expect(parseRunnerSessions(sessions, 'bob').map(s => s.orderId)).toEqual(['ord-c']);
  });
});

const running = (...slots: number[]) => slots.map(slot => ({ slot, orderId: `o${slot}`, sessionName: `ada-claude-runner-s${slot}-o${slot}-r` }));

describe('allocateSlot', () => {
  it('gives the first session slot 2 (the owner keeps instance 1)', () => {
    expect(allocateSlot([], 'new')).toEqual({ kind: 'new', slot: 2 });
  });

  it('fills the lowest free slot', () => {
    expect(allocateSlot(running(2, 4), 'new')).toEqual({ kind: 'new', slot: 3 });
    expect(allocateSlot(running(2, 3), 'new')).toEqual({ kind: 'new', slot: 4 });
  });

  it('is idempotent on the order id', () => {
    expect(allocateSlot(running(2, 3), 'o3')).toEqual({ kind: 'existing', slot: 3 });
  });

  it('refuses a fourth concurrent session per box', () => {
    expect(MAX_RUNNERS_PER_BOX).toBe(3);
    expect(allocateSlot(running(2, 3, 4), 'new')).toEqual({ kind: 'full', running: 3, max: 3 });
  });

  it('honours a different cap', () => {
    expect(allocateSlot(running(2), 'new', 1)).toEqual({ kind: 'full', running: 1, max: 1 });
    expect(allocateSlot(running(2, 3, 4), 'new', 5)).toEqual({ kind: 'new', slot: 5 });
  });
});

describe('placeRunner', () => {
  it('keeps an order on the box already running it, even when a better box has room', () => {
    expect(placeRunner([{ box: 'a', sessions: [] }, { box: 'b', sessions: running(2, 3) }], 'o3'))
      .toEqual({ kind: 'existing', box: 'b', slot: 3 });
  });

  it('takes the first box with a free slot', () => {
    expect(placeRunner([{ box: 'a', sessions: running(2) }, { box: 'b', sessions: [] }], 'new'))
      .toEqual({ kind: 'new', box: 'a', slot: 3 });
  });

  it('moves past a full box instead of queueing the session', () => {
    expect(placeRunner([{ box: 'a', sessions: running(2, 3, 4) }, { box: 'b', sessions: [] }], 'new'))
      .toEqual({ kind: 'new', box: 'b', slot: 2 });
  });

  it('is full only when every box is', () => {
    expect(placeRunner([{ box: 'a', sessions: running(2, 3, 4) }, { box: 'b', sessions: running(2, 3, 4) }], 'new'))
      .toEqual({ kind: 'full', boxes: 2, max: 3 });
  });

  it('places a new runner only on an eligible box, but finds an existing one anywhere (Devin on #287)', () => {
    const onlyB = (box: string) => box === 'b';
    expect(placeRunner([{ box: 'a', sessions: [] }, { box: 'b', sessions: [] }], 'new', 3, onlyB))
      .toEqual({ kind: 'new', box: 'b', slot: 2 });
    // An order already live on the ineligible box stays there: no second runner.
    expect(placeRunner([{ box: 'a', sessions: running(2, 3) }, { box: 'b', sessions: [] }], 'o3', 3, onlyB))
      .toEqual({ kind: 'existing', box: 'a', slot: 3 });
    // Full counts the eligible boxes only.
    expect(placeRunner([{ box: 'a', sessions: [] }, { box: 'b', sessions: running(2, 3, 4) }], 'new', 3, onlyB))
      .toEqual({ kind: 'full', boxes: 1, max: 3 });
  });
});

describe('bearer helpers', () => {
  it('extracts a bearer token case-insensitively and rejects other schemes', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer   abc ')).toBe('abc');
    expect(bearerToken(['Bearer first', 'Bearer second'])).toBe('first');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });

  it('compares tokens in constant time, including different lengths', () => {
    expect(tokensEqual('secret', 'secret')).toBe(true);
    expect(tokensEqual('secret', 'secreT')).toBe(false);
    expect(tokensEqual('secret', 'secre')).toBe(false);
    expect(tokensEqual('', 'x')).toBe(false);
  });
});

describe('serializeByKey', () => {
  it('runs calls with the same key one after another, and different keys concurrently', async () => {
    const order: string[] = [];
    const gate = (label: string, ms: number) => async () => {
      order.push(`${label}:start`);
      await new Promise(r => setTimeout(r, ms));
      order.push(`${label}:end`);
      return label;
    };
    const [a, b, c] = await Promise.all([
      serializeByKey('owner-1', gate('a', 20)),
      serializeByKey('owner-1', gate('b', 1)),
      serializeByKey('owner-2', gate('c', 1)),
    ]);
    expect([a, b, c]).toEqual(['a', 'b', 'c']);
    expect(order.indexOf('b:start')).toBeGreaterThan(order.indexOf('a:end'));
    expect(order.indexOf('c:end')).toBeLessThan(order.indexOf('a:end'));
  });

  it('keeps serving the key after a rejected call', async () => {
    await expect(serializeByKey('owner-3', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(serializeByKey('owner-3', async () => 'ok')).resolves.toBe('ok');
  });
});

describe('REFUSAL', () => {
  // Every refusal the route can answer, built once with sample arguments.
  const all = [
    REFUSAL.githubNotConnected(), REFUSAL.noBox(), REFUSAL.agentOutdated(), REFUSAL.boxesFull(2, 3),
    REFUSAL.hookGone('launch'), REFUSAL.hookGone('box'), REFUSAL.boxWait('box "p" is provisioning; retried when its agent connects'),
    REFUSAL.boxHold('box "f" failed to provision less than an hour ago, ...'), REFUSAL.boxSettling('w1'), REFUSAL.boxStarting('starting', 'old'),
    REFUSAL.boxStarting('resuming', 'nap'), REFUSAL.boxStartFailed('old', 'stopped', null), REFUSAL.boxStartFailed('old', 'stopped', 'not found'),
    REFUSAL.boxClaimed('claude-20261009'), REFUSAL.boxProvisioning('claude-20261009'), REFUSAL.boxOnItsWay(), REFUSAL.noProvisioning(),
    REFUSAL.boxCreationRefused('Connect GitHub in Settings before adding a box'), REFUSAL.agentListFailed('timeout'), REFUSAL.agentLaunchFailed('tmux-create failed'),
  ];

  it('uses every code in REFUSAL_CODES and no other', () => {
    expect(new Set(all.map(r => r.code))).toEqual(new Set(REFUSAL_CODES));
  });

  it('keeps the texts the Activity tab, the journal and old events already carry', () => {
    // Pinned: a reader of an event written before the code column matches on these.
    expect(all.map(r => r.text)).toEqual([
      'the session owner has not connected GitHub in termag; paste `gh auth token` on the termag Credentials page, then the session is retried',
      'no ready termag box with a connected agent for the session owner; start or add a box in termag',
      "the session owner's box runs a termag agent too old for cloud sessions; it is retried once the box's termag is updated",
      'every box of the session owner (2) already runs 3 cloud sessions; it is retried when one ends',
      'the spawn hook stopped waiting; not launched',
      'the spawn hook stopped waiting; no box started for it',
      'box "p" is provisioning; retried when its agent connects',
      'box "f" failed to provision less than an hour ago, ...',
      'box "w1" is still receiving its credentials; retried once they have landed',
      'starting box "old" for this session; retried when its agent connects',
      'resuming box "nap" for this session; retried when its agent connects',
      'box "old" is stopped and EC2 refused to start it; start it from termag',
      'box "old" is stopped and could not be started: not found',
      'claimed termag box "claude-20261009" for this session; retried when its agent connects',
      'provisioning termag box "claude-20261009" for this session (a few minutes); retried when its agent connects',
      'a termag box is being set up for the session owner; retried when its agent connects',
      'the session owner has no termag box and this orchestrator cannot provision one; add a box in termag',
      'Connect GitHub in Settings before adding a box; the session is retried once GitHub is connected',
      'a box agent did not list its sessions: timeout',
      'the box agent refused the launch: tmux-create failed',
    ]);
  });

  it('answers 502 only for a box agent that failed an RPC', () => {
    expect(all.filter(r => refusalStatus(r) === 502).map(r => r.code)).toEqual(['agent-list-failed', 'agent-launch-failed']);
  });
});

describe('githubGate', () => {
  it('refuses an owner with no GitHub credential on a broker host, with the fix in the message and its code', () => {
    const r = githubGate({ brokerConfigured: true, credential: 'absent' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/Credentials page/);
      expect(r.code).toBe('github');
      expect(r.text).toBe(r.error);
    }
  });

  it('lets a connected owner through', () => {
    expect(githubGate({ brokerConfigured: true, credential: 'present' })).toEqual({ ok: true });
  });

  it('does not hold a failed credential read against the owner', () => {
    expect(githubGate({ brokerConfigured: true, credential: 'unknown' })).toEqual({ ok: true });
  });

  it('checks nothing on a host without the broker (boxes use their own SSH keys)', () => {
    expect(githubGate({ brokerConfigured: false, credential: 'absent' })).toEqual({ ok: true });
  });
});

describe('autoBoxPlan', () => {
  const now = new Date('2026-10-06T12:00:00Z').getTime();
  const box = (over: Partial<Parameters<typeof autoBoxPlan>[0][number]> & { id: string; status: string }) => ({
    name: over.id, kind: 'ec2', ec2InstanceId: 'i-1', lastConnectedAt: null, createdAt: new Date(now - 2 * AUTO_BOX_FAILURE_HOLD_MS), ...over,
  });

  it('acquires when the owner has no usable box', () => {
    expect(autoBoxPlan([], now)).toEqual({ kind: 'acquire' });
    expect(autoBoxPlan([box({ id: 'gone', status: 'terminated' }), box({ id: 'old-fail', status: 'failed' })], now)).toEqual({ kind: 'acquire' });
    expect(autoBoxPlan([box({ id: 'ext', status: 'stopped', kind: 'external' })], now)).toEqual({ kind: 'acquire' });
  });

  it('starts a stopped EC2 box rather than making a new one', () => {
    expect(autoBoxPlan([box({ id: 'old', status: 'stopped' })], now)).toMatchObject({ kind: 'start', box: { id: 'old' } });
  });

  it('waits on a box that is already on its way, instead of starting or acquiring another', () => {
    expect(autoBoxPlan([box({ id: 's', status: 'stopped' }), box({ id: 'p', status: 'provisioning' })], now))
      .toMatchObject({ kind: 'wait', box: { id: 'p' }, reason: expect.stringContaining('provisioning') });
    expect(autoBoxPlan([box({ id: 'r', status: 'ready' })], now))
      .toMatchObject({ kind: 'wait', reason: expect.stringContaining('not connected') });
    expect(autoBoxPlan([box({ id: 'st', status: 'starting' })], now)).toMatchObject({ kind: 'wait' });
    expect(autoBoxPlan([box({ id: 'sp', status: 'stopping' })], now)).toMatchObject({ kind: 'wait' });
  });

  it('never starts a stopped box without an EC2 instance id', () => {
    expect(autoBoxPlan([box({ id: 'noid', status: 'stopped', ec2InstanceId: null })], now)).toEqual({ kind: 'acquire' });
  });

  it('resumes a hibernated EC2 box instead of making one, and waits while it is still hibernating', () => {
    expect(autoBoxPlan([box({ id: 'nap', status: 'hibernated' })], now)).toMatchObject({ kind: 'start', box: { id: 'nap' } });
    expect(autoBoxPlan([box({ id: 'nap', status: 'hibernated' }), box({ id: 'p', status: 'provisioning' })], now))
      .toMatchObject({ kind: 'wait', box: { id: 'p' } });
    expect(autoBoxPlan([box({ id: 'h', status: 'hibernating' })], now))
      .toMatchObject({ kind: 'wait', box: { id: 'h' }, reason: expect.stringContaining('hibernating') });
    expect(autoBoxPlan([box({ id: 'noid', status: 'hibernated', ec2InstanceId: null })], now)).toEqual({ kind: 'acquire' });
  });

  it('holds off a new box for an hour after one failed, but still starts a stopped one', () => {
    const recent = box({ id: 'claude-20261006', status: 'failed', createdAt: new Date(now - 10 * 60 * 1000) });
    expect(autoBoxPlan([recent], now)).toMatchObject({ kind: 'hold', box: { id: 'claude-20261006' }, reason: expect.stringContaining('failed') });
    expect(autoBoxPlan([recent, box({ id: 'mine', status: 'stopped' })], now)).toMatchObject({ kind: 'start', box: { id: 'mine' } });
    // The row says when it was created, not when it failed (the stuck sweep fails
    // it up to 15 minutes later), so the hold is an hour past that window.
    const createdAgo = (ms: number) => box({ id: 'late', status: 'failed', createdAt: new Date(now - ms) });
    expect(autoBoxPlan([createdAgo(AUTO_BOX_FAILURE_HOLD_MS + 1)], now)).toMatchObject({ kind: 'hold' });
    expect(autoBoxPlan([createdAgo(AUTO_BOX_FAILURE_HOLD_MS + PROVISIONING_FAILURE_WINDOW_MS - 1)], now)).toMatchObject({ kind: 'hold' });
    expect(autoBoxPlan([createdAgo(AUTO_BOX_FAILURE_HOLD_MS + PROVISIONING_FAILURE_WINDOW_MS + 1)], now)).toEqual({ kind: 'acquire' });
  });
});

describe('autoBoxName', () => {
  it('says why the box exists and when', () => {
    expect(autoBoxName(new Date('2026-10-06T12:00:00Z'))).toBe('claude-20261006');
  });
});

describe('isRunnerSessionOf', () => {
  it("admits a box's own runner sessions and nothing else under its prefix", () => {
    expect(isRunnerSessionOf('termag-claude-runner-s3-ord_d1-r', 'termag')).toBe(true);
    expect(isRunnerSessionOf('ada-claude-runner-s2-x-r', 'ada')).toBe(true);
    // A project pane under the same prefix is not a runner session.
    expect(isRunnerSessionOf('termag-webapp-agent', 'termag')).toBe(false);
    // Another box's user, or no user.
    expect(isRunnerSessionOf('ada-claude-runner-s2-x-r', 'termag')).toBe(false);
    expect(isRunnerSessionOf('ada-claude-runner-s2-x-r', null)).toBe(false);
    expect(isRunnerSessionOf('ada-claude-runner-s2-x-r', undefined)).toBe(false);
  });
});

describe('isOwnRunnerSessionStatus', () => {
  const boxes = new Map<string, string | null>([['box-a', 'termag'], ['box-b', null]]);
  it("delivers a runner session on one of the client's boxes, named after that box's user", () => {
    expect(isOwnRunnerSessionStatus('termag-claude-runner-s3-ord_d1-r', 'box-a', boxes)).toBe(true);
    expect(isOwnRunnerSessionStatus('termag-webapp-agent', 'box-a', boxes)).toBe(false);
    expect(isOwnRunnerSessionStatus('termag-claude-runner-s3-ord_d1-r', 'box-z', boxes)).toBe(false);
    expect(isOwnRunnerSessionStatus('termag-claude-runner-s3-ord_d1-r', null, boxes)).toBe(false);
    expect(isOwnRunnerSessionStatus('x-claude-runner-s3-ord_d1-r', 'box-b', boxes)).toBe(false);
  });
  it('recognises the runner shape cheaply', () => {
    expect(isRunnerSessionShaped('ada-claude-runner-s2-x-r')).toBe(true);
    expect(isRunnerSessionShaped('ada-webapp-agent')).toBe(false);
  });
});
