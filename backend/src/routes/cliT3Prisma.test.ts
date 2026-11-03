import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CliUser } from '../services/cliStore';

const instances = new Map<string, { id: string; name: string; kind: string; status: string; userId: string }>();
const projectKinds = new Map<string, { userId: string; instanceId: string; kind: string }>();
vi.mock('../db', () => ({
  prisma: {
    instance: {
      findFirst: async ({ where }: { where: { id: string; userId: string } }) => {
        const row = instances.get(where.id);
        return row && row.userId === where.userId ? row : null;
      },
      findUnique: async ({ where }: { where: { id: string } }) => instances.get(where.id) ?? null,
    },
    project: {
      findMany: async ({ where }: { where: { userId: string; instanceId: string; kind: string } }) =>
        [...projectKinds].filter(([, p]) => p.userId === where.userId && p.instanceId === where.instanceId && p.kind === where.kind).map(([id]) => ({ id })),
    },
    user: { findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id, googleEmail: 'a@x', displayName: 'A', unixUsername: 'a', defaultAgentProvider: 'claude' }) },
  },
}));
const listProjects = vi.fn();
vi.mock('../services/cliStorePrisma', () => ({ prismaCliStore: { listProjects: (id: string) => listProjects(id) } }));
vi.mock('../services/agentRegistry', () => ({ instanceAgentTransport: () => null, sendToInstanceAgent: async () => null }));
vi.mock('../services/featureFlags', () => ({ boolVariation: async () => false }));
vi.mock('../services/spaces/spacesRuntime', () => ({ spacesEnabledFor: async () => false }));

const { createPrismaCliT3 } = await import('./cliT3Prisma');
const { TunnelError } = await import('../services/agentTunnels');

const alice: CliUser = { id: 'alice', googleEmail: 'a@x', unixUsername: 'a', displayName: 'A' };

let flagOn: boolean;
let spacesOn: boolean;
let agent: { helloReceived: boolean; capabilities: string[] } | null;
let rpcs: Array<[string, string, Record<string, unknown>]>;
let replies: Record<string, unknown>;
const tunnels = { openTunnel: vi.fn() };

const t3 = createPrismaCliT3({
  tunnels: tunnels as never,
  flag: async () => flagOn,
  spacesFlag: async () => spacesOn,
  transport: () => agent as never,
  send: async (boxId: string, type: string, payload: Record<string, unknown> = {}) => {
    rpcs.push([boxId, type, payload]);
    const r = replies[type];
    if (r instanceof Error) throw r;
    return r;
  },
});

beforeEach(() => {
  instances.clear();
  projectKinds.clear();
  instances.set('box-1', { id: 'box-1', name: 'devbox', kind: 'ec2', status: 'ready', userId: 'alice' });
  instances.set('box-bob', { id: 'box-bob', name: 'bobs', kind: 'ec2', status: 'ready', userId: 'bob' });
  flagOn = true;
  spacesOn = true;
  agent = { helloReceived: true, capabilities: ['t3-v1', 't3-revoke-v1', 'space-sync-v1'] };
  rpcs = [];
  replies = {};
  tunnels.openTunnel.mockReset();
  listProjects.mockReset();
});

describe('access', () => {
  it('is the owner\'s, behind the flag, for a ready box whose agent speaks t3-v1', async () => {
    expect(await t3.access(alice, 'box-1')).toEqual({ ok: true });
    expect(await t3.access(alice, 'box-bob')).toMatchObject({ ok: false, status: 404, code: 'not_found' });
    expect(await t3.access(alice, 'nope')).toMatchObject({ ok: false, status: 404 });
    flagOn = false;
    expect(await t3.access(alice, 'box-1')).toMatchObject({ ok: false, status: 404, code: 'not_found' });
    flagOn = true;
    instances.get('box-1')!.status = 'hibernated';
    expect(await t3.access(alice, 'box-1')).toMatchObject({ ok: false, status: 409, code: 'box_not_ready', parked: 'hibernated' });
    instances.get('box-1')!.status = 'provisioning';
    expect(await t3.access(alice, 'box-1')).toMatchObject({ ok: false, status: 409, code: 'box_not_ready' });
    instances.get('box-1')!.status = 'ready';
    agent = null;
    expect(await t3.access(alice, 'box-1')).toMatchObject({ ok: false, status: 409 });
    agent = { helloReceived: true, capabilities: ['tmux-v1'] };
    expect(await t3.access(alice, 'box-1')).toMatchObject({ ok: false, status: 501, code: 'box_outdated' });
    instances.get('box-1')!.status = 'terminated';
    expect(await t3.access(alice, 'box-1')).toMatchObject({ ok: false, status: 404 });
  });
});

