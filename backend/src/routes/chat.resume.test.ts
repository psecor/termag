// A chat's box notices on chat-send: with
// chat-resume-new-box-enabled on for the owner, every send lets the runner
// tell a restart; the first send on a new box restores the stored session
// first and carries the new-box notice, once. Flag off: the send is as before.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ALL_CAPS = ['chat-runner-v1', 'chat-trust-v1', 'chat-box-notice-v1', 'chat-restore-v1'];
const SESSION = '5109190e-c0d2-4f72-9c15-3c4c57fb126c';

const h = vi.hoisted(() => ({
  resume: null as null | Record<string, unknown>,
  restored: [] as string[],
  noticed: [] as string[],
  connected: true,
  facts: null as null | Record<string, unknown>,
  held: [] as Array<{ id: string; text: string; error: null }>,
  continues: [] as unknown[],
  starts: [] as string[],
}));
const quiet = { flagOn: true, isOwner: true, ownerName: 'O', excluded: false, box: { id: 'box-new', status: 'ready', kind: 'ec2' }, setupReady: true, connected: true, complete: true, lockHeld: false, credentialsPending: false, pendingResume: null, hasHeld: false };
const prisma = vi.hoisted(() => ({
  project: { findUnique: vi.fn(), update: vi.fn() },
  workflow: { update: vi.fn() },
  workstream: { findUnique: vi.fn(async () => ({ name: 'main' })) },
  chatResume: { findFirst: vi.fn(async () => null) },
  user: { findUnique: vi.fn(async () => ({ id: 'owner', googleEmail: 'o@example.com', displayName: 'O', unixUsername: 'owner', defaultAgentProvider: null })) },
}));
vi.mock('../db', () => ({ prisma }));
vi.mock('../services/agentRegistry', () => ({
  instanceAgentTransport: vi.fn(() => ({ capabilities: ALL_CAPS, helloReceived: true })),
  isProjectAgentConnected: vi.fn(() => h.connected),
  onBoxAgentHello: vi.fn(() => () => {}),
  sendToInstanceAgent: vi.fn(),
  sendForProject: vi.fn(async (_host: unknown, type: string) => {
    if (type === 'tmux-foreground-cmd') return { cmd: 'bash', dead: false };
    if (type === 'chat-history') return { running: false, sessionId: SESSION, entries: [] };
    return { queued: false, turnId: 't1' };
  }),
}));
vi.mock('../services/sessionAccess', () => ({
  SessionAccessError: class extends Error { status = 403; },
  projectSessionAccess: vi.fn(async () => () => ({
    host: { userId: 'owner', instanceId: 'box-new' }, isOwner: true, session: 'owner_proj_agent',
    project: { ownerUsername: 'owner' },
  })),
}));
const ld = vi.hoisted(() => ({ on: new Set<string>() }));
vi.mock('../services/featureFlags', () => ({ boolVariation: vi.fn(async (key: string) => ld.on.has(key)) }));
vi.mock('../services/automations/chatGate', () => ({ runChatRefusalFor: vi.fn(async () => null), RUN_CHAT_REFUSAL_TEXT: {} }));
vi.mock('../services/tmux', () => ({
  projectDirFor: vi.fn(() => '/home/owner/termag/projects/proj'),
  sessionName: vi.fn(() => 'owner_proj_agent'),
}));
vi.mock('../services/chatTranscriptStore', () => ({
  getTranscriptStoreConfig: () => ({ materials: null, rawCap: 64 << 20 }),
  readStoredView: vi.fn(async () => ({ sessionId: SESSION, entries: [{ type: 'user', message: { role: 'user', content: 'from the store' } }] })),
  storedRawOf: vi.fn(async () => null),
}));
const restoreFails = vi.hoisted(() => ({ on: false }));
vi.mock('../services/chatNewBox', async (orig) => {
  const real = await orig<typeof import('../services/chatNewBox')>();
  return {
    ...real,
    pendingResumeFor: vi.fn(async () => h.resume),
    continueUnderWay: vi.fn(async () => false),
    ensureRestored: vi.fn(async (r: { id: string }) => {
      h.restored.push(r.id);
      if (restoreFails.on) throw new Error("the new box's agent is not connected yet");
    }),
    markNoticeSent: vi.fn(async (id: string) => { h.noticed.push(id); h.resume = null; }),
    continuationFacts: vi.fn(async () => ({ ...quiet, ...(h.facts ?? {}), hasHeld: h.held.length > 0 })),
    // The real one is behind the database lock (chatNewBox.test.ts): the first starts the box, the rest are told it is under way.
    continueOnNewBoxFor: vi.fn(async () => {
      h.continues.push(1);
      return h.continues.length === 1 ? { status: 202, body: { instanceId: 'box-new' } } : { status: 409, body: { code: 'continuing', error: 'already' } };
    }),
  };
});
vi.mock('../services/chatHeld', () => ({
  heldFor: vi.fn(async () => h.held),
  holdMessage: vi.fn(async (_k: unknown, b: { text: string }) => { h.held.push({ id: `m${h.held.length + 1}`, text: b.text, error: null }); return { id: `m${h.held.length}`, position: h.held.length }; }),
  kickHeldDelivery: vi.fn(),
}));
vi.mock('./instances', () => ({ powerOwnedBox: vi.fn(async (_u: unknown, id: string) => { h.starts.push(id); return { status: 202, body: { ok: true, status: 'starting' } }; }) }));

