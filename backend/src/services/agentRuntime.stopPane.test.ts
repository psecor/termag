import { beforeEach, describe, expect, it, vi } from 'vitest';

const sent: { type: string; payload: Record<string, unknown> }[] = [];
const events: string[] = [];
const connected = { value: true };

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('./agentRegistry', () => ({
  isProjectAgentConnected: vi.fn(() => connected.value),
  sendForProject: vi.fn(async (_host: unknown, type: string, payload: Record<string, unknown> = {}) => {
    sent.push({ type, payload });
    events.push(`rpc:${type}`);
    return {};
  }),
}));
vi.mock('./tmuxPoller', () => ({
  registerPollerSession: vi.fn(),
  unregisterPollerSession: vi.fn((s: string) => { events.push(`unregister:${s}`); }),
}));
const killSession = vi.fn(async () => {});
vi.mock('./tmux', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tmux')>()),
  killSession,
}));

const { stopAgentPane, stopAgentSessions } = await import('./agentRuntime');
const { PROVIDERS } = await import('../providers/registry');
const pollerProvider = Object.values(PROVIDERS).find(p => p.needsPoller)!.id;

const ctx = { userId: 'u1', unixUsername: 'ada', projectName: 'termag', instanceId: 'box1', workstream: 'feature-x' };

describe('stopAgentPane', () => {
  beforeEach(() => { sent.length = 0; events.length = 0; connected.value = true; killSession.mockClear(); });

  it('unregisters a poller only after the pane is gone', async () => {
    await stopAgentPane({ ...ctx, provider: pollerProvider });
    expect(events).toEqual(['rpc:tmux-kill', 'unregister:ada-termag-feature-x-agent']);
  });

  it('keeps the poller of an agent it failed to stop', async () => {
    connected.value = false;
    await expect(stopAgentPane({ ...ctx, provider: pollerProvider })).rejects.toThrow();
    expect(events).toEqual([]);
  });

  it('kills only the agent session, by exact name', async () => {
    await stopAgentPane({ ...ctx, provider: 'claude' });
    expect(sent).toEqual([{ type: 'tmux-kill', payload: { sessionName: 'ada-termag-feature-x-agent', exact: true } }]);
  });

  it('stops a Codex bridge before the kill', async () => {
    await stopAgentPane({ ...ctx, provider: 'codex' });
    expect(sent.map(s => s.type)).toEqual(['codex-session-stop', 'tmux-kill']);
  });

  it('throws for a box whose agent is offline, so the caller can undo', async () => {
    connected.value = false;
    await expect(stopAgentPane({ ...ctx, provider: 'claude' })).rejects.toThrow(/not connected/);
    expect(sent).toEqual([]);
  });

  it('uses local tmux for a legacy project on the orchestrator', async () => {
    connected.value = false;
    await stopAgentPane({ ...ctx, instanceId: null, provider: 'claude' });
    expect(killSession).toHaveBeenCalledWith('ada-termag-feature-x-agent');
  });
});

describe('stopAgentSessions: every review pane, every terminal slot', () => {
  beforeEach(() => { sent.length = 0; events.length = 0; connected.value = true; killSession.mockClear(); });
  it('kills all eight review slots by exact target, beside the agent pair', async () => {
    await stopAgentSessions({ ...ctx, provider: 'claude' });
    const kills = sent.filter(s => s.type === 'tmux-kill').map(s => s.payload.sessionName);
    expect(kills.slice(0, 2)).toEqual(['ada-termag-feature-x-agent', 'ada-termag-feature-x-ctrl']);
    expect(kills.slice(2, 10)).toEqual(['=ada-termag-feature-x-review:', ...[2, 3, 4, 5, 6, 7, 8].map(n => `=ada-termag-feature-x-review-${n}:`)]);
    // The user's terminal slots 2..8 die with the workflow too.
    expect(kills.slice(10)).toEqual([2, 3, 4, 5, 6, 7, 8].map(n => `=ada-termag-feature-x-ctrl-${n}:`));
  });
  it('kills them on the orchestrator\'s own tmux for a legacy project', async () => {
    connected.value = false;
    await stopAgentSessions({ ...ctx, instanceId: null, provider: 'claude' });
    expect(killSession.mock.calls.map(c => (c as unknown[])[0])).toContain('ada-termag-feature-x-review-8');
    expect(killSession.mock.calls.map(c => (c as unknown[])[0])).toContain('ada-termag-feature-x-ctrl-8');
  });
});
