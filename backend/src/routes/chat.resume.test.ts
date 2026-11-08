// A chat's box notices on chat-send: every send lets
// the runner tell a restart; the first send on a new box restores the stored
// session first and carries the new-box notice, once.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ALL_CAPS = ['chat-runner-v1', 'chat-trust-v1', 'chat-box-notice-v1', 'chat-restore-v1', 'chat-images-v1'];
const SESSION = '5109190e-c0d2-4f72-9c15-3c4c57fb126c';

const h = vi.hoisted(() => ({
  resume: null as null | Record<string, unknown>,
  restored: [] as string[],
  noticed: [] as string[],
  connected: true,
  facts: null as null | Record<string, unknown>,
  held: [] as Array<{ id: string; text: string; error: string | null; senderId?: string; imageTypes?: string[]; images?: unknown[]; boxStarted?: boolean }>,
  taken: null as null | { text: string; images: unknown[]; error: string },
  continues: [] as unknown[],
  starts: [] as string[],
  startedBy: [] as string[],
  startFails: false,
}));
const quiet = { isOwner: true, ownerName: 'O', excluded: false, box: { id: 'box-new', status: 'ready', kind: 'ec2' }, setupReady: true, connected: true, complete: true, lockHeld: false, credentialsPending: false, pendingResume: null, hasHeld: false };
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
// Only `termag ask --model`'s flag is read here, and a test turns it on.
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
    // As the real one: only messages still waiting (no error) count.
    continuationFacts: vi.fn(async () => ({ ...quiet, ...(h.facts ?? {}), hasHeld: h.held.some(m => !m.error) })),
    // The real one is behind the database lock (chatNewBox.test.ts): the first starts the box, the rest are told it is under way.
    continueOnNewBoxFor: vi.fn(async () => {
      h.continues.push(1);
      return h.continues.length === 1 ? { status: 202, body: { instanceId: 'box-new' } } : { status: 409, body: { code: 'continuing', error: 'already' } };
    }),
  };
});
vi.mock('../services/chatHeld', () => ({
  heldFor: vi.fn(async () => h.held),
  holdMessage: vi.fn(async (k: { senderId: string }, b: { text: string; images?: Array<{ mediaType: string }> }, o: { boxStarted?: boolean } = {}) => {
    h.held.push({ id: `m${h.held.length + 1}`, text: b.text, error: null, senderId: k.senderId, imageTypes: (b.images ?? []).map(i => i.mediaType), images: b.images ?? [], boxStarted: o.boxStarted === true });
    return { id: `m${h.held.length}`, position: h.held.length };
  }),
  heldImage: vi.fn(async (id: string, _ws: string, n: number) => (id === 'm1' && n === 0 ? { mediaType: 'image/png', data: Buffer.from('png') } : null)),
  takeRefused: vi.fn(async () => { const t = h.taken; h.taken = null; return t; }),
  markBoxStarted: vi.fn(async () => {}),
  kickHeldDelivery: vi.fn(),
}));
vi.mock('./instances', () => ({ powerOwnedBox: vi.fn(async (u: { id: string }, id: string) => {
  h.startedBy.push(u.id);
  if (h.startFails) return { status: 502, body: { error: 'EC2 said no' } };
  h.starts.push(id);
  return { status: 202, body: { ok: true, status: 'starting' } };
}) }));

import { chatHeldImageFor, chatHeldTakeFor, chatHistoryFor, chatReclaimFor, chatSendFor, deliverHeldMessage } from './chat';
import { sendForProject } from '../services/agentRegistry';
import { CHAT_FILE_ATTACHMENTS_FLAG } from '../services/chatFiles';
import { NEW_BOX_NOTICE } from '../services/chatNewBox';

const viewer = { id: 'owner', googleEmail: 'o@example.com', displayName: 'O', unixUsername: 'owner', defaultAgentProvider: 'claude' } as never;
const sent = (type: string) => vi.mocked(sendForProject).mock.calls.filter(c => c[1] === type).map(c => c[2] as Record<string, unknown>);
const sendHi = async () => (await chatSendFor('owner', 'p1', { workstream: 'main', text: 'hi' }, viewer)).status;

