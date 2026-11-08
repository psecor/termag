// The database side of chatConfinedMcp.ts: where an automation's turn sends what it produces, and who reads a space.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  automation: { findUnique: vi.fn() },
  workstream: { findUnique: vi.fn() },
  space: { findUnique: vi.fn() },
}));
vi.mock('../db', () => ({ prisma }));

import { automationOutputsOf, spaceReadersOf } from './chatConfinedMcp';

const automationRow = (over: Record<string, unknown> = {}) => ({
  spaceName: 'mine', notifySlack: false, project: { slackChannelId: 'C-proj', _count: { shares: 0, invites: 0 } }, ...over,
});
const runChat = (over: Record<string, unknown> = {}) => ({ projectId: 'p1', name: 'run-20261105-0900', slackChannelId: null, spaceId: null, space: null, ...over });

beforeEach(() => vi.clearAllMocks());

describe('automationOutputsOf', () => {
  it('a project that is not an automation is null', async () => {
    prisma.automation.findUnique.mockResolvedValue(null);
    expect(await automationOutputsOf('p1', 'ws1')).toBeNull();
    expect(prisma.workstream.findUnique).not.toHaveBeenCalled();
  });

  it('counts pending project invites only: an accepted or declined one stays as a row (Bugbot, #1433)', async () => {
    prisma.automation.findUnique.mockResolvedValue(automationRow({ project: { slackChannelId: null, _count: { shares: 1, invites: 2 } } }));
    prisma.workstream.findUnique.mockResolvedValue(runChat());
    expect((await automationOutputsOf('p1', 'ws1'))?.projectSharees).toBe(3);
    const select = prisma.automation.findUnique.mock.calls[0][0].select;
    expect(select.project.select._count.select).toEqual({ shares: true, invites: { where: { status: 'pending' } } });
  });

  it('a run\'s own workstream: the automation\'s space and the chat\'s, no Slack', async () => {
    prisma.automation.findUnique.mockResolvedValue(automationRow());
    prisma.workstream.findUnique.mockResolvedValue(runChat({ spaceId: 's-old', space: { name: 'team' } }));
    expect(await automationOutputsOf('p1', 'ws1')).toEqual({ spaceNames: ['mine', 'team'], notifySlack: false, workstreamSlack: false, projectSharees: 0 });
  });

  it('Slack, or a workstream it can\'t place: a channel of its own, main on the project\'s channel, none found, another project\'s, or no id', async () => {
    prisma.automation.findUnique.mockResolvedValue(automationRow());
    for (const ws of [runChat({ slackChannelId: 'C-ws' }), runChat({ name: 'main' }), null, runChat({ projectId: 'p2' })]) {
      prisma.workstream.findUnique.mockResolvedValueOnce(ws);
      expect((await automationOutputsOf('p1', 'ws1'))?.workstreamSlack, JSON.stringify(ws)).toBe(true);
    }
    expect((await automationOutputsOf('p1', null))?.workstreamSlack).toBe(true);
  });

  it('a chat space whose row can\'t be read throws: a failed lookup sends nothing', async () => {
    prisma.automation.findUnique.mockResolvedValue(automationRow());
    prisma.workstream.findUnique.mockResolvedValue(runChat({ spaceId: 's-gone', space: null }));
    await expect(automationOutputsOf('p1', 'ws1')).rejects.toThrow(/could not be read/);
  });
});

describe('spaceReadersOf', () => {
  it('members, pending invites, a linked Slack and file shares of a live space', async () => {
    prisma.space.findUnique.mockResolvedValue({ deletedAt: null, members: [{ userId: 'u1' }, { userId: 'u2' }], _count: { invites: 1, fileShares: 2 }, slack: { id: 'sl' } });
    expect(await spaceReadersOf('team')).toEqual({ memberIds: ['u1', 'u2'], pendingInvites: 1, slackLinked: true, fileShares: 2 });
  });

  it('no such space, or a deleted one, is null', async () => {
    prisma.space.findUnique.mockResolvedValueOnce(null);
    expect(await spaceReadersOf('gone')).toBeNull();
    prisma.space.findUnique.mockResolvedValueOnce({ deletedAt: new Date(), members: [], _count: { invites: 0, fileShares: 0 }, slack: null });
    expect(await spaceReadersOf('deleted')).toBeNull();
  });
});
