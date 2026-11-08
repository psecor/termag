import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ status: 'ready' as string }));
vi.mock('../db', () => ({ prisma: { instance: { findUnique: async () => ({ status: db.status }) } } }));

type Agent = { conn: unknown; capabilities: string[] };
const reg = vi.hoisted(() => ({
  agents: new Map<string, Agent>(),
  sent: [] as Array<{ instanceId: string; type: string; frame: Record<string, any> }>,
  sendHook: null as null | (() => Promise<void>),
}));
vi.mock('./agentRegistry', () => ({
  instanceAgentTransport: (id: string) => reg.agents.get(id) ?? null,
  connectedOwnedBoxes: () => [...reg.agents.entries()]
    .filter(([, a]) => (a.conn as { kind: string }).kind === 'owned-box')
    .map(([, a]) => ({ instance: (a.conn as any).instance, user: (a.conn as any).user, agentCommit: null, capabilities: a.capabilities })),
  sendToInstanceAgent: vi.fn(async (instanceId: string, type: string, frame: Record<string, any>) => {
    if (reg.sendHook) await reg.sendHook();
    reg.sent.push({ instanceId, type, frame });
  }),
}));

const ld = vi.hoisted(() => ({
  initialized: true,
  enabled: true as boolean | null,
  config: {} as unknown,
  configUnknown: false,
  flagListeners: [] as Array<{ keys: readonly string[]; listener: () => void }>,
  readyListeners: [] as Array<() => void>,
}));
vi.mock('./featureFlags', () => ({
  flagsInitialized: () => ld.initialized,
  boolVariationOrUnknown: async () => ld.enabled,
  jsonVariationOrUnknown: async () => (ld.configUnknown ? null : { value: ld.config }),
  onFlagUpdate: (keys: readonly string[], listener: () => void) => { ld.flagListeners.push({ keys, listener }); },
  onFlagsReady: (listener: () => void) => { ld.readyListeners.push(listener); },
}));

const {
  BAZEL_CACHE_REASONS, bazelCacheStepFor, deliverBazelCache, nextBazelCacheSeq, redeliverBazelCache, resetBazelCacheDelivery, startBazelCacheDelivery,
} = await import('./bazelCacheDelivery');
const { setBazelCacheGenerationForTest } = await import('./bazelCacheGeneration');

const ORIGIN = 'https://termag-bazel-cache-123456789012-us-east-2-an.s3.us-east-2.amazonaws.com';
const ada = { id: 'u_ada', googleEmail: 'ada@example.com', displayName: 'Ada', unixUsername: 'ada', defaultAgentProvider: 'claude' };
const ownedBox = (id: string, over: Record<string, unknown> = {}) => ({ kind: 'owned-box', user: ada, instance: { id, name: `ada-${id}`, userId: 'u_ada', kind: 'ec2', ...over } });
const V2 = ['credentials-v1', 'bazel-cache-v2'];
const connect = (id: string, capabilities = V2, conn: unknown = ownedBox(id)) => reg.agents.set(id, { conn, capabilities });
const box = { user: ada, instance: { id: 'i1', name: 'ada-i1', kind: 'ec2' } };
const DEFAULTS = { flushGeneration: 0, remoteTimeoutSeconds: 5, remoteRetries: 1, jobs: 200, downloadOutputs: 'toplevel', goHostModcache: false };

