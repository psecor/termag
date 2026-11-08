// A chat's space memory: every turn loads the chat's
// own space, fixed when it started (services/chatSpace.ts), never the tab it
// is open in. A chat with no space, or one its box isn't granted, loads
// nothing, and the box is told so. An older runner gets nothing.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  project: { findUnique: vi.fn(), update: vi.fn() },
  // Every send checks for a resume onto this box whose session is still to restore: none here.
  chatResume: { findFirst: vi.fn(async () => null) },
  workflow: { update: vi.fn() },
  // chatLaunchFor reads whether the owner has the Claude gateway on.
  user: { findUnique: vi.fn(async () => ({ claudeGatewayEnabled: true })) },
}));
vi.mock('../db', () => ({ prisma }));
const caps = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock('../services/agentRegistry', () => ({
  instanceAgentTransport: vi.fn(() => ({ capabilities: caps.list })),
  isProjectAgentConnected: vi.fn(() => true),
  sendForProject: vi.fn(async (_host: unknown, type: string) => {
    if (type === 'tmux-foreground-cmd') return { cmd: 'bash', dead: false };
    if (type === 'chat-history') return { running: false, sessionId: 'abcd1234-0000-0000-0000-000000000000', entries: [] };
    if (type === 'chat-resume-claim') return { claimed: false, running: true };
    if (type === 'chat-note-pane') return { resume: true };
    return { queued: false, turnId: 't1' };
  }),
}));
vi.mock('../services/sessionAccess', () => ({
  SessionAccessError: class extends Error { status = 403; },
  projectSessionAccess: vi.fn(async () => () => ({
    host: { userId: 'owner', instanceId: 'box1' }, isOwner: true, session: 'owner_proj_agent',
    project: { ownerUsername: 'owner' },
  })),
}));
// Only `termag ask --model` is on (an ask chat runs on its stored tier), unless a test turns it off.
const askModel = vi.hoisted(() => ({ on: true }));
vi.mock('../services/featureFlags', () => ({ boolVariation: vi.fn(async (key: string) => key === 'ask-model-choice-enabled' && askModel.on) }));
vi.mock('../services/fireworksFlag', () => ({ fireworksModelsForBox: vi.fn(async () => null), fireworksOfferedTo: vi.fn(async () => null) }));
vi.mock('../services/automations/chatGate', () => ({ runChatRefusalFor: vi.fn(async () => null), RUN_CHAT_REFUSAL_TEXT: {} }));
const place = vi.hoisted(() => ({ value: { space: { id: 's1', name: 'design' }, reachable: true } as { space: { id: string; name: string } | null; reachable: boolean } }));
// turnMemorySpace's answer from the chat's place (services/chatSpace.ts); undefined when it can't be read.
vi.mock('../services/chatSpace', () => ({
  turnMemorySpace: vi.fn(async () => (place.value.space && place.value.reachable ? place.value.space.name : null) as string | null | undefined),
}));
vi.mock('../services/tmux', () => ({
  projectDirFor: vi.fn(() => '/home/owner/termag/projects/proj'),
  sessionName: vi.fn(() => 'owner_proj_agent'),
}));

import { chatSendFor } from './chat';
import { sendForProject } from '../services/agentRegistry';
import { turnMemorySpace } from '../services/chatSpace';

const sent = () => vi.mocked(sendForProject).mock.calls.filter(c => c[1] === 'chat-send').map(c => c[2] as Record<string, unknown>);
const viewer = { id: 'owner', googleEmail: 'o@example.com', displayName: 'O', unixUsername: 'owner', defaultAgentProvider: 'claude' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  caps.list = ['chat-runner-v1', 'chat-trust-v1', 'space-memory-v1'];
  place.value = { space: { id: 's1', name: 'design' }, reachable: true };
  prisma.project.findUnique.mockResolvedValue({
    name: 'proj', userId: 'owner', setupStatus: 'ready', repoUrl: null, chatTrustedAt: null, chatOrchestrator: false,
    instance: { hostHome: '/home/owner', userId: 'owner' },
    workflows: [{ id: 'wf1', provider: 'claude-chat', backend: null, model: 'opus', workstream: { id: 'ws1', name: 'main', askThread: null } }],
  });
});

