/**
 * The CLI's automation routes (routes/cliAutomations.ts) against the web UI's
 * (routes/automations.ts), both over the same real handlers and one in-memory
 * database: whatever the browser refuses, a CLI sign-in is refused with the
 * same status and words, and a box's own credential is refused more (its box
 * only).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { CliSessionRecord, CliStore, CliUser } from '../services/cliStore';

interface Row {
  id: string; projectId: string; userId: string; schedule: string; timezone: string; prompt: string; tier: string;
  enabled: boolean; prOnChange: boolean; wakeBox: boolean; notifySlack: boolean; maxRunMinutes: number; keepRuns: number;
  spaceName: string | null; spaceFolder: string | null; pausedReason: string | null; consecutiveFailures: number;
  nextRunAt: Date | null; lastOccurrence: Date | null; createdAt: Date; updatedAt: Date;
  project: { name: string; instanceId: string | null; repoUrl: string | null; repoDefaultBranch: string | null; archived: boolean; userId: string };
  shares: string[];
}

const db = vi.hoisted(() => ({
  users: new Map<string, Record<string, unknown>>(),
  boxes: [] as Array<{ id: string; name: string; kind: string; userId: string; hostHome: string | null }>,
  automations: [] as unknown[],
  flag: true,
  limits: null as unknown,
  flagCalls: [] as Array<{ key: string; user: string; box: string | null }>,
  created: [] as Array<Record<string, unknown>>,
  /** The row create answered last: update finds it too, as the create route's folder write needs. */
  lastCreated: null as Record<string, unknown> | null,
  patched: [] as Array<Record<string, unknown>>,
  archived: [] as string[],
}));

const rows = () => db.automations as Row[];
const visible = (a: Row, userId: string) => a.project.userId === userId || a.shares.includes(userId);
const byId = (a: Row, id: string) => a.id === id || a.projectId === id;
const withProject = (a: Row) => ({ ...a, project: { ...a.project } });

vi.mock('../db', () => ({
  prisma: {
    user: { findUnique: async ({ where }: { where: { id: string } }) => db.users.get(where.id) ?? null },
    instance: {
      findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
        db.boxes.find(b => b.id === where.id && b.userId === where.userId) ?? null,
      findUnique: async ({ where }: { where: { id: string } }) => db.boxes.find(b => b.id === where.id) ?? null,
    },
    project: {
      findFirst: async () => null,
      updateMany: async () => ({ count: 0 }),
    },
    automation: {
      // automationFor and automationsFor (services/automations/store.ts): by id or project id, owner or share.
      findFirst: async ({ where }: { where: { OR: Array<{ id?: string; projectId?: string }>; project: { OR: Array<{ userId?: string; shares?: { some: { userId: string } } }> } } }) => {
        const id = where.OR[0].id ?? where.OR[1].projectId!;
        const userId = where.project.OR[0].userId!;
        const a = rows().find(r => byId(r, id) && visible(r, userId));
        return a ? withProject(a) : null;
      },
      findMany: async ({ where }: { where: { project: { OR: Array<{ userId?: string }> } } }) => {
        const userId = where.project.OR[0].userId!;
        return rows().filter(r => !r.project.archived && visible(r, userId)).map(withProject);
      },
      count: async () => 0,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        db.created.push(data);
        const now = new Date();
        return db.lastCreated = {
          id: 'a-new', enabled: true, notifySlack: false, pausedReason: null, consecutiveFailures: 0, spaceName: null, spaceFolder: null,
          createdAt: now, updatedAt: now, ...data,
          project: { name: 'nightly', instanceId: data.instanceId ?? 'i-a1', repoUrl: null, repoDefaultBranch: null, archived: false, userId: data.userId },
        };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        db.patched.push({ id: where.id, ...data });
        const a = rows().find(r => r.id === where.id);
        return a ? { ...withProject(a), ...data } : { ...db.lastCreated!, ...data };
      },
    },
    automationRun: { findFirst: async () => null, findMany: async () => [] },
    // Main's agent row, for the view's model (services/automations/model.ts): none here.
    workflow: { findFirst: async () => null },
  },
}));

