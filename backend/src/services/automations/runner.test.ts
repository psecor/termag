import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  workstream: { findUnique: vi.fn() },
  workflow: { findFirst: vi.fn() },
  automationRun: { update: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn(async () => null) },
}));
vi.mock('./spaceSync', () => ({
  pullForRun: vi.fn(async () => ({ error: null, usable: true })),
  readmeFor: vi.fn(() => '# readme'),
  spaceFoldersEnabledFor: vi.fn(async () => false),
  syncErrorText: (e: string) => `words for ${e}`,
}));
vi.mock('../../db', () => ({ prisma }));
vi.mock('../agentRegistry', () => ({
  instanceAgentTransport: vi.fn(() => ({ capabilities: ['chat-runner-v1', 'chat-auto-v1'] })),
  isProjectAgentConnected: vi.fn(() => true),
  sendForProject: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../chatRunner', () => ({
  AUTO_MODE: 'auto',
  chatKeyFor: (p: string, w: string) => `${p}--${w}`,
  chatSendRpcPayload: vi.fn((p: Record<string, unknown>, message: string, _caps?: unknown, opts?: Record<string, unknown>) => ({ ...p, message, ...opts })),
  chatMemorySpace: (place: { space: { name: string } | null; reachable: boolean }) => (place.space && place.reachable ? place.space.name : null),
}));
// The run's chat belongs to the automation's space (services/chatSpace.ts): granted to the box here.
vi.mock('../chatSpace', () => ({
  resolveChatSpaceChoice: vi.fn(async (name: string | null) => ({ spaceId: name ? `s-${name}` : null })),
  chatSpaceFor: vi.fn(async (_ws: string, opts: { requested?: { name: string | null } }) => ({
    space: opts.requested?.name ? { id: `s-${opts.requested.name}`, name: opts.requested.name } : null, reachable: true,
  })),
}));
vi.mock('../chatTrust', () => ({ UNTRUSTED_MODE: 'plan' }));
vi.mock('../chatConfinedMcp', () => ({ brokerMcpFor: vi.fn(async () => null) }));
// The choice's launch (services/chatLaunch.test.ts): a tier as itself, none as Sonnet, Fireworks refused here.
vi.mock('../chatLaunch', () => ({
  chatLaunchFor: vi.fn(async (choice: { backend: string | null; model: string | null }) => (choice.backend
    ? { ok: false, status: 409, body: { error: 'This box cannot run chats on Fireworks yet.', code: 'runner-outdated' } }
    : { ok: true, launch: { model: choice.model ?? 'sonnet' } })),
}));
vi.mock('../tmux', () => ({ projectDirFor: vi.fn(() => '/home/me/termag/projects/triage/.worktrees/run-20261020-0900') }));
vi.mock('../../routes/workstreams', () => ({
  createWorkstreamFor: vi.fn(async () => ({ status: 201, body: { id: 'w1', name: 'run-20261020-0900', fetched: true, baseSha: 'abc1234' } })),
  removeWorkstreamFor: vi.fn(async () => ({ status: 200, body: {} })),
}));

import { startRun } from './runner';
import { chatLaunchFor } from '../chatLaunch';
import { sendForProject } from '../agentRegistry';
import { chatSendRpcPayload } from '../chatRunner';
import { chatSpaceFor } from '../chatSpace';
import { brokerMcpFor } from '../chatConfinedMcp';
import { createWorkstreamFor, removeWorkstreamFor } from '../../routes/workstreams';
import { pullForRun, spaceFoldersEnabledFor } from './spaceSync';

const occurrence = new Date('2026-10-20T09:00:00Z');
const target = {
  automation: { id: 'a1', timezone: 'UTC', prompt: 'do it', tier: 'full', prOnChange: true } as never,
  run: { id: 'r1', scheduledFor: occurrence } as never,
  project: { id: 'p1', name: 'triage', userId: 'u1', instanceId: 'box1', repoDefaultBranch: 'main', chatTrustedAt: occurrence },
  owner: { id: 'u1', unixUsername: 'me' },
  box: { id: 'box1', hostHome: '/home/me' },
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.workstream.findUnique.mockResolvedValue(null);
  prisma.automationRun.update.mockResolvedValue({});
  prisma.automationRun.updateMany.mockResolvedValue({ count: 1 });
  prisma.workflow.findFirst.mockResolvedValue({ backend: null, model: null });
});

const chatSends = () => vi.mocked(sendForProject).mock.calls.filter(c => c[1] === 'chat-send');

