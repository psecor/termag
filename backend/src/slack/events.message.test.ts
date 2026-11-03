import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Only the message handler's routing is under test: which events reach the
// Claude DM executor. Everything it would call further down is stubbed.
vi.mock('../db', () => ({ prisma: {} }));
vi.mock('./executor', () => ({
  executeClaudeCommand: vi.fn(async () => 'answer'),
  resolveWorkingDir: vi.fn(async () => '/tmp'),
}));
vi.mock('./streaming', () => ({
  StreamingMessageUpdater: class { appendChunk = vi.fn(async () => {}); finalize = vi.fn(async () => {}); },
}));
vi.mock('./formatting', () => ({ formatResponse: vi.fn(), formatError: vi.fn(() => 'err'), formatWelcome: vi.fn(() => 'welcome'), splitMessage: vi.fn() }));
vi.mock('./homeView', () => ({ publishHomeView: vi.fn() }));
vi.mock('./userMapping', () => ({ resolveTermagUser: vi.fn(async () => null) }));
vi.mock('./access', () => ({
  slackUserRefusal: vi.fn(async () => null),
  slackRefusalText: vi.fn(() => 'Ask for access in #termag-help.'),
  slackChatAllowed: vi.fn(() => true),
}));
vi.mock('./collab', () => ({ handleCollabThreadMessage: vi.fn(async () => false) }));
vi.mock('../services/workstreams', () => ({ ensureMainWorkstream: vi.fn() }));
vi.mock('../services/tmux', () => ({ sessionName: vi.fn(), projectDir: vi.fn(), formatPaneForSlack: vi.fn() }));
vi.mock('../services/sessionResolver', () => ({ isAmbiguousSession: vi.fn(), operationScopeForResolvedSession: vi.fn(), resolveSessionProject: vi.fn() }));
vi.mock('./channels', () => ({ matchChannelTarget: vi.fn(), createProjectChannel: vi.fn() }));
vi.mock('./tmuxAgent', () => ({}));
vi.mock('../services/agentRegistry', () => ({ isAgentConnected: vi.fn(), sendToAgent: vi.fn() }));
vi.mock('../services/agentRuntime', () => ({ ensureAgentSessionsAndLaunch: vi.fn() }));
vi.mock('../services/admin/adminAccess', () => ({ isAdminUser: vi.fn() }));
vi.mock('./lts', () => ({}));
vi.mock('../services/slackAgentFlag', () => ({ slackAgentEnabled: vi.fn(async () => false) }));
vi.mock('./agentTurn', () => ({ runAgentTurn: vi.fn(async () => {}) }));

import { registerEventHandlers } from './events';
import { executeClaudeCommand } from './executor';
import { handleCollabThreadMessage } from './collab';
import { slackChatAllowed, slackUserRefusal } from './access';
import { slackAgentEnabled } from '../services/slackAgentFlag';
import { runAgentTurn } from './agentTurn';
import { agentRuns, claudeSessionFor, rememberClaudeSession } from './agentSession';

type Listener = (args: any) => Promise<void>;

let actions: Array<[string | RegExp, Listener]> = [];

function fakeApp() {
  const events = new Map<string, Listener>();
  actions = [];
  const app = {
    event: (name: string, fn: Listener) => { events.set(name, fn); },
    action: (id: string | RegExp, fn: Listener) => { actions.push([id, fn]); },
    command: vi.fn(), view: vi.fn(), message: vi.fn(),
  };
  registerEventHandlers(app);
  return events;
}

/** The handler registered for a block action id (string or pattern). */
function actionFor(actionId: string): Listener {
  const found = actions.find(([id]) => (typeof id === 'string' ? id === actionId : id.test(actionId)));
  if (!found) throw new Error(`no handler for ${actionId}`);
  return found[1];
}

