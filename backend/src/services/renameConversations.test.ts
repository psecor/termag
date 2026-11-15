import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  instance: { findUnique: vi.fn(async () => ({ id: 'box1', name: 'ada-box', kind: 'ec2' })) },
  tokenUsageDay: {
    findMany: vi.fn(async () => [{ date: '2024-01-02' }]),
    deleteMany: vi.fn((args: unknown) => ({ op: 'days', args })),
    updateMany: vi.fn((args: unknown) => ({ op: 'days-rekey', args })),
  },
  tokenUsageModelDay: {
    deleteMany: vi.fn((args: unknown) => ({ op: 'models', args })),
    updateMany: vi.fn((args: unknown) => ({ op: 'models-rekey', args })),
  },
  $transaction: vi.fn(async (ops: unknown[]) => ops.map((_, i) => ({ count: i === 0 ? 3 : 2 }))),
};
let capabilities: string[] = [];
const boolVariation = vi.fn(async () => true);
const getConnectedAgents = vi.fn(() => [] as unknown[]);

vi.mock('../db', () => ({ prisma }));
vi.mock('./agentRegistry', () => ({
  projectAgentCapabilities: () => capabilities,
  getConnectedAgents,
  sendForProject: vi.fn(),
}));
vi.mock('./featureFlags', () => ({ boolVariation }));

const { carriesConversations, movedUsageSources, RENAME_CONVERSATIONS_CAPABILITY } = await import('./renameConversations');
const { moveUsageSources } = await import('./tokenUsageSampler');
const user = { id: 'u1', googleEmail: 'a@x', displayName: 'A', unixUsername: 'ada', defaultAgentProvider: 'claude' };

beforeEach(() => {
  vi.clearAllMocks();
  capabilities = [RENAME_CONVERSATIONS_CAPABILITY];
});

describe('carriesConversations', () => {
  it('is yes for a box whose agent announces it, with the flag on for the owner and the box', async () => {
    expect(await carriesConversations(user, { userId: 'u1', instanceId: 'box1' })).toBe(true);
    expect(boolVariation).toHaveBeenCalledWith('rename-conversations-enabled', user, false, { id: 'box1', name: 'ada-box', kind: 'ec2' });
  });

  it('is no for an older agent, without reading the flag', async () => {
    capabilities = ['pane-subagents-v1'];
    expect(await carriesConversations(user, { userId: 'u1', instanceId: 'box1' })).toBe(false);
    expect(boolVariation).not.toHaveBeenCalled();
  });

  it('is no with the flag off, and with no box', async () => {
    boolVariation.mockResolvedValueOnce(false);
    expect(await carriesConversations(user, { userId: 'u1', instanceId: 'box1' })).toBe(false);
    expect(await carriesConversations(user, { userId: 'u1', instanceId: null })).toBe(false);
  });

  it('is no, not a throw, when the box lookup fails', async () => {
    prisma.instance.findUnique.mockRejectedValueOnce(new Error('db down'));
    expect(await carriesConversations(user, { userId: 'u1', instanceId: 'box1' })).toBe(false);
  });
});

describe('movedUsageSources', () => {
  it('takes the moved buckets of the answer, old name to new, and drops anything malformed', () => {
    expect(movedUsageSources({ usageSources: [{ from: '-home-ada-a', to: '-home-ada-b' }, { from: 3, to: 'x' }, null, { from: 'y', to: '' }, { from: 'z' }] }))
      .toEqual([{ from: '-home-ada-a', to: '-home-ada-b' }]);
    expect(movedUsageSources({ ok: true })).toEqual([]);
    expect(movedUsageSources(null)).toEqual([]);
  });
});

describe('moveUsageSources', () => {
  it('drops the days a rescan writes again, renames older ones the new name lacks, and rescans', async () => {
    const n = await moveUsageSources('u1', 'box1', [{ from: '-home-ada-a', to: '-home-ada-b' }, { from: '-home-ada-a', to: '-home-ada-c' }]);
    expect(n).toEqual({ dropped: 3, rekeyed: 2 });
    const scope = { userId: 'u1', hostKey: 'box1', provider: 'claude' };
    const since = (prisma.tokenUsageDay.deleteMany.mock.calls[0][0] as { where: { date: { gte: string } } }).where.date.gte;
    expect(since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const recent = { ...scope, sourceKey: '-home-ada-a', date: { gte: since } };
    expect(prisma.tokenUsageDay.deleteMany).toHaveBeenCalledWith({ where: recent });
    expect(prisma.tokenUsageModelDay.deleteMany).toHaveBeenCalledWith({ where: recent });
    expect(prisma.tokenUsageDay.findMany).toHaveBeenCalledWith({ where: { ...scope, sourceKey: '-home-ada-b', date: { lt: since } }, select: { date: true } });
    const older = { where: { ...scope, sourceKey: '-home-ada-a', date: { lt: since, notIn: ['2024-01-02'] } }, data: { sourceKey: '-home-ada-b' } };
    expect(prisma.tokenUsageDay.updateMany).toHaveBeenCalledWith(older);
    expect(prisma.tokenUsageModelDay.updateMany).toHaveBeenCalledWith(older);
    // One move per old name: the second pair for the same folder is ignored.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(getConnectedAgents).toHaveBeenCalled();
  });

  it('does nothing for no moves, or a move onto itself', async () => {
    expect(await moveUsageSources('u1', 'box1', [])).toEqual({ dropped: 0, rekeyed: 0 });
    expect(await moveUsageSources('u1', 'box1', [{ from: 'a', to: 'a' }])).toEqual({ dropped: 0, rekeyed: 0 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
