import { beforeEach, describe, expect, it, vi } from 'vitest';

// /t routing: someone the flag let in reaches only their own or shared
// projects; an id in ALLOWED_SLACK_USERS keeps the unscoped routing.

const prisma = vi.hoisted(() => ({
  workstream: { findFirst: vi.fn(), update: vi.fn() },
  project: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  instance: { findMany: vi.fn(async () => []) },
  chatActiveTarget: { upsert: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({})) },
}));
vi.mock('../db', () => ({ prisma }));
vi.mock('./executor', () => ({ executeClaudeCommand: vi.fn(), resolveWorkingDir: vi.fn() }));
vi.mock('./streaming', () => ({ StreamingMessageUpdater: vi.fn() }));
vi.mock('./formatting', () => ({ formatResponse: vi.fn(), formatError: vi.fn(), formatWelcome: vi.fn(), splitMessage: vi.fn() }));
vi.mock('./homeView', () => ({ publishHomeView: vi.fn() }));
vi.mock('./userMapping', () => ({ resolveTermagUser: vi.fn() }));
vi.mock('../services/featureFlags', () => ({ boolVariation: vi.fn() }));
vi.mock('../services/sessionAccess', () => {
  class SessionAccessError extends Error {}
  return { SessionAccessError, projectSessionAccess: vi.fn() };
});
vi.mock('./access', async importOriginal => ({
  ...(await importOriginal<typeof import('./access')>()),
  slackUserAllowed: vi.fn(async () => true),
  slackUserRefusal: vi.fn(async () => null),
}));
vi.mock('./collab', () => ({ handleCollabThreadMessage: vi.fn() }));
vi.mock('./handoffCommand', () => ({ isHandoffCommand: vi.fn(() => false), slackHandoff: vi.fn() }));
vi.mock('../services/workstreams', () => ({ ensureMainWorkstream: vi.fn() }));
vi.mock('../services/tmux', () => ({
  sessionName: (user: string, project: string, role: string, ws = 'main') => `${user}-${project}-${ws === 'main' ? '' : `${ws}-`}${role}`,
  projectDir: vi.fn(),
  formatPaneForSlack: () => ({ text: 'pane' }),
}));
vi.mock('../services/sessionResolver', () => ({
  isAmbiguousSession: () => false, operationScopeForResolvedSession: () => null, resolveSessionProject: vi.fn(),
}));
vi.mock('./channels', () => ({ matchChannelTarget: vi.fn(), createProjectChannel: vi.fn() }));
vi.mock('./tmuxAgent', () => ({
  hasSession: vi.fn(async () => true), sendKeys: vi.fn(), capturePaneForSlack: vi.fn(async () => 'pane'),
  pollUntilStable: vi.fn(), listSessionsViaAgent: vi.fn(async () => []),
}));
vi.mock('../services/agentRegistry', () => ({ isAgentConnected: vi.fn(), sendToAgent: vi.fn(), connectedOwnedBoxIds: vi.fn(() => []) }));
vi.mock('../services/agentRuntime', () => ({ ensureAgentSessionsAndLaunch: vi.fn() }));
vi.mock('../services/admin/adminAccess', () => ({ isAdminUser: vi.fn() }));
vi.mock('./lts', () => ({
  registerLocalSession: vi.fn(), queueLocalCommand: vi.fn(), isLocalSession: (name: string) => name === 'mac',
  removeLocalSession: vi.fn(), listLocalSessions: () => [], updateLocalSessionMessage: vi.fn(),
  setActiveLocalSession: vi.fn(), getActiveLocalSession: vi.fn(() => null), clearActiveLocalSession: vi.fn(),
  setNotificationTarget: vi.fn(),
}));

import { registerEventHandlers } from './events';
import { resolveTermagUser } from './userMapping';
import { projectSessionAccess, SessionAccessError } from '../services/sessionAccess';
import { resolveSessionProject } from '../services/sessionResolver';
import { matchChannelTarget } from './channels';
import { listSessionsViaAgent, sendKeys } from './tmuxAgent';
import { connectedOwnedBoxIds, isAgentConnected } from '../services/agentRegistry';
import { getActiveLocalSession, queueLocalCommand, registerLocalSession } from './lts';
import { slackUserRefusal } from './access';

const alice = { id: 'u-alice', unixUsername: 'alice' };
const bob = { id: 'u-bob', unixUsername: 'bob' };
const aliceProject = { id: 'p-alice', name: 'web', userId: alice.id, instanceId: 'i-alice', user: alice, workstreams: [] };
const bobProject = { id: 'p-bob', name: 'api', userId: bob.id, instanceId: 'i-bob', user: bob, workstreams: [] };

