import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chatTurnPreview, chatTurnRecipients, isChatTurnEnd, pushOnChatTurn, resetChatTurnPushState, shouldPushChatTurn,
  CHAT_TURN_COOLDOWN_MS, type ChatTurnAudience, type ChatTurnDeps, type ChatTurnPerson,
} from './chatTurnPush';
import type { PushStore } from './webPush';
import type { AgentStatus } from '../types/index';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('./featureFlags', () => ({ boolVariation: vi.fn(async () => false) }));
vi.mock('./pushFlag', () => ({ webPushEnabledFor: vi.fn(async () => false) }));

const RESULT = { type: 'result', result: 'All green.' };

describe('isChatTurnEnd', () => {
  it.each<[AgentStatus['status'] | undefined, AgentStatus['status'], unknown, boolean]>([
    ['working', 'idle', RESULT, true],
    ['working', 'idle', { type: 'turn-end', exitCode: 0, signal: null }, true],
    ['working', 'idle', { type: 'turn-end', exitCode: 1 }, true],
    // Someone pressed Stop: they know.
    ['working', 'idle', { type: 'turn-end', exitCode: null, signal: 'SIGTERM' }, false],
    // turn-end after the result: already idle, no transition.
    ['idle', 'idle', { type: 'turn-end', exitCode: 0 }, false],
    ['idle', 'working', { type: 'turn-start' }, false],
    ['working', 'working', { type: 'assistant' }, false],
    [undefined, 'idle', RESULT, false],
    ['not_running', 'idle', RESULT, false],
    ['working', 'idle', null, false],
  ])('%s → %s on %j: %s', (prev, next, event, expected) => {
    expect(isChatTurnEnd(prev, next, event)).toBe(expected);
  });
});

describe('chatTurnPreview', () => {
  it("reads the result's answer, as the open tab does, not the streamed preview", () => {
    expect(chatTurnPreview({ type: 'result', result: '\n\n  All   green.\nMore.' })).toBe('All green.');
    expect(chatTurnPreview({ type: 'result', result: '   ' })).toBeNull();
    expect(chatTurnPreview({ type: 'result' })).toBeNull();
    expect(chatTurnPreview({ type: 'turn-end', exitCode: 1 })).toBeNull();
    expect(chatTurnPreview(null)).toBeNull();
  });
});

describe('shouldPushChatTurn', () => {
  const now = 1_000_000;
  it('pushes each answer of a live turn, but not twice inside the cooldown', () => {
    expect(shouldPushChatTurn('working', 'idle', RESULT, null, now)).toBe(true);
    expect(shouldPushChatTurn('working', 'idle', RESULT, now - 2_000, now)).toBe(false);
    expect(shouldPushChatTurn('working', 'idle', RESULT, now - CHAT_TURN_COOLDOWN_MS, now)).toBe(true);
  });
});

function person(id: string, chatTurnNotify = true): ChatTurnPerson {
  return { id, googleEmail: `${id}@example.com`, displayName: id, unixUsername: id, defaultAgentProvider: 'claude', chatTurnNotify };
}

describe('chatTurnRecipients', () => {
  it('owner then collaborators, once each, only those who opted in', () => {
    expect(chatTurnRecipients(person('owner'), [person('a'), person('b', false), person('owner'), person('a')]).map(p => p.id))
      .toEqual(['owner', 'a']);
    expect(chatTurnRecipients(person('owner', false), [])).toEqual([]);
  });
});

describe('pushOnChatTurn', () => {
  const VAPID = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:ops@example.com' };
  let sent: Array<{ endpoint: string; payload: Record<string, unknown> }>;
  let deps: ChatTurnDeps;
  let audience: ChatTurnAudience | null;
  let allowedIds: Set<string>;

  beforeEach(() => {
    resetChatTurnPushState();
    sent = [];
    allowedIds = new Set(['owner', 'collab']);
    audience = { projectName: 'orchestrator', owner: person('owner'), collaborators: [person('collab'), person('lurker', false)] };
    const store: PushStore = {
      listForUser: async (userId) => [{ id: `s-${userId}`, endpoint: `https://fcm.googleapis.com/fcm/send/${userId}`, p256dh: 'k', auth: 'a' }],
      remove: async () => {},
      markUsed: async () => {},
      markFailed: async () => {},
    };
    deps = {
      send: {
        vapid: VAPID, store,
        transport: async (sub, payload) => { sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) }); return { statusCode: 201 }; },
      },
      loadAudience: async () => audience,
      allowed: async (p) => allowedIds.has(p.id),
    };
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const turn = (over: Partial<Parameters<typeof pushOnChatTurn>[0]> = {}) => ({
    projectId: 'p1', workstream: 'main', session: 'owner-orchestrator-agent',
    prev: 'working' as const, next: 'idle' as const, event: RESULT, now: 1_000_000, ...over,
  });

  async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0));
  }

  it('sends to everyone who can see the chat and opted in, with the flags on for them', async () => {
    expect(pushOnChatTurn(turn(), deps)).toBe(true);
    await settle();
    expect(sent.map(s => s.endpoint.split('/').pop())).toEqual(['owner', 'collab']);
    const n = sent[0].payload.notification as Record<string, unknown>;
    expect(n.title).toBe('orchestrator');
    expect(n.body).toBe('Your turn · All green.');
    expect(String(n.navigate)).toMatch(/\/chat\/p\/p1$/);
    expect(n.data).toEqual({ key: 'chat-turn:p1:main', kind: 'chat-turn' });
  });

  it('says Done · your turn for a turn that ended without an answer', async () => {
    pushOnChatTurn(turn({ event: { type: 'turn-end', exitCode: 1 } }), deps);
    await settle();
    expect((sent[0].payload.notification as Record<string, unknown>).body).toBe('Done · your turn');
  });

  it('skips a person the flags are off for', async () => {
    allowedIds = new Set(['collab']);
    pushOnChatTurn(turn(), deps);
    await settle();
    expect(sent.map(s => s.endpoint.split('/').pop())).toEqual(['collab']);
  });

  it('sends nothing for a stopped turn, a non-transition, an archived project or without VAPID', async () => {
    expect(pushOnChatTurn(turn({ event: { type: 'turn-end', signal: 'SIGTERM' } }), deps)).toBe(false);
    expect(pushOnChatTurn(turn({ prev: 'idle' }), deps)).toBe(false);
    expect(pushOnChatTurn(turn({ workstream: 'feat' }), { ...deps, send: { ...deps.send, vapid: null } })).toBe(false);
    audience = null;
    expect(pushOnChatTurn(turn({ projectId: 'p2' }), deps)).toBe(true);
    await settle();
    expect(sent).toEqual([]);
  });

  it('holds a second answer of the same chat inside the cooldown, not another chat', async () => {
    expect(pushOnChatTurn(turn(), deps)).toBe(true);
    expect(pushOnChatTurn(turn({ now: 1_002_000 }), deps)).toBe(false);
    expect(pushOnChatTurn(turn({ workstream: 'feat', now: 1_002_000 }), deps)).toBe(true);
    await settle();
    expect(sent).toHaveLength(4);
  });
});
