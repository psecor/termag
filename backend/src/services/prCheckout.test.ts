import { describe, expect, it, vi } from 'vitest';
import { checkoutLinkKey, findPrCheckout, isPathUnder, type CheckoutCandidate } from './prCheckout';

const HOME = '/home/olive';
const host = { userId: 'u-owner', instanceId: 'box-1' };
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const WEBAPP = 'https://github.com/example-org/webapp.git';
const HANDBOOK = 'https://github.com/example-team/ffeld-termag.git';

const main: CheckoutCandidate = { dir: `${HOME}/termag/projects/Webapp`, workstream: { id: null, name: 'main' }, worktrees: true };
const feature: CheckoutCandidate = { dir: `${HOME}/termag/projects/Webapp/.worktrees/feature-x`, workstream: { id: 'ws1', name: 'feature-x' }, worktrees: false };
const src: CheckoutCandidate = { dir: `${HOME}/src/webapp`, workstream: null, worktrees: true };

/** A box whose directories answer the light git-branch-state from `boxDirs`; absent ones fail as git does. */
function box(boxDirs: Record<string, Record<string, unknown> | Error>) {
  return vi.fn(async (_h: unknown, _type: string, payload: Record<string, unknown>) => {
    const got = boxDirs[payload.cwd as string];
    if (got instanceof Error) throw got;
    if (!got) throw new Error(`Command failed: git -C ${payload.cwd} rev-parse --show-toplevel\nfatal: cannot change to '${payload.cwd}': No such file or directory`);
    return { light: true, dir: payload.cwd, toplevel: payload.cwd, ...got };
  });
}

const lookup = (send: ReturnType<typeof box>, over: Partial<Parameters<typeof findPrCheckout>[0]> = {}, connected = true) =>
  findPrCheckout(
    { host, home: HOME, candidates: [main, feature, src], asking: main.dir, repo: 'example-org/webapp', branch: 'retro-mode', headOid: HEAD, ...over },
    { connected: () => connected, send },
  );

