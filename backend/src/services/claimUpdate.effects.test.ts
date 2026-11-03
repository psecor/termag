// prismaClaimUpdateEffects' writes. Bugbot on #1118: a run aborted before its
// RPC (too little of the bound left) must not leave updatePushedAt set, which
// the lifecycle sweep reads as an update in flight (boxLifecycle.ts).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const writes: Array<{ where: unknown; data: Record<string, unknown> }> = [];
vi.mock('../db', () => ({ prisma: { instance: { updateMany: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => { writes.push(args); return { count: 1 }; }) } } }));
const send = vi.fn(async () => ({ ok: true }));
vi.mock('./agentRegistry', () => ({ sendToInstanceAgent: (...a: unknown[]) => send(...(a as [])) }));
vi.mock('./boxUpdate', () => ({ BOX_UPDATE_CAPABILITY: 'box-update-v1', noteClaimUpdated: () => {} }));
vi.mock('./termagVersion', () => ({ termagVersion: async () => ({ sha: null, source: 'unknown' }) }));

const { prismaClaimUpdateEffects: fx, runClaimUpdate, CLAIM_UPDATE_TIMEOUT_MS } = await import('./claimUpdate');

beforeEach(() => { writes.length = 0; send.mockReset(); send.mockResolvedValue({ ok: true }); });

describe('prismaClaimUpdateEffects', () => {
  it('marks the row updating without stamping a push: nothing has been sent yet', async () => {
    await fx.begin('box1', 'a → b');
    expect(writes).toHaveLength(1);
    expect(writes[0].data).toMatchObject({ claimUpdateStatus: 'updating' });
    expect(writes[0].data).not.toHaveProperty('updatePushedAt');
  });

  it('stamps the push as the RPC goes out, for the report to clear', async () => {
    await fx.sendUpdate('box1', 'b'.repeat(40));
    expect(writes.map(w => Object.keys(w.data))).toEqual([['updatePushedAt']]);
    expect(send).toHaveBeenCalledWith('box1', 'box-update', { target: 'b'.repeat(40) }, 15_000);
  });

  it('takes the stamp back when the RPC fails: no run will report it', async () => {
    send.mockRejectedValueOnce(new Error('not installed'));
    await expect(fx.sendUpdate('box1', 'b'.repeat(40))).rejects.toThrow('not installed');
    expect(writes.map(w => w.data.updatePushedAt === null ? 'cleared' : 'stamped')).toEqual(['stamped', 'cleared']);
  });
});

// The finding's own path, through runClaimUpdate with these writes: the
// delivery leaves too little of the bound, the run ends before its RPC.
describe('a run aborted before its RPC', () => {
  it('leaves no push stamp on the row', async () => {
    let now = 0;
    const result = await runClaimUpdate({ id: 'box1', name: 'b', kind: 'ec2', userId: 'u' }, {
      ...fx,
      now: () => now,
      targetCommit: async () => 'b'.repeat(40),
      agent: () => ({ conn: {}, capabilities: ['box-update-v1'], agentCommit: 'a'.repeat(40), helloReceived: true }),
      settled: () => true,
    }, { before: Promise.resolve().then(() => { now = CLAIM_UPDATE_TIMEOUT_MS; }) });
    expect(result.status).toBe('timed-out');
    expect(send).not.toHaveBeenCalled();
    expect(writes.some(w => 'updatePushedAt' in w.data)).toBe(false);
    expect(writes.map(w => w.data.claimUpdateStatus)).toEqual(['updating', 'timed-out']);
  });
});