const say = vi.fn(async () => ({ ts: '9.9' }));
const client = {
  // The bot token's scopes say the app is a Slack agent (agentSession.ts isAgentApp).
  auth: { test: vi.fn(async () => ({ ok: true, response_metadata: { scopes: ['chat:write', 'assistant:write'] } })) },
  apiCall: vi.fn(async () => ({ ok: true })),
  chat: { update: vi.fn(async () => ({})), postMessage: vi.fn(async () => ({ ts: '9.9' })), postEphemeral: vi.fn(async () => ({})) },
  reactions: { add: vi.fn(async () => ({})), remove: vi.fn(async () => ({})) },
  filesUploadV2: vi.fn(async () => ({ ok: true })),
};

describe('the Slack message handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('never runs the executor for channel messages, even in a thread an @mention followed', async () => {
    const events = fakeApp();
    // An @mention in a channel reaches the executor...
    await events.get('app_mention')!({ event: { user: 'U1', channel: 'C1', ts: '1.0', text: '<@BOT> hi' }, say, client, context: { botUserId: 'BOT' } });
    vi.mocked(executeClaudeCommand).mockClear();
    // ...but a plain reply in its thread, delivered by message.channels, is not an executor input.
    await events.get('message')!({ event: { user: 'U2', channel: 'C1', channel_type: 'channel', ts: '1.5', thread_ts: '1.0', text: 'run something' }, say, client });
    expect(handleCollabThreadMessage).toHaveBeenCalled();
    expect(executeClaudeCommand).not.toHaveBeenCalled();
  });

  it('still answers a plain DM', async () => {
    const events = fakeApp();
    // A user of its own: the handler rate-limits per user, and U1 spoke in the test before.
    await events.get('message')!({ event: { user: 'U9DM', channel: 'D1', channel_type: 'im', ts: '2.0', text: 'hello' }, say, client });
    expect(executeClaudeCommand).toHaveBeenCalled();
  });

  it('points someone the Slack gate refuses at where to ask, only them, without running the executor', async () => {
    vi.mocked(slackUserRefusal).mockResolvedValue('flag-off');
    const events = fakeApp();
    await events.get('message')!({ event: { user: 'U9NO', channel: 'D2', channel_type: 'im', ts: '3.0', text: 'hello' }, say, client });
    await events.get('app_mention')!({ event: { user: 'U9NO2', channel: 'C2', ts: '3.1', text: '<@BOT> hi' }, say, client, context: { botUserId: 'BOT' } });
    await events.get('app_mention')!({ event: { user: 'U9NO3', channel: 'C2', ts: '3.3', thread_ts: '3.2', text: '<@BOT> hi' }, say, client, context: { botUserId: 'BOT' } });
    expect(slackUserRefusal).toHaveBeenCalledWith('U9NO', client);
    expect(executeClaudeCommand).not.toHaveBeenCalled();
    // In the DM, a reply is private already; in a channel it is ephemeral, in the mention's thread when there is one.
    expect(say).toHaveBeenCalledWith({ text: 'Ask for access in #termag-help.', thread_ts: '3.0' });
    expect(client.chat.postEphemeral).toHaveBeenCalledWith({ channel: 'C2', user: 'U9NO2', text: 'Ask for access in #termag-help.' });
    expect(client.chat.postEphemeral).toHaveBeenCalledWith({ channel: 'C2', user: 'U9NO3', text: 'Ask for access in #termag-help.', thread_ts: '3.2' });
    expect(client.chat.postMessage).not.toHaveBeenCalled();
    vi.mocked(slackUserRefusal).mockResolvedValue(null);
  });

  it('answers a refused sender once per rate-limit window, not once per message', async () => {
    vi.mocked(slackUserRefusal).mockResolvedValue('flag-off');
    const events = fakeApp();
    for (const ts of ['5.0', '5.1', '5.2']) {
      await events.get('message')!({ event: { user: 'U9SPAM', channel: 'D5', channel_type: 'im', ts, text: 'hello?' }, say, client });
    }
    expect(say).toHaveBeenCalledTimes(1);
    vi.mocked(slackUserRefusal).mockResolvedValue(null);
  });

  it('keeps the operators-only pointer for an @mention in a channel to the sender', async () => {
    vi.mocked(slackChatAllowed).mockReturnValue(false);
    const events = fakeApp();
    await events.get('app_mention')!({ event: { user: 'U9FLAG2', channel: 'C3', ts: '6.0', text: '<@BOT> hi' }, say, client, context: { botUserId: 'BOT' } });
    expect(executeClaudeCommand).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
    expect(client.chat.postEphemeral).toHaveBeenCalledWith(expect.objectContaining({ user: 'U9FLAG2', text: expect.stringContaining('only for the bot\'s operators') }));
    vi.mocked(slackChatAllowed).mockReturnValue(true);
  });

  it('points someone the flag let in, but the list leaves out, at /t instead of running the executor', async () => {
    vi.mocked(slackChatAllowed).mockReturnValue(false);
    const events = fakeApp();
    await events.get('message')!({ event: { user: 'U9FLAG', channel: 'D3', channel_type: 'im', ts: '4.0', text: 'cat ~/.env' }, say, client });
    expect(executeClaudeCommand).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('only for the bot\'s operators') }));
    vi.mocked(slackChatAllowed).mockReturnValue(true);
  });

  it('leaves a collaboration-card thread reply to the card, not the executor', async () => {
    vi.mocked(handleCollabThreadMessage).mockResolvedValueOnce(true);
    const events = fakeApp();
    await events.get('message')!({ event: { user: 'U1', channel: 'D1', channel_type: 'im', ts: '2.5', thread_ts: '2.0', text: 'my reply' }, say, client });
    expect(executeClaudeCommand).not.toHaveBeenCalled();
  });
});