describe('a chat\'s space memory', () => {
  it('loads the chat\'s own space, whatever space the tab sending it is in (plan-outbox #38)', async () => {
    expect((await chatSendFor('owner', 'p1', { workstream: 'main', text: 'hi', space: 'other' }, viewer)).status).toBe(202);
    expect(vi.mocked(turnMemorySpace)).toHaveBeenCalledWith('ws1');
    expect(sent()[0].spaceMemory).toEqual({ space: 'design' });
  });

  it('a chat with no space, or one its box isn\'t granted, loads nothing, and the box is told', async () => {
    place.value = { space: null, reachable: false };
    await chatSendFor('owner', 'p1', { workstream: 'main', text: 'hi' }, viewer);
    place.value = { space: { id: 's1', name: 'design' }, reachable: false };
    await chatSendFor('owner', 'p1', { workstream: 'main', text: 'hi', space: 'design' }, viewer);
    expect(sent().map(p => p.spaceMemory)).toEqual([{ space: null }, { space: null }]);
  });

  it('an ask\'s chat loads the chat\'s own space too, as its UI turns do (Bugbot, #769: ask turns omit space memory)', async () => {
    prisma.project.findUnique.mockResolvedValue({
      name: 'proj', userId: 'owner', setupStatus: 'ready', repoUrl: null, chatTrustedAt: null, chatOrchestrator: false,
      instance: { hostHome: '/home/owner', userId: 'owner' },
      workflows: [{ id: 'wf1', provider: 'claude-chat', backend: null, model: 'opus', workstream: {
        id: 'ws1', name: 'ask-abc', askThread: { id: 'thread1', workstream: 'main', baseSha: null, originUser: { displayName: 'O', unixUsername: 'owner', googleEmail: 'o@example.com' } },
      } }],
    });
    caps.list = ['chat-runner-v1', 'chat-trust-v1', 'space-memory-v1', 'ask-chat-v1'];
    expect((await chatSendFor('owner', 'p1', { workstream: 'ask-abc', text: 'hi' }, viewer)).status).toBe(202);
    expect(sent()[0]).toHaveProperty('ask');
    // On the tier the thread keeps (termag ask --model), as its ask turns run.
    expect(sent()[0]).toMatchObject({ model: 'opus' });
    // With ask-model-choice-enabled off, a person's message there names no --model: the box's default, as its asks.
    askModel.on = false;
    await chatSendFor('owner', 'p1', { workstream: 'ask-abc', text: 'hi' }, viewer);
    expect(sent().at(-1)).not.toHaveProperty('model');
    askModel.on = true;
    expect(sent()[0].spaceMemory).toEqual({ space: 'design' });
    place.value = { space: null, reachable: false };
    await chatSendFor('owner', 'p1', { workstream: 'ask-abc', text: 'hi' }, viewer);
    expect(sent().at(-1)!.spaceMemory).toEqual({ space: null });
  });

  it("a person's message in an ask chat with no tier runs on the box's default, as the thread's asks did", async () => {
    vi.stubEnv('CLAUDE_GATEWAY_URL', 'https://gateway.example/bedrock');
    vi.stubEnv('CLAUDE_BEDROCK_REGION', 'us-east-2');
    vi.stubEnv('CLAUDE_BEDROCK_MODELS', 'opus=us.anthropic.claude-opus-5-5,sonnet=us.anthropic.claude-sonnet-5-5,haiku=us.anthropic.claude-haiku-4-5');
    vi.stubEnv('CLAUDE_DEFAULT_MODEL', 'opus');
    try {
      prisma.project.findUnique.mockResolvedValue({
        name: 'proj', userId: 'owner', setupStatus: 'ready', repoUrl: null, chatTrustedAt: null, chatOrchestrator: false,
        user: { claudeGatewayEnabled: true },
        instance: { hostHome: '/home/owner', userId: 'owner' },
        workflows: [{ id: 'wf1', provider: 'claude-chat', backend: null, model: null, workstream: {
          id: 'ws1', name: 'ask-abc', askThread: { id: 'thread1', workstream: 'main', baseSha: null, originUser: { displayName: 'O', unixUsername: 'owner', googleEmail: 'o@example.com' } },
        } }],
      });
      caps.list = ['chat-runner-v1', 'chat-trust-v1', 'ask-chat-v1'];
      expect((await chatSendFor('owner', 'p1', { workstream: 'ask-abc', text: 'hi' }, viewer)).status).toBe(202);
      // No --model, as the thread's asks: the box's own default, even on a box that skipped the gateway.
      expect(sent().at(-1)).not.toHaveProperty('model');
      // Nothing is written: the thread still has no tier of its own.
      expect(prisma.workflow.update).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("caps a person's message in the ask chat of a project from a shared environment, as its runs are (askService askModeFor)", async () => {
    prisma.project.findUnique.mockResolvedValue({
      // Trusted: auto needs the owner's trust tick (Security Agent, #998).
      name: 'proj', userId: 'owner', setupStatus: 'ready', repoUrl: null, chatTrustedAt: new Date(), chatOrchestrator: false, environmentId: 'e1',
      instance: { hostHome: '/home/owner', userId: 'owner' },
      workflows: [{ id: 'wf1', provider: 'claude-chat', backend: null, model: 'opus', workstream: {
        id: 'ws1', name: 'ask-abc', askThread: { id: 'thread1', workstream: 'main', baseSha: null, originUser: { displayName: 'O', unixUsername: 'owner', googleEmail: 'o@example.com' } },
      } }],
    });
    caps.list = ['chat-runner-v1', 'chat-trust-v1', 'ask-chat-v1', 'ask-mode-cap-v1', 'chat-auto-v1'];
    expect((await chatSendFor('owner', 'p1', { workstream: 'ask-abc', text: 'hi' }, viewer)).status).toBe(202);
    expect(sent()[0]).toMatchObject({ permissionMode: 'auto', ask: { permissionMode: 'auto' } });
    // An agent from before the cap would run it as bypassPermissions: refused, and nothing is sent.
    caps.list = ['chat-runner-v1', 'chat-trust-v1', 'ask-chat-v1', 'chat-auto-v1'];
    const refused = await chatSendFor('owner', 'p1', { workstream: 'ask-abc', text: 'hi' }, viewer);
    expect(refused.status).toBe(409);
    expect(sent()).toHaveLength(1);
  });

  it('a runner without space-memory-v1 gets nothing; an unreadable space leaves it to the box', async () => {
    caps.list = ['chat-runner-v1', 'chat-trust-v1'];
    await chatSendFor('owner', 'p1', { workstream: 'main', text: 'hi' }, viewer);
    caps.list = ['chat-runner-v1', 'chat-trust-v1', 'space-memory-v1'];
    vi.mocked(turnMemorySpace).mockResolvedValueOnce(undefined);
    expect((await chatSendFor('owner', 'p1', { workstream: 'main', text: 'hi' }, viewer)).status).toBe(202);
    for (const p of sent()) expect(p).not.toHaveProperty('spaceMemory');
  });
});
