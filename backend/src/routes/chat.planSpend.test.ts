// chat-plan-spend-enabled: a send asks the box for
// its owner's Claude Enterprise monthly spend only when the project's owner
// sends with the flag on for them. Off, or a collaborator's send, and the
// chat-send RPC carries no planSpend, so the box never calls the endpoint.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  project: { findUnique: vi.fn(), update: vi.fn() },
  workflow: { update: vi.fn() },
  // chatLaunchFor reads whether the owner has the Claude gateway on.
  user: { findUnique: vi.fn(async () => ({ claudeGatewayEnabled: true })) },
}));
vi.mock('../db', () => ({ prisma }));
vi.mock('../services/agentRegistry', () => ({
  instanceAgentTransport: vi.fn(() => ({ capabilities: ['chat-runner-v1', 'chat-trust-v1'] })),
  isProjectAgentConnected: vi.fn(() => true),
  sendForProject: vi.fn(async (_host: unknown, type: string) => {
    if (type === 'tmux-foreground-cmd') return { cmd: 'bash', dead: false };
    return { queued: false, turnId: 't1' };
  }),
}));
const access = vi.hoisted(() => ({ isOwner: true }));
vi.mock('../services/sessionAccess', () => ({
  SessionAccessError: class extends Error { status = 403; },
  projectSessionAccess: vi.fn(async () => () => ({
    host: { userId: 'owner', instanceId: 'box1' }, isOwner: access.isOwner, session: 'owner_proj_agent',
    project: { ownerUsername: 'owner' },
  })),
}));
const flagsOn = vi.hoisted(() => ({ keys: new Set<string>() }));
vi.mock('../services/featureFlags', () => ({ boolVariation: vi.fn(async (key: string) => flagsOn.keys.has(key)) }));
vi.mock('../services/fireworksFlag', () => ({ fireworksModelsForBox: vi.fn(async () => null), fireworksOfferedTo: vi.fn(async () => null) }));
vi.mock('../services/automations/chatGate', () => ({ runChatRefusalFor: vi.fn(async () => null), RUN_CHAT_REFUSAL_TEXT: {} }));
vi.mock('../services/tmux', () => ({
  projectDirFor: vi.fn(() => '/home/owner/termag/projects/proj'),
  sessionName: vi.fn(() => 'owner_proj_agent'),
}));

import { chatReclaimFor, chatSendFor } from './chat';
import { sendForProject } from '../services/agentRegistry';
import { boolVariation } from '../services/featureFlags';
import { CHAT_PLAN_SPEND_FLAG } from '../services/chatRunner';

const sent = () => vi.mocked(sendForProject).mock.calls.filter(c => c[1] === 'chat-send').map(c => c[2] as Record<string, unknown>);
const planSpendReads = () => vi.mocked(boolVariation).mock.calls.filter(c => c[0] === CHAT_PLAN_SPEND_FLAG);
const sender = { id: 'owner', googleEmail: 'o@example.com', displayName: 'O', unixUsername: 'owner', defaultAgentProvider: 'claude' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  access.isOwner = true;
  flagsOn.keys = new Set();
  prisma.project.findUnique.mockResolvedValue({
    name: 'proj', userId: 'owner', setupStatus: 'ready', repoUrl: null, chatTrustedAt: null, chatOrchestrator: false,
    instance: { hostHome: '/home/owner', userId: 'owner' },
    workflows: [{ id: 'wf1', provider: 'claude-chat', backend: null, model: null, workstream: { id: 'ws1', name: 'main', askThread: null } }],
  });
  prisma.workflow.update.mockResolvedValue({});
});

describe('chat send and the monthly spend', () => {
  it("asks for it on the owner's send with the flag on for them", async () => {
    flagsOn.keys.add(CHAT_PLAN_SPEND_FLAG);
    expect((await chatSendFor('owner', 'p1', { workstream: 'main', text: 'hi' }, sender)).status).toBe(202);
    expect(sent()[0].planSpend).toBe(true);
    expect(planSpendReads()[0][1]).toBe(sender);
  });

  it('asks for nothing with the flag off', async () => {
    expect((await chatSendFor('owner', 'p1', { workstream: 'main', text: 'hi' }, sender)).status).toBe(202);
    expect(sent()[0]).not.toHaveProperty('planSpend');
    expect(planSpendReads()).toHaveLength(1);
  });

  it("never asks on a collaborator's send, whatever the flag says for them, and does not read it", async () => {
    access.isOwner = false;
    flagsOn.keys.add(CHAT_PLAN_SPEND_FLAG);
    expect((await chatSendFor('bob', 'p1', { workstream: 'main', text: 'hi' }, sender)).status).toBe(202);
    expect(sent()[0]).not.toHaveProperty('planSpend');
    expect(planSpendReads()).toHaveLength(0);
  });

  it('asks on the draft send of a reclaim the same way, and not for a reclaim with no draft', async () => {
    flagsOn.keys.add(CHAT_PLAN_SPEND_FLAG);
    await chatReclaimFor('owner', 'p1', { workstream: 'main', text: 'hi' }, sender);
    expect(sent()[0].planSpend).toBe(true);
    vi.clearAllMocks();
    await chatReclaimFor('owner', 'p1', { workstream: 'main' }, sender);
    expect(sent()).toHaveLength(0);
    expect(planSpendReads()).toHaveLength(0);
    flagsOn.keys.clear();
    await chatReclaimFor('owner', 'p1', { workstream: 'main', text: 'hi' }, sender);
    expect(sent()[0]).not.toHaveProperty('planSpend');
  });
});
