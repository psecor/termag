import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => {
  const p = {
    project: { findFirst: vi.fn() },
    agentHandoff: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(),
  };
  p.$transaction.mockImplementation(async (fn: (tx: typeof p) => unknown) => fn(p));
  return p;
});
vi.mock('../db', () => ({ prisma }));
vi.mock('../middleware/auth', () => ({ requireAuth: vi.fn(), requireAuthOrAgentToken: vi.fn() }));
vi.mock('../middleware/parkedBox', () => ({ refuseParkedBox: () => vi.fn() }));
vi.mock('../middleware/unreadySetup', () => ({ refuseUnreadySetup: () => vi.fn() }));
vi.mock('../services/featureFlags', () => ({ boolVariation: vi.fn(async () => true) }));
vi.mock('../services/agentRegistry', () => ({ isProjectAgentConnected: vi.fn(() => true), sendForProject: vi.fn(async () => ({ ok: true })) }));
vi.mock('../services/agentHandoffSweep', () => ({ publishHandoff: vi.fn() }));
vi.mock('../services/status', () => ({ getStatus: vi.fn(() => ({ status: 'idle', contextTokens: 180_000 })) }));
vi.mock('./spawns', () => ({ resolveCaller: vi.fn() }));

import { agentHandoffFor, cliHandoffFor, startHandoff, writtenFor } from './handoffs';
import { boolVariation } from '../services/featureFlags';
import { sendForProject } from '../services/agentRegistry';
import { resolveCaller } from './spawns';

const user = { id: 'u1', unixUsername: 'me', defaultAgentProvider: null } as unknown as Express.User;
const project = (provider: string | null = 'claude') => ({
  id: 'p1', name: 'proj', kind: 'standard', instanceId: 'box1',
  instance: { id: 'box1', name: 'box', kind: 'ec2', hostHome: '/home/me', status: 'ready' },
  workstreams: [{ name: 'main', workflows: [{ type: 'agent', provider }] }],
});
const target = { projectId: 'p1', workstream: 'main' };
const person = { initiator: 'person' as const, surface: 'web' as const };