describe('ensure tells the box its Fireworks models', () => {
  const KIMI = 'accounts/fireworks/models/kimi-k3';
  let models: { models: Array<{ id: string; label: string; context: number | null }>; defaultModel: string; fastModel: string } | null | Error;
  const withFireworks = createPrismaCliT3({
    tunnels: tunnels as never,
    flag: async () => true,
    transport: () => agent as never,
    send: async (boxId: string, type: string, payload: Record<string, unknown> = {}) => {
      rpcs.push([boxId, type, payload]);
      return { state: 'ready', port: 4100, version: '0.1.1', home: '/h' };
    },
    fireworksGateway: () => true,
    fireworks: async () => {
      if (models instanceof Error) throw models;
      return models;
    },
  });

  it('sends them to a box that takes Fireworks, null when they are off, and nothing it could not use', async () => {
    agent = { helloReceived: true, capabilities: ['t3-v1', 'fireworks-v1'] };
    models = { models: [{ id: KIMI, label: 'Kimi K3', context: 262144 }], defaultModel: KIMI, fastModel: KIMI };
    await withFireworks.ensure(alice, 'box-1');
    expect(rpcs.at(-1)![2]).toEqual({ label: 'devbox', fireworks: { models: [{ id: KIMI, context: 262144 }], defaultModel: KIMI } });
    models = null;
    await withFireworks.ensure(alice, 'box-1');
    expect(rpcs.at(-1)![2]).toEqual({ label: 'devbox', fireworks: null });
    // Unreadable flags: the box keeps what it has.
    models = new Error('the flag source is down');
    await withFireworks.ensure(alice, 'box-1');
    expect(rpcs.at(-1)![2]).toEqual({ label: 'devbox' });
    // A box without the Fireworks delivery has no pi-model to add them with.
    agent = { helloReceived: true, capabilities: ['t3-v1'] };
    models = { models: [{ id: KIMI, label: 'Kimi K3', context: null }], defaultModel: KIMI, fastModel: KIMI };
    await withFireworks.ensure(alice, 'box-1');
    expect(rpcs.at(-1)![2]).toEqual({ label: 'devbox' });
  });
});

