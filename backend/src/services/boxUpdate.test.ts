import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./featureFlags', () => ({ boolVariation: vi.fn(async () => false) }));
vi.mock('../db', () => ({ prisma: { instance: { groupBy: vi.fn(async () => [{ lastUpdateOutcome: 'updated', _count: 2 }, { lastUpdateOutcome: 'failed', _count: 1 }]) } } }));
vi.mock('./agentRegistry', () => ({
  sendToInstanceAgent: vi.fn(async () => ({ ok: true, started: true, unit: 'termag-box-update.service' })),
  instanceAgentTransport: vi.fn(() => null),
  connectedOwnedBoxes: vi.fn(() => []),
  onBoxAgentHello: vi.fn(() => () => {}),
}));
// Never reached: the tests hand the module a target loader of their own.
vi.mock('./boxProvisioner', () => ({
  getBoxConfig: () => null,
  awsClientConfig: () => ({}),
  discoverLatestAmi: async () => { throw new Error('not in this test'); },
}));

const {
  BOX_AUTO_UPDATE_FLAG, boxUpdateDecision, boxUpdateStatus, considerBoxUpdate, resetBoxUpdateCache,
  runBoxUpdateSweep, startBoxUpdateSweep, stopBoxUpdateSweep, targetBoxCommit,
} = await import('./boxUpdate');
const { boolVariation } = await import('./featureFlags');
const registry = await import('./agentRegistry');

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const NEWER = 'c'.repeat(40);
const CAPABLE = ['credentials-v1', 'tmux-create-command-v1', 'box-update-v1'];

const ada = { id: 'u_ada', googleEmail: 'ada@example.com', displayName: 'Ada', unixUsername: 'ada', defaultAgentProvider: 'claude' } as any;
const box = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `ada-${id}`, kind: 'ec2', userId: 'u_ada', ...over }) as any;
const candidate = (id: string, agentCommit: string | null, over: { capabilities?: string[]; instance?: Record<string, unknown> } = {}) => ({
  instance: box(id, over.instance), user: ada, agentCommit, capabilities: over.capabilities ?? CAPABLE,
});

const flag = vi.mocked(boolVariation);
const send = vi.mocked(registry.sendToInstanceAgent);
let targetCalls = 0;
let target: string | null = NEW;

