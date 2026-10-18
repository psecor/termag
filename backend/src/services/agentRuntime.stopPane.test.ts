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

const { stopAgentPane } = await import('./agentRuntime');
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
