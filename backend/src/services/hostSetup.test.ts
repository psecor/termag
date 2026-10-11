import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory stand-in for the three agentToken calls hostSetup makes.
interface Row { id: string; userId: string; instanceId: string | null; name: string; tokenHash: string; revokedAt: Date | null }
const rows: Row[] = [];
const fakePrisma = {
  agentToken: {
    updateMany: async ({ where, data }: { where: Partial<Omit<Row, 'id'>> & { id?: { not: string } }; data: Partial<Row> }) => {
      const hits = rows.filter(r => r.userId === where.userId && r.instanceId === where.instanceId
        && r.name === where.name && r.revokedAt === null && r.id !== where.id?.not);
      hits.forEach(r => Object.assign(r, data));
      return { count: hits.length };
    },
    create: async ({ data }: { data: Omit<Row, 'id' | 'instanceId' | 'revokedAt'> }) => {
      const row: Row = { id: `t${rows.length + 1}`, instanceId: null, revokedAt: null, ...data };
      rows.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const row = rows.find(r => r.id === where.id)!;
      Object.assign(row, data);
      return row;
    },
  },
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(fakePrisma),
};
vi.mock('../db', () => ({ prisma: fakePrisma }));

const {
  ensureHostSetup,
  hostAgentUnavailableResponse,
  hostSetupEnabled,
  hostStorageReady,
  HOST_STORAGE_READY_FILE,
  HOST_TOKEN_NAME,
} = await import('./hostSetup');

const user = { id: 'u1', unixUsername: 'dev' };
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const active = () => rows.filter(r => r.revokedAt === null);
const noHold = { connectHoldMs: 0 };
const timerSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