describe('the Slack agent path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('takes an operator with the agent flag on to an agent session, not the plain executor', async () => {
    vi.mocked(slackAgentEnabled).mockResolvedValueOnce(true);
    const events = fakeApp();
    await events.get('message')!({ event: { user: 'U9AG', channel: 'D7', channel_type: 'im', ts: '7.0', text: 'hello' }, say, client });
    expect(runAgentTurn).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'D7', userId: 'U9AG', recipient: null }));
    expect(executeClaudeCommand).not.toHaveBeenCalled();
  });

  it('never gives the agent path to someone DMs and @mentions do not answer, flag or not', async () => {
    vi.mocked(slackAgentEnabled).mockResolvedValue(true);
    vi.mocked(slackChatAllowed).mockReturnValue(false);
    const events = fakeApp();
    await events.get('message')!({ event: { user: 'U9AG2', channel: 'D8', channel_type: 'im', ts: '8.0', text: 'hello' }, say, client });
    await events.get('app_mention')!({ event: { user: 'U9AG3', channel: 'C8', ts: '8.1', text: '<@BOT> hi', team: 'T1' }, say, client, context: { botUserId: 'BOT' } });
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(executeClaudeCommand).not.toHaveBeenCalled();
    vi.mocked(slackChatAllowed).mockReturnValue(true);
    vi.mocked(slackAgentEnabled).mockResolvedValue(false);
  });
});