import { chatHistoryFor, chatReclaimFor, chatSendFor, deliverHeldMessage } from './chat';
import { sendForProject } from '../services/agentRegistry';
import { NEW_BOX_NOTICE } from '../services/chatNewBox';

const viewer = { id: 'owner', googleEmail: 'o@example.com', displayName: 'O', unixUsername: 'owner', defaultAgentProvider: 'claude' } as never;
const sent = (type: string) => vi.mocked(sendForProject).mock.calls.filter(c => c[1] === type).map(c => c[2] as Record<string, unknown>);
const sendHi = async () => (await chatSendFor('owner', 'p1', { workstream: 'main', text: 'hi' }, viewer)).status;

beforeEach(() => {
  vi.clearAllMocks();
  h.restored = []; h.noticed = [];
  h.resume = null;
  restoreFails.on = false;
  h.connected = true; h.facts = null; h.held = []; h.continues = []; h.starts = [];
  ld.on = new Set(['chat-resume-new-box-enabled', 'chat-transcripts-enabled']);
  prisma.project.findUnique.mockResolvedValue({
    name: 'proj', userId: 'owner', instanceId: 'box-new', setupStatus: 'ready', repoUrl: null, chatTrustedAt: null, chatOrchestrator: false,
    instance: { hostHome: '/home/owner', userId: 'owner' },
    workflows: [{ id: 'wf1', provider: 'claude-chat', backend: null, model: 'opus', workstream: { id: 'ws1', name: 'main', askThread: null } }],
  });
});

