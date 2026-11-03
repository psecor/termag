// A simple-UI chat's effort (services/chatEffort.ts): carried on chat-send
// with the sender's chat-effort-enabled, to a runner with chat-effort-v1, for a
// chat on Claude's own models; dropped, never refused, anywhere else.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const KIMI = 'accounts/fireworks/models/kimi-k3';
const FAST = 'accounts/fireworks/models/glm-5';
const FW = { defaultModel: KIMI, fastModel: FAST, models: [{ id: KIMI, label: 'Kimi K3', context: 262144 }, { id: FAST, label: 'GLM 5', context: 131072 }] };
const ALL_CAPS = ['chat-runner-v1', 'chat-trust-v1', 'chat-backend-v1', 'fireworks-v1', 'chat-effort-v1'];

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
const ld = vi.hoisted(() => ({ on: new Set<string>() }));
vi.mock('../services/featureFlags', () => ({ boolVariation: vi.fn(async (key: string) => ld.on.has(key)) }));
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

import { chatHistoryFor, chatReclaimFor, chatSendFor } from './chat';
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
  ld.on = new Set(['chat-effort-enabled']);
  prisma.workflow.update.mockResolvedValue({});
  storedOn(null, 'opus');
});

describe('chat effort', () => {
  it('carries a chosen effort to the box with the flag on and a runner that takes it', async () => {
    expect((await chatSendFor('owner', 'p1', { workstream: 'main', text: 'hi', effort: 'high' }, viewer)).status).toBe(202);
    expect(sent('chat-send')[0]).toMatchObject({ effort: 'high', model: 'opus' });
  });

  it('drops an unknown effort and Default, and still sends', async () => {
    expect((await chatSendFor('owner', 'p1', { workstream: 'main', text: 'hi', effort: 'eleven' }, viewer)).status).toBe(202);
    expect((await chatSendFor('owner', 'p1', { workstream: 'main', text: 'hi' }, viewer)).status).toBe(202);
    for (const payload of sent('chat-send')) expect(payload).not.toHaveProperty('effort');
  });

  it('drops it with the flag off, on a runner without chat-effort-v1, and on Fireworks', async () => {
    ld.on = new Set();
    expect((await chatSendFor('owner', 'p1', { workstream: 'main', text: 'off', effort: 'max' }, viewer)).status).toBe(202);
    ld.on = new Set(['chat-effort-enabled']);
    caps.list = ALL_CAPS.filter(c => c !== 'chat-effort-v1');
    expect((await chatSendFor('owner', 'p1', { workstream: 'main', text: 'old', effort: 'max' }, viewer)).status).toBe(202);
    caps.list = ALL_CAPS;
    expect((await chatSendFor('owner', 'p1', { workstream: 'main', text: 'fw', effort: 'max', backend: 'fireworks', model: KIMI }, viewer)).status).toBe(202);
    for (const payload of sent('chat-send')) expect(payload).not.toHaveProperty('effort');
  });

  it("tells the composer whether this chat offers an effort", async () => {
    const body = async () => (await chatHistoryFor('owner', 'p1', { workstream: 'main' }, viewer)).body as Record<string, unknown>;
    expect((await body()).effortInput).toBe(true);
    ld.on = new Set();
    expect((await body()).effortInput).toBe(false);
    ld.on = new Set(['chat-effort-enabled']);
    caps.list = ALL_CAPS.filter(c => c !== 'chat-effort-v1');
    expect((await body()).effortInput).toBe(false);
    caps.list = ALL_CAPS;
    storedOn('fireworks', KIMI);
    expect((await body()).effortInput).toBe(false);
  });

  it('carries it on a reclaim that sends a draft', async () => {
    await chatReclaimFor('owner', 'p1', { workstream: 'main', text: 'back', effort: 'low' }, viewer);
    expect(sent('chat-send')[0]).toMatchObject({ effort: 'low' });
  });
});
