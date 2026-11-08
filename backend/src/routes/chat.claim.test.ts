// The desktop app's thread taking a chat's Claude session (routes/chat.ts
// claimChatFor): the owner
// only, never an ask's chat, a box whose runner keeps the hold; the box's
// answer decides, and a claim it takes is recorded as of when it was asked.
// The desktop's live send and stop (chatOwnerRefusal) are the owner's too.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SESSION = '5109190e-c0d2-4f72-9c15-3c4c57fb126c';
const h = vi.hoisted(() => ({
  caps: ['chat-runner-v1', 'chat-trust-v1', 'chat-t3-hold-v1'] as string[],
  isOwner: true,
  answer: { claimed: true, sessionId: '5109190e-c0d2-4f72-9c15-3c4c57fb126c' } as unknown,
  askThread: null as null | Record<string, unknown>,
  saved: [] as unknown[][],
}));
const prisma = vi.hoisted(() => ({
  project: { findUnique: vi.fn() },
  workstream: { findUnique: vi.fn(async () => ({ name: 'main' })) },
  chatResume: { findFirst: vi.fn(async () => null) },
}));
vi.mock('../db', () => ({ prisma }));
vi.mock('../services/agentRegistry', () => ({
  instanceAgentTransport: vi.fn(() => ({ capabilities: h.caps, helloReceived: true })),
  isProjectAgentConnected: vi.fn(() => true),
  onBoxAgentHello: vi.fn(() => () => {}),
  sendToInstanceAgent: vi.fn(),
  sendForProject: vi.fn(async (_host: unknown, type: string) => (type === 'chat-t3-claim' ? h.answer : {})),
}));
vi.mock('../services/sessionAccess', () => ({
  SessionAccessError: class extends Error { status = 403; },
  projectSessionAccess: vi.fn(async () => () => ({
    host: { userId: 'owner', instanceId: 'box-1' }, isOwner: h.isOwner, session: 'owner_proj_agent',
    project: { ownerUsername: 'owner' },
  })),
}));
vi.mock('../services/featureFlags', () => ({ boolVariation: vi.fn(async () => false) }));
vi.mock('../services/tmux', () => ({
  projectDirFor: vi.fn(() => '/home/owner/termag/projects/proj'),
  sessionName: vi.fn(() => 'owner_proj_agent'),
}));
vi.mock('../services/chatHolder', async (orig) => ({
  ...(await orig<typeof import('../services/chatHolder')>()),
  saveChatHolder: vi.fn(async (...args: unknown[]) => { h.saved.push(args); }),
}));

import { chatOwnerRefusal, claimChatFor } from './chat';
import { sendForProject } from '../services/agentRegistry';
import { paneLockKey, withPaneLock } from '../services/agentRuntime';

const claims = () => vi.mocked(sendForProject).mock.calls.filter(c => c[1] === 'chat-t3-claim').map(c => c[2]);

beforeEach(() => {
  vi.clearAllMocks();
  h.caps = ['chat-runner-v1', 'chat-trust-v1', 'chat-t3-hold-v1'];
  h.isOwner = true;
  h.answer = { claimed: true, sessionId: SESSION };
  h.askThread = null;
  h.saved = [];
  prisma.project.findUnique.mockImplementation(async () => ({
    name: 'proj', userId: 'owner', instanceId: 'box-1', setupStatus: 'ready', repoUrl: null, chatTrustedAt: null, chatOrchestrator: false,
    instance: { hostHome: '/home/owner', userId: 'owner' },
    workflows: [{ id: 'wf1', provider: 'claude-chat', backend: null, model: 'opus', workstream: { id: 'ws1', name: 'main', askThread: h.askThread } }],
  }));
});