describe('reset in a DM', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stops a new thread from carrying the old conversation over', async () => {
    rememberClaudeSession('D9R:5.0', 'sess-old', '/tmp', 'D9R');
    const events = fakeApp();
    await events.get('message')!({ event: { user: 'U9RS', channel: 'D9R', channel_type: 'im', ts: '6.0', text: 'reset' }, say, client });
    expect(say).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Session cleared') }));
    expect(claudeSessionFor('D9R:7.0', '/tmp', 'D9R')).toBeUndefined();
  });

  it('treats an @mention typed in a DM as the DM, so its reset clears the carry-over too', async () => {
    rememberClaudeSession('D9M:5.0', 'sess-mention', '/tmp', 'D9M');
    const events = fakeApp();
    await events.get('app_mention')!({ event: { user: 'U9RM', channel: 'D9M', ts: '6.0', text: '<@BOT> reset' }, say, client, context: { botUserId: 'BOT' } });
    expect(claudeSessionFor('D9M:7.0', '/tmp', 'D9M')).toBeUndefined();
  });

  it('forgets the session of the thread it is typed in', async () => {
    rememberClaudeSession('D9T:5.0', 'sess-thread', '/tmp', 'D9T');
    const events = fakeApp();
    await events.get('message')!({ event: { user: 'U9RT', channel: 'D9T', channel_type: 'im', ts: '5.5', thread_ts: '5.0', text: 'new session' }, say, client });
    expect(claudeSessionFor('D9T:5.0', '/tmp', 'D9T')).toBeUndefined();
  });
});

describe('the Stop button', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ends a run only for the person it is running for', async () => {
    const events = fakeApp();
    const controller = new AbortController();
    const keepAlive = vi.fn();
    agentRuns.set('D60:1.0', { controller, userId: 'U-OWN', keepAlive, finished: Promise.resolve() });
    await events.get('agent_session_stopped')!({ event: { channel: 'D60', thread_ts: '1.0', user: 'U-OTHER' }, client });
    expect(controller.signal.aborted).toBe(false);
    // ...and the thread is put back on Working… through the run, so the owner keeps their Stop button.
    expect(keepAlive).toHaveBeenCalledTimes(1);
    await events.get('agent_session_stopped')!({ event: { channel: 'D60', thread_ts: '1.0', user: 'U-OWN' }, client });
    expect(controller.signal.aborted).toBe(true);
    agentRuns.delete('D60:1.0');
  });
});