describe('startRun', () => {
  it('links the run row to its workstream before the brief is sent', async () => {
    const outcome = await startRun(target);
    expect(outcome).toMatchObject({ kind: 'started', workstreamId: 'w1', workstream: 'run-20261020-0900' });
    const link = prisma.automationRun.updateMany.mock.calls.find(c => c[0].data.workstreamId === 'w1');
    expect(link).toBeDefined();
    // Only a row still running takes the link: Stop or the timeout sweep may have finished it meanwhile.
    expect(link![0]).toMatchObject({ where: { id: 'r1', state: 'running' }, data: { workstreamId: 'w1', branch: 'automation/triage/20261020-0900' } });
    const sendCall = chatSends()[0];
    expect(sendCall).toBeDefined();
    const linkOrder = prisma.automationRun.updateMany.mock.invocationCallOrder[prisma.automationRun.updateMany.mock.calls.indexOf(link!)];
    const sendOrder = vi.mocked(sendForProject).mock.invocationCallOrder[vi.mocked(sendForProject).mock.calls.indexOf(sendCall)];
    expect(linkOrder).toBeLessThan(sendOrder);
    expect(vi.mocked(chatSendRpcPayload).mock.calls[0][0]).toMatchObject({ model: 'sonnet' });
    expect(removeWorkstreamFor).not.toHaveBeenCalled();
  });

  it("sends the model the run workstream's agent row holds, defaulting an unset one to Sonnet", async () => {
    prisma.workflow.findFirst.mockResolvedValueOnce({ backend: null, model: 'sonnet' });
    await startRun(target);
    expect(prisma.workflow.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { workstreamId: 'w1', type: 'agent' } }));
    expect(vi.mocked(chatLaunchFor).mock.calls.at(-1)?.[1]).toEqual({ ownerId: 'u1', instanceId: 'box1', capabilities: ['chat-runner-v1', 'chat-auto-v1'] });
    expect(vi.mocked(chatSendRpcPayload).mock.calls.at(-1)?.[0]).toMatchObject({ model: 'sonnet' });
    vi.mocked(chatSendRpcPayload).mockClear();
    await startRun(target);
    expect(vi.mocked(chatSendRpcPayload).mock.calls.at(-1)?.[0]).toMatchObject({ model: 'sonnet' });
  });

  it("sends the owner's launch as chatLaunchFor decides it: the gateway's profile, or the alias for an owner off the gateway", async () => {
    prisma.workflow.findFirst.mockResolvedValueOnce({ backend: null, model: 'opus' });
    vi.mocked(chatLaunchFor).mockResolvedValueOnce({ ok: true, launch: { model: 'us.anthropic.claude-opus-5-5' } });
    await startRun(target);
    expect(vi.mocked(chatLaunchFor).mock.calls.at(-1)?.[1]).toMatchObject({ ownerId: 'u1' });
    expect(vi.mocked(chatSendRpcPayload).mock.calls.at(-1)?.[0]).toMatchObject({ model: 'us.anthropic.claude-opus-5-5' });
    prisma.workflow.findFirst.mockResolvedValueOnce({ backend: null, model: 'opus' });
    await startRun(target);
    expect(vi.mocked(chatSendRpcPayload).mock.calls.at(-1)?.[0]).toMatchObject({ model: 'opus' });
  });

  it('fails the launch, and discards the tree, when the choice cannot start on this box', async () => {
    prisma.workflow.findFirst.mockResolvedValueOnce({ backend: 'fireworks', model: 'accounts/fireworks/models/kimi-k3' });
    expect(await startRun(target)).toEqual({ kind: 'failed', reason: 'launch', error: 'This box cannot run chats on Fireworks yet.' });
    expect(chatSends()).toHaveLength(0);
    expect(removeWorkstreamFor).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'p1', 'w1', { force: true, ownsRun: true });
  });

  it('removes the workstream and clears the link when the send fails', async () => {
    vi.mocked(sendForProject).mockImplementation(async (_h, type) => {
      if (type === 'chat-send') throw new Error('the runner refused the brief');
      return { ok: true };
    });
    expect(await startRun(target)).toEqual({ kind: 'failed', reason: 'launch', error: 'the runner refused the brief' });
    // ownsRun: the removal leaves the row `running` for decideAndStart to fail as launch.
    expect(removeWorkstreamFor).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'p1', 'w1', { force: true, ownsRun: true });
    expect(prisma.automationRun.update).toHaveBeenLastCalledWith({ where: { id: 'r1' }, data: { workstreamId: null, branch: null } });
  });

  it('sends no brief, and discards the tree, when Stop or the timeout sweep finished the row during the setup', async () => {
    prisma.automationRun.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await startRun(target)).toEqual({ kind: 'failed', reason: 'interrupted', error: 'the run was stopped before its brief was sent' });
    expect(chatSends()).toHaveLength(0);
    expect(removeWorkstreamFor).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'p1', 'w1', { force: true, ownsRun: true });
  });

  it('tears nothing down when the send only timed out: the turn may be live', async () => {
    vi.mocked(sendForProject).mockImplementation(async (_h, type) => {
      if (type === 'chat-send') throw new Error('Agent request timed out: chat-send');
      return { ok: true };
    });
    expect(await startRun(target)).toMatchObject({ kind: 'unknown', workstreamId: 'w1', workstream: 'run-20261020-0900' });
    expect(removeWorkstreamFor).not.toHaveBeenCalled();
    expect(prisma.automationRun.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ workstreamId: null }) }));
  });

  it('keeps the link when git refuses to remove the tree, so the retire sweep gets it', async () => {
    vi.mocked(sendForProject).mockImplementation(async (_h, type) => {
      if (type === 'chat-send') throw new Error('mode-refused: auto');
      return { ok: true };
    });
    vi.mocked(removeWorkstreamFor).mockResolvedValueOnce({ status: 409, body: { error: 'worktree is dirty' } });
    expect(await startRun(target)).toMatchObject({ kind: 'failed', reason: 'runner_outdated' });
    expect(prisma.automationRun.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ workstreamId: null }) }));
  });

  it('fails the launch without a workstream when the box cannot make one', async () => {
    vi.mocked(createWorkstreamFor).mockResolvedValue({ status: 503, body: { error: 'Box agent is not connected' } });
    expect(await startRun(target)).toEqual({ kind: 'failed', reason: 'launch', error: 'Box agent is not connected' });
    expect(chatSends()).toHaveLength(0);
    expect(prisma.automationRun.update).not.toHaveBeenCalled();
  });

  it('seeds the notes file only where the box says there is none, and never over a read that failed', async () => {
    const writes = () => vi.mocked(sendForProject).mock.calls.filter(c => c[1] === 'write-file');
    vi.mocked(createWorkstreamFor).mockResolvedValue({ status: 201, body: { id: 'w1', name: 'run-20261020-0900', fetched: true, baseSha: 'abc1234' } });
    vi.mocked(sendForProject).mockImplementation(async (_h, type) => (type === 'read-file' ? { ok: true, content: null } : { ok: true }));
    await startRun(target);
    expect(writes()).toHaveLength(1);
    expect(writes()[0][2]).toMatchObject({ path: '/home/me/.termag/automations/p1/memory/MEMORY.md', mode: 0o600 });
    vi.clearAllMocks();
    vi.mocked(sendForProject).mockImplementation(async (_h, type) => (type === 'read-file' ? { ok: true, content: '# notes from run 1' } : { ok: true }));
    await startRun(target);
    expect(writes()).toHaveLength(0);
    vi.clearAllMocks();
    vi.mocked(sendForProject).mockImplementation(async (_h, type) => { if (type === 'read-file') throw new Error('Agent request timed out: read-file'); return { ok: true }; });
    expect(await startRun(target)).toMatchObject({ kind: 'started' });
    expect(writes()).toHaveLength(0);
  });

  it('retries from HEAD once when an older box cannot resolve origin/<default>', async () => {
    vi.mocked(sendForProject).mockImplementation(async () => ({ ok: true }));
    vi.mocked(createWorkstreamFor)
      .mockResolvedValueOnce({ status: 500, body: { error: 'git worktree add failed: fatal: invalid reference: origin/main' } })
      .mockResolvedValueOnce({ status: 201, body: { id: 'w1', name: 'run-20261020-0900' } });
    expect(await startRun(target)).toMatchObject({ kind: 'started', workstreamId: 'w1' });
    expect(createWorkstreamFor).toHaveBeenCalledTimes(2);
    expect(vi.mocked(createWorkstreamFor).mock.calls[1][2]).toMatchObject({ baseRef: 'HEAD' });
    expect(chatSends()).toHaveLength(1);
  });

  it('does not retry from HEAD when the add failed for another reason, such as a fetch that timed out', async () => {
    vi.mocked(createWorkstreamFor).mockResolvedValue({ status: 500, body: { error: 'git worktree add failed: Agent request timed out: git-worktree-add' } });
    expect(await startRun(target)).toEqual({ kind: 'failed', reason: 'launch', error: 'git worktree add failed: Agent request timed out: git-worktree-add' });
    expect(createWorkstreamFor).toHaveBeenCalledTimes(1);
    expect(chatSends()).toHaveLength(0);
  });
});