describe('ensure, pair, projects', () => {
  it('ask the box\'s agent and shape its answers', async () => {
    // The directory can be there before the clone has moved in: the clone says when it is done.
    const clone = { state: 'cloning', setupStatus: 'cloning', error: null, repoUrl: 'https://github.com/a/sample', retryable: false };
    replies['t3-ensure'] = { state: 'ready', port: 4100, version: '0.1.1', home: '/home/a' };
    expect(await t3.ensure(alice, 'box-1')).toEqual({ status: 200, body: { state: 'ready', version: '0.1.1', home: '/home/a' } });
    replies['t3-pair'] = { credential: 'CRED', expiresAt: '2026-10-21T00:05:00.000Z' };
    expect(await t3.pair(alice, 'box-1', 'mbp')).toEqual({ status: 200, body: { credential: 'CRED', expiresAt: '2026-10-21T00:05:00.000Z' } });
    listProjects.mockResolvedValue([
      { id: 'p1', name: 'sample', box: { id: 'box-1', name: 'devbox' }, directory: '/home/a/termag/projects/sample', workstreams: ['main'], clone },
      { id: 'p2', name: 'elsewhere', box: { id: 'box-2', name: 'other' }, directory: '/home/a/termag/projects/elsewhere', workstreams: ['main'] },
    ]);
    replies['t3-paths'] = [{ path: '/Users/a/termag/projects/sample', exists: true }];
    expect(await t3.projects(alice, 'box-1')).toEqual({
      status: 200,
      body: { projects: [{ id: 'p1', name: 'sample', directory: '/Users/a/termag/projects/sample', exists: true, workstreams: ['main'], clone }] },
    });
    expect(rpcs.map(r => r[1])).toEqual(['t3-ensure', 't3-pair', 't3-paths']);
    expect(rpcs[0][2]).toEqual({ label: 'devbox' });
    expect(rpcs[1][2]).toEqual({ label: 'mbp' });
    expect(rpcs[2][2]).toEqual({ paths: ['/home/a/termag/projects/sample'] });
  });

  it('leave an automation\'s project out: its runs are not a project to open in t3', async () => {
    listProjects.mockResolvedValue([
      { id: 'p1', name: 'sample', box: { id: 'box-1', name: 'devbox' }, directory: '/home/a/termag/projects/sample', workstreams: ['main'] },
      { id: 'p3', name: 't3-nightly-bump-48bc6b', box: { id: 'box-1', name: 'devbox' }, directory: '/home/a/termag/projects/t3-nightly-bump-48bc6b', workstreams: ['main'] },
    ]);
    projectKinds.set('p3', { userId: 'alice', instanceId: 'box-1', kind: 'automation' });
    replies['t3-paths'] = [{ path: '/home/a/termag/projects/sample', exists: true }];
    expect(await t3.projects(alice, 'box-1')).toMatchObject({ status: 200, body: { projects: [{ id: 'p1' }] } });
    expect(rpcs).toEqual([['box-1', 't3-paths', { paths: ['/home/a/termag/projects/sample'] }]]);
  });

  it('refuse without asking the box when access does', async () => {
    flagOn = false;
    expect(await t3.ensure(alice, 'box-1')).toMatchObject({ status: 404 });
    expect(await t3.pair(alice, 'box-1', undefined)).toMatchObject({ status: 404 });
    expect(await t3.revoke(alice, 'box-1', 'L')).toMatchObject({ status: 404 });
    expect(await t3.projects(alice, 'box-1')).toMatchObject({ status: 404 });
    expect(rpcs).toEqual([]);
  });

  it('revoke a label on the box, and say when the box is too old to', async () => {
    replies['t3-revoke'] = { sessions: 2, pairings: 1 };
    expect(await t3.revoke(alice, 'box-1', 'termag-desktop 0a1b box-1')).toEqual({ status: 200, body: { revoked: { sessions: 2, pairings: 1 } } });
    expect(rpcs).toEqual([['box-1', 't3-revoke', { label: 'termag-desktop 0a1b box-1' }]]);
    replies['t3-revoke'] = new Error('Command failed: t3 auth session list');
    expect(await t3.revoke(alice, 'box-1', 'L')).toMatchObject({ status: 502, body: { code: 't3_failed' } });
    agent = { helloReceived: true, capabilities: ['t3-v1'] };
    expect(await t3.revoke(alice, 'box-1', 'L')).toMatchObject({ status: 501, body: { code: 'box_outdated' } });
    expect(await t3.revoke(alice, 'box-bob', 'L')).toMatchObject({ status: 404 });
    expect(rpcs).toHaveLength(2);
  });

  it('update the box to a release, label its environment, and say when the box can\'t', async () => {
    agent = { helloReceived: true, capabilities: ['t3-v1', 't3-revoke-v1', 't3-update-v1'] };
    replies['t3-update'] = { state: 'ready', port: 4100, version: '0.1.14', home: '/home/a' };
    expect(await t3.update(alice, 'box-1', '0.1.14')).toEqual({ status: 200, body: { state: 'ready', version: '0.1.14', home: '/home/a' } });
    expect(rpcs).toEqual([['box-1', 't3-update', { version: '0.1.14', label: 'devbox' }]]);
    replies['t3-update'] = new Error('could not install t3 0.1.14: release termag-desktop-v0.1.14 of a/b has no single linux-arm64 server tarball');
    expect(await t3.update(alice, 'box-1', '0.1.14')).toMatchObject({ status: 502, body: { code: 't3_failed', error: expect.stringContaining('no single linux-arm64 server tarball') } });
    // An older agent, or one running the owner's own t3: never asked.
    agent = { helloReceived: true, capabilities: ['t3-v1', 't3-revoke-v1'] };
    expect(await t3.update(alice, 'box-1', '0.1.14')).toMatchObject({ status: 501, body: { code: 'box_outdated' } });
    expect(await t3.update(alice, 'box-bob', '0.1.14')).toMatchObject({ status: 404 });
    flagOn = false;
    expect(await t3.update(alice, 'box-1', '0.1.14')).toMatchObject({ status: 404 });
    expect(rpcs).toHaveLength(2);
  });

  it('says box_not_ready, not box_outdated, when the agent drops between the access check and the revoke', async () => {
    let looks = 0;
    const dropping = createPrismaCliT3({
      tunnels: tunnels as never,
      flag: async () => flagOn,
      transport: () => (looks++ === 0 ? agent : null) as never,
      send: async () => { throw new Error('unused'); },
    });
    expect(await dropping.revoke(alice, 'box-1', 'L')).toMatchObject({ status: 409, body: { code: 'box_not_ready' } });
  });

  it('report an agent failure as t3_failed', async () => {
    replies['t3-pair'] = new Error('t3 printed no pairing credential');
    expect(await t3.pair(alice, 'box-1', undefined)).toMatchObject({ status: 502, body: { code: 't3_failed' } });
  });
});

