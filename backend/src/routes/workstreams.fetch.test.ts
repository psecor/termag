import { beforeEach, describe, expect, it, vi } from 'vitest';

// A fetch before the branch-off: an automation run's (system), or a person's
// from the browser's create body (New session's worktree, frontend
// pages/chat/NewChat.tsx), which only a box that marks the tree attended may
// do (agent/worktree-fetch.js).
vi.mock('../db', () => ({
  prisma: {
    project: { findFirst: vi.fn() },
    workstream: { findUnique: vi.fn(), findMany: vi.fn(async () => []), create: vi.fn(), update: vi.fn(async () => ({})) },
    workflow: { findMany: vi.fn(async () => []), create: vi.fn() },
  },
}));
vi.mock('../services/agentRegistry', () => ({
  isProjectAgentConnected: vi.fn(() => true),
  projectAgentCapabilities: vi.fn(() => []),
  sendForProject: vi.fn(),
}));
const flag = vi.hoisted(() => ({ on: true }));
vi.mock('../services/featureFlags', () => ({ boolVariation: vi.fn(async () => flag.on) }));
vi.mock('../slack/channels', () => ({ createChannelFor: vi.fn(async () => null), archiveChannel: vi.fn() }));
vi.mock('../slack/lts', () => ({ setNotificationTarget: vi.fn(), renameNotificationTargets: vi.fn() }));

const { prisma } = await import('../db');
const registry = await import('../services/agentRegistry');
const ld = await import('../services/featureFlags');
const {
  browserChatSpace, browserFetchAllowed, createWorkstreamBody, createWorkstreamFor, WORKTREE_FETCH_ATTENDED_CAPABILITY, WORKTREE_FETCH_CAPABILITY,
} = await import('./workstreams');
const ALLOW = { allowFetch: true };

const USER = { id: 'u1', unixUsername: 'psecor' } as Express.User;
const PROJECT = {
  id: 'p1', userId: 'u1', name: 'termag', kind: 'normal', instanceId: 'box1', setupStatus: 'none',
  repoUrl: 'https://github.com/example-org/termag.git',
  user: { unixUsername: 'psecor' }, instance: { hostHome: '/home/psecor', status: 'ready' },
};
const send = vi.mocked(registry.sendForProject);
const caps = vi.mocked(registry.projectAgentCapabilities);
// New session's body for a worktree from a fresh origin/main, on Full access and on Read only.
const personBody = { name: 'fix-login', baseRef: 'origin/main', fetch: { remoteBranch: 'main', fullAccess: true } };
const readOnlyBody = { name: 'fix-login', baseRef: 'origin/main', fetch: { remoteBranch: 'main', fullAccess: false } };

function worktreeAdd() {
  return send.mock.calls.find(c => c[1] === 'git-worktree-add')?.[2] as { baseRef?: string; fetch?: string; attended?: boolean; readOnly?: boolean } | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  flag.on = true;
  vi.mocked(prisma.project.findFirst).mockResolvedValue(PROJECT as never);
  vi.mocked(prisma.workstream.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.workstream.create).mockImplementation((async ({ data }: { data: object }) => ({ id: 'w1', ...data })) as never);
  send.mockResolvedValue({ ok: true, path: '/x', fetched: true, baseSha: 'abc123' });
});

describe('createWorkstreamBody', () => {
  it('keeps name, branch and base, and a fetch only for a valid branch name', () => {
    expect(createWorkstreamBody({ ...personBody, branch: 'fix-login' }, ALLOW)).toEqual({
      name: 'fix-login', branch: 'fix-login', baseRef: 'origin/main', fetch: { remoteBranch: 'main' }, attended: true, readOnly: false,
    });
    expect(createWorkstreamBody({ name: 'a', fetch: { remoteBranch: 'main; rm -rf ~' } }, ALLOW)).toEqual({ name: 'a', branch: undefined, baseRef: undefined });
    expect(createWorkstreamBody({ name: 'a', fetch: 'main' }, ALLOW)).not.toHaveProperty('fetch');
    expect(createWorkstreamBody({ name: 'a', fetch: 'main' }, ALLOW)).not.toHaveProperty('attended');
    // Nothing from the browser can say it is a system (unattended) caller.
    expect(createWorkstreamBody({ name: 'a', system: true, attended: false }, ALLOW)).toEqual({ name: 'a', branch: undefined, baseRef: undefined });
    expect(createWorkstreamBody(null, ALLOW)).toEqual({ name: undefined, branch: undefined, baseRef: undefined });
  });

  it('is Read only unless the person picked Full access', () => {
    expect(createWorkstreamBody(readOnlyBody, ALLOW)).toMatchObject({ fetch: { remoteBranch: 'main' }, attended: true, readOnly: true });
    // A body from before the pill, or one that says anything else, is Read only too.
    expect(createWorkstreamBody({ name: 'a', fetch: { remoteBranch: 'main' } }, ALLOW)).toMatchObject({ readOnly: true });
    expect(createWorkstreamBody({ name: 'a', fetch: { remoteBranch: 'main', fullAccess: 'yes' } }, ALLOW)).toMatchObject({ readOnly: true });
  });

  it('drops the fetch, keeping the rest, when it is not allowed', () => {
    expect(createWorkstreamBody(personBody, { allowFetch: false })).toEqual({ name: 'fix-login', branch: undefined, baseRef: 'origin/main' });
  });
});