beforeEach(() => {
  vi.clearAllMocks();
  h.restored = []; h.noticed = [];
  h.resume = null;
  restoreFails.on = false;
  ld.on = new Set();
  h.connected = true; h.facts = null; h.held = []; h.continues = []; h.starts = []; h.taken = null; h.startedBy = []; h.startFails = false;
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
    await chatHistoryFor('owner', 'p1', { workstream: 'main' });
    expect(h.restored).toEqual(['r1']);
    expect(h.noticed).toEqual([], 'the history does not use up the notice');
  });

  it('a restore that has not finished opens the stored copy, not the new box\'s empty chat', async () => {
    h.resume = { id: 'r1', projectId: 'p1', workstreamId: 'ws1', sessionId: SESSION, toInstanceId: 'box-new', restoredAt: null, gitState: null };
    restoreFails.on = true;
    const r = await chatHistoryFor('owner', 'p1', { workstream: 'main' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ stored: true, sessionId: SESSION, entries: [{ message: { content: 'from the store' } }] });
    expect(sent('chat-history')).toEqual([]);
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
    const r = await chatHistoryFor('owner', 'p1', { workstream: 'main' });
    expect(r).toMatchObject({ status: 200, body: { stored: true, entries: [{ message: { content: 'from the store' } }], continuation: { phase: 'restoring', held: [{ text: 'pick up where we left off' }] } } });
  });

  it('a terminated box\'s chat with nothing under way says a send to it is taken, so a message queued before the history came goes out', async () => {
    h.connected = false;
    h.facts = terminated;
    const owner = await chatHistoryFor('owner', 'p1', { workstream: 'main' });
    expect(owner.body).toMatchObject({ stored: true, continuation: { takesSends: true } });
    h.facts = { ...terminated, isOwner: false, ownerName: 'Pat' };
    const other = (await chatHistoryFor('owner', 'p1', { workstream: 'main' })).body as { continuation: Record<string, unknown> };
    expect(other.continuation).toMatchObject({ sendRefusal: { code: 'owner-only' } });
    expect(other.continuation).not.toHaveProperty('takesSends');
    // Another workstream (or an ask's chat) with nothing stored to hold for: no continuation.
    h.facts = { ...terminated, excluded: true };
    expect((await chatHistoryFor('owner', 'p1', { workstream: 'main' })).body).not.toHaveProperty('continuation');
  });

  // Devin on #1478: a stored ask's thread, or a chat whose box is gone, offered uploads that could only fail.
  it('a stored chat offers files on the flag alone, but not in an ask\'s thread nor where the box is gone', async () => {
    // Through ld.on, not mockResolvedValue: that would outlive this test and turn every later flag off (vi.clearAllMocks keeps it).
    ld.on = new Set([CHAT_FILE_ATTACHMENTS_FLAG]);
    h.connected = false;
    h.facts = { connected: false };
    const base = await prisma.project.findUnique();
    const history = async () => (await chatHistoryFor('owner', 'p1', { workstream: 'main' }, viewer)).body as { stored?: boolean; fileInput?: boolean };
    expect(await history()).toMatchObject({ stored: true, fileInput: true });
    prisma.project.findUnique.mockResolvedValue({ ...base, instance: { hostHome: '/home/owner', userId: 'owner', status: 'terminated' } });
    expect(await history()).toMatchObject({ stored: true, fileInput: false });
    prisma.project.findUnique.mockResolvedValue({ ...base, workflows: [{ ...base.workflows[0], workstream: { id: 'ws1', name: 'main', askThread: { id: 't1' } } }] });
    expect(await history()).toMatchObject({ stored: true, fileInput: false });
    ld.on = new Set();
    prisma.project.findUnique.mockResolvedValue(base);
    expect(await history()).toMatchObject({ stored: true, fileInput: false });
  });

  it('a ready box whose agent is briefly offline does not say it takes sends: its send would go the usual way and fail', async () => {
    h.connected = false;
    h.facts = { connected: false };
    const offline = (await chatHistoryFor('owner', 'p1', { workstream: 'main' })).body as { stored?: boolean; continuation?: Record<string, unknown> };
    expect(offline.stored).toBe(true);
    expect(offline.continuation ?? {}).not.toHaveProperty('takesSends');
    // A stopped box, or one with messages already held, does take it.
    h.facts = { box: { id: 'box-old', status: 'stopped', kind: 'ec2' }, connected: false };
    expect((await chatHistoryFor('owner', 'p1', { workstream: 'main' })).body).toMatchObject({ continuation: { takesSends: true } });
    h.facts = { connected: false }; h.held = [{ id: 'm1', text: 'earlier', error: null }];
    expect((await chatHistoryFor('owner', 'p1', { workstream: 'main' })).body).toMatchObject({ continuation: { takesSends: true } });
  });

  it('a restored chat whose box\'s Claude credentials are still on their way reads from the store: no sign-in card, no box read', async () => {
    h.facts = { pendingResume: { restored: true }, credentialsPending: true };
    const r = await chatHistoryFor('owner', 'p1', { workstream: 'main' });
    expect(r).toMatchObject({ status: 200, body: { stored: true, continuation: { phase: 'restoring' } } });
    expect(sent('chat-history')).toEqual([]);
    h.facts = { pendingResume: { restored: true } };
    expect((await chatHistoryFor('owner', 'p1', { workstream: 'main' })).body).not.toHaveProperty('stored');
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
});