// The browser's session: the signed-in user, from a header standing in for the cookie.
vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const user = db.users.get(String(req.headers['x-test-user'] ?? ''));
    if (!user) { res.status(401).json({ error: 'Unauthorized' }); return; }
    req.user = user as Express.User;
    next();
  },
}));

vi.mock('../services/featureFlags', () => ({
  boolVariation: async (key: string, user: { id: string }, _fallback: boolean, box?: { id: string } | null) => {
    db.flagCalls.push({ key, user: user.id, box: box?.id ?? null });
    return key === 'automations-enabled' ? db.flag : false;
  },
  jsonVariation: async () => db.limits,
}));

vi.mock('./projects', () => ({
  createProjectFor: async (_user: unknown, input: { name: string; instanceId: string; repoUrl: string | null }) => {
    db.created.push({ project: input });
    return { status: 201, body: { id: 'p-new', name: input.name, instanceId: input.instanceId, repoUrl: input.repoUrl, secretish: 'not for the CLI' } };
  },
  archiveOwnedProject: async (_user: unknown, id: string) => { db.archived.push(id); return { status: 200, body: { id, archived: true } }; },
}));
vi.mock('./workstreams', () => ({ removeWorkstreamFor: async () => ({ status: 200, body: {} }) }));
vi.mock('./cliLifecyclePrisma', () => ({
  prismaCliLifecycle: {
    projectRepoUrl: async (_user: unknown, box: string, project: string) => box === 'a1' && project === 'termag'
      ? { repoUrl: 'https://github.com/example/termag' }
      : { status: 404, body: { error: `No project ${box}/${project}`, code: 'not_found' } },
  },
}));
vi.mock('../services/agentRegistry', () => ({ sendForProject: async () => ({}) }));
vi.mock('../services/automations/scheduler', () => ({
  AUTOMATIONS_FLAG: 'automations-enabled',
  NOTES_PUSH_DELAY_MS: 0,
  decideAndStart: async () => ({ kind: 'start' }),
}));
vi.mock('../services/automations/complete', () => ({ settleInterruptedRun: async () => {} }));
vi.mock('../services/automations/report', () => ({ changesLabel: () => null }));
vi.mock('../services/automations/runner', () => ({ memoryDir: (home: string, id: string) => `${home}/.termag/automations/${id}/memory` }));
vi.mock('../services/automations/spaceSync', () => ({
  SPACE_FOLDER_FLAG: 'automation-space-folder-enabled',
  SYNC_REFUSAL_TEXT: {},
  checkSpaceForOwner: async () => ({ ok: true }),
  publishReadmeFor: async () => {},
}));
vi.mock('../services/chatRunner', () => ({ chatKeyFor: (p: string, w: string) => `${p}--${w}` }));

const { automationsRouter } = await import('./automations');
const { cliApiRouter } = await import('./cliApi');
const { prismaCliAutomations } = await import('./cliAutomationsPrisma');
const { AuthCodeStore, sha256Hex } = await import('../services/cliAuth');

const cliUser = (id: string): CliUser => ({ id, googleEmail: `${id}@example.com`, unixUsername: id, displayName: id });
const DEVICE: Record<string, string> = { alice: 'tmcli_' + 'a'.repeat(64), bob: 'tmcli_' + 'b'.repeat(64), carol: 'tmcli_' + 'c'.repeat(64) };
const BOX_A1 = 'tmag_alice_a1';
const BOX_A2 = 'tmag_alice_a2';
const BOX_NONE = 'tmag_alice_nobox';
const now = new Date('2026-10-27T12:00:00Z');