describe("browserChatSpace: New session's space for a worktree session", () => {
  it('resolves a named space or No space for the caller, and nothing else', async () => {
    const resolve = vi.fn(async (name: string | null | undefined) => (name === 'notes' ? { spaceId: 's1' } : name === null ? { spaceId: null } : null));
    expect(await browserChatSpace(USER, { name: 'a', chatSpace: 'notes' }, resolve as never)).toEqual({ spaceId: 's1' });
    expect(resolve).toHaveBeenCalledWith('notes', USER.id);
    expect(await browserChatSpace(USER, { name: 'a', chatSpace: null }, resolve as never)).toEqual({ spaceId: null });
    // A space they can't use, or a body that names none, leaves the chat to its box's first grant.
    expect(await browserChatSpace(USER, { name: 'a', chatSpace: 'theirs' }, resolve as never)).toBeNull();
    resolve.mockClear();
    expect(await browserChatSpace(USER, { name: 'a' }, resolve as never)).toBeNull();
    expect(await browserChatSpace(USER, { name: 'a', chatSpace: 7 }, resolve as never)).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
    // A failed lookup is no space choice, never a failed create.
    expect(await browserChatSpace(USER, { chatSpace: 'notes' }, (async () => { throw new Error('db down'); }) as never)).toBeNull();
  });
});

describe('browserFetchAllowed: chat-worktree-sessions-enabled', () => {
  it('is the flag for the caller when the body asks for a fetch', async () => {
    expect(await browserFetchAllowed(USER, personBody)).toBe(true);
    expect(ld.boolVariation).toHaveBeenCalledWith('chat-worktree-sessions-enabled', USER, false);
    flag.on = false;
    expect(await browserFetchAllowed(USER, personBody)).toBe(false);
  });

  it('reads no flag for a body without a fetch it would keep', async () => {
    expect(await browserFetchAllowed(USER, { name: 'a' })).toBe(false);
    expect(await browserFetchAllowed(USER, { name: 'a', fetch: { remoteBranch: '--upload-pack=x' } })).toBe(false);
    expect(ld.boolVariation).not.toHaveBeenCalled();
  });

  it('off, a person\'s worktree is a plain branch-off from the base, never fetched or attended', async () => {
    flag.on = false;
    caps.mockReturnValue([WORKTREE_FETCH_CAPABILITY, WORKTREE_FETCH_ATTENDED_CAPABILITY]);
    send.mockResolvedValue({ ok: true, path: '/x' });
    const allowFetch = await browserFetchAllowed(USER, personBody);
    const got = await createWorkstreamFor(USER, 'p1', createWorkstreamBody(personBody, { allowFetch }));
    expect(got.status).toBe(201);
    expect(worktreeAdd()).toMatchObject({ baseRef: 'origin/main' });
    expect(worktreeAdd()).not.toHaveProperty('fetch');
    expect(worktreeAdd()).not.toHaveProperty('attended');
  });
});