describe('claimChatFor', () => {
  it("asks the box to hold the chat's session for the thread, and records what it took", async () => {
    const before = Date.now();
    expect(await claimChatFor('owner', 'p1', { workstream: 'main', threadId: 'import:claude:abc' }))
      .toEqual({ status: 200, body: { holder: 't3', threadId: 'import:claude:abc', sessionId: SESSION } });
    expect(claims()).toEqual([{ chatKey: 'p1--ws1', threadId: 'import:claude:abc', workstream: 'main' }]);
    expect(h.saved).toEqual([['p1', 'ws1', { holder: 't3', threadId: 'import:claude:abc', sessionId: SESSION }, expect.any(Date)]]);
    // As of the ask: a release the box reported meanwhile is newer, and stays.
    expect((h.saved[0][3] as Date).getTime()).toBeLessThanOrEqual(Date.now());
    expect((h.saved[0][3] as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('records the claim as of when the box was asked, not before it waited for the pane', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-31T06:00:00Z'));
      let letGo!: () => void;
      const resume = withPaneLock(paneLockKey('box-1', 'owner_proj_agent'), () => new Promise<void>(r => { letGo = r; }));
      const claim = claimChatFor('owner', 'p1', { threadId: 't1' });
      await vi.waitFor(() => expect(letGo).toBeTypeOf('function'));
      // Open in full UI holds the pane meanwhile; a notice recorded now is older than the box's answer.
      vi.setSystemTime(new Date('2026-10-31T06:00:05Z'));
      letGo();
      await resume;
      expect((await claim).status).toBe(200);
      expect((h.saved[0][3] as Date).toISOString()).toBe('2026-10-31T06:00:05.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes on the box's refusal with its reason, and records nothing", async () => {
    for (const reason of ['chat-running', 'terminal-holds', 't3-busy', 't3-unknown', 'forked', 't3-unsupported', 't3-offline']) {
      h.answer = { claimed: false, reason };
      const out = await claimChatFor('owner', 'p1', { threadId: 't1' });
      expect(out.status, reason).toBe(409);
      expect((out.body as { code: string }).code, reason).toBe(reason);
    }
    h.answer = { claimed: false, reason: 'something new' };
    expect((await claimChatFor('owner', 'p1', { threadId: 't1' })).body).toMatchObject({ code: 't3-offline' });
    expect(h.saved).toEqual([]);
  });

  it("asks nothing of a box that can't hold, a collaborator's claim, an ask's chat or a bad thread id", async () => {
    expect((await claimChatFor('owner', 'p1', { threadId: 'a b' })).status).toBe(400);
    expect((await claimChatFor('owner', 'p1', {})).status).toBe(400);
    h.caps = ['chat-runner-v1', 'chat-trust-v1'];
    expect(await claimChatFor('owner', 'p1', { threadId: 't1' })).toMatchObject({ status: 409, body: { code: 't3-unsupported' } });
    h.caps = ['chat-runner-v1', 'chat-trust-v1', 'chat-t3-hold-v1'];
    h.isOwner = false;
    expect(await claimChatFor('bob', 'p1', { threadId: 't1' })).toMatchObject({ status: 403, body: { code: 'not-owner' } });
    expect(claims()).toEqual([]);
  });
});

describe('chatOwnerRefusal', () => {
  it("lets the owner through, refuses a collaborator, and passes on a person with no access", async () => {
    expect(await chatOwnerRefusal('owner', 'p1', 'main')).toBeNull();
    h.isOwner = false;
    expect(await chatOwnerRefusal('bob', 'p1', undefined)).toEqual({ status: 403, body: { error: "Only the project's owner can continue this chat", code: 'not-owner' } });
    const { projectSessionAccess, SessionAccessError } = await import('../services/sessionAccess');
    vi.mocked(projectSessionAccess).mockRejectedValueOnce(new SessionAccessError('Project not found'));
    expect(await chatOwnerRefusal('eve', 'p1', 'main')).toEqual({ status: 403, body: { error: 'Project not found' } });
    expect(sendForProject).not.toHaveBeenCalled();
  });
});