const store: CliStore = {
  async findSessionByHash(hash) {
    const who = Object.keys(DEVICE).find(u => sha256Hex(DEVICE[u]) === hash);
    if (!who) return null;
    return { id: `s-${who}`, userId: who, user: cliUser(who), deviceName: 'mbp', tokenPrefix: 'tmcli_xxx', createdAt: now, lastUsedAt: now, revokedAt: null } satisfies CliSessionRecord;
  },
  async validateAgentToken(raw) {
    if (raw === BOX_A1) return { user: cliUser('alice'), instanceId: 'i-a1' };
    if (raw === BOX_A2) return { user: cliUser('alice'), instanceId: 'i-a2' };
    if (raw === BOX_NONE) return { user: cliUser('alice'), instanceId: null };
    return null;
  },
  createSession: async () => { throw new Error('unused'); },
  findSessionById: async () => null,
  touchSession: async () => {},
  revokeSession: async () => {},
  listBoxes: async () => [],
  listProjects: async () => [],
  listDevices: async () => [],
  revokeDevice: async () => false,
};

function automation(id: string, owner: string, box: string, extra: Partial<Row> = {}): Row {
  return {
    id, projectId: `p-${id}`, userId: owner, schedule: '0 * * * *', timezone: 'UTC', prompt: 'do the thing', tier: 'full',
    enabled: true, prOnChange: true, wakeBox: false, notifySlack: false, maxRunMinutes: 60, keepRuns: 20,
    spaceName: null, spaceFolder: null, pausedReason: null, consecutiveFailures: 0, nextRunAt: null, lastOccurrence: null,
    createdAt: now, updatedAt: now,
    project: { name: id, instanceId: box, repoUrl: null, repoDefaultBranch: null, archived: false, userId: owner },
    shares: [], ...extra,
  };
}

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/automations', automationsRouter());
  app.use('/api/cli/v1', cliApiRouter({ store, codes: new AuthCodeStore(), jwt: new Promise(() => {}), now: () => now, automations: prismaCliAutomations }));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  db.users.clear();
  for (const id of ['alice', 'bob', 'carol']) db.users.set(id, { id, googleEmail: `${id}@example.com`, unixUsername: id, displayName: id, role: 'user' });
  db.boxes = [
    { id: 'i-a1', name: 'a1', kind: 'ec2', userId: 'alice', hostHome: '/home/alice' },
    { id: 'i-a2', name: 'a2', kind: 'ec2', userId: 'alice', hostHome: '/home/alice' },
    { id: 'i-b1', name: 'b1', kind: 'ec2', userId: 'bob', hostHome: '/home/bob' },
  ];
  db.automations = [
    automation('a-on-a1', 'alice', 'i-a1', { shares: ['carol'] }),
    automation('a-on-a2', 'alice', 'i-a2'),
    automation('b-on-b1', 'bob', 'i-b1'),
  ];
  db.flag = true;
  db.limits = null;
  db.flagCalls = [];
  db.created = [];
  db.lastCreated = null;
  db.patched = [];
  db.archived = [];
});

interface Answer { status: number; body: Record<string, unknown> & { error?: string; code?: string } }

async function call(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Answer> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Answer['body'] };
}

const browser = (user: string, method: string, path: string, body?: unknown) =>
  call(method, `/api/automations${path}`, { 'x-test-user': user }, body);
const cli = (token: string, method: string, path: string, body?: unknown) =>
  call(method, `/api/cli/v1/automations${path}`, { authorization: `Bearer ${token}` }, body);

/** The same request as the browser's session and as the user's CLI sign-in. */
async function both(user: string, method: string, path: string, body?: unknown): Promise<[Answer, Answer]> {
  return [await browser(user, method, path, body), await cli(DEVICE[user], method, path, body)];
}

function sameRefusal([web, term]: [Answer, Answer], status: number): void {
  expect(web.status).toBe(status);
  expect(term.status).toBe(status);
  expect(term.body.error).toBe(web.body.error);
  if (web.body.code) expect(term.body.code).toBe(web.body.code);
}

const create = (extra: Record<string, unknown> = {}) => ({ name: 'nightly', instanceId: 'i-a1', schedule: '*/15 * * * *', timezone: 'UTC', prompt: 'triage', ...extra });

