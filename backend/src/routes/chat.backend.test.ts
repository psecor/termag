// A simple-UI chat's backend and model: kept on its
// workstream's agent row, carried on chat-send and chat-resume-claim, and
// refused where the box or the flags cannot run it.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const KIMI = 'accounts/fireworks/models/kimi-k3';
const FAST = 'accounts/fireworks/models/glm-5';
const FW = { defaultModel: KIMI, fastModel: FAST, models: [{ id: KIMI, label: 'Kimi K3', context: 262144 }, { id: FAST, label: 'GLM 5', context: 131072 }] };
const ALL_CAPS = ['chat-runner-v1', 'chat-trust-v1', 'chat-backend-v1', 'fireworks-v1'];

const prisma = vi.hoisted(() => ({
  project: { findUnique: vi.fn(), update: vi.fn() },
  workflow: { update: vi.fn() },
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
const flags = vi.hoisted(() => ({ box: null as unknown, viewer: null as unknown }));
vi.mock('../services/fireworksFlag', () => ({
  fireworksModelsForBox: vi.fn(async () => flags.box),
  fireworksOfferedTo: vi.fn(async () => flags.viewer),
}));
vi.mock('../services/automations/chatGate', () => ({ runChatRefusalFor: vi.fn(async () => null), RUN_CHAT_REFUSAL_TEXT: {} }));
vi.mock('../services/tmux', () => ({
  projectDirFor: vi.fn(() => '/home/owner/termag/projects/proj'),
  sessionName: vi.fn(() => 'owner_proj_agent'),
}));

import { chatHistoryFor, chatSendFor, chatTerminalFor } from './chat';
import { sendForProject } from '../services/agentRegistry';

function storedOn(backend: string | null, model: string | null) {
  prisma.project.findUnique.mockResolvedValue({
    name: 'proj', userId: 'owner', setupStatus: 'ready', repoUrl: null, chatTrustedAt: null, chatOrchestrator: false,
    instance: { hostHome: '/home/owner', userId: 'owner' },
    workflows: [{ id: 'wf1', provider: 'claude-chat', backend, model, workstream: { id: 'ws1', name: 'main', askThread: null } }],
  });
}

const sent = (type: string) => vi.mocked(sendForProject).mock.calls.filter(c => c[1] === type).map(c => c[2] as Record<string, unknown>);
const viewer = { id: 'owner', googleEmail: 'o@example.com', displayName: 'O', unixUsername: 'owner', defaultAgentProvider: 'claude' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  caps.list = ALL_CAPS;
  flags.box = FW;
  flags.viewer = FW;
  prisma.workflow.update.mockResolvedValue({});
});

describe('chat send on a model backend', () => {
  it("switches onto one of the sender's Fireworks models, carries it to the box, and keeps it on the workstream's row", async () => {
    storedOn(null, 'sonnet');
    const r = await chatSendFor('owner', 'p1', { workstream: 'main', text: 'hi', backend: 'fireworks', model: KIMI }, viewer);
    expect(r.status).toBe(202);
    // The smaller window of the model and Claude Code's fast model, as a pane launch takes.
    expect(sent('chat-send')[0]).toMatchObject({ model: KIMI, backend: 'fireworks', fastModel: FAST, context: 131072 });
    expect(prisma.workflow.update).toHaveBeenCalledWith({ where: { id: 'wf1' }, data: { backend: 'fireworks', model: KIMI } });
    expect(prisma.project.update).not.toHaveBeenCalled();
  });

  it('keeps a stored Fireworks choice for a send that names none, and writes nothing', async () => {
    storedOn('fireworks', KIMI);
    expect((await chatSendFor('owner', 'p1', { workstream: 'main', text: 'hi' }, viewer)).status).toBe(202);
    expect(sent('chat-send')[0]).toMatchObject({ model: KIMI, backend: 'fireworks' });
    expect(prisma.workflow.update).not.toHaveBeenCalled();
  });

  it('refuses on a box whose runner cannot start another backend, rather than running the model on the default', async () => {
    storedOn('fireworks', KIMI);
    caps.list = ['chat-runner-v1', 'chat-trust-v1', 'fireworks-v1'];
    const r = await chatSendFor('owner', 'p1', { workstream: 'main', text: 'hi' }, viewer);
    expect(r).toMatchObject({ status: 409, body: { code: 'runner-outdated' } });
    expect(sent('chat-send')).toHaveLength(0);
  });

  it("refuses while Fireworks is off for the owner and box, until a message switches back to a Claude model", async () => {
    storedOn('fireworks', KIMI);
    flags.box = null;
    expect(await chatSendFor('owner', 'p1', { workstream: 'main', text: 'hi' }, viewer)).toMatchObject({ status: 403, body: { code: 'backend-off' } });
    expect(sent('chat-send')).toHaveLength(0);
    const back = await chatSendFor('owner', 'p1', { workstream: 'main', text: 'hi', model: 'sonnet' }, viewer);
    expect(back.status).toBe(202);
    expect(sent('chat-send')[0]).toMatchObject({ model: 'sonnet' });
    expect(sent('chat-send')[0]).not.toHaveProperty('backend');
    expect(prisma.workflow.update).toHaveBeenCalledWith({ where: { id: 'wf1' }, data: { backend: null, model: 'sonnet' } });
  });

  it("refuses a model that is not on the sender's list", async () => {
    storedOn(null, null);
    const r = await chatSendFor('owner', 'p1', { workstream: 'main', text: 'hi', backend: 'fireworks', model: 'accounts/fireworks/models/other' }, viewer);
    expect(r.status).toBe(400);
    expect(sent('chat-send')).toHaveLength(0);
  });
});

describe('chat history and Open in full UI on a model backend', () => {
  it('reports the backend with the model', async () => {
    storedOn('fireworks', KIMI);
    expect((await chatHistoryFor('owner', 'p1', { workstream: 'main' }, viewer)).body).toMatchObject({ model: KIMI, backend: 'fireworks' });
    storedOn(null, null);
    const body = (await chatHistoryFor('owner', 'p1', { workstream: 'main' }, viewer)).body as Record<string, unknown>;
    expect(body.model).toBe('sonnet');
    expect(body).not.toHaveProperty('backend');
  });

  it("reports a Fireworks chat with no stored model as the default it runs on, and as Fireworks when that can't be read", async () => {
    storedOn('fireworks', null);
    expect((await chatHistoryFor('owner', 'p1', { workstream: 'main' }, viewer)).body).toMatchObject({ model: KIMI, backend: 'fireworks' });
    flags.box = null;
    expect((await chatHistoryFor('owner', 'p1', { workstream: 'main' }, viewer)).body).toMatchObject({ model: null, backend: 'fireworks' });
  });

  it('claims the resume on the backend, so the pane continues there', async () => {
    storedOn('fireworks', KIMI);
    await chatTerminalFor('owner', 'p1', { workstream: 'main' });
    expect(sent('chat-resume-claim')[0]).toMatchObject({ backend: 'fireworks', model: KIMI, fastModel: FAST });
  });

  it('refuses Open in full UI where the backend cannot run, instead of resuming on the default', async () => {
    storedOn('fireworks', KIMI);
    flags.box = null;
    expect(await chatTerminalFor('owner', 'p1', { workstream: 'main' })).toMatchObject({ status: 403 });
    expect(sent('chat-resume-claim')).toHaveLength(0);
  });

  it('claims a default-backend resume as before, with no model', async () => {
    storedOn(null, 'sonnet');
    await chatTerminalFor('owner', 'p1', { workstream: 'main' });
    expect(sent('chat-resume-claim')[0]).not.toHaveProperty('model');
    expect(sent('chat-resume-claim')[0]).not.toHaveProperty('backend');
  });
});