describe('box notices on chat-send', () => {
  it('lets the runner tell a restart, with no notice of its own when there is no resume', async () => {
    expect(await sendHi()).toBe(202);
    expect(sent('chat-send')[0]).toMatchObject({ text: 'hi', boxNotices: true });
    expect(sent('chat-send')[0]).not.toHaveProperty('notice');
  });

  it('restores first on a new box, sends the notice with the last git state once, then never again', async () => {
    h.resume = { id: 'r1', projectId: 'p1', workstreamId: 'ws1', sessionId: SESSION, toInstanceId: 'box-new', restoredAt: null,
      gitState: { branch: 'X', head: 'abc1234def5678901234567890abcdef12345678', upstream: 'origin/X', pushed: true, unpushed: 0, uncommitted: 2, untracked: 0, pr: null, at: '2026-10-27T12:00:00.000Z' } };
    expect(await sendHi()).toBe(202);
    expect(h.restored).toEqual(['r1']);
    const first = sent('chat-send')[0];
    expect(first.text).toBe('hi');
    expect(String(first.notice)).toContain(NEW_BOX_NOTICE);
    expect(String(first.notice)).toContain('Last state on the old box: HEAD at abc1234 on a branch, pushed to its upstream, 2 uncommitted files lost.');
    // Accepted is not started: the notice stays owed until Claude starts the turn that carries it.
    expect(h.noticed).toEqual([]);
    expect(await sendHi()).toBe(202);
    expect(String(sent('chat-send')[1].notice)).toContain(NEW_BOX_NOTICE);
    h.resume = null; // Claude started it (chatNewBox.ts noteNoticeTold, on the turn's init event).
    expect(await sendHi()).toBe(202);
    expect(sent('chat-send')[2]).not.toHaveProperty('notice');
  });

  it('a held message refused while the new box\'s checkout is still coming is tried again, not dropped', async () => {
    const usual = vi.mocked(sendForProject).getMockImplementation()!;
    vi.mocked(sendForProject).mockImplementation(async (_host: unknown, type: string) => {
      if (type === 'tmux-foreground-cmd') return { cmd: 'bash', dead: false };
      if (type === 'chat-send') throw new Error('checkout-pending: the repository is still being checked out');
      return { running: false, sessionId: SESSION, entries: [] };
    });
    const m = { id: 'm1', projectId: 'p1', workstreamId: 'ws1', senderId: 'owner', text: 'pick up where we left off', model: null, backend: null, effort: null, error: null };
    try {
      expect(await deliverHeldMessage(m)).toEqual({ kind: 'not-ready' });
    } finally {
      vi.mocked(sendForProject).mockImplementation(usual);
    }
  });

  it('a reclaim that sends a draft on the new box restores first and carries the notice, so it never starts a fresh session', async () => {
    h.resume = { id: 'r1', projectId: 'p1', workstreamId: 'ws1', sessionId: SESSION, toInstanceId: 'box-new', restoredAt: null, gitState: null };
    const r = await chatReclaimFor('owner', 'p1', { workstream: 'main', text: 'back to the chat' }, viewer);
    expect(r.status).toBeLessThan(400);
    expect(h.restored).toEqual(['r1']);
    const send = sent('chat-send')[0];
    expect(send).toMatchObject({ text: 'back to the chat' });
    expect(String(send.notice)).toContain(NEW_BOX_NOTICE);
  });

  it('a reclaim whose draft is held still exits the pane\'s Claude first, and answers reclaimed', async () => {
    h.held = [{ id: 'm0', text: 'an earlier one', error: null }];
    const usual = vi.mocked(sendForProject).getMockImplementation()!;
    let probes = 0;
    vi.mocked(sendForProject).mockImplementation(async (host: unknown, type: string, payload?: unknown) => {
      // Claude holds the pane until /exit is typed; a shell after.
      if (type === 'tmux-foreground-cmd') return { cmd: ++probes <= 2 ? 'claude' : 'bash', dead: false };
      if (type === 'tmux-send-keys' || type === 'chat-note-pane') return {};
      return usual(host as never, type, payload as never);
    });
    try {
      const r = await chatReclaimFor('owner', 'p1', { workstream: 'main', text: 'back to the chat' }, viewer);
      expect(sent('tmux-send-keys')).toHaveLength(1);
      expect(r).toMatchObject({ status: 202, body: { reclaimed: true, held: true, queued: true } });
      expect(h.held.map(m => m.text)).toEqual(['an earlier one', 'back to the chat']);
      expect(sent('chat-send')).toEqual([]);
    } finally {
      vi.mocked(sendForProject).mockImplementation(usual);
    }
  });

  it('a reclaim\'s draft whose restore can\'t go through yet is not sent', async () => {
    h.resume = { id: 'r1', projectId: 'p1', workstreamId: 'ws1', sessionId: SESSION, toInstanceId: 'box-new', restoredAt: null, gitState: null };
    restoreFails.on = true;
    const r = await chatReclaimFor('owner', 'p1', { workstream: 'main', text: 'back to the chat' }, viewer);
    expect(r).toMatchObject({ status: 503, body: { code: 'restore-pending' } });
    expect(sent('chat-send')).toEqual([]);
  });

  it('restores before the history of a chat continued on this box, so it never opens empty', async () => {
    h.resume = { id: 'r1', projectId: 'p1', workstreamId: 'ws1', sessionId: SESSION, toInstanceId: 'box-new', restoredAt: null, gitState: null };
    await chatHistoryFor('owner', 'p1', { workstream: 'main' }, viewer);
    expect(h.restored).toEqual(['r1']);
    expect(h.noticed).toEqual([], 'the history does not use up the notice');
  });

  it('a restore that has not finished opens the stored copy, not the new box\'s empty chat', async () => {
    h.resume = { id: 'r1', projectId: 'p1', workstreamId: 'ws1', sessionId: SESSION, toInstanceId: 'box-new', restoredAt: null, gitState: null };
    restoreFails.on = true;
    const r = await chatHistoryFor('owner', 'p1', { workstream: 'main' }, viewer);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ stored: true, sessionId: SESSION, entries: [{ message: { content: 'from the store' } }] });
    expect(sent('chat-history')).toEqual([]);
  });

  it('flag off: the send is as it was, with nothing restored or told', async () => {
    ld.on = new Set(['chat-transcripts-enabled']);
    h.resume = { id: 'r1', projectId: 'p1', workstreamId: 'ws1', sessionId: SESSION, toInstanceId: 'box-new', restoredAt: null, gitState: null };
    expect(await sendHi()).toBe(202);
    const payload = sent('chat-send')[0];
    expect(payload).not.toHaveProperty('boxNotices');
    expect(payload).not.toHaveProperty('notice');
    expect(h.noticed).toEqual([]);
  });
});

