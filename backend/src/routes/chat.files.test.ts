// A file for a chat message that the box keeps (services/chatFiles.ts):
// POST …/chat/files sends it to the chat's box (chat-file-put, agent
// chat-files-v1) with the sender's chat-file-attachments-enabled on, for
// anyone who may send the chat a message, and answers the path it was kept at.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({ project: { findUnique: vi.fn() } }));
vi.mock('../db', () => ({ prisma }));
const caps = vi.hoisted(() => ({ list: [] as string[], connected: true }));
const box = vi.hoisted(() => ({ answer: null as unknown, error: null as Error | null }));
vi.mock('../services/agentRegistry', () => ({
  instanceAgentTransport: vi.fn(() => ({ capabilities: caps.list })),
  isProjectAgentConnected: vi.fn(() => caps.connected),
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

import { chatFilePutFor } from './chat';
import { sendForProject } from '../services/agentRegistry';

const viewer = { id: 'collab', googleEmail: 'c@example.com', displayName: 'C', unixUsername: 'collab', defaultAgentProvider: 'claude' } as never;
const zip = Buffer.from('PK\u0003\u0004zip-body');
const put = (body: unknown = zip, name: unknown = 'data set.zip', type = 'application/octet-stream') =>
  chatFilePutFor('collab', 'p1', { workstream: 'main', name } as never, body, type, viewer);
const kept = { path: '.termag-attachments/0123456789abcdef/data-set.zip', name: 'data-set.zip', size: zip.length };

beforeEach(() => {
  vi.clearAllMocks();
  caps.list = ['chat-runner-v1', 'chat-files-v1'];
  caps.connected = true;
  ld.on = new Set(['chat-file-attachments-enabled']);
  access.denied = false;
  box.error = null;
  box.answer = kept;
  prisma.project.findUnique.mockResolvedValue({
    name: 'proj', userId: 'owner', setupStatus: 'ready', repoUrl: null, chatTrustedAt: null, chatOrchestrator: false,
    instance: { hostHome: '/home/owner', userId: 'owner' },
    workflows: [{ id: 'wf1', provider: 'claude-chat', backend: null, model: null, workstream: { id: 'ws1', name: 'main', askThread: null } }],
  });
});

describe('POST …/chat/files', () => {
  it('sends the file to the chat\'s checkout on its box and answers where it was kept', async () => {
    expect(await put()).toEqual({ status: 200, body: kept });
    const [host, command, payload, timeout] = vi.mocked(sendForProject).mock.calls[0];
    expect(host).toEqual({ userId: 'owner', instanceId: 'box1' });
    expect(command).toBe('chat-file-put');
    expect(payload).toEqual({ cwd: '/home/owner/termag/projects/proj', name: 'data set.zip', data: zip.toString('base64') });
    expect(timeout).toBe(60_000);
  });

  it('is not there with the flag off, and sends nothing', async () => {
    ld.on = new Set();
    expect(await put()).toEqual({ status: 404, body: { error: 'Not found', code: 'files-off' } });
    expect(sendForProject).not.toHaveBeenCalled();
  });

  it('takes only a raw octet-stream body of up to 20 MB, with a name', async () => {
    expect((await put(zip, 'a.zip', 'text/plain')).status).toBe(415);
    expect((await put({}, 'a.zip')).status).toBe(415);
    expect(await put(Buffer.alloc(0))).toMatchObject({ status: 400, body: { error: 'The file is empty' } });
    expect(await put(Buffer.alloc(20_000_001))).toMatchObject({ status: 413, body: { code: 'file-too-large' } });
    expect(await put(zip, '')).toMatchObject({ status: 400, body: { error: 'name is required' } });
    expect(sendForProject).not.toHaveBeenCalled();
  });

  it('keeps to who may send the chat a message', async () => {
    access.denied = true;
    expect((await put()).status).toBe(403);
    expect(sendForProject).not.toHaveBeenCalled();
  });

  it('says an older agent needs an update, and a box that is down is offline, for the composer to wake it', async () => {
    caps.list = ['chat-runner-v1'];
    expect(await put()).toMatchObject({ status: 409, body: { code: 'files-unsupported', error: expect.stringContaining('needs an update and a restart') } });
    caps.list = ['chat-runner-v1', 'chat-files-v1'];
    caps.connected = false;
    expect(await put()).toMatchObject({ status: 503, body: { code: 'offline' } });
    expect(sendForProject).not.toHaveBeenCalled();
  });

  it('refuses an ask\'s thread, whose turns run in a clone of their own', async () => {
    prisma.project.findUnique.mockResolvedValue({
      name: 'proj', userId: 'owner', setupStatus: 'ready', repoUrl: null, chatTrustedAt: null, chatOrchestrator: false, environmentId: null,
      instance: { hostHome: '/home/owner', userId: 'owner', name: 'box' },
      workflows: [{ id: 'wf1', provider: 'claude-chat', backend: null, model: null, workstream: { id: 'ws1', name: 'main', askThread: {
        id: 't1', workstream: 'main', repoName: 'repo', baseSha: null, targetPr: null, targetBranch: null,
        originUser: { displayName: 'O', unixUsername: 'owner', googleEmail: 'o@example.com' }, parentProjectId: null, parentWorkstream: null, parentClaudeSession: null,
      } } }],
    });
    expect(await put()).toMatchObject({ status: 409, body: { code: 'files-unsupported', error: "Files can't be attached in an ask's thread yet" } });
    expect(sendForProject).not.toHaveBeenCalled();
  });

  it('passes on what the box refused, and never a path the box should not have answered', async () => {
    box.error = new Error('file-refused: .termag-attachments in the checkout is not a folder');
    expect(await put()).toEqual({ status: 400, body: { error: '.termag-attachments in the checkout is not a folder', code: 'file-refused' } });
    box.error = new Error('Unknown command: chat-file-put');
    expect(await put()).toMatchObject({ status: 409, body: { code: 'files-unsupported' } });
    box.error = null;
    for (const path of ['/etc/passwd', '.termag-attachments/../../x', 'elsewhere/0123456789abcdef/a.zip']) {
      box.answer = { ...kept, path };
      expect(await put()).toMatchObject({ status: 502, body: { code: 'file-failed' } });
    }
  });
});
