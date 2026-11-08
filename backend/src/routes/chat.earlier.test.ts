// Older history: GET …/chat/earlier?before=<uuid> asks the chat's box
// (chat-history-before, agent chat-history-pages-v1) for the page before
// that entry, for anyone who may read the chat.
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

import { chatHistoryBeforeFor } from './chat';
import { sendForProject } from '../services/agentRegistry';

const read = (before: unknown = 'q150', cursor?: unknown) => chatHistoryBeforeFor('collab', 'p1', { workstream: 'main', before, ...(cursor === undefined ? {} : { cursor }) } as never);

beforeEach(() => {
  vi.clearAllMocks();
  caps.list = ['chat-runner-v1', 'chat-history-pages-v1'];
  access.denied = false;
  box.error = null;
  box.answer = { entries: [{ type: 'user', uuid: 'q100', message: { role: 'user', content: 'question 100' } }], done: false };
  prisma.project.findUnique.mockResolvedValue({
    name: 'proj', userId: 'owner', setupStatus: 'ready', repoUrl: null, chatTrustedAt: null, chatOrchestrator: false,
    instance: { hostHome: '/home/owner', userId: 'owner' },
    workflows: [{ id: 'wf1', provider: 'claude-chat', backend: null, model: null, workstream: { id: 'ws1', name: 'main', askThread: null } }],
  });
});

describe('GET …/chat/earlier', () => {
  it('asks the chat\'s box for the page before the entry and hands it on', async () => {
    expect(await read()).toEqual({ status: 200, body: { entries: [{ type: 'user', uuid: 'q100', message: { role: 'user', content: 'question 100' } }], done: false } });
    expect(vi.mocked(sendForProject).mock.calls[0][1]).toBe('chat-history-before');
    expect(vi.mocked(sendForProject).mock.calls[0][2]).toEqual({ chatKey: expect.any(String), before: 'q150' });
  });

  it('hands the box the page\'s cursor and the box\'s next one back, dropping any not well formed', async () => {
    box.answer = { entries: [], done: false, cursor: 'sess-1:4096' };
    expect((await read('q150', 'sess-1:8192')).body).toEqual({ entries: [], done: false, cursor: 'sess-1:4096' });
    expect(vi.mocked(sendForProject).mock.calls[0][2]).toEqual({ chatKey: expect.any(String), before: 'q150', cursor: 'sess-1:8192' });
    box.answer = { entries: [], done: false, cursor: '../x:1' };
    expect((await read('q150', '../etc:1')).body).toEqual({ entries: [], done: false });
    expect(vi.mocked(sendForProject).mock.calls[1][2]).toEqual({ chatKey: expect.any(String), before: 'q150' });
  });

  it('says done unless the box says there is more', async () => {
    box.answer = { entries: [] };
    expect(await read()).toEqual({ status: 200, body: { entries: [], done: true } });
  });

  it('refuses a before that is not a uuid, before asking anyone', async () => {
    for (const bad of ['../x', 'a/b', '', 'x'.repeat(81), 7, null]) {
      expect((await read(bad)).status).toBe(400);
    }
    expect(sendForProject).not.toHaveBeenCalled();
  });

  it('keeps to who may read the chat', async () => {
    access.denied = true;
    expect((await read()).status).toBe(403);
    expect(sendForProject).not.toHaveBeenCalled();
  });

  it('says an older agent needs an update, and a box that went away is away', async () => {
    caps.list = ['chat-runner-v1'];
    expect(await read()).toMatchObject({ status: 409, body: { code: 'runner-update' } });
    expect(sendForProject).not.toHaveBeenCalled();
    caps.list = ['chat-runner-v1', 'chat-history-pages-v1'];
    box.error = new Error('Agent not connected');
    expect(await read()).toMatchObject({ status: 503, body: { code: 'box-away' } });
  });
});
