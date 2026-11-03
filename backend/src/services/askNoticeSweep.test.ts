import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  agentMessage: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  project: { findFirst: vi.fn() },
}));
vi.mock('../db', () => ({ prisma }));
const paneSend = vi.hoisted(() => async (_host: unknown, cmd: string) => (cmd === 'tmux-foreground-cmd' ? { cmd: 'claude', dead: false } : { ok: true }));
vi.mock('./agentRegistry', () => ({ isProjectAgentConnected: vi.fn(() => true), sendForProject: vi.fn(paneSend) }));
vi.mock('./status', () => ({ getStatus: vi.fn(() => ({ status: 'idle' })) }));
vi.mock('./humanActivity', () => ({ lastHumanHeartbeat: vi.fn(() => null) }));
vi.mock('./featureFlags', () => ({ boolVariation: vi.fn(async () => true) }));
vi.mock('./tmux', () => ({
  sessionName: vi.fn((u: string, p: string, r: string, w = 'main') => (w === 'main' ? `${u}-${p}-${r}` : `${u}-${p}-${w}-${r}`)),
}));

import { runAskNoticeTick, setAskNoticeChatSender, type ChatNoticeSender } from './askNoticeSweep';
import { isProjectAgentConnected, sendForProject } from './agentRegistry';
import { boolVariation } from './featureFlags';
import { lastHumanHeartbeat } from './humanActivity';
import { getStatus } from './status';

const now = Date.parse('2026-10-29T12:00:00Z');
const thread = { id: 'thr1', title: 'Diagnose the 502s', prUrl: 'https://github.com/acme/api/pull/12', prs: [{ key: '', prUrl: 'https://github.com/acme/api/pull/12' }] };
const row = (over: Record<string, unknown> = {}) => ({
  id: 'msg1', status: 'completed', error: null, publish: 'published', replyBytes: 2300, completedAt: new Date(now - 60_000), supersededById: null,
  senderUserId: 'u-ada', notifyProjectId: 'p-orch', notifyWorkstream: 'main', notifyVia: 'chat', thread, ...over,
});
const project = (over: Record<string, unknown> = {}) => ({
  name: 'orch', archived: false, instanceId: 'box1', kind: 'normal',
  user: { id: 'u-ada', googleEmail: 'ada@example.com', displayName: 'Ada', unixUsername: 'ada', defaultAgentProvider: 'claude' },
  instance: { status: 'ready' }, workstreams: [{ archived: false, askThread: null }], ...over,
});

const chat = vi.fn<ChatNoticeSender>(async () => ({ kind: 'sent' }));
const updates = () => prisma.agentMessage.updateMany.mock.calls.map(c => c[0]);