describe('spaceSync', () => {
  it('has the box copy its spaces and passes on what it copied', async () => {
    const copied = { root: '/home/a/termag/spaces', default: 'team', spaces: [{ kind: 'synced', space: 'team', files: 3 }], removed: [] };
    replies['space-sync'] = copied;
    expect(await t3.spaceSync(alice, 'box-1', undefined)).toEqual({ status: 200, body: copied });
    expect(await t3.spaceSync(alice, 'box-1', 'team')).toEqual({ status: 200, body: copied });
    expect(rpcs).toEqual([['box-1', 'space-sync', {}], ['box-1', 'space-sync', { space: 'team' }]]);
  });

  it('refuses without asking the box: spaces off, an outdated box, or no access', async () => {
    spacesOn = false;
    expect(await t3.spaceSync(alice, 'box-1', undefined)).toMatchObject({ status: 404, body: { code: 'spaces_off' } });
    spacesOn = true;
    agent = { helloReceived: true, capabilities: ['t3-v1'] };
    expect(await t3.spaceSync(alice, 'box-1', undefined)).toMatchObject({ status: 501, body: { code: 'box_outdated' } });
    expect(await t3.spaceSync(alice, 'box-bob', undefined)).toMatchObject({ status: 404, body: { code: 'not_found' } });
    expect(rpcs).toEqual([]);
  });

  it('reports a failed copy as space_sync_failed', async () => {
    replies['space-sync'] = new Error('termag space sync: You reach no spaces');
    expect(await t3.spaceSync(alice, 'box-1', undefined)).toMatchObject({ status: 502, body: { code: 'space_sync_failed', error: expect.stringContaining('You reach no spaces') } });
  });
});

describe('openTunnel', () => {
  it('starts a server that is not running once, then retries', async () => {
    tunnels.openTunnel.mockRejectedValueOnce(new TunnelError(503, 't3_not_running', 'not running')).mockResolvedValueOnce({ stream: 's', port: 4100 });
    replies['t3-ensure'] = { state: 'ready', port: 4100, version: '0.1.1', home: '/h' };
    expect(await t3.openTunnel(alice, 'box-1')).toEqual({ stream: 's', port: 4100 });
    expect(tunnels.openTunnel).toHaveBeenCalledTimes(2);
    expect(rpcs.map(r => r[1])).toEqual(['t3-ensure']);
  });

  it('says starting when the server is not up yet, and passes other failures on', async () => {
    tunnels.openTunnel.mockRejectedValueOnce(new TunnelError(503, 't3_not_running', 'not running'));
    replies['t3-ensure'] = { state: 'starting', port: 4100, version: null, home: '/h' };
    await expect(t3.openTunnel(alice, 'box-1')).rejects.toMatchObject({ status: 503, code: 't3_starting' });
    tunnels.openTunnel.mockRejectedValueOnce(new TunnelError(429, 'too_many_tunnels', 'cap'));
    await expect(t3.openTunnel(alice, 'box-1')).rejects.toMatchObject({ code: 'too_many_tunnels' });
  });
});