describe('startRun in a space', () => {
  const inSpace = { ...target, automation: { ...(target.automation as object), spaceName: 'team', spaceFolder: 'automations/triage', projectId: 'p1' } as never, run: { id: 'r1', scheduledFor: occurrence, trigger: 'schedule' } as never };
  beforeEach(() => {
    vi.mocked(sendForProject).mockImplementation(async () => ({ ok: true }));
    vi.mocked(createWorkstreamFor).mockReset().mockResolvedValue({ status: 201, body: { id: 'w1', name: 'run-20261020-0900', fetched: true, baseSha: 'abc1234' } });
  });
  const brief = () => String(chatSends()[0]?.[2] && (chatSends()[0][2] as { message: string }).message);

  it('with folders off, pulls the notes only and names no space in the brief', async () => {
    await startRun(inSpace);
    expect(pullForRun).toHaveBeenCalledWith(expect.objectContaining({ spaceName: 'team', folder: 'automations/triage', memoryDir: '/home/me/.termag/automations/p1/memory' }), { folders: false, previousLog: null, readme: null });
    expect(brief()).not.toContain('--- space ---');
  });

  it('with folders on, pulls the previous log and the README, and the brief has the space section', async () => {
    vi.mocked(spaceFoldersEnabledFor).mockResolvedValueOnce(true);
    prisma.automationRun.findFirst.mockResolvedValueOnce({ scheduledFor: new Date('2026-10-19T09:00:00Z'), trigger: 'manual' } as never);
    await startRun(inSpace);
    expect(pullForRun).toHaveBeenCalledWith(expect.anything(), { folders: true, previousLog: 'run-20261019-0900-manual', readme: '# readme' });
    expect(brief()).toContain('This automation lives in termag space team, folder automations/triage/.');
    // Its chat belongs to the automation's space, fixed as its workstream is made (services/chatSpace.ts), and its turns load that space's memory.
    expect(vi.mocked(createWorkstreamFor).mock.calls.at(-1)?.[2]).toMatchObject({ chatSpace: { spaceId: 's-team' } });
    expect(vi.mocked(chatSpaceFor)).toHaveBeenLastCalledWith(expect.any(String), { requested: { name: 'team', userId: expect.any(String) } });
    expect(vi.mocked(chatSendRpcPayload).mock.calls.at(-1)?.[3]).toEqual({ memorySpace: 'team' });
    expect(brief()).toContain('outputs/run-20261020-0900/');
  });

  it('the run is the owner\'s: its brief carries their broker connectors when chat-confined-mcp-enabled gives any', async () => {
    const field = { connectors: 'owner' as const, broker: 'https://mcp-broker.example.test', allow: ['mcp__slack__slack_read_*'], deny: [] };
    vi.mocked(brokerMcpFor).mockResolvedValueOnce(field);
    await startRun(inSpace);
    // Its project and workstream, so brokerMcpFor can tell whether the run's output stays with the owner (chatConfinedMcp.ts automationStaysWithOwner).
    expect(vi.mocked(brokerMcpFor)).toHaveBeenLastCalledWith(expect.objectContaining({ isOwner: true, projectId: expect.any(String), workstreamId: expect.any(String) }));
    expect(vi.mocked(chatSendRpcPayload).mock.calls.at(-1)?.[3]).toEqual({ memorySpace: 'team', brokerMcp: field });
  });

  it('records the trouble on the row as it links it, and the brief says the space was not available', async () => {
    vi.mocked(spaceFoldersEnabledFor).mockResolvedValueOnce(true);
    vi.mocked(pullForRun).mockResolvedValueOnce({ error: 'space_read_only', usable: false });
    await startRun(inSpace);
    const link = prisma.automationRun.updateMany.mock.calls.find(c => c[0].data.workstreamId === 'w1');
    expect(link![0].data).toMatchObject({ spaceSyncError: 'space_read_only' });
    expect(brief()).toContain('the space was not available this run: words for space_read_only');
  });
});
