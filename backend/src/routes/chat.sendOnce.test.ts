// A new conversation's first message goes to the box exactly once. The
// box answers chat-send once it has started the turn, which on a box just
// claimed and updated can take well over 10 s (the space-memory CLI alone
// may take 20 s), so the RPC waits CHAT_SEND_TIMEOUT_MS for it. The
// browser's send id rides along, so a repeat of a send the box already
// took is answered as the first was (agent/chat-send-ids.js). A send that
// arrives while the box's claim update runs waits for it, then goes once.
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
vi.mock('../services/agentRegistry', () => ({
  instanceAgentTransport: vi.fn(() => ({ capabilities: ['chat-runner-v1', 'chat-trust-v1', 'chat-live-v1'] })),
  isProjectAgentConnected: vi.fn(() => true),
  sendForProject: vi.fn(async (_host: unknown, type: string) => {
    if (type === 'tmux-foreground-cmd') return { cmd: 'bash', dead: false };
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
vi.mock('../services/chatSpace', () => ({ turnMemorySpace: vi.fn(async () => undefined) }));
// The chat's box is up and connected, with nothing held or continuing: a send goes the usual way.
vi.mock('../services/chatNewBox', async (orig) => ({
  ...(await orig<typeof import('../services/chatNewBox')>()),
  continuationFacts: vi.fn(async () => ({
    flagOn: true, isOwner: true, ownerName: 'O', excluded: false, box: { id: 'box1', status: 'ready', kind: 'ec2' }, setupReady: true,
    connected: true, complete: true, lockHeld: false, credentialsPending: false, pendingResume: null, hasHeld: false, parkHold: false,
    ask: false, ownsBox: true,
  })),
}));
vi.mock('../services/tmux', () => ({
  projectDirFor: vi.fn(() => '/home/owner/termag/projects/proj'),
  sessionName: vi.fn(() => 'owner_proj_agent'),
}));

import { chatSendFor } from './chat';
import { sendForProject } from '../services/agentRegistry';
import { resetClaimUpdateGate, trackClaimUpdate } from '../services/claimUpdateGate';
import { CHAT_SEND_TIMEOUT_MS, chatSendTimeoutMs } from '../services/chatRunner';
import { CHAT_IMAGE_SEND_TIMEOUT_MS } from '../services/chatImages';

const chatSends = () => vi.mocked(sendForProject).mock.calls.filter(c => c[1] === 'chat-send');
const viewer = { id: 'owner', googleEmail: 'o@example.com', displayName: 'O', unixUsername: 'owner', defaultAgentProvider: 'claude' } as never;
const SEND_ID = '0b6f3c1e-4b7a-4d2e-9f00-3a1b2c3d4e5f';

beforeEach(() => {
  vi.clearAllMocks();
  resetClaimUpdateGate();
  prisma.project.findUnique.mockResolvedValue({
    name: 'proj', userId: 'owner', instanceId: 'box1', setupStatus: 'ready', repoUrl: null, chatTrustedAt: null, chatOrchestrator: false,
    instance: { hostHome: '/home/owner', userId: 'owner' },
    workflows: [{ id: 'wf1', provider: 'claude-chat', backend: null, model: 'opus', workstream: { id: 'ws1', name: 'main', askThread: null } }],
  });
});

describe('a new conversation\'s first message', () => {
  it('goes to the box once, with its send id, and the RPC waits as long as the box\'s turn start may take', async () => {
    const r = await chatSendFor('owner', 'p1', { workstream: 'main', text: 'connect the MCP server', sendId: SEND_ID }, viewer);
    expect(r.status).toBe(202);
    expect(chatSends()).toHaveLength(1);
    const [, , payload, timeout] = chatSends()[0];
    expect(payload).toMatchObject({ text: 'connect the MCP server', sendId: SEND_ID });
    expect(timeout).toBe(CHAT_SEND_TIMEOUT_MS);
    // Longer than the space-memory CLI's own bound on the box (agent/space-memory.js CLI_TIMEOUT_MS, 20 s).
    expect(CHAT_SEND_TIMEOUT_MS).toBeGreaterThan(20_000);
  });

  it('waits out the box\'s claim update, then goes once', async () => {
    let finish!: () => void;
    trackClaimUpdate('box1', new Promise<void>(resolve => { finish = resolve; }));
    const pending = chatSendFor('owner', 'p1', { workstream: 'main', text: 'hello', sendId: SEND_ID }, viewer);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(chatSends()).toHaveLength(0);
    finish();
    expect((await pending).status).toBe(202);
    expect(chatSends()).toHaveLength(1);
  });

  it('a send with images also waits for the images to reach the box', () => {
    expect(chatSendTimeoutMs(0)).toBe(CHAT_SEND_TIMEOUT_MS);
    expect(chatSendTimeoutMs(2)).toBe(CHAT_SEND_TIMEOUT_MS + CHAT_IMAGE_SEND_TIMEOUT_MS);
  });

  it('a send id that is not one is dropped, never handed to the box', async () => {
    for (const sendId of ['../x', 'short', 42, 'a'.repeat(65)]) {
      await chatSendFor('owner', 'p1', { workstream: 'main', text: 'hi', sendId }, viewer);
    }
    expect(chatSends()).toHaveLength(4);
    for (const c of chatSends()) expect(c[2]).not.toHaveProperty('sendId');
  });
});