beforeEach(() => {
  resetBazelCacheDelivery();
  reg.agents.clear();
  reg.sent = [];
  reg.sendHook = null;
  db.status = 'ready';
  Object.assign(ld, { initialized: true, enabled: true, config: {}, configUnknown: false });
  process.env.BAZEL_CACHE_URL = ORIGIN;
  setBazelCacheGenerationForTest('2026w45');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.BAZEL_CACHE_URL;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('bazelCacheStepFor', () => {
  it('applies with a valid BAZEL_CACHE_URL, the flag on and a known generation: the URL from the environment, the settings clamped', async () => {
    ld.config = { jobs: 100, remoteTimeoutSeconds: 999 };
    expect(await bazelCacheStepFor(box)).toEqual({
      type: 'credentials-apply', provider: 'bazel-cache',
      payload: { url: `${ORIGIN}/g/2026w45`, ...DEFAULTS, jobs: 100 },
    });
  });

  it('never takes the URL or bucket from the config flag', async () => {
    ld.config = { url: 'https://evil.example.com', bucket: 'evil' };
    const step = await bazelCacheStepFor(box);
    expect(step).toEqual({ type: 'credentials-apply', provider: 'bazel-cache', payload: { url: `${ORIGIN}/g/2026w45`, ...DEFAULTS } });
  });

  it('removes with the flag off or the URL unset or invalid, still carrying flushGeneration', async () => {
    ld.config = { flushGeneration: 7 };
    ld.enabled = false;
    expect(await bazelCacheStepFor(box)).toEqual({ type: 'credentials-remove', provider: 'bazel-cache', reason: BAZEL_CACHE_REASONS.off, flushGeneration: 7 });
    ld.enabled = true;
    delete process.env.BAZEL_CACHE_URL;
    expect(await bazelCacheStepFor(box)).toEqual({ type: 'credentials-remove', provider: 'bazel-cache', reason: BAZEL_CACHE_REASONS.noUrl, flushGeneration: 7 });
    process.env.BAZEL_CACHE_URL = 'https://bazel-cache.termag.example.internal';
    expect(await bazelCacheStepFor(box)).toMatchObject({ type: 'credentials-remove', reason: BAZEL_CACHE_REASONS.noUrl });
  });

  it('gives no step with no generation yet, while the flag source is uninitialized, or when either flag fails to evaluate', async () => {
    setBazelCacheGenerationForTest(null);
    expect(await bazelCacheStepFor(box)).toBeNull();
    setBazelCacheGenerationForTest('2026w45');
    ld.initialized = false;
    expect(await bazelCacheStepFor(box)).toBeNull();
    ld.initialized = true;
    // A failed evaluation is not an off: no remove, and no fallback config over what was sent.
    ld.enabled = null;
    expect(await bazelCacheStepFor(box)).toBeNull();
    ld.enabled = false;
    ld.configUnknown = true;
    expect(await bazelCacheStepFor(box)).toBeNull();
  });
});

describe('deliverBazelCache', () => {
  it('sends the apply frame with seq first in the payload, and the remove frame with reason, flushGeneration and seq', async () => {
    connect('i1');
    await deliverBazelCache('i1', { force: true });
    ld.enabled = false;
    ld.config = { flushGeneration: 2 };
    await deliverBazelCache('i1');
    expect(reg.sent).toEqual([
      { instanceId: 'i1', type: 'credentials-apply', frame: { provider: 'bazel-cache', payload: { seq: expect.any(Number), url: `${ORIGIN}/g/2026w45`, ...DEFAULTS } } },
      { instanceId: 'i1', type: 'credentials-remove', frame: { provider: 'bazel-cache', reason: BAZEL_CACHE_REASONS.off, flushGeneration: 2, seq: expect.any(Number) } },
    ]);
    expect(Object.keys(reg.sent[0].frame.payload)[0]).toBe('seq');
    expect(reg.sent[1].frame.seq).toBeGreaterThan(reg.sent[0].frame.payload.seq);
  });

  it('sends nothing to a box without bazel-cache-v2, an unmanaged or warm box, or a quarantined or terminated one', async () => {
    connect('v1', ['credentials-v1', 'bazel-cache-v1']);
    connect('ext', V2, ownedBox('ext', { kind: 'external' }));
    connect('warm', V2, { kind: 'warm-box', instance: { id: 'warm', userId: null, kind: 'ec2' } });
    for (const id of ['v1', 'ext', 'warm']) await deliverBazelCache(id, { force: true });
    connect('q');
    db.status = 'quarantined';
    await deliverBazelCache('q', { force: true });
    db.status = 'terminated';
    await deliverBazelCache('q', { force: true });
    expect(reg.sent).toEqual([]);
  });

  it('skips an unchanged step unless forced, and never skips a raised flushGeneration, for an apply or a remove', async () => {
    connect('i1');
    await deliverBazelCache('i1', { force: true });
    await deliverBazelCache('i1');
    expect(reg.sent).toHaveLength(1);
    await deliverBazelCache('i1', { force: true });
    expect(reg.sent).toHaveLength(2);
    ld.config = { flushGeneration: 1 };
    await deliverBazelCache('i1');
    expect(reg.sent).toHaveLength(3);
    expect(reg.sent[2].frame.payload.flushGeneration).toBe(1);
    ld.enabled = false;
    await deliverBazelCache('i1');
    await deliverBazelCache('i1');
    expect(reg.sent).toHaveLength(4);
    ld.config = { flushGeneration: 2 };
    await deliverBazelCache('i1');
    expect(reg.sent).toHaveLength(5);
    expect(reg.sent[4]).toMatchObject({ type: 'credentials-remove', frame: { flushGeneration: 2 } });
  });

  it('a new generation changes the step; a settings change alone does too, and is sent', async () => {
    connect('i1');
    await deliverBazelCache('i1', { force: true });
    setBazelCacheGenerationForTest('2026w46');
    await deliverBazelCache('i1');
    expect(reg.sent[1].frame.payload.url).toBe(`${ORIGIN}/g/2026w46`);
    ld.config = { jobs: 300 };
    await deliverBazelCache('i1');
    expect(reg.sent[2].frame.payload.jobs).toBe(300);
  });

  it('two overlapping deliveries to one box end with the later evaluation applied, at a higher seq', async () => {
    connect('i1');
    let release!: () => void;
    reg.sendHook = () => new Promise<void>(r => { release = r; });
    const first = deliverBazelCache('i1', { force: true });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    // The flag turns off while the apply is in flight.
    ld.enabled = false;
    const second = deliverBazelCache('i1');
    reg.sendHook = null;
    release();
    await Promise.all([first, second]);
    expect(reg.sent.map(s => s.type)).toEqual(['credentials-apply', 'credentials-remove']);
    expect(reg.sent[1].frame.seq).toBeGreaterThan(reg.sent[0].frame.payload.seq);
  });

  it('evaluates again after a send, and sends once more when the inputs moved meanwhile', async () => {
    connect('i1');
    reg.sendHook = async () => { reg.sendHook = null; setBazelCacheGenerationForTest('2026w46'); };
    await deliverBazelCache('i1', { force: true });
    expect(reg.sent.map(s => s.frame.payload.url)).toEqual([`${ORIGIN}/g/2026w45`, `${ORIGIN}/g/2026w46`]);
  });

  it('still runs a pass asked for while a send was failing: a reconnect mid-send gets its forced apply', async () => {
    connect('i1');
    let fail!: () => void;
    reg.sendHook = () => new Promise<void>((_ok, no) => { fail = () => no(new Error('replaced by new agent')); });
    const first = deliverBazelCache('i1', { force: true });
    await vi.waitFor(() => expect(fail).toBeTypeOf('function'));
    // The agent reconnects: its hello asks for a forced delivery while the old socket's send is in flight.
    const second = deliverBazelCache('i1', { force: true });
    reg.sendHook = null;
    fail();
    await Promise.all([first, second]);
    expect(reg.sent).toEqual([{ instanceId: 'i1', type: 'credentials-apply', frame: expect.objectContaining({ provider: 'bazel-cache' }) }]);
  });

  it('a reconnect whose forced pass can send nothing yet still gets its apply from the next unforced delivery', async () => {
    // Each way a forced pass ends with no step: the flag source not initialized, a
    // flag that failed to evaluate, no generation read yet.
    const noStep: Array<[string, () => void, () => void]> = [
      ['the flag source uninitialized', () => { ld.initialized = false; }, () => { ld.initialized = true; }],
      ['a failed flag evaluation', () => { ld.enabled = null; }, () => { ld.enabled = true; }],
      ['no generation yet', () => { setBazelCacheGenerationForTest(null); }, () => { setBazelCacheGenerationForTest('2026w45'); }],
    ];
    for (const [why, block, unblock] of noStep) {
      resetBazelCacheDelivery();
      reg.sent = [];
      connect('i1');
      await deliverBazelCache('i1', { force: true });
      expect(reg.sent, why).toHaveLength(1);
      // The agent reconnects (its box may hold anything) while the step can't be evaluated.
      block();
      await deliverBazelCache('i1', { force: true });
      expect(reg.sent, why).toHaveLength(1);
      // Then it can, and an unforced redelivery (the flag source ready, a flag or generation event)
      // must send the same step again rather than skip it as unchanged.
      unblock();
      await deliverBazelCache('i1');
      expect(reg.sent, why).toHaveLength(2);
      expect(reg.sent[1].type, why).toBe('credentials-apply');
    }
  });

  it('a forced send that fails leaves the next unforced delivery to send, even an unchanged step', async () => {
    connect('i1');
    await deliverBazelCache('i1', { force: true });
    reg.sendHook = async () => { throw new Error('replaced by new agent'); };
    await expect(deliverBazelCache('i1', { force: true })).rejects.toThrow('replaced by new agent');
    reg.sendHook = null;
    await deliverBazelCache('i1');
    expect(reg.sent).toHaveLength(2);
  });

  it('a forced request that arrives during the last pass, past the bound, still makes the next delivery send', async () => {
    connect('i1');
    let calls = 0;
    reg.sendHook = async () => {
      calls++;
      // The inputs move after each of the first four sends, so every pass sends and the run reaches its bound.
      if (calls < 5) setBazelCacheGenerationForTest(`2026w${45 + calls}`);
      // A reconnect asks for a forced delivery during the fifth and last pass: the run ends without it.
      else void deliverBazelCache('i1', { force: true });
    };
    await deliverBazelCache('i1');
    expect(reg.sent).toHaveLength(5);
    reg.sendHook = null;
    // The step is unchanged since the last send, but that forced request never ran, so it must go out now.
    await deliverBazelCache('i1');
    expect(reg.sent).toHaveLength(6);
    expect(reg.sent[5].frame.payload.url).toBe(`${ORIGIN}/g/2026w49`);
  });

  it('rejects with the send error, and does not count the failed step as sent', async () => {
    connect('i1');
    reg.sendHook = async () => { throw new Error('agent gone'); };
    await expect(deliverBazelCache('i1')).rejects.toThrow('agent gone');
    reg.sendHook = null;
    await deliverBazelCache('i1');
    expect(reg.sent).toHaveLength(1);
  });
});

describe('nextBazelCacheSeq', () => {
  it('only rises, even when the clock stands still or goes back', () => {
    const a = nextBazelCacheSeq(1_000);
    const b = nextBazelCacheSeq(1_000);
    const c = nextBazelCacheSeq(500);
    const d = nextBazelCacheSeq(5_000);
    expect([a, b, c, d]).toEqual([1_000, 1_001, 1_002, 5_000]);
  });
});

describe('redeliverBazelCache', () => {
  it('schedules only connected capable managed boxes, spread over a minute, once each until their turn', async () => {
    vi.useFakeTimers();
    connect('a');
    connect('b');
    connect('old', ['credentials-v1']);
    connect('ext', V2, ownedBox('ext', { kind: 'external' }));
    const randoms = [0, 0.999];
    expect(redeliverBazelCache('test', () => randoms.shift() ?? 0)).toBe(2);
    expect(redeliverBazelCache('again')).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(reg.sent.map(s => s.instanceId)).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(59_998);
    expect(reg.sent.map(s => s.instanceId)).toEqual(['a', 'b']);
    // Their turn came: a later change schedules them again; an unchanged step is skipped.
    expect(redeliverBazelCache('later', () => 0)).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(reg.sent).toHaveLength(2);
  });
});

describe('startBazelCacheDelivery', () => {
  it('redelivers on either flag changing and on the flag source becoming ready', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ generation: '2026w45' })));
    const stop = startBazelCacheDelivery({ BAZEL_CACHE_URL: ORIGIN });
    expect(fetchFn).toHaveBeenCalledWith(`${ORIGIN}/current-generation`, expect.anything());
    expect(ld.flagListeners.at(-1)!.keys).toEqual(['box-bazel-cache-enabled', 'box-bazel-cache-config']);
    connect('i1');
    // An uninitialized client at the connect: nothing; the ready event delivers.
    ld.initialized = false;
    await deliverBazelCache('i1', { force: true });
    expect(reg.sent).toHaveLength(0);
    ld.initialized = true;
    ld.readyListeners.at(-1)!();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reg.sent).toHaveLength(1);
    ld.enabled = false;
    ld.flagListeners.at(-1)!.listener();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reg.sent.map(s => s.type)).toEqual(['credentials-apply', 'credentials-remove']);
    stop();
  });

  it('reads no generation without BAZEL_CACHE_URL', () => {
    const fetchFn = vi.spyOn(globalThis, 'fetch');
    startBazelCacheDelivery({});
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
