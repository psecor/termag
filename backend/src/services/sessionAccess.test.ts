import { describe, it, expect, vi } from 'vitest';

// Alice owns myproj (workstreams main and feature) and myproj-secret; Bob has
// a share on myproj only. Their names overlap the way the bypass needs.
const projects = [
  { id: 'p-myproj', name: 'myproj', userId: 'u-alice', instanceId: 'box-a', archived: false, setupStatus: 'ready', workstreams: ['main', 'feature'] },
  { id: 'p-secret', name: 'myproj-secret', userId: 'u-alice', instanceId: 'box-a', archived: false, setupStatus: 'ready', workstreams: ['main'] },
  { id: 'p-old', name: 'old', userId: 'u-alice', instanceId: 'box-a', archived: true, setupStatus: 'ready', workstreams: ['main'] },
];
const shares = [{ projectId: 'p-myproj', userId: 'u-bob' }, { projectId: 'p-old', userId: 'u-bob' }];
vi.mock('../db', () => ({
  prisma: {
    project: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const p = projects.find(x => x.id === where.id);
        return p ? { ...p, user: { id: p.userId, unixUsername: 'alice' }, workstreams: p.workstreams.map(name => ({ name })) } : null;
      }),
    },
    projectShare: {
      findUnique: vi.fn(async ({ where }: { where: { projectId_userId: { projectId: string; userId: string } } }) =>
        shares.find(s => s.projectId === where.projectId_userId.projectId && s.userId === where.projectId_userId.userId) ?? null),
    },
  },
}));

const { legalSessions, isSessionRole, isOnCallerHost, terminalSessionAccess, SESSION_ROLES } = await import('./sessionAccess');

describe('legalSessions', () => {
  it('builds every role for main, collapsing the workstream segment', () => {
    expect(legalSessions('alice', 'termag', ['main'])).toEqual([
      'alice-termag-agent', 'alice-termag-ctrl', 'alice-termag-data', 'alice-termag-data-ctrl', 'alice-termag-review',
    ]);
  });
  it('threads non-main workstreams through the name', () => {
    expect(legalSessions('alice', 'termag', ['feature'])).toContain('alice-termag-feature-agent');
    expect(legalSessions('alice', 'termag', ['feature'])).toContain('alice-termag-feature-data-ctrl');
  });
  it('defaults to main when a project has no workstreams', () => {
    expect(legalSessions('alice', 'termag', [])).toEqual(legalSessions('alice', 'termag', ['main']));
  });
  it('covers all workstreams × roles', () => {
    expect(legalSessions('alice', 'p', ['main', 'a', 'b'])).toHaveLength(3 * SESSION_ROLES.length);
  });
  it('handles hyphenated project and workstream names verbatim', () => {
    expect(legalSessions('alice', 'ic-sample-app', ['small-fixes']))
      .toContain('alice-ic-sample-app-small-fixes-agent');
  });
});

describe('isSessionRole', () => {
  it('accepts the four roles and rejects anything else', () => {
    for (const r of SESSION_ROLES) expect(isSessionRole(r)).toBe(true);
    expect(isSessionRole('shell')).toBe(false);
    expect(isSessionRole('')).toBe(false);
    expect(isSessionRole(undefined)).toBe(false);
  });
});

describe('isOnCallerHost', () => {
  it('matches a box token to projects on that box only', () => {
    expect(isOnCallerHost('box-1', 'box-1')).toBe(true);
    expect(isOnCallerHost('box-2', 'box-1')).toBe(false);
    expect(isOnCallerHost(null, 'box-1')).toBe(false);
  });
  it('matches a per-user token to box-less projects', () => {
    expect(isOnCallerHost(null, null)).toBe(true);
    expect(isOnCallerHost('box-1', null)).toBe(false);
  });
  it('is false for a browser session, which has no host', () => {
    expect(isOnCallerHost(null, undefined)).toBe(false);
    expect(isOnCallerHost('box-1', undefined)).toBe(false);
  });
});

describe('terminalSessionAccess', () => {
  it("lets a collaborator attach the shared project's own sessions", async () => {
    const access = await terminalSessionAccess('u-bob', 'p-myproj', 'alice-myproj-agent');
    expect(access).toMatchObject({ role: 'agent', workstream: 'main', isOwner: false, session: 'alice-myproj-agent' });
    expect(await terminalSessionAccess('u-bob', 'p-myproj', 'alice-myproj-feature-data-ctrl', 'feature'))
      .toMatchObject({ role: 'data-ctrl', workstream: 'feature' });
  });

  it("carries what the socket routes on: the owner, the box and the project's setup", async () => {
    expect(await terminalSessionAccess('u-alice', 'p-myproj', 'alice-myproj-ctrl')).toMatchObject({
      isOwner: true,
      host: { userId: 'u-alice', instanceId: 'box-a' },
      project: { id: 'p-myproj', userId: 'u-alice', ownerUsername: 'alice', instanceId: 'box-a', setupStatus: 'ready' },
    });
  });

  // `tmux attach-session -t alice-myproj-secret?ctrl` attaches
  // alice-myproj-secret-ctrl (fnmatch), and `-t alice-myproj-a` the only
  // session it prefixes (verified on tmux 3.4). The legacy branch parsed
  // project "myproj" out of the first and let Bob's share through.
  it('refuses a tmux pattern or prefix that would reach another project', async () => {
    for (const target of ['alice-myproj-secret?ctrl', 'alice-myproj-s*l', 'alice-myproj-[s]ecret-agent', 'alice-myproj-a', 'alice-myproj-secret-ctrl']) {
      expect(await terminalSessionAccess('u-bob', 'p-myproj', target)).toEqual({ refusal: 'session/project mismatch' });
    }
  });

  it("refuses a workstream the project does not have, which would rebuild another project's name", async () => {
    // myproj + workstream "secret" builds myproj-secret's main ctrl.
    expect(await terminalSessionAccess('u-bob', 'p-myproj', 'alice-myproj-secret-ctrl', 'secret'))
      .toEqual({ refusal: 'session/project mismatch' });
  });

  it('refuses a project the caller neither owns nor has a share on, an archived one and an unknown one', async () => {
    expect(await terminalSessionAccess('u-bob', 'p-secret', 'alice-myproj-secret-ctrl')).toEqual({ refusal: 'session forbidden' });
    expect(await terminalSessionAccess('u-bob', 'p-old', 'alice-old-agent')).toEqual({ refusal: 'session forbidden' });
    expect(await terminalSessionAccess('u-bob', 'p-none', 'alice-myproj-agent')).toEqual({ refusal: 'session forbidden' });
  });

  it("lets the owner attach that other project through its own id", async () => {
    expect(await terminalSessionAccess('u-alice', 'p-secret', 'alice-myproj-secret-ctrl')).toMatchObject({ role: 'ctrl', isOwner: true });
  });
});