describe('a CLI sign-in is refused as the browser is', () => {
  it("another user's automation is 404 for every operation", async () => {
    for (const [method, path, body] of [
      ['GET', '/b-on-b1'], ['PATCH', '/b-on-b1', { enabled: false }], ['POST', '/b-on-b1/run'],
      ['POST', '/b-on-b1/runs/r1/stop'], ['POST', '/b-on-b1/runs/r1/retire'], ['GET', '/b-on-b1/memory'], ['DELETE', '/b-on-b1'],
    ] as Array<[string, string, unknown?]>) {
      sameRefusal(await both('alice', method, path, body), 404);
    }
    expect(db.patched).toEqual([]);
    expect(db.archived).toEqual([]);
  });

  it('does not list another user\'s automations', async () => {
    const [web, term] = await both('alice', 'GET', '');
    expect(term.status).toBe(200);
    expect(term.body).toEqual(web.body);
    expect((term.body as unknown as Array<{ id: string }>).map(a => a.id)).toEqual(['a-on-a1', 'a-on-a2']);
  });

  it('with automations-enabled off, create, edit and run now answer 403 automations_disabled, read for the same user and box', async () => {
    db.flag = false;
    sameRefusal(await both('alice', 'POST', '', create()), 403);
    sameRefusal(await both('alice', 'PATCH', '/a-on-a1', { prompt: 'x' }), 403);
    sameRefusal(await both('alice', 'POST', '/a-on-a1/run'), 403);
    const [, term] = await both('alice', 'POST', '/a-on-a1/run');
    expect(term.body.code).toBe('automations_disabled');
    // Every evaluation, the browser's and the CLI's, for alice on box a1.
    const gate = db.flagCalls.filter(c => c.key === 'automations-enabled');
    expect(gate.length).toBeGreaterThanOrEqual(6);
    expect(new Set(gate.map(c => `${c.user}@${c.box}`))).toEqual(new Set(['alice@i-a1']));
    expect(db.created).toEqual([]);
    expect(db.patched).toEqual([]);
  });

  it('refuses a schedule below the minimum interval, on create and on edit', async () => {
    sameRefusal(await both('alice', 'POST', '', create({ schedule: '*/5 * * * *' })), 400);
    const [web] = await both('alice', 'PATCH', '/a-on-a1', { schedule: '*/10 * * * *' });
    expect(web.body.error).toBe('schedule runs every 10 minutes; the minimum is 15');
    sameRefusal(await both('alice', 'PATCH', '/a-on-a1', { schedule: '*/10 * * * *' }), 400);
    expect(db.created).toEqual([]);
    expect(db.patched).toEqual([]);
  });

  it('follows automation-limits for the minimum, as the browser does', async () => {
    db.limits = { minIntervalMinutes: 60 };
    sameRefusal(await both('alice', 'POST', '', create({ schedule: '*/30 * * * *' })), 400);
    const [, term] = await both('alice', 'POST', '', create({ schedule: '*/30 * * * *' }));
    expect(term.body.error).toBe('schedule runs every 30 minutes; the minimum is 60');
  });

  it('a sharee may read but not change, run or delete', async () => {
    const [web, term] = await both('carol', 'GET', '/a-on-a1');
    expect(web.status).toBe(200);
    expect(term.status).toBe(200);
    expect(term.body).toMatchObject({ id: 'a-on-a1', owner: false });
    sameRefusal(await both('carol', 'PATCH', '/a-on-a1', { enabled: false }), 403);
    sameRefusal(await both('carol', 'POST', '/a-on-a1/run'), 403);
    sameRefusal(await both('carol', 'DELETE', '/a-on-a1'), 403);
  });

  it('refuses a box that is not yours, and the other validation, in the same words', async () => {
    sameRefusal(await both('alice', 'POST', '', create({ instanceId: 'i-b1' })), 400);
    sameRefusal(await both('alice', 'POST', '', create({ prompt: '' })), 400);
    sameRefusal(await both('alice', 'POST', '', create({ timezone: 'Mars/Olympus' })), 400);
    sameRefusal(await both('alice', 'POST', '', create({ tier: 'root' })), 400);
    sameRefusal(await both('alice', 'POST', '/preview', { schedule: 'every so often', timezone: 'UTC' }), 400);
  });
});

