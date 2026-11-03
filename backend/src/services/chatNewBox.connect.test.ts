/**
 * Sending is the decision: what a send to a chat does
 * for each state of its box, the status it shows, and that the restore
 * starts when the new box's agent connects, before anyone opens the chat.
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  pending: null as null | { restoredAt: Date | null; credentialsReadyAt: Date | null; createdAt?: Date },
  unmarked: [] as Array<{ toInstanceId: string; project: { userId: string } }>,
  delivered: [] as Array<[string, string]>,
  credentialsMarked: [] as unknown[],
  hello: null as null | ((ev: unknown) => void),
  chatEvent: null as null | ((seen: unknown) => void),
  sends: [] as Array<{ type: string; payload: Record<string, unknown> }>,
  kicked: [] as string[],
}));
const SESSION = '5109190e-c0d2-4f72-9c15-3c4c57fb126c';
vi.mock('../db', () => ({
  prisma: {
    chatResume: {
      findUnique: vi.fn(async () => ({ restoredAt: null })),
      update: vi.fn(async () => ({})),
      findFirst: vi.fn(async () => h.pending),
      updateMany: vi.fn(async (q: unknown) => { h.credentialsMarked.push(q); return { count: 1 }; }),
      findMany: vi.fn(async (q: { where: { credentialsReadyAt?: unknown } }) => (q.where.credentialsReadyAt === null ? h.unmarked
        : [{ id: 'r1', projectId: 'p1', workstreamId: 'ws1', sessionId: SESSION, toInstanceId: 'box-new', gitState: null, lostWorkstreams: null, restoredAt: null }])),
    },
    project: {
      findUnique: vi.fn(async () => ({
        setupStatus: 'ready', instanceId: 'box-new', instance: { id: 'box-new', status: 'ready', kind: 'ec2' },
        user: { id: 'o', googleEmail: 'o@example.com', displayName: 'Pat', unixUsername: 'o', defaultAgentProvider: null },
      })),
    },
    workstream: { findUnique: vi.fn(async () => ({ name: 'main', project: { name: 'chat', instanceId: 'box-new', user: { unixUsername: 'o' }, instance: { hostHome: null } } })) },
  },
}));
vi.mock('./agentRegistry', () => ({
  onBoxAgentHello: (l: (ev: unknown) => void) => { h.hello = l; return () => {}; },
  instanceAgentTransport: () => ({ helloReceived: true, capabilities: ['chat-restore-v1'] }),
  sendToInstanceAgent: vi.fn(async (_box: string, type: string, payload: Record<string, unknown>) => {
    h.sends.push({ type, payload });
    return payload.done ? { restored: true } : { restored: false };
  }),
}));
vi.mock('./chatTranscriptStore', () => ({
  getTranscriptStoreConfig: () => ({ materials: null, rawCap: 64 << 20 }),
  storedRawOf: vi.fn(async () => ({ sessionId: SESSION, rawBytes: 8, complete: true, ranges: [{ byteStart: 0, byteEnd: 8 }] })),
  storedRawChunks: async function* () { yield Buffer.from('{"a":1}\n'); },
}));
vi.mock('./chatHeld', () => ({
  kickHeldDelivery: (ws: string) => { h.kicked.push(ws); },
  kickHeldDeliveryOnBox: vi.fn(async () => {}),
  hasHeld: vi.fn(async () => false),
}));
// Another pod's delivery: this process sees none running.
vi.mock('./credentialDelivery', () => ({
  deliveryInFlight: () => null,
  deliverToInstance: vi.fn(async (box: string, user: string) => { h.delivered.push([box, user]); }),
}));
vi.mock('./chatContinueLock', () => ({ continueUnderWay: async () => false, acquireContinueLock: async () => 't', releaseContinueLock: async () => {} }));
vi.mock('./chatRunner', () => ({
  CHAT_BOX_NOTICE_CAPABILITY: 'chat-box-notice-v1',
  chatKeyFor: (p: string, w: string) => `${p}--${w}`,
  onChatEvent: (l: (seen: unknown) => void) => { h.chatEvent = l; return () => {}; },
}));
vi.mock('./tmux', () => ({ projectDirFor: () => '/home/o/termag/projects/chat' }));
vi.mock('./featureFlags', () => ({ boolVariation: async () => true }));

import { CREDENTIALS_STALE_MS, continuationFacts, continuationPhase, continuationRefusal, recoverUnmarkedCredentials, sendPlanFor, startChatResumeRestores, type ContinuationFacts } from './chatNewBox';

const base: ContinuationFacts = {
  flagOn: true, isOwner: true, ownerName: 'Pat', excluded: false, box: { id: 'b', status: 'ready', kind: 'ec2' }, setupReady: true,
  connected: true, complete: true, lockHeld: false, pendingResume: null, hasHeld: false, credentialsPending: false,
};
const gone = { ...base, box: { id: 'b', status: 'terminated', kind: 'ec2' }, connected: false };

describe('sendPlanFor', () => {
  it('a terminated box: the owner\'s send continues it on a new box; anyone else is refused with who can', () => {
    expect(sendPlanFor(gone)).toEqual({ kind: 'continue' });
    expect(sendPlanFor({ ...gone, box: null })).toEqual({ kind: 'continue' });
    expect(sendPlanFor({ ...gone, isOwner: false })).toMatchObject({ kind: 'refuse', status: 403, code: 'owner-only', reason: 'Only Pat can continue this chat' });
    expect(sendPlanFor({ ...gone, complete: false })).toMatchObject({ kind: 'refuse', code: 'incomplete' });
  });

  it('while a continue is under way, or the new box restores, a send is held; a second send joins, not a second box', () => {
    expect(sendPlanFor({ ...gone, lockHeld: true })).toEqual({ kind: 'hold' });
    expect(sendPlanFor({ ...base, connected: false, pendingResume: { restored: false } })).toEqual({ kind: 'hold' });
    expect(sendPlanFor({ ...base, pendingResume: { restored: false } })).toEqual({ kind: 'hold' });
    expect(sendPlanFor({ ...base, setupReady: false, pendingResume: { restored: true } })).toEqual({ kind: 'hold' });
    // Up and restored: the send goes in (it carries the notice).
    expect(sendPlanFor({ ...base, pendingResume: { restored: true } })).toEqual({ kind: 'normal' });
  });

  it('a resume left on a box that then failed or was terminated doesn\'t hold the send: it continues on another new box', () => {
    for (const status of ['terminated', 'failed']) {
      const dead = { ...base, box: { id: 'b2', status, kind: 'ec2' }, connected: false, pendingResume: { restored: false } };
      expect(sendPlanFor(dead), status).toEqual({ kind: 'continue' });
      expect(sendPlanFor({ ...dead, hasHeld: true }), `${status}, with held messages`).toEqual({ kind: 'continue' });
      expect(continuationPhase(dead), status).toBeNull();
    }
  });

  it('a new box whose Claude credentials are still on their way holds the send and says it is restoring', () => {
    const arriving = { ...base, pendingResume: { restored: true }, credentialsPending: true };
    expect(sendPlanFor(arriving)).toEqual({ kind: 'hold' });
    expect(continuationPhase(arriving)).toBe('restoring');
    expect(continuationPhase({ ...arriving, credentialsPending: false })).toBeNull();
  });

  it('a stopped box starts on send: never a fork', () => {
    expect(sendPlanFor({ ...base, box: { id: 'b', status: 'stopped', kind: 'ec2' }, connected: false })).toEqual({ kind: 'start-box', boxId: 'b' });
    expect(sendPlanFor({ ...base, box: { id: 'b', status: 'hibernated', kind: 'ec2' }, connected: false })).toEqual({ kind: 'start-box', boxId: 'b' });
    expect(sendPlanFor({ ...base, box: { id: 'b', status: 'stopped', kind: 'ec2' }, isOwner: false })).toMatchObject({ kind: 'refuse', code: 'owner-only' });
  });

  it('messages already held: the next one waits behind them', () => {
    expect(sendPlanFor({ ...base, hasHeld: true })).toEqual({ kind: 'hold' });
  });

  it('flag off, an ask\'s chat, another workstream: as before', () => {
    expect(sendPlanFor({ ...gone, flagOn: false })).toEqual({ kind: 'normal' });
    expect(sendPlanFor({ ...gone, excluded: true })).toEqual({ kind: 'normal' });
    expect(sendPlanFor(base)).toEqual({ kind: 'normal' });
  });
});

describe('continuationPhase and the composer\'s refusal', () => {
  it('starting a new box, then restoring, then the chat\'s own status', () => {
    expect(continuationPhase({ ...gone, lockHeld: true })).toBe('starting-box');
    expect(continuationPhase({ ...base, connected: false, pendingResume: { restored: false } })).toBe('starting-box');
    expect(continuationPhase({ ...base, pendingResume: { restored: false } })).toBe('restoring');
    expect(continuationPhase({ ...base, setupReady: false, pendingResume: { restored: true } })).toBe('restoring');
    expect(continuationPhase({ ...base, pendingResume: { restored: true } })).toBeNull();
    expect(continuationPhase({ ...base, box: { id: 'b', status: 'starting', kind: 'ec2' }, connected: false, hasHeld: true })).toBe('starting');
    expect(continuationPhase(gone)).toBeNull();
  });

  it('a non-owner\'s composer says who can continue it', () => {
    expect(continuationRefusal({ ...gone, isOwner: false })).toEqual({ code: 'owner-only', reason: 'Only Pat can continue this chat' });
    expect(continuationRefusal(gone)).toBeNull();
  });
});

describe('restore on connect', () => {
  it('the new box\'s hello starts the restore, before anyone opens the chat, and the held messages go in after it', async () => {
    startChatResumeRestores();
    h.hello!({ instance: { id: 'box-new', name: 'box-1' }, capabilities: ['chat-restore-v1'], settled: Promise.resolve() });
    for (let i = 0; i < 20 && !h.kicked.length; i++) await new Promise(r => setTimeout(r, 0));
    expect(h.sends.map(s => [s.type, s.payload.done])).toEqual([['chat-session-restore', true]]);
    expect(h.kicked).toEqual(['ws1']);
  });
});

describe('the new-box notice is told when Claude starts the turn that carries it', () => {
  const ev = (turnId: string, event: unknown) => ({ instanceId: 'box-new', projectId: 'p1', workstreamId: 'ws1', turnId, event });
  const init = { type: 'system', subtype: 'init', session_id: 's' };
  const settle = () => new Promise(r => setTimeout(r, 5));

  it('the pairing is on the chat_resumes row: turn-start names its turn, and only that turn\'s init (on any process) tells it', async () => {
    h.credentialsMarked = [];
    startChatResumeRestores();
    // A compact (or a reclaim's send) starts a turn without the notice: nothing is written.
    h.chatEvent!(ev('t-compact', { type: 'turn-start', text: '', compact: true }));
    await settle();
    expect(h.credentialsMarked).toEqual([]);
    // The turn that carries it records its id on the row.
    h.chatEvent!(ev('t-first', { type: 'turn-start', text: 'hi', newBoxNotice: true }));
    await settle();
    expect(h.credentialsMarked).toEqual([{ where: { workstreamId: 'ws1', toInstanceId: 'box-new', noticeSentAt: null }, data: { noticeTurnId: 't-first' } }]);
    // Any init only tells the notice when its turn is the one recorded: the
    // where clause does the pairing, so an init seen by another process (a
    // deploy, a restart) still tells it, and a compact's init never does.
    h.credentialsMarked = [];
    h.chatEvent!(ev('t-compact', init));
    h.chatEvent!(ev('t-first', init));
    await settle();
    expect(h.credentialsMarked).toEqual([
      { where: { workstreamId: 'ws1', toInstanceId: 'box-new', noticeSentAt: null, restoredAt: { not: null }, noticeTurnId: 't-compact' }, data: { noticeSentAt: expect.any(Date) } },
      { where: { workstreamId: 'ws1', toInstanceId: 'box-new', noticeSentAt: null, restoredAt: { not: null }, noticeTurnId: 't-first' }, data: { noticeSentAt: expect.any(Date) } },
    ]);
    // A noticed turn that ends before Claude starts gives its claim up.
    h.credentialsMarked = [];
    h.chatEvent!(ev('t-lost', { type: 'turn-end', exitCode: null, lost: true }));
    await settle();
    expect(h.credentialsMarked).toEqual([{ where: { workstreamId: 'ws1', toInstanceId: 'box-new', noticeSentAt: null, noticeTurnId: 't-lost' }, data: { noticeTurnId: null } }]);
  });
});

describe('the credentials gate is in the database, not this process', () => {
  it('a resume whose box\'s credentials are not marked delivered is pending, whatever this process sees', async () => {
    h.pending = { restoredAt: new Date(), credentialsReadyAt: null };
    const f = await continuationFacts('p1', 'ws1', 'main', true, false);
    expect(f.credentialsPending).toBe(true);
    expect(sendPlanFor(f)).toEqual({ kind: 'hold' });
    expect(continuationPhase(f)).toBe('restoring');
    h.pending = { restoredAt: new Date(), credentialsReadyAt: new Date() };
    expect((await continuationFacts('p1', 'ws1', 'main', true, false)).credentialsPending).toBe(false);
  });

  it('the box\'s hello marks its resumes\' credentials delivered once it has settled (the delivery is part of it)', async () => {
    h.credentialsMarked = [];
    startChatResumeRestores();
    h.hello!({ instance: { id: 'box-new', name: 'box-1' }, capabilities: ['chat-restore-v1'], settled: Promise.resolve() });
    for (let i = 0; i < 20 && !h.credentialsMarked.length; i++) await new Promise(r => setTimeout(r, 0));
    expect(h.credentialsMarked).toEqual([{ where: { toInstanceId: 'box-new', credentialsReadyAt: null }, data: { credentialsReadyAt: expect.any(Date) } }]);
  });
});

describe('unmarked credentials never block a chat for good', () => {
  it('a resume unmarked for longer than the stale window no longer holds the chat (its continuer died mid-wait)', async () => {
    h.pending = { restoredAt: new Date(), credentialsReadyAt: null, createdAt: new Date(Date.now() - CREDENTIALS_STALE_MS - 1000) };
    const f = await continuationFacts('p1', 'ws1', 'main', true, false);
    expect(f.credentialsPending).toBe(false);
    expect(sendPlanFor(f)).toEqual({ kind: 'normal' });
    h.pending = { restoredAt: new Date(), credentialsReadyAt: null, createdAt: new Date() };
    expect((await continuationFacts('p1', 'ws1', 'main', true, false)).credentialsPending).toBe(true);
  });

  it('the recovery sweep delivers again to a connected box whose resume is still unmarked, then marks it', async () => {
    h.unmarked = [{ toInstanceId: 'box-new', project: { userId: 'o' } }];
    h.delivered = []; h.credentialsMarked = [];
    await recoverUnmarkedCredentials();
    expect(h.delivered).toEqual([['box-new', 'o']]);
    expect(h.credentialsMarked).toEqual([{ where: { toInstanceId: 'box-new', credentialsReadyAt: null }, data: { credentialsReadyAt: expect.any(Date) } }]);
  });
});