beforeEach(() => { rows.length = 0; });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ensureHostSetup', () => {
  it('does nothing when disabled or when the host agent is already connected', async () => {
    const run = vi.fn();
    await expect(ensureHostSetup(user, { enabled: false, isConnected: () => false, storageReady: () => true, run, ...noHold })).resolves.toBe(false);
    await expect(ensureHostSetup(user, { enabled: true, isConnected: () => true, storageReady: () => true, run, ...noHold })).resolves.toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
  });

  it('mints a host token, hands the raw value to the helper, and stores only its hash', async () => {
    const run = vi.fn(async () => {});
    await expect(ensureHostSetup(user, { enabled: true, isConnected: () => false, storageReady: () => true, run, ...noHold })).resolves.toBe(true);

    expect(run).toHaveBeenCalledTimes(1);
    const [unix, raw] = run.mock.calls[0] as unknown as [string, string];
    expect(unix).toBe('dev');
    expect(raw).toMatch(/^tmag_[0-9a-f]{64}$/);
    expect(active()).toEqual([expect.objectContaining({ userId: 'u1', name: HOST_TOKEN_NAME, tokenHash: sha256(raw) })]);
    expect(JSON.stringify(rows)).not.toContain(raw);
  });

  it('replaces the previous host token but leaves hand-made tokens alone', async () => {
    rows.push(
      { id: 'old', userId: 'u1', instanceId: null, name: HOST_TOKEN_NAME, tokenHash: 'x', revokedAt: null },
      { id: 'laptop', userId: 'u1', instanceId: null, name: 'macbook', tokenHash: 'y', revokedAt: null },
    );
    await ensureHostSetup(user, { enabled: true, isConnected: () => false, storageReady: () => true, run: async () => {}, ...noHold });

    expect(rows.find(r => r.id === 'old')!.revokedAt).not.toBeNull();
    expect(rows.find(r => r.id === 'laptop')!.revokedAt).toBeNull();
    expect(active().filter(r => r.name === HOST_TOKEN_NAME)).toHaveLength(1);
  });

  it('revokes the token it just minted when the helper fails, and never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const run = vi.fn(async () => { throw new Error('termag-host-setup exited 2: reserved username'); });
    await expect(ensureHostSetup(user, { enabled: true, isConnected: () => false, storageReady: () => true, run, ...noHold })).resolves.toBe(false);

    expect(rows).toHaveLength(1);
    expect(rows[0].revokedAt).not.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('reserved username'));
  });

  it('keeps the previous host token live when the helper fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    rows.push({ id: 'old', userId: 'u1', instanceId: null, name: HOST_TOKEN_NAME, tokenHash: 'x', revokedAt: null });
    const run = vi.fn(async () => { throw new Error('termag-host-setup exited 3: host storage is not mounted'); });
    await expect(ensureHostSetup(user, { enabled: true, isConnected: () => false, storageReady: () => true, run, ...noHold })).resolves.toBe(false);

    expect(active().map(r => r.id)).toEqual(['old']);
  });

  it('mints nothing and runs no helper until host storage is ready', async () => {
    const run = vi.fn(async () => {});
    rows.push({ id: 'old', userId: 'u1', instanceId: null, name: HOST_TOKEN_NAME, tokenHash: 'x', revokedAt: null });
    let ready = false;
    const deps = { enabled: true, isConnected: () => false, storageReady: () => ready, run, ...noHold };

    await expect(ensureHostSetup(user, deps)).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(rows.map(r => [r.id, r.revokedAt])).toEqual([['old', null]]);

    ready = true;
    await expect(ensureHostSetup(user, deps)).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('still reports a connected host agent while storage is attaching', async () => {
    const run = vi.fn(async () => {});
    await expect(ensureHostSetup(user, { enabled: true, isConnected: () => true, storageReady: () => false, run, ...noHold })).resolves.toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it('runs one setup per user at a time', async () => {
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>(r => { finish = r; }));
    const deps = { enabled: true, isConnected: () => false, storageReady: () => true, run, ...noHold };

    const a = ensureHostSetup(user, deps);
    const b = ensureHostSetup(user, deps);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    finish();
    await expect(Promise.all([a, b])).resolves.toEqual([true, true]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(active()).toHaveLength(1);
  });

  it('keeps sequential retries coalesced while waiting for the agent to connect', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const deps = {
      enabled: true,
      isConnected: () => false, storageReady: () => true,
      run,
      connectHoldMs: 500,
      sleep: timerSleep,
    };

    const first = ensureHostSetup(user, deps);
    await vi.advanceTimersByTimeAsync(0);
    const second = ensureHostSetup(user, deps);

    expect(second).toBe(first);
    expect(run).toHaveBeenCalledTimes(1);
    const raw = run.mock.calls[0][1];
    expect(active()).toEqual([expect.objectContaining({ tokenHash: sha256(raw) })]);

    await vi.advanceTimersByTimeAsync(500);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(active()).toEqual([expect.objectContaining({ tokenHash: sha256(raw) })]);
  });

  it('coalesces overlap across both the helper run and connect hold', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const deps = {
      enabled: true,
      isConnected: () => false, storageReady: () => true,
      run,
      connectHoldMs: 500,
      sleep: timerSleep,
    };

    const first = ensureHostSetup(user, deps);
    const duringHelper = ensureHostSetup(user, deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    finish();
    await vi.advanceTimersByTimeAsync(0);
    const duringHold = ensureHostSetup(user, deps);
    expect(duringHelper).toBe(first);
    expect(duringHold).toBe(first);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    await expect(Promise.all([first, duringHelper, duringHold])).resolves.toEqual([true, true, true]);
  });

  it('finishes the hold on the next poll once the agent connects', async () => {
    vi.useFakeTimers();
    let connected = false;
    const run = vi.fn(async () => {});
    const deps = {
      enabled: true,
      isConnected: () => connected, storageReady: () => true,
      run,
      connectHoldMs: 30_000,
      sleep: timerSleep,
    };

    const attempt = ensureHostSetup(user, deps);
    await vi.advanceTimersByTimeAsync(0);
    connected = true;
    await vi.advanceTimersByTimeAsync(250);

    await expect(attempt).resolves.toBe(true);
    await expect(ensureHostSetup(user, deps)).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows a recovery remint after the connect hold times out', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const deps = {
      enabled: true,
      isConnected: () => false, storageReady: () => true,
      run,
      connectHoldMs: 50,
      sleep: timerSleep,
    };

    const first = ensureHostSetup(user, deps);
    await vi.advanceTimersByTimeAsync(50);
    await expect(first).resolves.toBe(true);
    const firstHash = active()[0].tokenHash;
    expect(vi.getTimerCount()).toBe(0);

    const recovery = ensureHostSetup(user, deps);
    await vi.advanceTimersByTimeAsync(50);
    await expect(recovery).resolves.toBe(true);

    expect(run).toHaveBeenCalledTimes(2);
    expect(active()).toHaveLength(1);
    expect(active()[0].tokenHash).not.toBe(firstHash);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not hold after helper failure and permits the next attempt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('unit failed'))
      .mockResolvedValueOnce(undefined);
    const deps = { enabled: true, isConnected: () => false, storageReady: () => true, run, ...noHold };

    await expect(ensureHostSetup(user, deps)).resolves.toBe(false);
    await expect(ensureHostSetup(user, deps)).resolves.toBe(true);

    expect(run).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(2);
    expect(active()).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unit failed'));
  });

  it('isolates setup holds by user', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const deps = {
      enabled: true,
      isConnected: () => false, storageReady: () => true,
      run,
      connectHoldMs: 50,
      sleep: timerSleep,
    };
    const otherUser = { id: 'u2', unixUsername: 'other' };

    const first = ensureHostSetup(user, deps);
    const second = ensureHostSetup(otherUser, deps);
    await vi.advanceTimersByTimeAsync(0);

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.map(([name]) => name)).toEqual(['dev', 'other']);

    await vi.advanceTimersByTimeAsync(50);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(active()).toHaveLength(2);
  });

  it('rejects an invalid unix username before minting or running the helper', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const run = vi.fn(async () => {});

    await expect(ensureHostSetup(
      { id: 'bad', unixUsername: 'systemd-network' },
      { enabled: true, isConnected: () => false, storageReady: () => true, run, ...noHold },
    )).resolves.toBe(false);

    expect(run).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('is reserved on this host'));
  });
});

