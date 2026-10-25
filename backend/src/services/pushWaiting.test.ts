import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../db';
import { getAllStatuses } from './status';
import { resolveSessionProject } from './sessionResolver';
import { webPushEnabledFor } from './pushFlag';
import {
  countOwnerWaiting, pushOnWaitingTransition, resetPushWaitingState, shouldPushWaiting, waitingChatMuted,
  PUSH_WAITING_COOLDOWN_MS,
} from './pushWaiting';
import type { PushStore, SendDeps } from './webPush';
import type { AgentStatus } from '../types/index';

vi.mock('../db', () => ({ prisma: { project: { findUnique: vi.fn() }, user: { findUnique: vi.fn() } } }));
vi.mock('./status', () => ({ getAllStatuses: vi.fn(() => new Map()) }));
vi.mock('./pushFlag', () => ({ webPushEnabledFor: vi.fn(async () => true) }));
vi.mock('./sessionResolver', () => ({
  resolveSessionProject: vi.fn(),
  isAmbiguousSession: (v: unknown) => !!v && typeof v === 'object' && (v as { ambiguous?: boolean }).ambiguous === true,
}));

describe('shouldPushWaiting', () => {
  const now = 1_000_000;
  it.each<[AgentStatus['status'] | undefined, AgentStatus['status'], boolean]>([
    [undefined, 'waiting', true],
    ['working', 'waiting', true],
    ['idle', 'waiting', true],
    ['not_running', 'waiting', true],
    ['waiting', 'waiting', false],
    ['waiting', 'working', false],
    ['working', 'idle', false],
    [undefined, 'working', false],
  ])('%s → %s: %s', (prev, next, expected) => {
    expect(shouldPushWaiting(prev, next, null, now)).toBe(expected);
  });

  it('holds a re-entry inside the cooldown, and lets it through after', () => {
    expect(shouldPushWaiting('working', 'waiting', now - 5_000, now)).toBe(false);
    expect(shouldPushWaiting('working', 'waiting', now - PUSH_WAITING_COOLDOWN_MS + 1, now)).toBe(false);
    expect(shouldPushWaiting('working', 'waiting', now - PUSH_WAITING_COOLDOWN_MS, now)).toBe(true);
    expect(PUSH_WAITING_COOLDOWN_MS).toBe(30_000);
  });
});

describe('countOwnerWaiting', () => {
  it("counts the owner's waiting workstreams once each", () => {
    const r = (userId: string, projectId: string | null, workstream: string | null) =>
      ({ resolved: { userId, instanceId: null, projectId, workstream } });
    expect(countOwnerWaiting([
      r('u1', 'p1', 'main'),
      r('u1', 'p1', 'main'), // the ctrl pane of the same workstream
      r('u1', 'p1', 'feat'),
      r('u1', 'p2', 'main'),
      r('u2', 'p3', 'main'),
      r('u1', null, null),
      { resolved: null },
    ], 'u1')).toBe(3);
  });
});

const VAPID = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:ops@example.com' };
const P256DH = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 7)]).toString('base64url');
const AUTH = Buffer.alloc(16, 3).toString('base64url');

function deps(vapid = VAPID as SendDeps['vapid']) {
  const store: PushStore = {
    listForUser: vi.fn(async () => [{ id: 's1', endpoint: 'https://web.push.apple.com/abc', p256dh: P256DH, auth: AUTH }]),
    remove: vi.fn(async () => {}),
    markUsed: vi.fn(async () => {}),
    markFailed: vi.fn(async () => {}),
  };
  const transport = vi.fn(async () => ({ statusCode: 201 }));
  return { store, transport, vapid, log: () => {} } satisfies SendDeps;
}

const flush = () => new Promise(r => setTimeout(r, 0));

