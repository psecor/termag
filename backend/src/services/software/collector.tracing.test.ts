import { describe, it, expect, vi } from 'vitest';
// The software sweep's span has to cover the pass itself: run() only starts
// one (singleFlight), so a span around it would end before the pass's calls
// and could never see the pass fail.
const passes = vi.hoisted(() => [] as Array<{ sweep?: string }>);
vi.mock('../../db', () => ({ prisma: {} }));
vi.mock('../agentRegistry', () => ({ inventoryHosts: () => [], sendToAgent: vi.fn(), sendToInstanceAgent: vi.fn() }));
vi.mock('../boxProvisioner', () => ({ amiTermagSha: () => null, awsClientConfig: () => ({}), getBoxConfig: () => null }));
vi.mock('../termagVersion', () => ({ termagVersion: async () => ({ sha: null, source: 'unknown' }) }));
vi.mock('../tracing/spans', () => ({
  traceSweep: (name: string, fn: (...a: unknown[]) => unknown) => Object.assign((...a: unknown[]) => fn(...a), { sweep: name }),
}));
vi.mock('./runner', () => ({
  singleFlight: (pass: { sweep?: string }) => { passes.push(pass); return { run: vi.fn(), idle: async () => {} }; },
}));
await import('./collector');

describe('the software sweep span', () => {
  it('wraps the pass that singleFlight runs, not the tick that starts it', () => {
    expect(passes.map(p => p.sweep)).toEqual(['software']);
  });
});