beforeEach(() => {
  flag.mockReset(); flag.mockResolvedValue(true);
  send.mockReset(); send.mockResolvedValue({ ok: true, started: true, unit: 'termag-box-update.service' });
  vi.mocked(registry.connectedOwnedBoxes).mockReset().mockReturnValue([]);
  vi.mocked(registry.instanceAgentTransport).mockReset().mockReturnValue(null);
  vi.mocked(registry.onBoxAgentHello).mockReset().mockReturnValue(() => {});
  targetCalls = 0; target = NEW;
  resetBoxUpdateCache(async () => { targetCalls++; return target; });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  stopBoxUpdateSweep();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('boxUpdateDecision', () => {
  const base = { flagOn: true, managed: true, capabilities: CAPABLE, agentCommit: OLD, targetCommit: NEW, lastPushedTarget: null };
  it.each([
    ['the flag is off for this owner and box', { flagOn: false }, 'flag-off'],
    ['an external box is the owner\'s own machine', { managed: false }, 'not-managed'],
    ['an agent from before the RPC cannot be asked', { capabilities: ['credentials-v1', 'tmux-create-command-v1'] }, 'agent-too-old'],
    ['no tagged AMI means nothing to compare against', { targetCommit: null }, 'no-target'],
    ['a box on the target commit is current', { agentCommit: NEW }, 'current'],
    ['a box already asked to move to this target is not asked again', { lastPushedTarget: NEW }, 'already-pushed'],
  ] as const)('skips when %s', (_name, over, reason) => {
    expect(boxUpdateDecision({ ...base, ...over })).toEqual({ push: false, reason });
  });

  it('pushes a stale box, a box of unknown commit, and a box last asked about an older target', () => {
    expect(boxUpdateDecision(base)).toEqual({ push: true });
    expect(boxUpdateDecision({ ...base, agentCommit: null })).toEqual({ push: true });
    expect(boxUpdateDecision({ ...base, lastPushedTarget: OLD })).toEqual({ push: true });
  });

  it('decides the flag before anything that would cost an AWS call', () => {
    expect(boxUpdateDecision({ ...base, flagOn: false, targetCommit: null })).toEqual({ push: false, reason: 'flag-off' });
    expect(boxUpdateDecision({ ...base, capabilities: [], targetCommit: null })).toEqual({ push: false, reason: 'agent-too-old' });
  });
});

describe('considerBoxUpdate', () => {
  it('asks a stale box once per target, with the target in the RPC', async () => {
    expect(await considerBoxUpdate(candidate('b1', OLD), 'sweep')).toEqual({ push: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('b1', 'box-update', { target: NEW }, 15_000);

    expect(await considerBoxUpdate(candidate('b1', OLD), 'sweep')).toEqual({ push: false, reason: 'already-pushed' });
    expect(send).toHaveBeenCalledTimes(1);

    // The agent restarted onto the new code and said hello again.
    expect(await considerBoxUpdate(candidate('b1', NEW), 'hello')).toEqual({ push: false, reason: 'current' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await boxUpdateStatus()).toMatchObject({ flag: BOX_AUTO_UPDATE_FLAG, targetCommit: NEW, pushedThisProcess: 1 });
    expect((await boxUpdateStatus()).boxesByLastOutcome24h).toEqual({ updated: 2, failed: 1 });
  });

  it('the admin status reads the target itself, so it is there before any box has the flag on', async () => {
    flag.mockResolvedValue(false);
    await considerBoxUpdate(candidate('b9', OLD), 'sweep');
    expect(targetCalls).toBe(0);
    expect(await boxUpdateStatus()).toMatchObject({ targetCommit: NEW, pushedThisProcess: 0 });
    expect(targetCalls).toBe(1);
    // Memoized: the page can be reloaded without another AWS call.
    await boxUpdateStatus();
    expect(targetCalls).toBe(1);
  });

  it('asks again when the target moves on', async () => {
    await considerBoxUpdate(candidate('b2', OLD), 'sweep');
    target = NEWER;
    resetBoxUpdateCache(async () => target); // a new memo: the cache would otherwise hold NEW for five minutes
    // resetBoxUpdateCache also forgets what was pushed, so re-record the first push by asking once.
    expect(await considerBoxUpdate(candidate('b2', OLD), 'sweep')).toEqual({ push: true });
    expect(send).toHaveBeenLastCalledWith('b2', 'box-update', { target: NEWER }, 15_000);
  });

  it('reads the flag for the owner and the box, and never looks at the AMI while it is off', async () => {
    flag.mockResolvedValue(false);
    expect(await considerBoxUpdate(candidate('b3', OLD), 'sweep')).toEqual({ push: false, reason: 'flag-off' });
    expect(flag).toHaveBeenCalledWith(BOX_AUTO_UPDATE_FLAG, ada, false, { id: 'b3', name: 'ada-b3', kind: 'ec2' });
    expect(targetCalls).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('leaves an external box and an agent without the RPC alone, without an AWS call', async () => {
    expect(await considerBoxUpdate(candidate('b4', OLD, { instance: { kind: 'external' } }), 'sweep')).toEqual({ push: false, reason: 'not-managed' });
    expect(await considerBoxUpdate(candidate('b5', OLD, { capabilities: ['tmux-create-command-v1'] }), 'sweep')).toEqual({ push: false, reason: 'agent-too-old' });
    expect(targetCalls).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('does nothing when there is no tagged AMI, and tries the lookup again next time', async () => {
    target = null;
    expect(await considerBoxUpdate(candidate('b6', OLD), 'sweep')).toEqual({ push: false, reason: 'no-target' });
    expect(send).not.toHaveBeenCalled();
    resetBoxUpdateCache(async () => { throw new Error('DescribeImages denied'); });
    expect(await targetBoxCommit()).toBe(null);
    expect(await considerBoxUpdate(candidate('b6', OLD), 'sweep')).toEqual({ push: false, reason: 'no-target' });
  });

  it('asks a capable agent of unknown commit once: the box, not the orchestrator, knows whether there is a pull', async () => {
    expect(await considerBoxUpdate(candidate('b7', null), 'hello')).toEqual({ push: true });
    expect(await considerBoxUpdate(candidate('b7', null), 'sweep')).toEqual({ push: false, reason: 'already-pushed' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('records a failed push for this target rather than retrying it every sweep', async () => {
    send.mockRejectedValueOnce(new Error('termag-box-update.service is not installed on this box'));
    expect(await considerBoxUpdate(candidate('b8', OLD), 'sweep')).toEqual({ push: true });
    expect(await considerBoxUpdate(candidate('b8', OLD), 'sweep')).toEqual({ push: false, reason: 'already-pushed' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('not installed on this box'));
  });
});

describe('the sweep', () => {
  it('walks every connected owned box and asks only the stale ones', async () => {
    vi.mocked(registry.connectedOwnedBoxes).mockReturnValue([
      { instance: box('s1'), user: ada, agentCommit: OLD, capabilities: CAPABLE },
      { instance: box('s2'), user: ada, agentCommit: NEW, capabilities: CAPABLE },
      { instance: box('s3'), user: ada, agentCommit: OLD, capabilities: ['credentials-v1'] },
    ]);
    await runBoxUpdateSweep();
    expect(send.mock.calls.map(c => c[0])).toEqual(['s1']);
    expect((await boxUpdateStatus()).lastSweepAt).not.toBeNull();
    // One AMI lookup served the whole pass.
    expect(targetCalls).toBe(1);
  });
});

describe('the hello hook', () => {
  it('waits before asking a box that just connected, and only if that agent is still the one connected', async () => {
    vi.useFakeTimers();
    let listener: ((ev: any) => void) | null = null;
    const unsubscribe = vi.fn();
    vi.mocked(registry.onBoxAgentHello).mockImplementation((fn) => { listener = fn; return unsubscribe; });
    startBoxUpdateSweep({ helloDelayMs: 60_000, sweepMs: 10 ** 9 });
    expect(listener).not.toBeNull();

    // Box h1 stays connected on the same code: asked after the delay.
    vi.mocked(registry.instanceAgentTransport).mockImplementation((id: string) =>
      id === 'h1' ? { conn: {} as never, capabilities: CAPABLE, agentCommit: OLD } : null);
    listener!({ instance: box('h1'), user: ada, agentCommit: OLD, capabilities: CAPABLE });
    // Box h2 went away (or reconnected on new code) before the delay elapsed.
    listener!({ instance: box('h2'), user: ada, agentCommit: OLD, capabilities: CAPABLE });

    await vi.advanceTimersByTimeAsync(59_000);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('h1', 'box-update', { target: NEW }, 15_000);

    stopBoxUpdateSweep();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('a stop clears the hello timers still pending, so a process that lost the lease pushes nothing during its drain', async () => {
    vi.useFakeTimers();
    let listener: ((ev: any) => void) | null = null;
    vi.mocked(registry.onBoxAgentHello).mockImplementation((fn) => { listener = fn; return () => {}; });
    vi.mocked(registry.instanceAgentTransport).mockReturnValue({ conn: {} as never, capabilities: CAPABLE, agentCommit: OLD });
    startBoxUpdateSweep({ helloDelayMs: 60_000, sweepMs: 10 ** 9 });
    listener!({ instance: box('d1'), user: ada, agentCommit: OLD, capabilities: CAPABLE });

    await vi.advanceTimersByTimeAsync(30_000);
    stopBoxUpdateSweep(); // the lease moved on; the socket stays open through the drain grace
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).not.toHaveBeenCalled();
  });

  it('runs the sweep on its interval and stops with it', async () => {
    vi.useFakeTimers();
    vi.mocked(registry.connectedOwnedBoxes).mockReturnValue([{ instance: box('i1'), user: ada, agentCommit: OLD, capabilities: CAPABLE }]);
    startBoxUpdateSweep({ sweepMs: 1000, helloDelayMs: 10 ** 9 });
    startBoxUpdateSweep({ sweepMs: 1, helloDelayMs: 1 }); // a second start is a no-op
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(1);
    stopBoxUpdateSweep();
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