describe('pushOnWaitingTransition', () => {
  beforeEach(() => {
    resetPushWaitingState();
    vi.mocked(resolveSessionProject).mockReset();
    vi.mocked(prisma.project.findUnique).mockReset();
    vi.stubEnv('FRONTEND_URL', 'https://example.com');
    vi.stubEnv('BASE_PATH', '/termag');
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("pushes the owner once on entering waiting, with the owner's waiting count", async () => {
    vi.mocked(resolveSessionProject).mockImplementation(async (session) => {
      if (session === 'alice-cx-agent') return { userId: 'u1', instanceId: 'box-a', projectId: 'p1', workstream: 'main' };
      if (session === 'alice-other-feat-agent') return { userId: 'u1', instanceId: 'box-a', projectId: 'p2', workstream: 'feat' };
      return null;
    });
    vi.mocked(prisma.project.findUnique).mockResolvedValue({ name: 'cx', user: { unixUsername: 'alice' } } as never);
    vi.mocked(getAllStatuses).mockReturnValue(new Map<string, AgentStatus>([
      ['box-a|alice-cx-agent', { status: 'waiting', updatedAt: new Date() }],
      ['box-a|alice-other-feat-agent', { status: 'waiting', updatedAt: new Date() }],
      ['box-a|alice-third-agent', { status: 'working', updatedAt: new Date() }],
      ['box-b|bob-cx-agent', { status: 'waiting', updatedAt: new Date() }],
    ]));
    const d = deps();
    expect(pushOnWaitingTransition({
      session: 'alice-cx-agent', instanceId: 'box-a', prev: 'working', next: 'waiting',
      message: 'Claude needs your permission to use Bash', waitingReason: 'approval', now: 1000,
    }, d)).toBe(true);
    await flush(); await flush();

    expect(d.store.listForUser).toHaveBeenCalledWith('u1');
    expect(d.transport).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(d.transport.mock.calls[0][1] as string);
    expect(sent).toEqual({
      web_push: 8030,
      mutable: true,
      notification: {
        title: 'cx',
        body: 'Claude needs your permission to use Bash',
        navigate: 'https://example.com/termag/m/p/p1',
        tag: 'box-a|alice-cx-agent',
        data: { key: 'box-a|alice-cx-agent' },
      },
      app_badge: '2',
      termag: { session: 'alice-cx-agent', projectId: 'p1', workstream: 'main' },
    });
    // bob's waiting session is never resolved for alice's badge.
    expect(vi.mocked(resolveSessionProject).mock.calls.map(c => c[0])).not.toContain('bob-cx-agent');
  });

  it('does not re-notify a session that waits again inside 30 s', () => {
    vi.mocked(resolveSessionProject).mockResolvedValue(null);
    const d = deps();
    expect(pushOnWaitingTransition({ session: 's', instanceId: null, prev: 'working', next: 'waiting', now: 0 }, d)).toBe(true);
    expect(pushOnWaitingTransition({ session: 's', instanceId: null, prev: 'working', next: 'waiting', now: 10_000 }, d)).toBe(false);
    expect(pushOnWaitingTransition({ session: 's', instanceId: 'box', prev: 'working', next: 'waiting', now: 10_000 }, d)).toBe(true);
    expect(pushOnWaitingTransition({ session: 's', instanceId: null, prev: 'idle', next: 'waiting', now: 31_000 }, d)).toBe(true);
  });

  it('does nothing for waiting → waiting, a non-waiting status, or with push off', () => {
    const d = deps();
    expect(pushOnWaitingTransition({ session: 's', instanceId: null, prev: 'waiting', next: 'waiting' }, d)).toBe(false);
    expect(pushOnWaitingTransition({ session: 's', instanceId: null, prev: 'working', next: 'idle' }, d)).toBe(false);
    expect(pushOnWaitingTransition({ session: 's', instanceId: null, prev: 'working', next: 'waiting' }, deps(null))).toBe(false);
    expect(resolveSessionProject).not.toHaveBeenCalled();
  });

  it('skips a session with no project (cloud runner, ambiguous name) and swallows resolver errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps();
    vi.mocked(resolveSessionProject).mockResolvedValueOnce({ ambiguous: true });
    pushOnWaitingTransition({ session: 'a', instanceId: null, prev: 'working', next: 'waiting' }, d);
    vi.mocked(resolveSessionProject).mockRejectedValueOnce(new Error('db down'));
    pushOnWaitingTransition({ session: 'b', instanceId: null, prev: 'working', next: 'waiting' }, d);
    await flush(); await flush();
    expect(d.transport).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/waiting push for b failed/), 'db down');
    warn.mockRestore();
  });
});

describe('mobile-web-push-enabled off for the owner', () => {
  beforeEach(() => {
    resetPushWaitingState();
    vi.mocked(resolveSessionProject).mockReset();
    vi.mocked(prisma.user.findUnique).mockReset();
    vi.mocked(resolveSessionProject).mockResolvedValue({ userId: 'u1', instanceId: 'box-a', projectId: 'p1', workstream: 'main' });
    vi.mocked(prisma.project.findUnique).mockResolvedValue({ name: 'cx', user: { unixUsername: 'alice' } } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ pushMutesChat: true, pushSubscriptions: [{ lastUsedAt: null, failedAt: null }] } as never);
    vi.mocked(webPushEnabledFor).mockResolvedValue(false);
  });
  afterEach(() => { vi.mocked(webPushEnabledFor).mockResolvedValue(true); });

  it('sends nothing and never mutes the chat posts', async () => {
    const d = deps();
    pushOnWaitingTransition({ session: 'alice-cx-agent', instanceId: 'box-a', prev: 'working', next: 'waiting', now: 1000 }, d);
    await flush(); await flush();
    expect(d.transport).not.toHaveBeenCalled();
    expect(await waitingChatMuted('alice-cx-agent', 'box-a', d)).toBe(false);
    expect(webPushEnabledFor).toHaveBeenCalledWith('u1');
  });
});

describe('waitingChatMuted', () => {
  beforeEach(() => {
    vi.mocked(resolveSessionProject).mockReset();
    vi.mocked(prisma.user.findUnique).mockReset();
    vi.mocked(resolveSessionProject).mockResolvedValue({ userId: 'u1', instanceId: null, projectId: 'p1', workstream: 'main' });
  });

  it('mutes with pushMutesChat and a live subscription', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ pushMutesChat: true, pushSubscriptions: [{ lastUsedAt: null, failedAt: null }] } as never);
    expect(await waitingChatMuted('s', null, deps())).toBe(true);
  });

  it('does not mute without the preference, without a live subscription, or with push off', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ pushMutesChat: false, pushSubscriptions: [{ lastUsedAt: null, failedAt: null }] } as never);
    expect(await waitingChatMuted('s', null, deps())).toBe(false);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ pushMutesChat: true, pushSubscriptions: [] } as never);
    expect(await waitingChatMuted('s', null, deps())).toBe(false);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ pushMutesChat: true, pushSubscriptions: [{ lastUsedAt: null, failedAt: new Date() }] } as never);
    expect(await waitingChatMuted('s', null, deps())).toBe(false);
    expect(await waitingChatMuted('s', null, deps(null))).toBe(false);
  });

  it('fails open when the lookup throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(prisma.user.findUnique).mockRejectedValue(new Error('db down'));
    expect(await waitingChatMuted('s', null, deps())).toBe(false);
    warn.mockRestore();
  });
});
