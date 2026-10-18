import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  collabResponse: { findMany: vi.fn(), updateMany: vi.fn() },
  project: { findFirst: vi.fn() },
}));
vi.mock('../db', () => ({ prisma }));
vi.mock('./agentRegistry', () => ({ isProjectAgentConnected: vi.fn(() => true), sendForProject: vi.fn(async () => ({ ok: true })) }));
vi.mock('./status', () => ({ getStatus: vi.fn(() => ({ status: 'idle' })) }));
vi.mock('./humanActivity', () => ({ lastHumanHeartbeat: vi.fn(() => null) }));
vi.mock('../slack/collab', () => ({ notifyResponse: vi.fn(async () => true) }));

import { runCollabNotifyRetryTick, runCollabNudgeTick } from './collabSweep';
import { notifyResponse } from '../slack/collab';
import { sendForProject } from './agentRegistry';
import { getStatus } from './status';

const now = Date.parse('2026-10-17T12:00:00Z');
const request = { id: 'cr1', userId: 'u1', projectId: 'p1', workstream: 'slack-app', fromRole: 'agent' };
const reply = (id: string) => ({ id, requestId: 'cr1', createdAt: new Date(now - 5_000), nudgedAt: null, request });

describe('runCollabNudgeTick', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.collabResponse.findMany.mockResolvedValue([reply('r1'), reply('r2')]);
    prisma.collabResponse.updateMany.mockResolvedValue({ count: 2 });
    prisma.project.findFirst.mockResolvedValue({ name: 'termag', instanceId: 'box1', user: { unixUsername: 'me' } });
    vi.mocked(getStatus).mockReturnValue({ status: 'idle' } as never);
  });

  it('reads only replies not yet nudged, on requests an agent drafted', async () => {
    await runCollabNudgeTick(now);
    expect(prisma.collabResponse.findMany.mock.calls[0][0].where).toEqual({
      nudgedAt: null, request: { fromSession: { not: null }, projectId: { not: null } },
    });
  });

  it('types one fixed line per request into the asking agent pane', async () => {
    expect(await runCollabNudgeTick(now)).toBe(1);
    expect(prisma.collabResponse.updateMany.mock.calls[0][0]).toEqual({ where: { id: { in: ['r1', 'r2'] }, nudgedAt: null }, data: { nudgedAt: new Date(now) } });
    const [host, cmd, args] = vi.mocked(sendForProject).mock.calls[0];
    expect(host).toEqual({ userId: 'u1', instanceId: 'box1' });
    expect(cmd).toBe('tmux-send-keys');
    expect(args).toEqual({
      sessionName: 'me-termag-slack-app-agent', withEnter: true, literal: true,
      keys: '[termag] 2 new replies to your Slack request cr1. Call slack_inbox (metaterm MCP server) to read them.',
    });
  });

  it('waits while the pane is busy and types nothing when another process claimed the replies', async () => {
    vi.mocked(getStatus).mockReturnValue({ status: 'working' } as never);
    await runCollabNudgeTick(now);
    expect(prisma.collabResponse.updateMany).not.toHaveBeenCalled();
    vi.mocked(getStatus).mockReturnValue({ status: 'idle' } as never);
    prisma.collabResponse.updateMany.mockResolvedValue({ count: 0 });
    expect(await runCollabNudgeTick(now)).toBe(0);
    expect(sendForProject).not.toHaveBeenCalled();
  });

  it('stamps replies whose project is gone without typing anything', async () => {
    prisma.project.findFirst.mockResolvedValue(null);
    await runCollabNudgeTick(now);
    expect(prisma.collabResponse.updateMany).toHaveBeenCalledTimes(1);
    expect(sendForProject).not.toHaveBeenCalled();
  });
});

describe('runCollabNotifyRetryTick', () => {
  beforeEach(() => vi.clearAllMocks());

  it('retries the sender DM for replies whose live notice failed, after the first minute and for half an hour', async () => {
    prisma.collabResponse.findMany.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);
    vi.mocked(notifyResponse).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await runCollabNotifyRetryTick(now)).toBe(1);
    expect(prisma.collabResponse.findMany.mock.calls[0][0].where).toEqual({
      notifiedAt: null, createdAt: { gt: new Date(now - 30 * 60_000), lt: new Date(now - 60_000) },
    });
    expect(vi.mocked(notifyResponse).mock.calls.map(c => c[0])).toEqual(['r1', 'r2']);
  });
});