describe('hostAgentUnavailableResponse', () => {
  it('returns no error when autosetup is disabled or the agent is connected', () => {
    expect(hostAgentUnavailableResponse(user, false, false)).toBeNull();
    expect(hostAgentUnavailableResponse(user, true, true)).toBeNull();
  });

  it('returns the existing retry response for a valid disconnected user', () => {
    expect(hostAgentUnavailableResponse(user, false, true, true)).toEqual({
      status: 503,
      error: 'Setting up your termag-agent on the orchestrator; try again in a few seconds.',
    });
  });

  it('returns a storage-attaching 503 while host storage is not ready', () => {
    expect(hostAgentUnavailableResponse(user, false, true, false)).toEqual({
      status: 503,
      error: 'Host storage is attaching after a deploy; try again in a few minutes.',
    });
    expect(hostAgentUnavailableResponse(user, true, true, false)).toBeNull();
    expect(hostAgentUnavailableResponse(user, false, false, false)).toBeNull();
  });

  it('returns an actionable client error for an invalid disconnected user', () => {
    expect(hostAgentUnavailableResponse(
      { id: 'bad', unixUsername: '_apt' },
      false,
      true,
    )).toEqual({
      status: 400,
      error: 'Unix username "_apt" is reserved on this host and cannot be auto-provisioned. Use a box, or ask an admin to map your email to a different unix username.',
    });
  });
});

describe('hostSetupEnabled', () => {
  it('is on only for HOST_AUTOSETUP=true', () => {
    expect(hostSetupEnabled({ HOST_AUTOSETUP: 'true' })).toBe(true);
    for (const v of [undefined, '', 'false', '1', 'TRUE']) {
      expect(hostSetupEnabled({ HOST_AUTOSETUP: v })).toBe(false);
    }
  });
});

describe('hostStorageReady', () => {
  it('reads the ready file at most once a second', () => {
    const exists = vi.fn((path: string) => path === HOST_STORAGE_READY_FILE);
    const t = Date.now() + 3_600_000;
    expect(hostStorageReady(t, exists)).toBe(true);
    expect(hostStorageReady(t + 999, () => false)).toBe(true);
    expect(exists).toHaveBeenCalledTimes(1);
    expect(hostStorageReady(t + 1_000, () => false)).toBe(false);
  });

  it('checks /run/termag/host-storage-ready', () => {
    expect(HOST_STORAGE_READY_FILE).toBe('/run/termag/host-storage-ready');
  });
});
