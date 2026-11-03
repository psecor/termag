import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// historyFor's collaborators, mocked at the module edge like the capture
// route's tests do: the access gate and the agent RPC send.
vi.mock('../services/sessionAccess', () => ({
  assertSessionAccess: vi.fn(async () => ({
    session: 'u-p-agent',
    host: { instanceId: 'i-1', host: '10.0.0.1', userId: 'u' },
  })),
  SessionAccessError: class SessionAccessError extends Error {
    constructor(public status: number, message: string) { super(message); }
  },
}));

const sendForProject = vi.fn(async () => ({ content: 'earlier\n', startByte: 10, endByte: 65546, totalBytes: 70000 }));
const isProjectAgentConnected = vi.fn(() => true);
vi.mock('../services/agentRegistry', () => ({
  sendForProject: (...a: unknown[]) => sendForProject(...(a as [])),
  isProjectAgentConnected: (...a: unknown[]) => isProjectAgentConnected(...(a as [])),
}));

import { historyFor } from './paneHistory';

describe('historyFor', () => {
  // The rate limiter keys on wall time and its Map lives at module level, so
  // each test runs at its own (later) frozen clock instead of sharing one.
  let clock = 1_000_000;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    clock += 10_000;
    vi.setSystemTime(clock);
    sendForProject.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('tails the pane history for the session the access gate named', async () => {
    const r = await historyFor('u1', 'p1', 'agent', {});
    expect(r.status).toBe(200);
    expect(sendForProject.mock.calls[0][1]).toBe('pane-history-read');
    expect(sendForProject.mock.calls[0][2]).toEqual({ sessionName: 'u-p-agent', beforeBytes: undefined, maxBytes: 65536 });
    expect(r.body).toMatchObject({ session: 'u-p-agent', content: 'earlier\n', startByte: 10, totalBytes: 70000 });
  });

  it('clamps maxBytes and passes before through', async () => {
    await historyFor('u1', 'p1', 'agent', { maxBytes: '9999999', before: '123' });
    expect(sendForProject.mock.calls[0][2]).toEqual({ sessionName: 'u-p-agent', beforeBytes: 123, maxBytes: 256 * 1024 });
    vi.setSystemTime(clock + 1100);
    await historyFor('u1', 'p1', 'agent', { maxBytes: '0' });
    expect(sendForProject.mock.calls[1][2]).toEqual({ sessionName: 'u-p-agent', beforeBytes: undefined, maxBytes: 1 });
  });

  it('rate limits per caller and session at 1/s', async () => {
    const first = await historyFor('u1', 'p1', 'agent', {}, 'browser');
    expect(first.status).toBe(200);
    const second = await historyFor('u1', 'p1', 'agent', {}, 'browser');
    expect(second.status).toBe(429);
    // A different caller or session has its own budget.
    const other = await historyFor('u1', 'p1', 'agent', {}, 'cli');
    expect(other.status).toBe(200);
    // A second later the first caller's budget is back.
    vi.setSystemTime(clock + 1100);
    const later = await historyFor('u1', 'p1', 'agent', {}, 'browser');
    expect(later.status).toBe(200);
  });

  it("maps an old agent's unknown command to 501", async () => {
    sendForProject.mockRejectedValueOnce(new Error('Unknown command: pane-history-read'));
    const r = await historyFor('u1', 'p1', 'agent', {});
    expect(r.status).toBe(501);
    expect((r.body as { error: string }).error).toMatch(/needs an update/);
  });

  it('maps a missing log to 404', async () => {
    sendForProject.mockRejectedValueOnce(new Error('no pane history for this session'));
    const r = await historyFor('u1', 'p1', 'agent', {});
    expect(r.status).toBe(404);
  });

  it('maps an offline agent to 503', async () => {
    isProjectAgentConnected.mockReturnValueOnce(false);
    const r = await historyFor('u1', 'p1', 'agent', {});
    expect(r.status).toBe(503);
    expect((r.body as { error: string }).error).toMatch(/offline/);
  });

  it('maps a failed RPC to 503 with the reason', async () => {
    sendForProject.mockRejectedValueOnce(new Error('socket hung up'));
    const r = await historyFor('u1', 'p1', 'agent', {});
    expect(r.status).toBe(503);
    expect((r.body as { error: string }).error).toMatch(/socket hung up/);
  });
});
