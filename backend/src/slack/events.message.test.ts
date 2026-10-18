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
  chat: { update: vi.fn(async () => ({})), postMessage: vi.fn(async () => ({ ts: '9.9' })) },
  reactions: { add: vi.fn(async () => ({})), remove: vi.fn(async () => ({})) },
};

describe('the Slack message handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('never runs the executor for channel messages, even in a thread an @mention followed', async () => {
    const events = fakeApp();
    // An @mention in a channel arms the follow for its thread...
    await events.get('app_mention')!({ event: { user: 'U1', channel: 'C1', ts: '1.0', text: '<@BOT> hi' }, say, client, context: { botUserId: 'BOT' } });
    vi.mocked(executeClaudeCommand).mockClear();
    // ...but a plain reply in that thread, now delivered by message.channels, is not an executor input.
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

  it('leaves a collaboration-card thread reply to the card, not the executor', async () => {
    vi.mocked(handleCollabThreadMessage).mockResolvedValueOnce(true);
    const events = fakeApp();
    await events.get('message')!({ event: { user: 'U1', channel: 'D1', channel_type: 'im', ts: '2.5', thread_ts: '2.0', text: 'my reply' }, say, client });
    expect(executeClaudeCommand).not.toHaveBeenCalled();
  });
});