// Opening a stored chat leaves its parked box alone (frontend chat/storedOpen.ts),
// so reading the stored copy must never need the box: nothing is sent to it.
describe('a stopped box\'s chat reads from the store without the box', () => {
  const stopped = { box: { id: 'box-new', status: 'stopped', kind: 'ec2' }, connected: false, setupReady: true };

  it('answers the stored transcript, and sends the box nothing', async () => {
    h.connected = false;
    h.facts = stopped;
    const r = await chatHistoryFor('owner', 'p1', { workstream: 'main' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ stored: true, running: false, entries: [{ type: 'user', message: { content: 'from the store' } }] });
    expect(vi.mocked(sendForProject)).not.toHaveBeenCalled();
  });

  it('a hibernated box is the same', async () => {
    h.connected = false;
    h.facts = { ...stopped, box: { ...stopped.box, status: 'hibernated' } };
    const r = await chatHistoryFor('owner', 'p1', { workstream: 'main' });
    expect(r.body).toMatchObject({ stored: true });
    expect(vi.mocked(sendForProject)).not.toHaveBeenCalled();
  });
});

// A stored chat's composer takes images while its box is down: the browser
// holds them with the message and sends both once the box is up (frontend
// pages/chat/useSdkChat.ts). The stored read always offers them.
describe('images in a stored chat whose box is down', () => {
  const stopped = { box: { id: 'box-new', status: 'stopped', kind: 'ec2' }, connected: false, setupReady: true };

  it('offers images', async () => {
    h.connected = false;
    h.facts = stopped;
    const r = await chatHistoryFor('owner', 'p1', { workstream: 'main' });
    expect(r.body).toMatchObject({ stored: true, imageInput: true });
  });

});

