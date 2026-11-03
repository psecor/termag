// A chat's space memory: every turn loads the chat's
// own space, fixed when it started (services/chatSpace.ts), never the tab it
// is open in. A chat with no space, or one its box isn't granted, loads
// nothing, and the box is told so. An older runner gets nothing.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  project: { findUnique: vi.fn(), update: vi.fn() },
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
vi.mock('../services/featureFlags', () => ({ boolVariation: vi.fn(async () => false) }));
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
    expect(sent()[0].spaceMemory).toEqual({ space: 'design' });
    place.value = { space: null, reachable: false };
    await chatSendFor('owner', 'p1', { workstream: 'ask-abc', text: 'hi' }, viewer);
    expect(sent()[1].spaceMemory).toEqual({ space: null });
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