describe('startHandoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.project.findFirst.mockResolvedValue(project());
    prisma.agentHandoff.findFirst.mockResolvedValue(null);
    prisma.agentHandoff.create.mockImplementation(async (a: { data: Record<string, unknown> }) => ({ id: 'ck1', createdAt: new Date(), ...a.data }));
    prisma.agentHandoff.update.mockImplementation(async (a: { data: Record<string, unknown> }) => ({ id: 'ck1', createdAt: new Date(), ...a.data }));
    prisma.agentHandoff.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentHandoff.findUnique.mockResolvedValue({ id: 'ck1', createdAt: new Date(), state: 'written' });
    vi.mocked(boolVariation).mockResolvedValue(true);
  });

  it('records a clear for Claude with the context reading, for the sweep to act on', async () => {
    const r = await startHandoff(user, target, { mode: 'clear' }, person);
    expect(r.status).toBe(202);
    expect(prisma.agentHandoff.create.mock.calls[0][0].data).toMatchObject({
      session: 'me-proj-agent', mode: 'clear', requestedMode: 'clear', fromProvider: 'claude', toProvider: null,
      initiator: 'person', surface: 'web', contextTokensBefore: 180_000,
    });
    expect(sendForProject).not.toHaveBeenCalled();
  });

  it('checks for an open handoff and creates under a per-pane advisory lock', async () => {
    await startHandoff(user, target, { mode: 'clear' }, person);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(prisma.agentHandoff.findFirst.mock.invocationCallOrder[0]);
  });

  it('records a provider only for a real switch, so a restart follows a later Switch agent', async () => {
    await startHandoff(user, target, { mode: 'restart' }, person);
    await startHandoff(user, target, { mode: 'restart', provider: 'claude' }, person);
    await startHandoff(user, target, { mode: 'restart', provider: 'devin' }, person);
    expect(prisma.agentHandoff.create.mock.calls.map(c => c[0].data.toProvider)).toEqual([null, null, 'devin']);
  });

  it('clears pi in place with its own /new', async () => {
    prisma.project.findFirst.mockResolvedValue(project('pi'));
    const r = await startHandoff(user, target, { mode: 'clear' }, person);
    expect(r.status).toBe(202);
    expect(prisma.agentHandoff.create.mock.calls[0][0].data).toMatchObject({ mode: 'clear', fromProvider: 'pi' });
  });

  it('falls back to a restart when another agent is asked for, and says so', async () => {
    const r = await startHandoff(user, target, { mode: 'clear', provider: 'devin' }, person);
    expect(r.status).toBe(202);
    expect(prisma.agentHandoff.create.mock.calls[0][0].data).toMatchObject({ mode: 'restart', requestedMode: 'clear', toProvider: 'devin' });
    expect((r.body as { note?: string }).note).toMatch(/switching to Devin restarts the pane/);
  });

  it('does not undo an abort that came in while the prompt file was being written', async () => {
    prisma.agentHandoff.updateMany.mockResolvedValueOnce({ count: 0 });
    const r = await startHandoff(user, target, { mode: 'clear', body: '## Goal' }, { initiator: 'agent', surface: 'mcp' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'handoff_aborted' });
  });

  it('fails the row, never makes it written, when the prompt file cannot be written', async () => {
    vi.mocked(sendForProject).mockRejectedValueOnce(new Error('box gone'));
    const r = await startHandoff(user, target, { mode: 'clear', body: '## Goal' }, { initiator: 'agent', surface: 'mcp' });
    expect(r.status).toBe(503);
    expect(prisma.agentHandoff.update.mock.calls.map(c => c[0].data.state)).toEqual(['failed']);
  });

  it('refuses an agent that has no way to write its handoff', async () => {
    prisma.project.findFirst.mockResolvedValueOnce(project('cursor'));
    const r = await startHandoff(user, target, { mode: 'restart' }, person);
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/Cursor cannot be handed off/);
  });

  it('is behind the flag, refuses Codex and a second open handoff', async () => {
    vi.mocked(boolVariation).mockResolvedValueOnce(false);
    expect((await startHandoff(user, target, { mode: 'clear' }, person)).status).toBe(403);
    prisma.project.findFirst.mockResolvedValueOnce(project('codex'));
    expect((await startHandoff(user, target, { mode: 'clear' }, person)).status).toBe(400);
    prisma.agentHandoff.findFirst.mockResolvedValueOnce({ id: 'ck0', state: 'writing' });
    const r = await startHandoff(user, target, { mode: 'clear' }, person);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'handoff_open', handoffId: 'ck0' });
    expect(prisma.agentHandoff.create).not.toHaveBeenCalled();
  });

  it('refuses a restart into an agent that is not offered', async () => {
    expect((await startHandoff(user, target, { mode: 'restart', provider: 'codex' }, person)).status).toBe(400);
  });

  it('takes an agent\'s own handoff, and makes it written only once the prompt file is on the box', async () => {
    const r = await startHandoff(user, target, { mode: 'restart', body: '## Goal\nship it' }, { initiator: 'agent', surface: 'mcp' });
    expect(r.status).toBe(202);
    // Created in `writing`, which the sweep never acts on…
    expect(prisma.agentHandoff.create.mock.calls[0][0].data).toMatchObject({ state: 'writing', body: '## Goal\nship it' });
    // …and flipped after the write-file, only if still writing (an abort wins).
    expect(prisma.agentHandoff.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'ck1', state: 'writing' }, data: { state: 'written' } });
    expect(vi.mocked(sendForProject).mock.invocationCallOrder[0]).toBeLessThan(prisma.agentHandoff.updateMany.mock.invocationCallOrder[0]);
    expect((r.body as { handoff: { state: string } }).handoff.state).toBe('written');
    const [, cmd, args] = vi.mocked(sendForProject).mock.calls[0];
    expect(cmd).toBe('write-file');
    expect(args).toMatchObject({ path: '/home/me/.termag/handoffs/ck1.md', mode: 0o600 });
    expect((args as { content: string }).content).toContain('--- handoff ---\n## Goal\nship it');
  });

  it('refuses a handoff carrying a secret-shaped string, in the body or the note', async () => {
    const secret = `token tmag_${'a'.repeat(20)}`;
    expect((await startHandoff(user, target, { mode: 'clear', body: secret }, { initiator: 'agent', surface: 'mcp' })).status).toBe(422);
    expect((await startHandoff(user, target, { mode: 'clear', note: secret }, person)).status).toBe(422);
    expect(prisma.agentHandoff.create).not.toHaveBeenCalled();
  });
});

describe('agentHandoffFor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses a body from a browser session: a person asks the agent to write it', async () => {
    vi.mocked(resolveCaller).mockResolvedValueOnce({ ok: true, value: { session: 'me-proj-agent', projectId: 'p1', projectName: 'proj', workstream: 'main', role: 'agent', instanceId: 'box1', provider: 'claude' } });
    const r = await agentHandoffFor(user, undefined, { mode: 'clear', session: 'me-proj-agent', body: '## Goal' });
    expect(r.status).toBe(400);
    expect(prisma.agentHandoff.create).not.toHaveBeenCalled();
  });

  it('needs the caller\'s own agent pane', async () => {
    expect((await agentHandoffFor(user, 'box1', { mode: 'clear' })).status).toBe(400);
    vi.mocked(resolveCaller).mockResolvedValueOnce({ ok: true, value: { session: 'me-proj-ctrl', projectId: 'p1', projectName: 'proj', workstream: 'main', role: 'ctrl', instanceId: 'box1', provider: 'claude' } });
    expect((await agentHandoffFor(user, 'box1', { mode: 'clear', session: 'me-proj-ctrl' })).status).toBe(400);
  });
});