describe('sending is the decision (docs/chat-resume.md)', () => {
  const terminated = { box: { id: 'box-old', status: 'terminated', kind: 'ec2' }, connected: false, setupReady: true };

  it('a send to a terminated box\'s chat starts the new box and holds the message, never sending it to an empty session', async () => {
    h.connected = false;
    h.facts = terminated;
    const r = await chatSendFor('owner', 'p1', { workstream: 'main', text: 'pick up where we left off' }, viewer);
    expect(r).toMatchObject({ status: 202, body: { queued: true, held: true, phase: 'starting-box' } });
    expect(h.continues).toHaveLength(1);
    expect(h.held.map(m => m.text)).toEqual(['pick up where we left off']);
    expect(sent('chat-send')).toEqual([]);
  });

  it('a double send starts one continue; the second joins it and queues behind the first', async () => {
    h.connected = false;
    h.facts = terminated;
    const [a, b] = await Promise.all([
      chatSendFor('owner', 'p1', { workstream: 'main', text: 'first' }, viewer),
      chatSendFor('owner', 'p1', { workstream: 'main', text: 'second' }, viewer),
    ]);
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(h.held.map(m => m.text)).toEqual(['first', 'second']);
    expect(sent('chat-send')).toEqual([]);
  });

  it('a send while the new box restores is held behind; a send once it is up goes straight in', async () => {
    h.facts = { lockHeld: false, pendingResume: { restored: false } };
    expect(await chatSendFor('owner', 'p1', { workstream: 'main', text: 'during restore' }, viewer)).toMatchObject({ status: 202, body: { held: true, phase: 'restoring' } });
    expect(h.continues).toEqual([]);
    h.facts = null; h.held = [];
    expect(await sendHi()).toBe(202);
    expect(sent('chat-send')).toHaveLength(1);
  });

  it('a stopped box starts on send, and the message waits for it; no new box', async () => {
    h.connected = false;
    h.facts = { box: { id: 'box-old', status: 'stopped', kind: 'ec2' }, connected: false };
    expect(await chatSendFor('owner', 'p1', { workstream: 'main', text: 'are you there?' }, viewer)).toMatchObject({ status: 202, body: { held: true, phase: 'starting' } });
    expect(h.starts).toEqual(['box-old']);
    expect(h.continues).toEqual([]);
  });

  it('someone else\'s send is refused with who can continue it, and starts nothing', async () => {
    h.connected = false;
    h.facts = { ...terminated, isOwner: false, ownerName: 'Pat' };
    expect(await chatSendFor('owner', 'p1', { workstream: 'main', text: 'hi' }, viewer)).toMatchObject({ status: 403, body: { code: 'owner-only', error: 'Only Pat can continue this chat' } });
    expect(h.continues).toEqual([]);
    expect(h.held).toEqual([]);
  });

  it('opening the chat while it restores reads the stored history, with the phase and the held message', async () => {
    h.connected = false;
    h.facts = { pendingResume: { restored: false }, connected: true, setupReady: false };
    h.held = [{ id: 'm1', text: 'pick up where we left off', error: null }];
    prisma.project.findUnique.mockResolvedValue({
      name: 'proj', userId: 'owner', setupStatus: 'pending', repoUrl: null, chatTrustedAt: null, chatOrchestrator: false,
      instance: { hostHome: '/home/owner', userId: 'owner' }, user: { id: 'owner' },
      workflows: [{ id: 'wf1', provider: 'claude-chat', backend: null, model: 'opus', workstream: { id: 'ws1', name: 'main', askThread: null } }],
    });
    const r = await chatHistoryFor('owner', 'p1', { workstream: 'main' }, viewer);
    expect(r).toMatchObject({ status: 200, body: { stored: true, entries: [{ message: { content: 'from the store' } }], continuation: { phase: 'restoring', held: [{ text: 'pick up where we left off' }] } } });
  });

  it('a terminated box\'s chat with nothing under way says a send to it is taken, so a message queued before the history came goes out', async () => {
    h.connected = false;
    h.facts = terminated;
    const owner = await chatHistoryFor('owner', 'p1', { workstream: 'main' }, viewer);
    expect(owner.body).toMatchObject({ stored: true, continuation: { takesSends: true } });
    h.facts = { ...terminated, isOwner: false, ownerName: 'Pat' };
    const other = (await chatHistoryFor('owner', 'p1', { workstream: 'main' }, viewer)).body as { continuation: Record<string, unknown> };
    expect(other.continuation).toMatchObject({ sendRefusal: { code: 'owner-only' } });
    expect(other.continuation).not.toHaveProperty('takesSends');
    h.facts = { ...terminated, flagOn: false };
    expect((await chatHistoryFor('owner', 'p1', { workstream: 'main' }, viewer)).body).not.toHaveProperty('continuation');
  });

  it('a ready box whose agent is briefly offline does not say it takes sends: its send would go the usual way and fail', async () => {
    h.connected = false;
    h.facts = { connected: false };
    const offline = (await chatHistoryFor('owner', 'p1', { workstream: 'main' }, viewer)).body as { stored?: boolean; continuation?: Record<string, unknown> };
    expect(offline.stored).toBe(true);
    expect(offline.continuation ?? {}).not.toHaveProperty('takesSends');
    // A stopped box, or one with messages already held, does take it.
    h.facts = { box: { id: 'box-old', status: 'stopped', kind: 'ec2' }, connected: false };
    expect((await chatHistoryFor('owner', 'p1', { workstream: 'main' }, viewer)).body).toMatchObject({ continuation: { takesSends: true } });
    h.facts = { connected: false }; h.held = [{ id: 'm1', text: 'earlier', error: null }];
    expect((await chatHistoryFor('owner', 'p1', { workstream: 'main' }, viewer)).body).toMatchObject({ continuation: { takesSends: true } });
  });

  it('a restored chat whose box\'s Claude credentials are still on their way reads from the store: no sign-in card, no box read', async () => {
    h.facts = { pendingResume: { restored: true }, credentialsPending: true };
    const r = await chatHistoryFor('owner', 'p1', { workstream: 'main' }, viewer);
    expect(r).toMatchObject({ status: 200, body: { stored: true, continuation: { phase: 'restoring' } } });
    expect(sent('chat-history')).toEqual([]);
    h.facts = { pendingResume: { restored: true } };
    expect((await chatHistoryFor('owner', 'p1', { workstream: 'main' }, viewer)).body).not.toHaveProperty('stored');
  });

  it('a held message waits while its new box\'s credentials are unmarked in the database, even if this process runs no delivery', async () => {
    prisma.chatResume.findFirst.mockResolvedValueOnce({ id: 'r1' } as never);
    const m = { id: 'm1', projectId: 'p1', workstreamId: 'ws1', senderId: 'owner', text: 'pick up where we left off', model: null, backend: null, effort: null, error: null };
    expect(await deliverHeldMessage(m)).toEqual({ kind: 'not-ready' });
    expect(sent('chat-send')).toEqual([]);
    expect(prisma.chatResume.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ credentialsReadyAt: null }) }));
    // Only a recent one: a resume unmarked past the stale window (its continuer died) doesn't hold it for good.
    expect(prisma.chatResume.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ createdAt: { gte: expect.any(Date) } }) }));
  });

  it('flag off: a send to a terminated box\'s chat is refused as before, with nothing held or started', async () => {
    h.connected = false;
    h.facts = terminated;
    ld.on = new Set(['chat-transcripts-enabled']);
    const r = await chatSendFor('owner', 'p1', { workstream: 'main', text: 'hi' }, viewer);
    expect(r.status).toBe(503);
    expect(h.continues).toEqual([]);
    expect(h.held).toEqual([]);
  });
});

