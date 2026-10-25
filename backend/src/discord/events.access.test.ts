import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';

// Discord /t reaches only projects the linked termag user owns or was shared:
// not by a session name, and not through a target saved across restarts.

const { prisma, resolveDiscordUser } = vi.hoisted(() => ({
  prisma: {
    project: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    chatActiveTarget: { upsert: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({})) },
  },
  resolveDiscordUser: vi.fn(),
}));
vi.mock('../db', () => ({ prisma }));
vi.mock('./userMapping', () => ({ resolveDiscordUser }));
vi.mock('./formatting', () => ({ formatPaneForDiscord: () => ({ content: 'pane' }) }));
vi.mock('../services/sessionAccess', () => {
  class SessionAccessError extends Error {}
  return { SessionAccessError, projectSessionAccess: vi.fn() };
});
vi.mock('../services/sessionResolver', () => ({
  isAmbiguousSession: () => false, operationScopeForResolvedSession: () => null, resolveSessionProject: vi.fn(),
}));
vi.mock('../slack/tmuxAgent', () => ({
  hasSession: vi.fn(async () => true), sendKeys: vi.fn(), capturePaneForSlack: vi.fn(async () => 'pane'),
}));
vi.mock('../slack/lts', () => ({ setNotificationTarget: vi.fn() }));
vi.mock('../services/agentRegistry', () => ({ isAgentConnected: () => false, sendToAgent: vi.fn() }));

import { registerDiscordEvents } from './events';
import { setActiveProjectId, getActiveProjectId } from '../slack/events';
import { projectSessionAccess, SessionAccessError } from '../services/sessionAccess';
import { resolveSessionProject } from '../services/sessionResolver';
import { sendKeys } from '../slack/tmuxAgent';
import { resetActiveTargetsForTests } from '../slack/activeTargets';

const bob = { id: 'u-bob', unixUsername: 'bob', role: 'member' };
const alice = { id: 'u-alice', unixUsername: 'alice' };
const aliceProject = { id: 'p-alice', name: 'web', userId: alice.id, archived: false, instanceId: 'i-alice', user: alice };
const bobProject = { id: 'p-bob', name: 'api', userId: bob.id, archived: false, instanceId: 'i-bob', user: bob };

type Handler = (interaction: unknown) => Promise<void>;
function slashT(): Handler {
  let handler: Handler | undefined;
  registerDiscordEvents({ on: (event: string, fn: Handler) => { if (event === 'interactionCreate') handler = fn; } } as unknown as Client);
  return handler!;
}

const reply = vi.fn(async (_a: unknown) => ({ id: 'm1', edit: vi.fn() }));
async function run(command: string) {
  await slashT()({
    isChatInputCommand: () => true, commandName: 't', user: { id: 'D-BOB' }, channelId: 'chan',
    options: { getString: () => command }, reply, deferReply: vi.fn(), editReply: vi.fn(async () => ({ id: 'm2', edit: vi.fn() })),
  });
}
const replied = () => reply.mock.calls.map(([a]) => (typeof a === 'string' ? a : (a as { content: string }).content));

describe('Discord /t project access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetActiveTargetsForTests();
    resolveDiscordUser.mockResolvedValue(bob);
    vi.mocked(projectSessionAccess).mockImplementation(async (userId, projectId) => {
      if (userId === bob.id && projectId === bobProject.id) return (() => ({})) as never;
      throw new (SessionAccessError as unknown as new (s: number, m: string) => Error)(404, 'Project not found');
    });
    prisma.project.findUnique.mockImplementation(async ({ where }: any) => [aliceProject, bobProject].find(p => p.id === where.id) ?? null);
  });

  it("treats someone else's session as missing to /t attach, without saving it", async () => {
    vi.mocked(resolveSessionProject).mockResolvedValue({ userId: alice.id, instanceId: 'i-alice', projectId: aliceProject.id, workstream: 'main' });
    await run('attach alice-web-agent');
    expect(replied()).toEqual(['No tmux session `alice-web-agent`.']);
    expect(getActiveProjectId('D-BOB')).toBeNull();
    expect(prisma.chatActiveTarget.upsert).not.toHaveBeenCalled();
  });

  it("refuses to type through a saved target that isn't theirs, in /t and /t ctrl", async () => {
    setActiveProjectId('D-BOB', aliceProject.id, 'main', 'discord');
    await run('rm -rf .');
    await run('ctrl whoami');
    expect(sendKeys).not.toHaveBeenCalled();
    expect(replied()).toEqual(['That project is not yours or shared with you.', 'That project is not yours or shared with you.']);
  });

  it('says an archived project of their own is archived', async () => {
    prisma.project.findUnique.mockResolvedValue({ ...bobProject, archived: true });
    // projectSessionAccess refuses an archived project, even its owner.
    vi.mocked(projectSessionAccess).mockRejectedValue(new (SessionAccessError as unknown as new (s: number, m: string) => Error)(404, 'Project not found'));
    setActiveProjectId('D-BOB', bobProject.id, 'main', 'discord');
    await run('status');
    expect(replied()).toEqual(['That project is archived. Use `/t switch <name>` to pick another.']);
  });

  it('still types into their own project', async () => {
    setActiveProjectId('D-BOB', bobProject.id, 'main', 'discord');
    await run('run the tests');
    expect(sendKeys).toHaveBeenCalledWith('bob-api-agent', 'run the tests', true, 'i-bob');
  });
});
