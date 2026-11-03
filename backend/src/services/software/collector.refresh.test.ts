import { describe, it, expect, vi } from 'vitest';
vi.mock('../../db', () => ({ prisma: {
  hostSoftware: { findFirst: vi.fn(async () => null) },
  instance: { findMany: vi.fn(async () => []) },
} }));
vi.mock('../agentRegistry', () => ({
  inventoryHosts: () => [{ hostKey: 'box-a', hostKind: 'box', instanceId: 'box-a', userId: 'u1', capabilities: ['software-inventory-v1'], agentCommit: null, agentCommitAt: null }],
  sendToAgent: vi.fn(),
  sendToInstanceAgent: vi.fn(),
}));
vi.mock('../boxProvisioner', () => ({ amiTermagSha: () => null, awsClientConfig: () => ({}), getBoxConfig: () => null }));
vi.mock('../termagVersion', () => ({ termagVersion: async () => ({ sha: null, source: 'unknown' }) }));
vi.mock('./store', () => ({
  parseInventoryReply: (r: unknown) => (r && typeof r === 'object' && 'entries' in r ? { entries: [], agentCommit: null, checkoutCommit: null } : null),
  recordEntries: vi.fn(async () => 0), pruneChanges: vi.fn(async () => {}), ORCHESTRATOR_COMPONENTS: new Set(),
}));
import { sendToInstanceAgent } from '../agentRegistry';
import { refreshHostInventory, sweep } from './collector';

const asks = () => vi.mocked(sendToInstanceAgent).mock.calls.filter(c => c[1] === 'software-inventory').length;

describe('refreshHostInventory', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  it('arms the 6-hour gate only once the ask worked', async () => {
    // A failed RPC, then a bad reply: neither holds the sweep's own ask off.
    vi.mocked(sendToInstanceAgent).mockRejectedValueOnce(new Error('timed out'));
    await expect(refreshHostInventory('box-a')).rejects.toThrow('timed out');
    vi.mocked(sendToInstanceAgent).mockResolvedValueOnce({ nope: true });
    await expect(refreshHostInventory('box-a')).rejects.toThrow('not an inventory reply');
    vi.mocked(sendToInstanceAgent).mockResolvedValueOnce({ entries: [] });
    await sweep();
    expect(asks()).toBe(3);
    // The sweep's success armed it: the next sweep does not ask.
    await sweep();
    expect(asks()).toBe(3);
  });

  it('arms it after a successful refresh', async () => {
    vi.mocked(sendToInstanceAgent).mockClear();
    vi.mocked(sendToInstanceAgent).mockResolvedValueOnce({ entries: [] });
    expect(await refreshHostInventory('box-a')).toBe(true);
    await sweep();
    expect(asks()).toBe(1);
  });
});
