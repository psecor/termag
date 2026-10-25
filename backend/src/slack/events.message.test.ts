import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { registerEventHandlers } from './events';
import { executeClaudeCommand } from './executor';
import { handleCollabThreadMessage } from './collab';
import { slackChatAllowed, slackUserRefusal } from './access';

type Listener = (args: any) => Promise<void>;

function fakeApp() {
  const events = new Map<string, Listener>();
  const app = {
    event: (name: string, fn: Listener) => { events.set(name, fn); },
    command: vi.fn(), action: vi.fn(), view: vi.fn(), message: vi.fn(),
  };
  registerEventHandlers(app);
  return events;
}

const say = vi.fn(async () => ({ ts: '9.9' }));
const client = {
  chat: { update: vi.fn(async () => ({})), postMessage: vi.fn(async () => ({ ts: '9.9' })), postEphemeral: vi.fn(async () => ({})) },
  reactions: { add: vi.fn(async () => ({})), remove: vi.fn(async () => ({})) },
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