// #971, the person's call: a message sent with images while a stored chat's box is down is held on
// the orchestrator, images and all, with chat-resume off: it survives the tab, shows in every tab,
// goes in once the box is up, and one the box refuses goes back to its sender's composer.
describe('a stored chat\'s held sends, chat-resume off', () => {
  // The smallest PNG there is.
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
  const parked = { parkHold: true, box: { id: 'box-old', status: 'stopped', kind: 'ec2' }, connected: false };

  it('a send with an image starts the box and is held with its image', async () => {
    h.connected = false;
    h.facts = parked;
    const r = await chatSendFor('owner', 'p1', { workstream: 'main', text: 'look', images: [{ mediaType: 'image/png', data: PNG }] }, viewer);
    expect(r).toMatchObject({ status: 202, body: { held: true, phase: 'starting' } });
    expect(h.starts).toEqual(['box-old']);
    expect(h.held).toMatchObject([{ text: 'look', imageTypes: ['image/png'], boxStarted: true }]);
    expect(sent('chat-send')).toEqual([]);
  });

  it('every tab\'s history lists the held message, its images as links, and whose it is', async () => {
    h.connected = false;
    h.facts = { ...parked, hasHeld: true };
    h.held = [{ id: 'm1', text: 'look', error: null, senderId: 'owner', imageTypes: ['image/png'] }];
    const r = await chatHistoryFor('owner', 'p1', { workstream: 'main' });
    expect(r.body).toMatchObject({ stored: true, continuation: { phase: 'starting', takesSends: true, held: [{ id: 'm1', text: 'look', mine: true, images: [{ mediaType: 'image/png' }] }] } });
  });

  it('a held image is served to whoever can read the chat', async () => {
    const r = await chatHeldImageFor('owner', 'p1', { workstream: 'main' }, 'm1', '0');
    expect(r).toEqual({ status: 200, mediaType: 'image/png', data: Buffer.from('png') });
    expect((await chatHeldImageFor('owner', 'p1', { workstream: 'main' }, 'm1', '1')).status).toBe(404);
  });

  it('one the box refused goes back to its sender once: text, images and why', async () => {
    h.taken = { text: 'look', images: [{ mediaType: 'image/png', data: PNG }], error: 'no images here' };
    expect(await chatHeldTakeFor('owner', 'p1', { workstream: 'main' }, 'm1')).toEqual({ status: 200, body: { text: 'look', images: [{ mediaType: 'image/png', data: PNG }], error: 'no images here' } });
    expect((await chatHeldTakeFor('owner', 'p1', { workstream: 'main' }, 'm1')).status).toBe(404);
  });

  it('delivery sends the images with the text; a box that is stopped again is started once for it', async () => {
    const m = { id: 'm1', projectId: 'p1', workstreamId: 'ws1', senderId: 'owner', text: 'look', model: null, backend: null, effort: null, error: null, images: [{ mediaType: 'image/png', data: PNG }] };
    expect(await deliverHeldMessage(m)).toEqual({ kind: 'sent' });
    expect(sent('chat-send')[0]).toMatchObject({ text: 'look', images: [{ mediaType: 'image/png', data: PNG }] });
    // Its box stopped meanwhile (it was still stopping when the message was sent): one start, then wait.
    h.connected = false;
    prisma.project.findUnique.mockResolvedValueOnce({ userId: 'owner', instanceId: 'box-old', instance: { id: 'box-old', status: 'stopped', kind: 'ec2' } } as never);
    expect(await deliverHeldMessage({ ...m, boxStartedAt: null })).toEqual({ kind: 'not-ready' });
    expect(h.starts).toEqual(['box-old']);
    prisma.project.findUnique.mockResolvedValueOnce({ userId: 'owner', instanceId: 'box-old', instance: { id: 'box-old', status: 'stopped', kind: 'ec2' } } as never);
    expect(await deliverHeldMessage({ ...m, boxStartedAt: new Date() })).toEqual({ kind: 'not-ready' });
    expect(h.starts).toEqual(['box-old']);
  });

  // Bugbot on #971: a start that failed was stamped as done, and a collaborator's held message started nothing.
  it('a start that fails is not marked done, so the next sweep tries again', async () => {
    const { markBoxStarted } = await import('../services/chatHeld');
    const m = { id: 'm1', projectId: 'p1', workstreamId: 'ws1', senderId: 'owner', text: 'look', model: null, backend: null, effort: null, error: null, boxStartedAt: null };
    const stopped = { userId: 'owner', instanceId: 'box-old', instance: { id: 'box-old', status: 'stopped', kind: 'ec2' } };
    h.connected = false;
    h.startFails = true;
    prisma.project.findUnique.mockResolvedValueOnce(stopped as never);
    expect(await deliverHeldMessage(m)).toEqual({ kind: 'not-ready' });
    expect(vi.mocked(markBoxStarted)).not.toHaveBeenCalled();
    h.startFails = false;
    prisma.project.findUnique.mockResolvedValueOnce(stopped as never);
    expect(await deliverHeldMessage(m)).toEqual({ kind: 'not-ready' });
    expect(h.starts).toEqual(['box-old']);
    expect(vi.mocked(markBoxStarted)).toHaveBeenCalledWith('m1');
  });

  // Security review on #971: only the box's owner starts it (powerRequestError, parkHoldPlan's ownerOnlyStart);
  // held delivery must not start it as the owner on a collaborator's behalf.
  it('a collaborator\'s held message never starts the owner\'s box: it waits until the owner starts it', async () => {
    prisma.user.findUnique.mockImplementation((async ({ where }: { where: { id: string } }) => ({ id: where.id, googleEmail: `${where.id}@example.com`, displayName: where.id, unixUsername: where.id, defaultAgentProvider: null })) as never);
    const { markBoxStarted } = await import('../services/chatHeld');
    const m = { id: 'm2', projectId: 'p1', workstreamId: 'ws1', senderId: 'collab', text: 'hi', model: null, backend: null, effort: null, error: null, boxStartedAt: null };
    h.connected = false;
    prisma.project.findUnique.mockResolvedValueOnce({ userId: 'owner', instanceId: 'box-old', instance: { id: 'box-old', status: 'stopped', kind: 'ec2' } } as never);
    expect(await deliverHeldMessage(m)).toEqual({ kind: 'not-ready' });
    expect(h.startedBy).toEqual([]);
    expect(h.starts).toEqual([]);
    expect(vi.mocked(markBoxStarted)).not.toHaveBeenCalled();
  });
});