describe('findPrCheckout', () => {
  it("finds ~/src/<repo> when the asking project's own checkout is another repository (webapp#76005)", async () => {
    const send = box({
      [main.dir]: { origin: HANDBOOK, branch: 'main', head: OTHER, worktrees: [] },
      [feature.dir]: { origin: HANDBOOK, branch: 'feat/x', head: OTHER },
      [src.dir]: { origin: WEBAPP, branch: 'retro-mode', head: HEAD, worktrees: [{ path: src.dir, branch: 'retro-mode', head: HEAD }] },
    });
    expect(await lookup(send)).toEqual({ ok: true, dir: src.dir, realDir: src.dir, workstream: null, repo: 'example-org/webapp', branch: 'retro-mode', head: HEAD });
    expect(send).toHaveBeenCalledWith(host, 'git-branch-state', { cwd: src.dir, light: true, worktrees: true }, 10_000);
    expect(send).toHaveBeenCalledWith(host, 'git-branch-state', { cwd: feature.dir, light: true }, 10_000);
  });

  it("prefers the asking workstream's own checkout, as today's rule does, over another match and over an unread directory", async () => {
    const send = box({
      [main.dir]: { origin: WEBAPP, branch: 'retro-mode', head: OTHER, worktrees: [] },
      [feature.dir]: new Error('git-branch-state timed out'),
      [src.dir]: { origin: WEBAPP, branch: 'retro-mode', head: HEAD, worktrees: [] },
    });
    expect(await lookup(send)).toMatchObject({ ok: true, dir: main.dir, workstream: { id: null, name: 'main' } });
  });

  it('stores a match that is another workstream\'s own checkout as that workstream', async () => {
    const send = box({
      [main.dir]: { origin: WEBAPP, branch: 'main', head: OTHER, worktrees: [] },
      [feature.dir]: { origin: WEBAPP, branch: 'retro-mode', head: HEAD },
    });
    expect(await lookup(send)).toMatchObject({ ok: true, dir: feature.dir, workstream: { id: 'ws1', name: 'feature-x' } });
  });

  it('an unread directory blocks every other match: it may be the PR\'s', async () => {
    const send = box({
      [main.dir]: { origin: HANDBOOK, branch: 'main', head: OTHER, worktrees: [] },
      [feature.dir]: new Error('git-branch-state timed out'),
      [src.dir]: { origin: WEBAPP, branch: 'retro-mode', head: HEAD, worktrees: [] },
    });
    expect(await lookup(send)).toMatchObject({ ok: false, reason: 'checkout-unreadable' });
    // A box that isn't connected can't be read at all.
    expect(await lookup(box({}), {}, false)).toMatchObject({ ok: false, reason: 'checkout-unreadable' });
  });

  it('a directory that is not there, or not a checkout, is absent rather than unread', async () => {
    const send = box({
      [main.dir]: { origin: HANDBOOK, branch: 'main', head: OTHER, worktrees: [] },
      [feature.dir]: new Error('fatal: not a git repository (or any of the parent directories): .git'),
    });
    expect(await lookup(send)).toEqual({ ok: false, reason: 'no-checkout', looked: [main.dir, feature.dir, src.dir] });
  });

  it('several matches: the one at the PR head wins, else it is ambiguous', async () => {
    const atHead = box({
      [main.dir]: { origin: HANDBOOK, branch: 'main', head: OTHER, worktrees: [] },
      [src.dir]: {
        origin: WEBAPP, branch: 'retro-mode', head: OTHER,
        worktrees: [{ path: src.dir, branch: 'retro-mode', head: OTHER }, { path: `${src.dir}/.worktrees/demo`, branch: 'retro-mode', head: HEAD }],
      },
    });
    // A worktree shares its checkout's origin.
    expect(await lookup(atHead)).toMatchObject({ ok: true, dir: `${src.dir}/.worktrees/demo`, workstream: null, head: HEAD });

    const neither = box({
      [main.dir]: { origin: HANDBOOK, branch: 'main', head: OTHER, worktrees: [] },
      [src.dir]: {
        origin: WEBAPP, branch: 'retro-mode', head: OTHER,
        worktrees: [{ path: src.dir, branch: 'retro-mode', head: OTHER }, { path: `${src.dir}/.worktrees/demo`, branch: 'retro-mode', head: OTHER }],
      },
    });
    expect(await lookup(neither)).toMatchObject({ ok: false, reason: 'ambiguous-checkout' });
  });

  it('a directory inside a checkout is not that checkout, and paths outside the owner\'s home are never asked or taken', async () => {
    const inside = vi.fn(async (_h: unknown, _t: string, payload: Record<string, unknown>) => (
      payload.cwd === src.dir
        ? { light: true, dir: src.dir, toplevel: `${HOME}/src`, origin: WEBAPP, branch: 'retro-mode', head: HEAD, worktrees: [{ path: '/data/webapp', branch: 'retro-mode', head: HEAD }] }
        : { light: true, dir: payload.cwd, toplevel: payload.cwd, origin: HANDBOOK, branch: 'main', head: OTHER, worktrees: [] }
    ));
    const outside: CheckoutCandidate = { dir: '/etc', workstream: null, worktrees: false };
    expect(await findPrCheckout(
      { host, home: HOME, candidates: [main, src, outside], asking: main.dir, repo: 'example-org/webapp', branch: 'retro-mode', headOid: HEAD },
      { connected: () => true, send: inside },
    )).toEqual({ ok: false, reason: 'no-checkout', looked: [main.dir, src.dir] });
    expect(inside).not.toHaveBeenCalledWith(host, 'git-branch-state', expect.objectContaining({ cwd: '/etc' }), expect.anything());
  });

  it('keeps a symlinked folder as asked, keyed by where it resolves, which may be outside the home; a worktree there is not taken', async () => {
    const send = vi.fn(async (_h: unknown, _t: string, payload: Record<string, unknown>) => (
      payload.cwd === src.dir
        ? { light: true, dir: '/data/olive/webapp', toplevel: '/data/olive/webapp', origin: WEBAPP, branch: 'retro-mode', head: HEAD, worktrees: [{ path: '/data/olive/webapp', branch: 'retro-mode', head: HEAD }, { path: '/data/olive/other', branch: 'retro-mode', head: HEAD }] }
        : { light: true, dir: payload.cwd, toplevel: payload.cwd, origin: HANDBOOK, branch: 'main', head: OTHER, worktrees: [] }
    ));
    expect(await lookup(send as any)).toEqual({ ok: true, dir: src.dir, realDir: '/data/olive/webapp', workstream: null, repo: 'example-org/webapp', branch: 'retro-mode', head: HEAD });
  });

  it('compares the repository without case, and ignores an origin that is not GitHub', async () => {
    const send = box({
      [main.dir]: { origin: 'https://github.com/Example-Org/Webapp.git', branch: 'retro-mode', head: HEAD, worktrees: [] },
      [src.dir]: { origin: '/srv/mirror/webapp.git', branch: 'retro-mode', head: HEAD, worktrees: [] },
    });
    expect(await lookup(send)).toMatchObject({ ok: true, dir: main.dir, repo: 'Example-Org/Webapp' });
  });

  it('an agent without the light form keeps today\'s rule', async () => {
    const full = vi.fn(async () => ({ branch: 'retro-mode', origin: WEBAPP, dirty: false }));
    expect(await lookup(full as any)).toMatchObject({ ok: false, reason: 'outdated-agent' });
    const ancient = vi.fn(async () => { throw new Error('Unknown command: git-branch-state'); });
    expect(await lookup(ancient as any)).toMatchObject({ ok: false, reason: 'outdated-agent' });
  });
});

describe('checkoutLinkKey and isPathUnder', () => {
  it('keys a checkout share by box and directory', () => {
    const key = checkoutLinkKey(host, src.dir);
    expect(key).toMatch(/^box:box-1:dir:[0-9a-f]{16}$/);
    expect(checkoutLinkKey(host, src.dir)).toBe(key);
    expect(checkoutLinkKey({ ...host, instanceId: 'box-2' }, src.dir)).not.toBe(key);
    expect(checkoutLinkKey(host, main.dir)).not.toBe(key);
    expect(checkoutLinkKey({ userId: 'u-owner', instanceId: null }, src.dir)).toMatch(/^box:legacy:u-owner:dir:/);
    // Unique across all owners: two owners whose checkouts resolve to one directory never share a key.
    expect(checkoutLinkKey({ ...host, userId: 'u-other' }, src.dir)).not.toBe(key);
  });

  it('takes only plain absolute paths under the home directory', () => {
    expect(isPathUnder(HOME, `${HOME}/src/webapp`)).toBe(true);
    expect(isPathUnder(HOME, HOME)).toBe(false);
    expect(isPathUnder(HOME, `${HOME}/src/../../root`)).toBe(false);
    expect(isPathUnder(HOME, `${HOME}//src`)).toBe(false);
    expect(isPathUnder(HOME, '/home/olivia/src')).toBe(false);
    expect(isPathUnder(HOME, 'src/webapp')).toBe(false);
    expect(isPathUnder(HOME, `${HOME}/src/a\0b`)).toBe(false);
  });
});