describe('a choice button click', () => {
  beforeEach(() => vi.clearAllMocks());
  const click = (clicker: string, forUser: string, channel: string, team?: string) => ({
    ack: vi.fn(async () => {}),
    action: { value: JSON.stringify({ u: forUser, c: 'Post them' }) },
    body: { user: { id: clicker, ...(team && { team_id: team }) }, channel: { id: channel }, message: { ts: '5.0', thread_ts: '4.0' } },
    client,
  });

  it('runs the next turn with the choice, and marks the buttons once it starts', async () => {
    vi.mocked(slackAgentEnabled).mockResolvedValueOnce(true);
    vi.mocked(runAgentTurn).mockImplementationOnce(async (t: any) => { await t.onStart?.(); });
    fakeApp();
    await actionFor('agent_choice_0')(click('U-CL1', 'U-CL1', 'D61'));
    expect(client.chat.update).toHaveBeenCalledWith(expect.objectContaining({ ts: '5.0', text: expect.stringContaining('Post them') }));
    expect(runAgentTurn).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'D61', threadTs: '4.0', message: 'Post them', userId: 'U-CL1', react: false, recipient: null,
    }));
  });

  it('leaves the buttons when the turn refuses to start (busy, the cap, a restart)', async () => {
    vi.mocked(slackAgentEnabled).mockResolvedValueOnce(true);
    // A turn that refuses never calls onStart.
    vi.mocked(runAgentTurn).mockImplementationOnce(async () => {});
    fakeApp();
    await actionFor('agent_choice_0')(click('U-CL4', 'U-CL4', 'D64'));
    expect(runAgentTurn).toHaveBeenCalled();
    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it('tells someone else privately that it is not theirs to answer, and leaves the buttons', async () => {
    vi.mocked(slackAgentEnabled).mockResolvedValueOnce(true);
    fakeApp();
    await actionFor('agent_choice_1')(click('U-CL2', 'U-OWNER', 'C62', 'T1'));
    expect(client.chat.postEphemeral).toHaveBeenCalledWith(expect.objectContaining({ user: 'U-CL2', text: expect.stringContaining('<@U-OWNER>') }));
    expect(client.chat.update).not.toHaveBeenCalled();
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it('leaves the buttons in place when a channel click cannot run a turn', async () => {
    vi.mocked(slackAgentEnabled).mockResolvedValueOnce(true);
    fakeApp();
    await actionFor('agent_choice_0')(click('U-CL3', 'U-CL3', 'C63'));
    expect(client.chat.update).not.toHaveBeenCalled();
    expect(runAgentTurn).not.toHaveBeenCalled();
  });
});

describe('sharing an attachment', () => {
  let dir: string;
  beforeAll(async () => {
    const { mkdtemp, writeFile } = await import('fs/promises');
    const { tmpdir } = await import('os');
    dir = await mkdtemp(require('path').join(tmpdir(), 'attach-click-'));
    await writeFile(require('path').join(dir, 'chart.png'), 'png');
  });
  beforeEach(() => vi.clearAllMocks());
  // A user of its own per test: clicks are rate-limited per person.
  const click = (clicker: string, forUser: string, actionId: string) => ({
    ack: vi.fn(async () => {}),
    action: { action_id: actionId, value: JSON.stringify({ u: forUser, p: require('path').join(dir, 'chart.png'), w: dir }) },
    body: { user: { id: clicker }, channel: { id: 'D90' }, message: { ts: '5.0', thread_ts: '4.0' } },
    client,
  });

  it('uploads into the thread when its owner presses Share', async () => {
    vi.mocked(slackAgentEnabled).mockResolvedValueOnce(true);
    fakeApp();
    await actionFor('agent_attach_share')(click('U-AT1', 'U-AT1', 'agent_attach_share'));
    expect(client.filesUploadV2).toHaveBeenCalledWith(expect.objectContaining({ channel_id: 'D90', thread_ts: '4.0', filename: 'chart.png' }));
    expect(client.chat.update).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('shared *chart.png*') }));
  });

  it('uploads nothing on Don\'t share', async () => {
    vi.mocked(slackAgentEnabled).mockResolvedValueOnce(true);
    fakeApp();
    await actionFor('agent_attach_skip')(click('U-AT2', 'U-AT2', 'agent_attach_skip'));
    expect(client.filesUploadV2).not.toHaveBeenCalled();
    expect(client.chat.update).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('chose not to share') }));
  });

  it('clears the buttons before uploading, and uploads once however often it is clicked', async () => {
    vi.mocked(slackAgentEnabled).mockResolvedValue(true);
    const order: string[] = [];
    client.chat.update.mockImplementation((async (a: any) => { order.push(`update: ${a.text}`); return {}; }) as any);
    client.filesUploadV2.mockImplementation((async () => { order.push('upload'); return { ok: true }; }) as any);
    fakeApp();
    const share = actionFor('agent_attach_share');
    const first = click('U-AT4', 'U-AT4', 'agent_attach_share');
    await share(first);
    // A second click on the same offer, five seconds later: past the rate limit,
    // so only the offer having been answered stops it.
    const later = Date.now() + 5000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(later);
    await share({ ...first, body: { ...first.body, user: { id: 'U-AT4' } } });
    now.mockRestore();
    expect(order).toEqual(['update: Sharing *chart.png*…', 'upload', 'update: <@U-AT4> shared *chart.png*.']);
    vi.mocked(slackAgentEnabled).mockResolvedValue(false);
    client.chat.update.mockImplementation((async () => ({})) as any);
    client.filesUploadV2.mockImplementation((async () => ({ ok: true })) as any);
  });

  it('lets nobody else decide', async () => {
    vi.mocked(slackAgentEnabled).mockResolvedValueOnce(true);
    fakeApp();
    await actionFor('agent_attach_share')(click('U-NOT', 'U-AT3', 'agent_attach_share'));
    expect(client.filesUploadV2).not.toHaveBeenCalled();
    expect(client.chat.postEphemeral).toHaveBeenCalledWith(expect.objectContaining({ user: 'U-NOT', text: expect.stringContaining('<@U-AT3>') }));
  });
});