// Opening a stored chat leaves its parked box alone (frontend chat/storedOpen.ts),
// so reading the stored copy must never need the box: nothing is sent to it.
describe('a stopped box\'s chat reads from the store without the box', () => {
  const stopped = { box: { id: 'box-new', status: 'stopped', kind: 'ec2' }, connected: false, setupReady: true };

  it('answers the stored transcript, and sends the box nothing', async () => {
    h.connected = false;
    h.facts = stopped;
    ld.on = new Set(['chat-transcripts-enabled']);
    const r = await chatHistoryFor('owner', 'p1', { workstream: 'main' }, viewer);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ stored: true, running: false, entries: [{ type: 'user', message: { content: 'from the store' } }] });
    expect(vi.mocked(sendForProject)).not.toHaveBeenCalled();
  });

  it('a hibernated box is the same', async () => {
    h.connected = false;
    h.facts = { ...stopped, box: { ...stopped.box, status: 'hibernated' } };
    ld.on = new Set(['chat-transcripts-enabled', 'chat-resume-new-box-enabled']);
    const r = await chatHistoryFor('owner', 'p1', { workstream: 'main' }, viewer);
    expect(r.body).toMatchObject({ stored: true });
    expect(vi.mocked(sendForProject)).not.toHaveBeenCalled();
  });

  it('flag off for the owner: no stored copy, the box-offline answer as before (the frontend then starts the box on open)', async () => {
    h.connected = false;
    h.facts = stopped;
    ld.on = new Set();
    const r = await chatHistoryFor('owner', 'p1', { workstream: 'main' }, viewer);
    expect(r.status).toBe(503);
    expect(r.body).not.toHaveProperty('stored');
    expect(vi.mocked(sendForProject)).not.toHaveBeenCalled();
  });
});