type Handler = (args: any) => Promise<void>;
function slashT(): Handler {
  let handler: Handler | undefined;
  registerEventHandlers({
    event: vi.fn(), action: vi.fn(), view: vi.fn(), message: vi.fn(),
    command: (name: string, fn: Handler) => { if (name === '/t') handler = fn; },
  });
  return handler!;
}

const postMessage = vi.fn(async (_args: Record<string, unknown>) => ({ ts: '1.0' }));
const client = { chat: { postMessage, update: vi.fn() }, reactions: { add: vi.fn(async () => ({})) } };
const said = () => postMessage.mock.calls.map(([a]) => a.text);
const respond = vi.fn(async (_args: Record<string, unknown>) => ({}));
const replied = () => respond.mock.calls.map(([a]) => a);
const repliedText = () => replied().map(a => a.text);

async function run(user: string, text: string, channel: { id?: string; name?: string } = {}) {
  await slashT()({ command: { user_id: user, text, channel_id: channel.id ?? 'C-dm', channel_name: channel.name ?? 'directmessage' }, ack: vi.fn(), client, respond });
}

describe('/t project access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ALLOWED_SLACK_USERS = 'UOPS:ops';
    // UBOB maps to bob, who owns only p-bob; UOPS is listed and has no termag user.
    vi.mocked(resolveTermagUser).mockImplementation(async id => (id === 'UBOB' ? bob : null) as never);
    vi.mocked(projectSessionAccess).mockImplementation(async (userId, projectId) => {
      if (userId === bob.id && projectId === bobProject.id) return (() => ({})) as never;
      throw new (SessionAccessError as unknown as new (s: number, m: string) => Error)(404, 'Project not found');
    });
    prisma.workstream.findFirst.mockResolvedValue(null);
    prisma.project.findFirst.mockResolvedValue(null);
    prisma.project.findMany.mockResolvedValue([]);
    prisma.project.findUnique.mockResolvedValue(null);
  });

  it("refuses typing into someone else's project from its channel, without falling back to the caller's own", async () => {
    prisma.project.findFirst.mockImplementation(async ({ where }: any) => (where.slackChannelId === 'C-alice' ? aliceProject : null));
    await run('UBOB', 'rm -rf .', { id: 'C-alice', name: 'proj-alice-web' });
    await run('UBOB', 'ctrl whoami', { id: 'C-alice', name: 'proj-alice-web' });
    expect(sendKeys).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(replied()).toEqual([
      { response_type: 'ephemeral', text: 'That project is not yours or shared with you.' },
      { response_type: 'ephemeral', text: 'That project is not yours or shared with you.' },
    ]);
  });

  it("does not link a channel named after someone else's project to it", async () => {
    prisma.project.findMany.mockResolvedValue([aliceProject]);
    vi.mocked(matchChannelTarget).mockReturnValue({ projectId: aliceProject.id, workstream: 'main' } as never);
    await run('UBOB', 'hello', { id: 'C-new', name: 'proj-alice-web' });
    expect(prisma.project.update).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("treats someone else's project as unknown to /t switch and /t attach", async () => {
    prisma.project.findMany.mockImplementation(async ({ where }: any) => (where.userId ? [] : [aliceProject]));
    await run('UBOB', 'switch web');
    vi.mocked(resolveSessionProject).mockResolvedValue({ userId: alice.id, instanceId: 'i-alice', projectId: aliceProject.id, workstream: 'main' });
    await run('UBOB', 'attach alice-web-agent');
    expect(repliedText()).toEqual([
      'No project `web`. Use `/t projects` to list.\n_To type `switch web` into the agent instead: `/t -- switch web`_',
      'No tmux session `alice-web-agent`.\n_To type `attach alice-web-agent` into the agent instead: `/t -- attach alice-web-agent`_',
    ]);
  });

  it('keeps the local sessions to the listed ids', async () => {
    await run('UBOB', 'local laptop');
    await run('UBOB', 'mac ls');
    expect(registerLocalSession).not.toHaveBeenCalled();
    expect(queueLocalCommand).not.toHaveBeenCalled();
    expect(repliedText()[0]).toBe('Local sessions are only for the Slack IDs in `ALLOWED_SLACK_USERS`.');
  });

  it("still types into the caller's own project", async () => {
    prisma.project.findFirst.mockImplementation(async ({ where }: any) => (where.slackChannelId === 'C-bob' ? bobProject : null));
    await run('UBOB', 'run the tests', { id: 'C-bob', name: 'proj-bob-api' });
    expect(sendKeys).toHaveBeenCalledWith('bob-api-agent', 'run the tests', true, 'i-bob');
  });

  it('leaves a listed id the unscoped routing it always had', async () => {
    prisma.project.findFirst.mockImplementation(async ({ where }: any) => (where.slackChannelId === 'C-alice' ? aliceProject : null));
    await run('UOPS', 'status', { id: 'C-alice', name: 'proj-alice-web' });
    await run('UOPS', 'mac ls');
    expect(sendKeys).toHaveBeenCalledWith('alice-web-agent', 'status', true, 'i-alice');
    expect(queueLocalCommand).toHaveBeenCalledWith('mac', 'ls', expect.anything());
    expect(projectSessionAccess).not.toHaveBeenCalled();
  });

  it('tells someone the bot refuses where to ask, only them, without running anything', async () => {
    vi.mocked(slackUserRefusal).mockResolvedValueOnce('flag-off').mockResolvedValueOnce('no-termag-user');
    await run('UNEW', 'run the tests', { id: 'C-alice', name: 'proj-alice-web' });
    await run('UNEW', 'projects');
    expect(postMessage).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
    expect(replied()).toEqual([
      { response_type: 'ephemeral', text: expect.stringMatching(/Ask for access in #termag-help\.$/) },
      { response_type: 'ephemeral', text: expect.stringContaining('no account with your Slack email') },
    ]);
  });
});

describe('/t parsing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ALLOWED_SLACK_USERS = 'UOPS:ops';
    vi.mocked(resolveTermagUser).mockImplementation(async id => (id === 'UBOB' ? bob : null) as never);
    vi.mocked(projectSessionAccess).mockResolvedValue((() => ({})) as never);
    prisma.workstream.findFirst.mockResolvedValue(null);
    prisma.project.findFirst.mockImplementation(async ({ where }: any) => (where.slackChannelId === 'C-bob' ? bobProject : null));
    prisma.project.findMany.mockResolvedValue([]);
    prisma.project.findUnique.mockResolvedValue(null);
    prisma.instance.findMany.mockResolvedValue([]);
    vi.mocked(connectedOwnedBoxIds).mockReturnValue([]);
    vi.mocked(isAgentConnected).mockReturnValue(false);
  });
  const inBobsChannel = { id: 'C-bob', name: 'proj-bob-api' };

  it('answers /t help and /t help <command> only to the caller, the local sessions only to operators', async () => {
    await run('UBOB', 'help', inBobsChannel);
    await run('UBOB', 'help switch', inBobsChannel);
    await run('UOPS', 'help', inBobsChannel);
    expect(postMessage).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
    const [bobs, bobsSwitch, ops] = replied();
    expect(bobs).toMatchObject({ response_type: 'ephemeral' });
    expect(bobs.text).toContain('`/t projects`');
    expect(bobs.text).not.toContain('/t local');
    expect(bobsSwitch.text).toMatch(/^\*`\/t switch/);
    expect(ops.text).toContain('`/t local');
  });

  it('types a command word with arguments it does not take into the agent', async () => {
    await run('UBOB', 'projects ls', inBobsChannel);
    await run('UBOB', 'localize the strings', inBobsChannel);
    await run('UBOB', 'switch to main and pull', inBobsChannel);
    expect(vi.mocked(sendKeys).mock.calls.map(c => c[1])).toEqual(['projects ls', 'localize the strings', 'switch to main and pull']);
    expect(prisma.project.findMany).not.toHaveBeenCalled();
  });

  it('types the text after -- as written, a leading ! included, with Enter', async () => {
    await run('UBOB', '-- help', inBobsChannel);
    await run('UBOB', '-- !ls', inBobsChannel);
    await run('UBOB', '!2', inBobsChannel);
    expect(vi.mocked(sendKeys).mock.calls).toEqual([
      ['bob-api-agent', 'help', true, 'i-bob'],
      ['bob-api-agent', '!ls', true, 'i-bob'],
      ['bob-api-agent', '2', false, 'i-bob'],
    ]);
    expect(respond).not.toHaveBeenCalled();
  });

  it('sends -- text to an active local session like any other text', async () => {
    vi.mocked(getActiveLocalSession).mockReturnValueOnce('mac');
    await run('UOPS', '-- help', inBobsChannel);
    expect(queueLocalCommand).toHaveBeenCalledWith('mac', 'help', expect.anything());
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it('picks a project shared with the caller when they own none with an agent', async () => {
    const carol = { id: 'u-carol', unixUsername: 'carol' };
    vi.mocked(resolveTermagUser).mockImplementation(async id => (id === 'UCAROL' ? carol : null) as never);
    prisma.project.findFirst.mockImplementation(async ({ where }: any) => (where.shares?.some?.userId === carol.id ? bobProject : null));
    await run('UCAROL', 'run the tests');
    expect(prisma.project.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: carol.id }) }));
    expect(sendKeys).toHaveBeenCalledWith('bob-api-agent', 'run the tests', true, 'i-bob');
    // A fallback, not carol's choice: it must not overwrite a row a failed load missed.
    expect(prisma.chatActiveTarget.upsert).not.toHaveBeenCalled();
  });

  it("does not take -- in front of a local session's name as that session", async () => {
    await run('UOPS', '-- mac ls', inBobsChannel);
    expect(queueLocalCommand).not.toHaveBeenCalled();
    expect(sendKeys).toHaveBeenCalledWith('bob-api-agent', 'mac ls', true, 'i-bob');
  });

  it('answers a command word without its argument with its help instead of typing it', async () => {
    await run('UBOB', 'switch', inBobsChannel);
    expect(sendKeys).not.toHaveBeenCalled();
    expect(replied()[0].text).toMatch(/^\*`\/t switch/);
  });

  it('lists shared projects with their owner', async () => {
    prisma.project.findMany.mockResolvedValue([
      { ...bobProject, workflows: [{ type: 'agent' }] },
      { ...aliceProject, workflows: [] },
    ]);
    await run('UBOB', 'projects');
    expect(prisma.project.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { archived: false, OR: [{ userId: bob.id }, { shares: { some: { userId: bob.id } } }] },
    }));
    expect(said()[0]).toContain("`api`\n");
    expect(said()[0]).toContain("`web` · alice's");
  });

  it('saves /t switch, so a deploy keeps it', async () => {
    prisma.project.findMany.mockResolvedValue([{ ...bobProject, workstreams: [{ name: 'fix' }] }]);
    await run('UBOB', 'switch api/fix');
    expect(prisma.chatActiveTarget.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { platform_chatUserId: { platform: 'slack', chatUserId: 'UBOB' } },
      create: expect.objectContaining({ platform: 'slack', chatUserId: 'UBOB', projectId: bobProject.id, workstream: 'fix' }),
    }));
  });

  it('says the switched-to project is gone instead of typing into nothing', async () => {
    prisma.project.findUnique.mockResolvedValue({ ...bobProject, archived: true });
    await run('UBOB', 'switch api');
    prisma.project.findMany.mockResolvedValue([{ ...bobProject, workstreams: [] }]);
    await run('UBOB', 'switch api');
    vi.mocked(sendKeys).mockClear();
    await run('UBOB', 'run the tests');
    expect(sendKeys).not.toHaveBeenCalled();
    expect(repliedText().at(-1)).toMatch(/^The project you switched to is gone\./);
    expect(prisma.chatActiveTarget.deleteMany).toHaveBeenCalledWith({ where: { platform: 'slack', chatUserId: 'UBOB' } });
  });

  it("tells the caller when Slack won't let the bot post there", async () => {
    postMessage.mockRejectedValueOnce(Object.assign(new Error('An API error occurred: channel_not_found'), { data: { error: 'channel_not_found' } }));
    await run('UBOB', 'projects', { id: 'G-private', name: 'privategroup' });
    expect(replied()).toEqual([{ response_type: 'ephemeral', text: expect.stringMatching(/^termag can't post in this conversation\./) }]);
  });

  it('matches command words in any casing, but types other capitalised text', async () => {
    await run('UBOB', 'Projects');
    await run('UBOB', 'HELP Switch');
    await run('UBOB', 'Run the tests', inBobsChannel);
    expect(said()[0]).toBe('No projects. Create one in the termag web UI.');
    expect(repliedText()[0]).toMatch(/^\*`\/t switch/);
    expect(sendKeys).toHaveBeenCalledWith('bob-api-agent', 'Run the tests', true, 'i-bob');
  });

  it('lists the tmux sessions on each of the caller\'s connected boxes, then their per-user agent', async () => {
    vi.mocked(connectedOwnedBoxIds).mockReturnValue(['i-bob', 'i-idle']);
    vi.mocked(isAgentConnected).mockReturnValue(true);
    prisma.instance.findMany.mockResolvedValue([{ id: 'i-bob', name: 'bob-heavy' }, { id: 'i-idle', name: 'bob-spare' }]);
    vi.mocked(listSessionsViaAgent).mockImplementation(async host => (
      host.instanceId === 'i-bob' ? ['bob-api-agent', 'bob-api-ctrl'] : host.instanceId === null ? ['bob-old-agent'] : []));
    await run('UBOB', 'ls');
    expect(prisma.instance.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['i-bob', 'i-idle'] } } }));
    expect(said()).toEqual(['*bob-heavy*\n```\nbob-api-agent\nbob-api-ctrl\n```\n*per-user agent*\n```\nbob-old-agent\n```']);
  });

  it('says so when none of the caller\'s boxes has a session', async () => {
    await run('UBOB', 'sessions');
    expect(said()).toEqual(['No tmux sessions on your boxes.']);
  });
});
