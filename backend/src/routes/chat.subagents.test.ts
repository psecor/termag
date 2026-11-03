// A subagent's own transcript: GET
// …/chat/subagents/:agentId asks the chat's box (chat-subagent-read, agent
// chat-subagents-v1) with the reader's chat-subagents-enabled on, for anyone
// who may read the chat.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({ project: { findUnique: vi.fn() } }));
vi.mock('../db', () => ({ prisma }));
const caps = vi.hoisted(() => ({ list: [] as string[] }));
const box = vi.hoisted(() => ({ answer: null as unknown, error: null as Error | null }));
vi.mock('../services/agentRegistry', () => ({
  instanceAgentTransport: vi.fn(() => ({ capabilities: caps.list })),
  isProjectAgentConnected: vi.fn(() => true),
  sendForProject: vi.fn(async () => {
    if (box.error) throw box.error;
    return box.answer;
  }),
}));
const access = vi.hoisted(() => ({ denied: false }));
vi.mock('../services/sessionAccess', () => {
  class SessionAccessError extends Error { status = 403; }
  return {
    SessionAccessError,
    projectSessionAccess: vi.fn(async () => {
      if (access.denied) throw new SessionAccessError('No access to this project');
      return () => ({ host: { userId: 'owner', instanceId: 'box1' }, isOwner: false, session: 'owner_proj_agent', project: { ownerUsername: 'owner' } });
    }),
  };
});
const ld = vi.hoisted(() => ({ on: new Set<string>() }));
vi.mock('../services/featureFlags', () => ({ boolVariation: vi.fn(async (key: string) => ld.on.has(key)) }));
vi.mock('../services/tmux', () => ({
  projectDirFor: vi.fn(() => '/home/owner/termag/projects/proj'),
  sessionName: vi.fn(() => 'owner_proj_agent'),
}));

import { chatSubagentFor } from './chat';
import { sendForProject } from '../services/agentRegistry';

const viewer = { id: 'collab', googleEmail: 'c@example.com', displayName: 'C', unixUsername: 'collab', defaultAgentProvider: 'claude' } as never;
const read = (agentId: unknown = 'aacba55454ef877bf') => chatSubagentFor('collab', 'p1', agentId, { workstream: 'main' }, viewer);

beforeEach(() => {
  vi.clearAllMocks();
  caps.list = ['chat-runner-v1', 'chat-subagents-v1'];
  ld.on = new Set(['chat-subagents-enabled']);
  access.denied = false;
  box.error = null;
  box.answer = { found: true, sessionId: 's1', entries: [{ type: 'user', message: { role: 'user', content: 'Run the tests.' } }], meta: { agentType: 'general-purpose', finished: true } };
  prisma.project.findUnique.mockResolvedValue({
    name: 'proj', userId: 'owner', setupStatus: 'ready', repoUrl: null, chatTrustedAt: null, chatOrchestrator: false,
    instance: { hostHome: '/home/owner', userId: 'owner' },
    workflows: [{ id: 'wf1', provider: 'claude-chat', backend: null, model: null, workstream: { id: 'ws1', name: 'main', askThread: null } }],
  });
});

describe('GET …/chat/subagents/:agentId', () => {
  it('asks the chat\'s box for the subagent\'s transcript and hands its entries on', async () => {
    const r = await read();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ agentId: 'aacba55454ef877bf', entries: [{ type: 'user', message: { role: 'user', content: 'Run the tests.' } }], meta: { agentType: 'general-purpose', finished: true } });
    expect(vi.mocked(sendForProject).mock.calls[0][1]).toBe('chat-subagent-read');
    expect(vi.mocked(sendForProject).mock.calls[0][2]).toEqual({ chatKey: expect.any(String), agentId: 'aacba55454ef877bf' });
  });

  it('is not there with the flag off, and asks nothing', async () => {
    ld.on = new Set();
    expect(await read()).toEqual({ status: 404, body: { error: 'Not found', code: 'subagents-off' } });
    expect(sendForProject).not.toHaveBeenCalled();
  });

  it('refuses an id that is not a name, before asking anyone', async () => {
    for (const bad of ['../x', 'a/b', '', 'x'.repeat(65), 7]) {
      expect((await read(bad)).status).toBe(400);
    }
    expect(sendForProject).not.toHaveBeenCalled();
  });

  it('keeps to who may read the chat', async () => {
    access.denied = true;
    expect((await read()).status).toBe(403);
    expect(sendForProject).not.toHaveBeenCalled();
  });

  it('says an older agent needs an update, a box that went away is away, and a missing transcript is missing', async () => {
    caps.list = ['chat-runner-v1'];
    expect(await read()).toMatchObject({ status: 409, body: { code: 'runner-update' } });
    // No runner at all is chatTarget's own answer.
    caps.list = [];
    expect(await read()).toMatchObject({ status: 409, body: { code: 'runner-missing' } });
    caps.list = ['chat-runner-v1', 'chat-subagents-v1'];
    box.error = new Error('Agent not connected');
    expect(await read()).toMatchObject({ status: 503, body: { code: 'box-away' } });
    box.error = null;
    box.answer = { found: false, entries: [] };
    expect(await read()).toMatchObject({ status: 404, body: { code: 'subagent-missing' } });
  });
});