describe('a fetch before the branch-off', () => {
  it("is a person's, attended, on a box that can mark it so", async () => {
    caps.mockReturnValue([WORKTREE_FETCH_CAPABILITY, WORKTREE_FETCH_ATTENDED_CAPABILITY]);
    const got = await createWorkstreamFor(USER, 'p1', createWorkstreamBody(personBody, ALLOW));
    expect(got.status).toBe(201);
    expect(worktreeAdd()).toMatchObject({ baseRef: 'origin/main', fetch: 'main', attended: true });
    expect(got.body).toMatchObject({ fetched: true });
  });

  it("refuses a person's Full access fetch on a box that would mark it an automation's, rather than branch off the checkout", async () => {
    // New session said origin/<default>, fetched now; a branch-off from the checkout would be other code.
    for (const boxCaps of [[WORKTREE_FETCH_CAPABILITY], []]) {
      send.mockClear();
      caps.mockReturnValue(boxCaps);
      const got = await createWorkstreamFor(USER, 'p1', createWorkstreamBody(personBody, ALLOW));
      expect(got.status).toBe(409);
      expect(got.body).toMatchObject({ error: expect.stringContaining('from a fresh origin') });
      expect(worktreeAdd()).toBeUndefined();
    }
  });

  it("fetches a person's Read only tree asking the box never to make it their own", async () => {
    caps.mockReturnValue([WORKTREE_FETCH_CAPABILITY, WORKTREE_FETCH_ATTENDED_CAPABILITY]);
    const got = await createWorkstreamFor(USER, 'p1', createWorkstreamBody(readOnlyBody, ALLOW));
    expect(got.status).toBe(201);
    expect(worktreeAdd()).toMatchObject({ baseRef: 'origin/main', fetch: 'main', readOnly: true });
    expect(worktreeAdd()).not.toHaveProperty('attended');
  });

  it("refuses a person's Read only fetch on a box that cannot keep it read-only, rather than branch off the checkout", async () => {
    // A box that fetches but would mark origin/<default> its own (an older agent) would give the pick an open mode.
    for (const boxCaps of [[WORKTREE_FETCH_CAPABILITY], []]) {
      send.mockClear();
      caps.mockReturnValue(boxCaps);
      const got = await createWorkstreamFor(USER, 'p1', createWorkstreamBody(readOnlyBody, ALLOW));
      expect(got.status).toBe(409);
      expect(got.body).toMatchObject({ error: expect.stringContaining('from a fresh origin') });
      expect(worktreeAdd()).toBeUndefined();
    }
  });

  it("refuses a person's fetched worktree in a project with several repositories, whose pick it could not hold", async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ ...PROJECT, layout: 'workspace' } as never);
    caps.mockReturnValue([WORKTREE_FETCH_CAPABILITY, WORKTREE_FETCH_ATTENDED_CAPABILITY]);
    for (const body of [personBody, readOnlyBody]) {
      const got = await createWorkstreamFor(USER, 'p1', createWorkstreamBody(body, ALLOW));
      expect(got.status).toBe(409);
      expect(got.body).toMatchObject({ error: expect.stringContaining('several repositories') });
    }
    expect(worktreeAdd()).toBeUndefined();
  });

  it("stays an automation run's, unattended, from a system caller", async () => {
    caps.mockReturnValue([WORKTREE_FETCH_CAPABILITY, WORKTREE_FETCH_ATTENDED_CAPABILITY]);
    const got = await createWorkstreamFor(USER, 'p1', { name: 'run-20261023-0900', baseRef: 'origin/main', fetch: { remoteBranch: 'main' }, system: true });
    expect(got.status).toBe(201);
    expect(worktreeAdd()).toMatchObject({ baseRef: 'origin/main', fetch: 'main' });
    expect(worktreeAdd()).not.toHaveProperty('attended');
  });

  it("stays unattended for a person's caller that did not come through New session (the desktop app's startFromOrigin)", async () => {
    // services/cliWorkstreams.ts: a non-system fetch with no `attended`, as on main.
    const desktop = { name: 't3-0a1b2c3d', baseRef: 'origin/main', fetch: { remoteBranch: 'main' } };
    caps.mockReturnValue([WORKTREE_FETCH_CAPABILITY, WORKTREE_FETCH_ATTENDED_CAPABILITY]);
    await createWorkstreamFor(USER, 'p1', desktop);
    expect(worktreeAdd()).toMatchObject({ baseRef: 'origin/main', fetch: 'main' });
    expect(worktreeAdd()).not.toHaveProperty('attended');

    send.mockClear();
    caps.mockReturnValue([WORKTREE_FETCH_CAPABILITY]);
    await createWorkstreamFor(USER, 'p1', desktop);
    // Still fetched from origin, never moved off it onto the checkout.
    expect(worktreeAdd()).toMatchObject({ baseRef: 'origin/main', fetch: 'main' });
    expect(worktreeAdd()).not.toHaveProperty('attended');
  });

  it('is not asked for on a box without the fetch, whoever calls', async () => {
    caps.mockReturnValue([]);
    await createWorkstreamFor(USER, 'p1', { name: 'run-20261023-0900', baseRef: 'origin/main', fetch: { remoteBranch: 'main' }, system: true });
    expect(worktreeAdd()?.fetch).toBeUndefined();
    expect(worktreeAdd()?.baseRef).toBe('origin/main');
  });
});