// Bugbot on #971, "Ask sends never reach orchestrator hold": a stored ask chat (stored and read once #970 is in)
// holds an owner's send and starts its box, since parkHold ignores the ask exclusion; on this branch alone an
// ask thread has no stored history, so its tab gets the box-offline answer and starts the box on open.
describe('an ask thread\'s send while its box is down', () => {
  it('a stored ask chat holds an owner\'s send and starts its box: parkHold ignores the ask exclusion', async () => {
    h.connected = false;
    h.facts = { excluded: true, parkHold: true, box: { id: 'box-new', status: 'stopped', kind: 'ec2' }, connected: false, setupReady: true };
    const r = await chatSendFor('owner', 'p1', { workstream: 'ask-t1', text: 'and the tests?' }, viewer);
    expect(r).toMatchObject({ status: 202, body: { held: true } });
    expect(h.starts).toEqual(['box-new']);
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
    prisma.project.findUnique.mockResolvedValue(askProject());
    const r = await chatHistoryFor('owner', 'p1', { workstream: 'ask-t1' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ stored: true, workstream: 'ask-t1', trust: { trusted: true }, canTrust: false });
    expect(vi.mocked(sendForProject)).not.toHaveBeenCalled();
    const { continuationFacts } = await import('../services/chatNewBox');
    expect(vi.mocked(continuationFacts).mock.calls.at(-1)?.[4]).toBe(true);
  });

  it('reports the model its turns run on, the default, not the workstream\'s saved one (Bugbot on #970)', async () => {
    h.connected = false;
    h.facts = { box: { id: 'box-new', status: 'stopped', kind: 'ec2' }, connected: false, setupReady: true };
    const saved = askProject();
    saved.workflows[0] = { ...saved.workflows[0], backend: 'fireworks', model: 'accounts/fireworks/models/kimi-k2' } as never;
    prisma.project.findUnique.mockResolvedValue(saved);
    const { resolvedChatTier, storedChatChoice } = await import('../services/claudeChatModel');
    const r = await chatHistoryFor('owner', 'p1', { workstream: 'ask-t1' });
    // An ask's chat runs on the default backend and model (agent/ask-chat.js, chatTarget's storedChatChoice(null, null)).
    expect(r.body).toMatchObject({ stored: true, model: resolvedChatTier(storedChatChoice(null, null).model) });
    expect(r.body).not.toHaveProperty('backend');
  });

  it("reports the tier the thread keeps (termag ask --model), the one its turns run on", async () => {
    h.connected = false;
    h.facts = { box: { id: 'box-new', status: 'stopped', kind: 'ec2' }, connected: false, setupReady: true };
    ld.on = new Set();
    prisma.project.findUnique.mockResolvedValue({ ...askProject(), user: { id: 'owner', googleEmail: 'o@example.com', displayName: 'O', unixUsername: 'owner', defaultAgentProvider: 'claude' }, instance: { id: 'box-new', name: 'box-new', status: 'stopped', kind: 'ec2', hostHome: '/home/owner', userId: 'owner' } });
    // With ask-model-choice-enabled off, as before it: the default.
    expect((await chatHistoryFor('owner', 'p1', { workstream: 'ask-t1' })).body).toMatchObject({ stored: true, model: 'sonnet' });
    ld.on = new Set(['ask-model-choice-enabled']);
    expect((await chatHistoryFor('owner', 'p1', { workstream: 'ask-t1' })).body).toMatchObject({ stored: true, model: 'opus' });
    ld.on = new Set();
  });

  // An ask with no tier (none asked for, the flag off, an older agent) names no --model, so it runs on the box's
  // default, the gateway's CLAUDE_DEFAULT_MODEL tier: the picker says that, not a chat's Sonnet.
  it("reports the box's default for a thread with no tier, the one its asks ran on", async () => {
    h.connected = false;
    h.facts = { box: { id: 'box-new', status: 'stopped', kind: 'ec2' }, connected: false, setupReady: true };
    vi.stubEnv('CLAUDE_GATEWAY_URL', 'https://gateway.example/bedrock');
    vi.stubEnv('CLAUDE_BEDROCK_REGION', 'us-east-2');
    vi.stubEnv('CLAUDE_BEDROCK_MODELS', 'opus=us.anthropic.claude-opus-5-5,sonnet=us.anthropic.claude-sonnet-5-5,haiku=us.anthropic.claude-haiku-4-5');
    vi.stubEnv('CLAUDE_DEFAULT_MODEL', 'opus');
    try {
      const user = { id: 'owner', googleEmail: 'o@example.com', displayName: 'O', unixUsername: 'owner', defaultAgentProvider: 'claude', claudeGatewayEnabled: true };
      const instance = { id: 'box-new', name: 'box-new', status: 'stopped', kind: 'ec2', hostHome: '/home/owner', userId: 'owner' };
      const project = askProject();
      // The flag off: the stored tier is not applied either.
      ld.on = new Set();
      prisma.project.findUnique.mockResolvedValue({ ...project, user, instance, workflows: [{ ...project.workflows[0], model: 'haiku' }] });
      expect((await chatHistoryFor('owner', 'p1', { workstream: 'ask-t1' })).body).toMatchObject({ stored: true, model: 'opus' });
      // The flag on, nothing stored.
      ld.on = new Set(['ask-model-choice-enabled']);
      prisma.project.findUnique.mockResolvedValue({ ...project, user, instance, workflows: [{ ...project.workflows[0], model: null }] });
      expect((await chatHistoryFor('owner', 'p1', { workstream: 'ask-t1' })).body).toMatchObject({ stored: true, model: 'opus' });
      // An owner off the gateway: no ANTHROPIC_MODEL on the box, so no known default; Sonnet as before.
      prisma.project.findUnique.mockResolvedValue({ ...project, user: { ...user, claudeGatewayEnabled: false }, instance, workflows: [{ ...project.workflows[0], model: null }] });
      expect((await chatHistoryFor('owner', 'p1', { workstream: 'ask-t1' })).body).toMatchObject({ stored: true, model: 'sonnet' });
    } finally {
      ld.on = new Set();
      vi.unstubAllEnvs();
    }
  });

  // Bugbot on #971 ("Ask sends never reach orchestrator hold"), with #970 in: the stored ask chat says it takes
  // sends, and a send is held and starts its box.
  it('says it takes sends, and a send is held and starts its box', async () => {
    h.connected = false;
    h.facts = { excluded: true, parkHold: true, box: { id: 'box-new', status: 'stopped', kind: 'ec2' }, connected: false, setupReady: true };
    prisma.project.findUnique.mockResolvedValue(askProject());
    const r = await chatHistoryFor('owner', 'p1', { workstream: 'ask-t1' });
    expect(r.body).toMatchObject({ stored: true, continuation: { takesSends: true } });
    const sent = await chatSendFor('owner', 'p1', { workstream: 'ask-t1', text: 'and the tests?' }, viewer);
    expect(sent).toMatchObject({ status: 202, body: { held: true } });
    expect(h.starts).toEqual(['box-new']);
  });
});