describe('runAskNoticeTick', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAskNoticeChatSender(chat);
    chat.mockResolvedValue({ kind: 'sent' });
    prisma.agentMessage.findMany.mockResolvedValue([row()]);
    prisma.agentMessage.updateMany.mockResolvedValue({ count: 1 });
    prisma.project.findFirst.mockResolvedValue(project());
    vi.mocked(getStatus).mockReturnValue({ status: 'idle' } as never);
    vi.mocked(isProjectAgentConnected).mockReturnValue(true);
    vi.mocked(boolVariation).mockResolvedValue(true);
    vi.mocked(sendForProject).mockImplementation(paneSend as never);
  });

  it('reads finished messages whose sender is recorded and nobody has told, past the grace', async () => {
    await runAskNoticeTick(now);
    expect(prisma.agentMessage.findMany.mock.calls[0][0].where).toEqual({
      notifyVia: { not: null }, notifiedAt: null, status: { in: ['completed', 'failed', 'canceled', 'superseded'] },
      completedAt: { not: null, lte: new Date(now - 15_000) },
    });
  });

  it("claims, then sends the notice as a turn of the asking chat, with the thread's metadata and no reply", async () => {
    expect(await runAskNoticeTick(now)).toBe(1);
    expect(updates()[0]).toEqual({ where: { id: { in: ['msg1'] }, notifiedAt: null }, data: { notifiedAt: new Date(now), notice: 'chat' } });
    expect(chat).toHaveBeenCalledTimes(1);
    const sent = chat.mock.calls[0][0];
    expect(sent).toMatchObject({ userId: 'u-ada', projectId: 'p-orch', workstream: 'main' });
    expect(sent.text).toMatch(/^\[termag\] Your ask "Diagnose the 502s" \(thread thr1, message msg1\) finished: completed; PR https:\/\/github.com\/acme\/api\/pull\/12; publish published/);
    expect(vi.mocked(boolVariation).mock.calls[0][0]).toBe('ask-completion-notify-enabled');
    expect(prisma.project.findFirst.mock.calls[0][0].where).toEqual({ id: 'p-orch', userId: 'u-ada' });
  });

  it("names the thread's own PR first, filled from the thread when its rows hold only named PRs", async () => {
    prisma.agentMessage.findMany.mockResolvedValue([row({ thread: {
      ...thread, prNumber: 12, branch: 'fix',
      prs: [{ key: 'pr/docs', branch: 'docs', prNumber: 13, prUrl: 'https://github.com/acme/api/pull/13' }],
    } })]);
    expect(await runAskNoticeTick(now)).toBe(1);
    expect(chat.mock.calls[0][0].text).toContain('PR https://github.com/acme/api/pull/12 and 1 more');
  });

  it("keeps an automation run's notice in the inbox only", async () => {
    prisma.project.findFirst.mockResolvedValue(project({ kind: 'automation' }));
    expect(await runAskNoticeTick(now)).toBe(0);
    expect(updates()).toEqual([{ where: { id: { in: ['msg1'] }, notifiedAt: null }, data: { notifiedAt: new Date(now), notice: 'skipped' } }]);
    expect(chat).not.toHaveBeenCalled();
  });

  it('hands the claim back when the chat is not ready, and marks it failed when the chat refuses', async () => {
    chat.mockResolvedValueOnce({ kind: 'not-ready' });
    expect(await runAskNoticeTick(now)).toBe(0);
    expect(updates()[1]).toEqual({ where: { id: { in: ['msg1'] }, notifiedAt: new Date(now) }, data: { notifiedAt: null, notice: null } });
    vi.clearAllMocks();
    prisma.agentMessage.updateMany.mockResolvedValue({ count: 1 });
    chat.mockResolvedValueOnce({ kind: 'refused', error: 'nope' });
    expect(await runAskNoticeTick(now)).toBe(0);
    expect(updates()[1]).toEqual({ where: { id: { in: ['msg1'] }, notifiedAt: new Date(now) }, data: { notice: 'failed' } });
  });

  it('hands the claim back on a transient send failure', async () => {
    chat.mockRejectedValueOnce(new Error('Instance agent not connected'));
    expect(await runAskNoticeTick(now)).toBe(0);
    expect(updates()[1]).toEqual({ where: { id: { in: ['msg1'] }, notifiedAt: new Date(now) }, data: { notifiedAt: null, notice: null } });
  });

  it('types one line into an idle agent pane, and waits while it works', async () => {
    prisma.agentMessage.findMany.mockResolvedValue([row({ notifyVia: 'pane', notifyWorkstream: 'fix', status: 'failed', error: 'lost: the run was gone' })]);
    vi.mocked(getStatus).mockReturnValue({ status: 'working' } as never);
    expect(await runAskNoticeTick(now)).toBe(0);
    expect(prisma.agentMessage.updateMany).not.toHaveBeenCalled();
    expect(sendForProject).not.toHaveBeenCalled();

    vi.mocked(getStatus).mockReturnValue({ status: 'idle' } as never);
    expect(await runAskNoticeTick(now)).toBe(1);
    expect(vi.mocked(sendForProject).mock.calls[0].slice(1, 3)).toEqual(['tmux-foreground-cmd', { sessionName: 'ada-orch-fix-agent' }]);
    const [host, cmd, args] = vi.mocked(sendForProject).mock.calls[1];
    expect(host).toEqual({ userId: 'u-ada', instanceId: 'box1' });
    expect(cmd).toBe('tmux-send-keys');
    expect(args).toMatchObject({ sessionName: 'ada-orch-fix-agent', withEnter: true, literal: true });
    expect((args as { keys: string }).keys).toMatch(/^\[termag\] Your ask "Diagnose the 502s" \(thread thr1, message msg1\) finished: failed; PR/);
    expect((args as { keys: string }).keys).not.toContain('lost');
    expect(chat).not.toHaveBeenCalled();
  });

  it('hands a pane claim back, typing nothing, while the pane holds a shell, a dead pane or an unreadable probe', async () => {
    prisma.agentMessage.findMany.mockResolvedValue([row({ notifyVia: 'pane', notifyWorkstream: 'fix' })]);
    for (const fg of [{ cmd: 'bash', dead: false }, { cmd: 'claude', dead: true }, { cmd: null, dead: false }, new Error('timed out')]) {
      vi.clearAllMocks();
      prisma.agentMessage.updateMany.mockResolvedValue({ count: 1 });
      vi.mocked(sendForProject).mockImplementation((async (_h: unknown, cmd: string) => {
        if (cmd !== 'tmux-foreground-cmd') return { ok: true };
        if (fg instanceof Error) throw fg;
        return fg;
      }) as never);
      expect(await runAskNoticeTick(now)).toBe(0);
      expect(vi.mocked(sendForProject).mock.calls.map(c => c[1])).toEqual(['tmux-foreground-cmd']);
      expect(updates()[1]).toEqual({ where: { id: { in: ['msg1'] }, notifiedAt: new Date(now) }, data: { notifiedAt: null, notice: null } });
    }
  });

  it('hands a pane claim back when its person starts typing after the decision', async () => {
    prisma.agentMessage.findMany.mockResolvedValue([row({ notifyVia: 'pane', notifyWorkstream: 'fix' })]);
    vi.mocked(lastHumanHeartbeat).mockReturnValueOnce(null).mockReturnValueOnce(now);
    expect(await runAskNoticeTick(now)).toBe(0);
    expect(sendForProject).not.toHaveBeenCalled();
    expect(updates()[1]).toEqual({ where: { id: { in: ['msg1'] }, notifiedAt: new Date(now) }, data: { notifiedAt: null, notice: null } });
  });

  it('keeps it in the inbox only when the asking box is stopped, and starts nothing', async () => {
    prisma.project.findFirst.mockResolvedValue(project({ instance: { status: 'stopped' } }));
    vi.mocked(isProjectAgentConnected).mockReturnValue(false);
    await runAskNoticeTick(now);
    expect(updates()).toEqual([{ where: { id: { in: ['msg1'] }, notifiedAt: null }, data: { notifiedAt: new Date(now), notice: 'gone' } }]);
    expect(chat).not.toHaveBeenCalled();
    expect(sendForProject).not.toHaveBeenCalled();
  });

  it('settles as off with the flag off', async () => {
    vi.mocked(boolVariation).mockResolvedValue(false);
    await runAskNoticeTick(now);
    expect(updates()[0].data).toEqual({ notifiedAt: new Date(now), notice: 'off' });
    expect(chat).not.toHaveBeenCalled();
  });

  it('puts the asks finishing for one session in one notice', async () => {
    prisma.agentMessage.findMany.mockResolvedValue([row(), row({ id: 'msg2', status: 'failed', error: 'lost: the run was no longer running on the box' })]);
    prisma.agentMessage.updateMany.mockResolvedValue({ count: 2 });
    expect(await runAskNoticeTick(now)).toBe(2);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0][0].text).toMatch(/^\[termag\] 2 of your asks finished/);
  });

  it('delivers nothing another process claimed first', async () => {
    prisma.agentMessage.updateMany.mockResolvedValue({ count: 0 });
    expect(await runAskNoticeTick(now)).toBe(0);
    expect(chat).not.toHaveBeenCalled();
  });

  describe('a superseded message', () => {
    const superseded = row({ status: 'superseded', supersededById: 'msg2', replyBytes: null, publish: null });

    it('waits while the follow-up it was answered with still runs', async () => {
      prisma.agentMessage.findMany.mockResolvedValue([superseded]);
      prisma.agentMessage.findUnique.mockResolvedValue(row({ id: 'msg2', status: 'working', completedAt: null }));
      expect(await runAskNoticeTick(now)).toBe(0);
      expect(prisma.agentMessage.updateMany).not.toHaveBeenCalled();
    });

    it("is covered by the follow-up's notice when that tells the same session", async () => {
      prisma.agentMessage.findMany.mockResolvedValue([superseded]);
      prisma.agentMessage.findUnique.mockResolvedValue(row({ id: 'msg2' }));
      await runAskNoticeTick(now);
      expect(updates()).toEqual([{ where: { id: { in: ['msg1'] }, notifiedAt: null }, data: { notifiedAt: new Date(now), notice: 'together' } }]);
      expect(chat).not.toHaveBeenCalled();
    });

    it('expires a day after it was superseded when the follow-up still runs', async () => {
      prisma.agentMessage.findMany.mockResolvedValue([{ ...superseded, completedAt: new Date(now - 25 * 60 * 60 * 1000) }]);
      prisma.agentMessage.findUnique.mockResolvedValue(row({ id: 'msg2', status: 'working', completedAt: null }));
      expect(await runAskNoticeTick(now)).toBe(0);
      expect(updates()).toEqual([{ where: { id: { in: ['msg1'] }, notifiedAt: null }, data: { notifiedAt: new Date(now), notice: 'expired' } }]);
      expect(chat).not.toHaveBeenCalled();
    });

    it('tells of itself when its follow-up is gone', async () => {
      prisma.agentMessage.findMany.mockResolvedValue([superseded]);
      prisma.agentMessage.findUnique.mockResolvedValue(null);
      expect(await runAskNoticeTick(now)).toBe(1);
      expect(chat.mock.calls[0][0].text).toContain('message msg1) finished: superseded; PR');
    });

    it('tells of itself when the chain is longer than it follows', async () => {
      prisma.agentMessage.findMany.mockResolvedValue([superseded]);
      prisma.agentMessage.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
        row({ id: `${where.id}x`, status: 'superseded', supersededById: `${where.id}x` }));
      expect(await runAskNoticeTick(now)).toBe(1);
      expect(prisma.agentMessage.findUnique).toHaveBeenCalledTimes(50);
      expect(chat.mock.calls[0][0].text).toContain('message msg1) finished: superseded');
    });

    it("tells its own sender, with the follow-up's outcome, when the follow-up came from another session", async () => {
      prisma.agentMessage.findMany.mockResolvedValue([superseded]);
      prisma.agentMessage.findUnique.mockResolvedValue(row({ id: 'msg2', notifyProjectId: 'p-other' }));
      expect(await runAskNoticeTick(now)).toBe(1);
      expect(chat.mock.calls[0][0].text).toContain('message msg1) finished: completed; answered together with follow-up msg2');
    });
  });
});