describe('what the CLI answers on success', () => {
  it('create: the automation, its next runs and only the project id and name', async () => {
    const res = await cli(DEVICE.alice, 'POST', '', create());
    expect(res.status).toBe(201);
    expect(res.body.project).toEqual({ id: 'p-new', name: 'nightly' });
    expect(res.body.automation).toMatchObject({ schedule: '*/15 * * * *', timezone: 'UTC', prompt: 'triage' });
    expect((res.body.next as string[]).length).toBe(3);
  });

  it('create --from <box>/<project> uses that project\'s repository', async () => {
    expect((await cli(DEVICE.alice, 'POST', '', create({ from: 'a1/termag' }))).status).toBe(201);
    expect(db.created[0]).toEqual({ project: expect.objectContaining({ repoUrl: 'https://github.com/example/termag' }) });
    const missing = await cli(DEVICE.alice, 'POST', '', create({ from: 'a1/nope' }));
    expect(missing).toMatchObject({ status: 404, body: { code: 'not_found' } });
  });

  it('pause is PATCH enabled false, as the web UI\'s Enabled switch', async () => {
    const res = await cli(DEVICE.alice, 'PATCH', '/a-on-a1', { enabled: false });
    expect(res.status).toBe(200);
    expect(db.patched[0]).toMatchObject({ id: 'a-on-a1', enabled: false, pausedReason: null });
  });

  it('preview answers as the browser\'s', async () => {
    const [web, term] = await both('alice', 'POST', '/preview', { schedule: '@hourly', timezone: 'UTC' });
    expect(term.status).toBe(200);
    expect(term.body).toMatchObject({ normalised: '0 * * * *', tooFrequent: null });
    expect(term.body.normalised).toBe(web.body.normalised);
  });
});

describe("a box's own credential: its box only", () => {
  it('lists, reads and changes the automations on its box', async () => {
    const list = await cli(BOX_A1, 'GET', '');
    expect((list.body as unknown as Array<{ id: string }>).map(a => a.id)).toEqual(['a-on-a1']);
    expect((await cli(BOX_A1, 'GET', '/a-on-a1')).status).toBe(200);
    expect((await cli(BOX_A1, 'PATCH', '/a-on-a1', { enabled: false })).status).toBe(200);
  });

  it("is 404 for the owner's automation on another box, which the browser and a sign-in may manage", async () => {
    expect((await browser('alice', 'GET', '/a-on-a2')).status).toBe(200);
    expect((await cli(DEVICE.alice, 'GET', '/a-on-a2')).status).toBe(200);
    for (const [method, path] of [['GET', '/a-on-a2'], ['PATCH', '/a-on-a2'], ['POST', '/a-on-a2/run'], ['POST', '/a-on-a2/runs/r1/stop'], ['DELETE', '/a-on-a2']]) {
      expect(await cli(BOX_A1, method, path, method === 'PATCH' ? { enabled: false } : undefined)).toEqual({ status: 404, body: { error: 'Automation not found', code: 'not_found' } });
    }
    expect((await cli(BOX_A2, 'GET', '/a-on-a2')).status).toBe(200);
    expect(db.patched).toEqual([]);
    expect(db.archived).toEqual([]);
  });

  it("is 404 for another user's automation, as for a sign-in", async () => {
    expect((await cli(BOX_A1, 'GET', '/b-on-b1')).status).toBe(404);
  });

  it('creates on its own box (the default) and nowhere else', async () => {
    const elsewhere = await cli(BOX_A1, 'POST', '', create({ instanceId: 'i-a2' }));
    expect(elsewhere).toMatchObject({ status: 403, body: { code: 'box_scope' } });
    const here = await cli(BOX_A1, 'POST', '', { ...create(), instanceId: undefined });
    expect(here.status).toBe(201);
    expect(db.created[0]).toEqual({ project: expect.objectContaining({ instanceId: 'i-a1' }) });
  });

  it('still meets the browser\'s gate and limits', async () => {
    expect((await cli(BOX_A1, 'POST', '', create({ schedule: '*/5 * * * *' }))).status).toBe(400);
    db.flag = false;
    expect(await cli(BOX_A1, 'POST', '/a-on-a1/run')).toMatchObject({ status: 403, body: { code: 'automations_disabled' } });
  });

  it('a box credential with no box is refused', async () => {
    expect(await cli(BOX_NONE, 'GET', '')).toMatchObject({ status: 403, body: { code: 'box_scope' } });
    expect(await cli(BOX_NONE, 'POST', '', create())).toMatchObject({ status: 403, body: { code: 'box_scope' } });
  });

  it('no credential is 401', async () => {
    expect((await call('GET', '/api/cli/v1/automations', {})).status).toBe(401);
  });
});