// Bugbot on #971 ("Refused holds hidden in stored history"): a refused held message (error set) no longer
// counts as waiting, but it must still be listed, or its sender's take-back never runs and others never see why.
describe('a refused held message in a stored chat', () => {
  it('is listed in the stored history even when nothing else waits', async () => {
    h.connected = false;
    h.facts = { parkHold: true, box: { id: 'box-old', status: 'stopped', kind: 'ec2' }, connected: false };
    h.held = [{ id: 'm1', text: 'look', error: 'no images here', senderId: 'owner', imageTypes: ['image/png'] }];
    const r = await chatHistoryFor('owner', 'p1', { workstream: 'main' });
    expect(r.body).toMatchObject({ stored: true, continuation: { held: [{ id: 'm1', error: 'no images here', mine: true }] } });
  });
});

// Security review on #971: a project share's send to an ask thread whose agent is offline is refused, not held.
describe('a share\'s send to an ask thread while its box is down', () => {
  it('is refused, and nothing is held', async () => {
    h.connected = false;
    h.facts = { excluded: true, ask: true, isOwner: false, ownerName: 'Pat', parkHold: true, box: { id: 'box-new', status: 'ready', kind: 'ec2' }, connected: false };
    h.held = [{ id: 'm1', text: 'the owner\'s', error: null }];
    const r = await chatSendFor('owner', 'p1', { workstream: 'ask-t1', text: 'from the share' }, viewer);
    expect(r).toMatchObject({ status: 403, body: { code: 'owner-only' } });
    expect(h.held.map(m => m.text)).toEqual(['the owner\'s']);
  });
});