describe('writtenFor', () => {
  const caller = { session: 'me-proj-agent', projectId: 'p1', projectName: 'proj', workstream: 'main', role: 'agent', instanceId: 'box1', provider: 'claude' };
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveCaller).mockResolvedValue({ ok: true, value: caller });
    prisma.project.findFirst.mockResolvedValue({ name: 'proj', instanceId: 'box1', instance: { hostHome: '/home/me' } });
    prisma.agentHandoff.updateMany.mockResolvedValue({ count: 1 });
  });

  it('stores the handoff of the pane being handed off and writes its prompt file', async () => {
    prisma.agentHandoff.findFirst.mockResolvedValue({ id: 'ck1', userId: 'u1', projectId: 'p1', workstream: 'main', state: 'writing', mode: 'clear', fromProvider: 'claude', toProvider: null, createdAt: new Date(), note: null });
    const r = await writtenFor(user, 'box1', 'ck1', { session: 'me-proj-agent', body: '## Goal' });
    expect(r.status).toBe(200);
    expect((r.body as { note: string }).note).toMatch(/End your turn now: once this pane is idle, termag types \/clear/);
    expect(prisma.agentHandoff.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'ck1' }, data: { state: 'written', body: '## Goal' } });
  });

  it('refuses another workstream\'s handoff and one that has moved on', async () => {
    prisma.agentHandoff.findFirst.mockResolvedValue({ id: 'ck1', userId: 'u1', projectId: 'p1', workstream: 'other', state: 'writing' });
    expect((await writtenFor(user, 'box1', 'ck1', { session: 'me-proj-agent', body: '## Goal' })).status).toBe(404);
    prisma.agentHandoff.findFirst.mockResolvedValue({ id: 'ck1', userId: 'u1', projectId: 'p1', workstream: 'main', state: 'resetting' });
    expect((await writtenFor(user, 'box1', 'ck1', { session: 'me-proj-agent', body: '## Goal' })).status).toBe(409);
    expect(sendForProject).not.toHaveBeenCalled();
  });
});

describe('cliHandoffFor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.project.findFirst.mockResolvedValue({ ...project(), workstreams: [{ name: 'feat', workflows: [{ type: 'agent', provider: 'claude' }] }] });
    prisma.agentHandoff.findFirst.mockResolvedValue(null);
    prisma.agentHandoff.create.mockImplementation(async (a: { data: Record<string, unknown> }) => ({ id: 'ck1', createdAt: new Date(), ...a.data }));
  });

  it('takes the workstream by name and the surface, cli by default', async () => {
    expect((await cliHandoffFor(user, 'p1', { mode: 'clear', workstream: 'feat', surface: 'tui' })).status).toBe(202);
    expect(prisma.project.findFirst.mock.calls[0][0].include.workstreams.where).toEqual({ name: 'feat' });
    expect(prisma.agentHandoff.create.mock.calls[0][0].data).toMatchObject({ workstream: 'feat', surface: 'tui', initiator: 'person' });
    await cliHandoffFor(user, 'p1', { mode: 'clear', surface: 'anything' });
    expect(prisma.agentHandoff.create.mock.calls[1][0].data).toMatchObject({ surface: 'cli' });
  });

  it('lets a box credential hand off only the projects on its own box', async () => {
    prisma.project.findFirst.mockResolvedValueOnce({ instanceId: 'box1' });
    expect((await cliHandoffFor(user, 'p1', { mode: 'clear', workstream: 'feat' }, 'box1')).status).toBe(202);
    prisma.project.findFirst.mockResolvedValueOnce({ instanceId: 'box1' });
    const other = await cliHandoffFor(user, 'p1', { mode: 'clear', workstream: 'feat' }, 'box2');
    expect(other).toMatchObject({ status: 403, body: { code: 'box_scope' } });
    // A per-user (host) token's box is null: never a box project.
    prisma.project.findFirst.mockResolvedValueOnce({ instanceId: 'box1' });
    expect((await cliHandoffFor(user, 'p1', { mode: 'clear' }, null)).status).toBe(403);
    expect(prisma.agentHandoff.create).toHaveBeenCalledTimes(1);
  });

  it('refuses a body: a person asks the agent to write it', async () => {
    expect((await cliHandoffFor(user, 'p1', { mode: 'clear', body: '## Goal' })).status).toBe(400);
    expect(prisma.agentHandoff.create).not.toHaveBeenCalled();
  });
});