describe('the space folder is fixed (decision 13)', () => {
  const create = { name: 'nightly', instanceId: 'i-a1', schedule: '0 * * * *', timezone: 'UTC', prompt: 'p' };

  it('a create in a space stores .termag/automations/<automation id>, on both surfaces', async () => {
    for (const send of [() => browser('alice', 'POST', '', { ...create, spaceName: 'team' }), () => cli(DEVICE.alice, 'POST', '', { ...create, spaceName: 'team' })]) {
      db.patched = [];
      const r = await send();
      expect(r.status).toBe(201);
      expect(db.created.at(-1)).not.toHaveProperty('spaceFolder');
      expect(db.patched).toEqual([{ id: 'a-new', spaceFolder: '.termag/automations/a-new' }]);
      expect(r.body.automation).toMatchObject({ spaceName: 'team', spaceFolder: '.termag/automations/a-new' });
    }
  });

  it('a create with no space stores no folder', async () => {
    expect((await browser('alice', 'POST', '', create)).status).toBe(201);
    expect(db.patched).toEqual([]);
  });

  it('a create naming a folder is a 400 space_folder_fixed, and creates nothing', async () => {
    for (const send of [() => browser('alice', 'POST', '', { ...create, spaceName: 'team', spaceFolder: 'reports/x' }), () => cli(DEVICE.alice, 'POST', '', { ...create, spaceName: 'team', spaceFolder: 'reports/x' })]) {
      const r = await send();
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: "An automation's space folder is fixed (.termag/automations/<automation id>); leave spaceFolder out", code: 'space_folder_fixed' });
    }
    expect(db.created).toEqual([]);
  });

  it('attaching a space, or another one, writes the fixed folder', async () => {
    const r = await browser('alice', 'PATCH', '/a-on-a1', { spaceName: 'team' });
    expect(r.status).toBe(200);
    expect(db.patched[0]).toMatchObject({ id: 'a-on-a1', spaceName: 'team', spaceFolder: '.termag/automations/a-on-a1' });
    expect(r.body.spaceFolder).toBe('.termag/automations/a-on-a1');
  });

  it("a save that carries the same space back leaves an old row's folder alone, for the move script", async () => {
    rows()[0].spaceName = 'team';
    rows()[0].spaceFolder = 'automations/a-on-a1';
    const r = await browser('alice', 'PATCH', '/a-on-a1', { spaceName: 'team', prompt: 'q' });
    expect(r.status).toBe(200);
    expect(db.patched[0]).not.toHaveProperty('spaceFolder');
    expect(r.body.spaceFolder).toBe('automations/a-on-a1');
  });

  it('a PATCH naming another folder is a 400; the folder it has, sent back, is fine', async () => {
    rows()[0].spaceName = 'team';
    rows()[0].spaceFolder = '.termag/automations/a-on-a1';
    const refused = await cli(DEVICE.alice, 'PATCH', '/a-on-a1', { spaceFolder: 'jobs/x' });
    expect(refused).toEqual({ status: 400, body: { error: "An automation's space folder is fixed (.termag/automations/a-on-a1); leave spaceFolder out", code: 'space_folder_fixed' } });
    expect(db.patched).toEqual([]);
    expect((await browser('alice', 'PATCH', '/a-on-a1', { spaceFolder: '.termag/automations/a-on-a1', prompt: 'q' })).status).toBe(200);
  });
});