// An ask's thread opens in the simple UI like any chat (agent/ask-chat.js): its
// stored transcript reads with the box stopped, so the tab leaves the box alone.
describe('an ask thread\'s chat on a stopped box', () => {
  const askProject = () => ({
    name: 'proj', userId: 'owner', instanceId: 'box-new', setupStatus: 'ready', repoUrl: null, chatTrustedAt: null, chatOrchestrator: false,
    instance: { hostHome: '/home/owner', userId: 'owner' },
    workflows: [{ id: 'wf2', provider: 'claude-chat', backend: null, model: 'opus', workstream: { id: 'ws-ask', name: 'ask-t1', askThread: { id: 't1', workstream: 'main', repoName: 'r', baseSha: 'abc', originUser: null } } }],
  });

  it('reads its stored transcript, sends the box nothing, and offers no trust or continue', async () => {
    h.connected = false;
    h.facts = { box: { id: 'box-new', status: 'stopped', kind: 'ec2' }, connected: false, setupReady: true };
    ld.on = new Set(['chat-transcripts-enabled', 'chat-resume-new-box-enabled']);
    prisma.project.findUnique.mockResolvedValue(askProject());
    const r = await chatHistoryFor('owner', 'p1', { workstream: 'ask-t1' }, viewer);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ stored: true, workstream: 'ask-t1', trust: { trusted: true }, canTrust: false });
    expect(vi.mocked(sendForProject)).not.toHaveBeenCalled();
    const { continuationFacts } = await import('../services/chatNewBox');
    expect(vi.mocked(continuationFacts).mock.calls.at(-1)?.[4]).toBe(true);
  });

  it('reports the model its turns run on, the default, not the workstream\'s saved one (Bugbot on #970)', async () => {
    h.connected = false;
    h.facts = { box: { id: 'box-new', status: 'stopped', kind: 'ec2' }, connected: false, setupReady: true };
    ld.on = new Set(['chat-transcripts-enabled']);
    const saved = askProject();
    saved.workflows[0] = { ...saved.workflows[0], backend: 'fireworks', model: 'accounts/fireworks/models/kimi-k2' } as never;
    prisma.project.findUnique.mockResolvedValue(saved);
    const { resolvedChatTier, storedChatChoice } = await import('../services/claudeChatModel');
    const r = await chatHistoryFor('owner', 'p1', { workstream: 'ask-t1' }, viewer);
    // An ask's chat runs on the default backend and model (agent/ask-chat.js, chatTarget's storedChatChoice(null, null)).
    expect(r.body).toMatchObject({ stored: true, model: resolvedChatTier(storedChatChoice(null, null).model) });
    expect(r.body).not.toHaveProperty('backend');
  });
});
