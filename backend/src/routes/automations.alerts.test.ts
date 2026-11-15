/**
 * An automation's alert settings and webhook on PATCH and create
 * (routes/automations.ts, services/automations/alerts.ts and webhook.ts):
 * validated on save, refused with automation-alerts-enabled off, the
 * webhook's URL and secret sealed in the credential store and the secret
 * shown once.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  automation: null as Record<string, unknown> | null,
  mainAgent: null as { id: string; provider: string | null; backend: string | null; model: string | null } | null,
  workflowUpdates: [] as Array<{ where: { id: string }; data: Record<string, unknown> }>,
  automationUpdates: [] as Array<Record<string, unknown>>,
  fireworks: null as unknown,
  flag: true,
  alertsFlag: true,
  enabledCount: 0,
  failUpdate: false,
  createProject: false,
  deleted: [] as string[],
  failDelete: false,
  channelCheck: { ok: true } as { ok: true } | { ok: false; code: string; error: string },
  folders: false,
  readmes: [] as string[],
  readCred: (() => null) as () => unknown,
  store: true,
  creds: [] as Array<{ op: string; provider: string; value?: unknown }>,
}));

// Prisma's writes are lazy until awaited or handed to $transaction, which applies all or none.
const lazy = <T>(run: () => Promise<T>) => ({ run, then: (ok: (v: T) => unknown, bad?: (e: unknown) => unknown) => run().then(ok, bad) });
vi.mock('../db', () => ({
  prisma: {
    $transaction: async (ops: Array<{ run: () => Promise<unknown> }>) => {
      const before = { creds: [...db.creds], updates: [...db.automationUpdates] };
      const out: unknown[] = [];
      try {
        for (const op of ops) out.push(await op.run());
      } catch (err) {
        db.creds = before.creds;
        db.automationUpdates = before.updates;
        throw err;
      }
      return out;
    },
    userCredential: {
      upsert: ({ where, create }: { where: { userId_provider: { provider: string } }; create: { ciphertext: { sealed: unknown } } }) =>
        lazy(async () => { db.creds.push({ op: 'write', provider: where.userId_provider.provider, value: create.ciphertext.sealed }); return {}; }),
      deleteMany: ({ where }: { where: { provider: string } }) => lazy(async () => {
        if (db.failDelete) throw new Error('db down');
        db.creds.push({ op: 'delete', provider: where.provider });
        return { count: 1 };
      }),
    },
    instance: { findUnique: async () => ({ id: 'box1', name: 'box', kind: 'box' }), findFirst: async () => ({ id: 'box1', name: 'box', kind: 'box' }) },
    project: { updateMany: async () => ({ count: 0 }), findFirst: async () => null },
    user: { findUnique: async () => ({ id: 'alice', slackUserId: 'U-alice', googleEmail: 'alice@example.com' }) },
    automation: {
      findFirst: async ({ where }: { where: { project: { OR: Array<{ userId?: string; shares?: { some: { userId: string } } }> } } }) => {
        const viewer = where.project.OR[0].userId!;
        const a = db.automation as { userId: string; shares: string[] } | null;
        return a && (a.userId === viewer || a.shares.includes(viewer)) ? db.automation : null;
      },
      count: async () => db.enabledCount,
      create: async ({ data }: { data: Record<string, unknown> }) => ({ ...db.automation!, ...data, id: 'cmauto00002', project: db.automation!.project }),
      delete: async ({ where }: { where: { id: string } }) => { db.deleted.push(where.id); return {}; },
      update: ({ data }: { data: Record<string, unknown> }) => lazy(async () => {
        if (db.failUpdate) throw new Error('db down');
        db.automationUpdates.push(data);
        return { ...db.automation!, ...data };
      }),
    },
    automationRun: { findFirst: async () => null, findMany: async () => [] },
    workflow: {
      findFirst: async () => db.mainAgent,
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        db.workflowUpdates.push(args);
        db.mainAgent = { ...db.mainAgent!, ...args.data } as typeof db.mainAgent;
        return db.mainAgent;
      },
    },
  },
}));
vi.mock('../middleware/auth', () => ({ requireAuth: () => {} }));
vi.mock('../services/featureFlags', () => ({
  boolVariation: async (key: string) => (key === 'automations-enabled' ? db.flag : key === 'automation-alerts-enabled' ? db.alertsFlag : key === 'automation-space-folder-enabled' ? db.folders : false),
  jsonVariation: async () => null,
}));
vi.mock('../services/credentialStore', () => ({
  getCredentialStoreConfig: () => (db.store ? { kmsKeyArn: 'arn:aws:kms:us-east-1:1:key/x' } : null),
  sealCredential: async (_cfg: unknown, _u: string, _provider: string, value: unknown) => ({ sealed: value }),
  readCredential: async () => db.readCred(),
  deleteCredentials: async (_u: string, providers: string[]) => {
    if (db.failDelete) throw new Error('db down');
    for (const provider of providers) db.creds.push({ op: 'delete', provider });
  },
}));
vi.mock('../services/automations/alertChannel', () => ({ checkAlertChannel: vi.fn(async () => db.channelCheck) }));
vi.mock('../services/fireworksFlag', () => ({ fireworksOfferedTo: async () => db.fireworks }));
vi.mock('./projects', () => ({ createProjectFor: async () => (db.createProject ? { status: 201, body: { id: 'p2', name: 'nightly' } } : { status: 500, body: {} }), archiveOwnedProject: async () => ({ status: 200, body: {} }) }));
vi.mock('./workstreams', () => ({ removeWorkstreamFor: async () => ({ status: 200, body: {} }) }));
vi.mock('../services/agentRegistry', () => ({ sendForProject: async () => ({}) }));
vi.mock('../services/automations/scheduler', () => ({ AUTOMATIONS_FLAG: 'automations-enabled', NOTES_PUSH_DELAY_MS: 0, decideAndStart: async () => ({ kind: 'start' }) }));
vi.mock('../services/automations/complete', () => ({ settleInterruptedRun: async () => {} }));
vi.mock('../services/automations/runner', () => ({ memoryDir: (home: string, id: string) => `${home}/.termag/automations/${id}/memory` }));
vi.mock('../services/automations/spaceSync', () => ({ SPACE_FOLDER_FLAG: 'automation-space-folder-enabled', SYNC_REFUSAL_TEXT: {}, checkSpaceForOwner: async () => ({ ok: true }), publishReadmeFor: async (id: string) => { db.readmes.push(id); } }));
vi.mock('../services/chatRunner', () => ({ chatKeyFor: (p: string, w: string) => `${p}--${w}` }));

const { updateAutomationFor, createAutomationFor, deleteAutomationFor } = await import('./automations');
const { checkAlertChannel } = await import('../services/automations/alertChannel');

const alice = { id: 'alice', googleEmail: 'alice@example.com', unixUsername: 'alice', displayName: 'alice' } as unknown as Express.User;
const now = new Date('2026-11-09T12:00:00Z');

beforeEach(() => {
  db.automation = {
    id: 'cmauto00001', projectId: 'p1', userId: 'alice', shares: [], schedule: '0 9 * * *', timezone: 'UTC', prompt: 'triage', tier: 'full', kind: 'chat',
    enabled: true, prOnChange: true, wakeBox: false, notifySlack: false, maxRunMinutes: 60, keepRuns: 20,
    alertPrefix: null, alertRegex: null, alertTarget: 'dm', healthAlerts: true, webhookHost: null,
    spaceName: null, spaceFolder: null, pausedReason: null, consecutiveFailures: 0, boxStartFailures: 0, nextRunAt: null, lastOccurrence: null,
    createdAt: now, updatedAt: now,
    project: { name: 'triage', instanceId: 'box1', repoUrl: null, repoDefaultBranch: null, archived: false, userId: 'alice' },
  };
  db.mainAgent = { id: 'wf-main', provider: 'claude-chat', backend: null, model: 'sonnet' };
  db.automationUpdates = [];
  db.flag = true;
  db.alertsFlag = true;
  db.store = true;
  db.creds = [];
  db.enabledCount = 0;
  db.failUpdate = false;
  db.createProject = false;
  db.deleted = [];
  db.failDelete = false;
  db.channelCheck = { ok: true };
  vi.mocked(checkAlertChannel).mockClear();
  db.folders = false;
  db.readmes = [];
  db.readCred = () => null;
});

describe('PATCH alert settings', () => {
  it('saves a prefix, a regex, a target and the health switch, and shows them', async () => {
    const r = await updateAutomationFor(alice, 'cmauto00001', { alertPrefix: 'BLOCKER:', alertRegex: '/fail(ed)?/i', alertTarget: 'C0123ABCD45', healthAlerts: false });
    expect(r.status).toBe(200);
    expect(db.automationUpdates.at(-1)).toMatchObject({ alertPrefix: 'BLOCKER:', alertRegex: '/fail(ed)?/i', alertTarget: 'C0123ABCD45', healthAlerts: false });
    expect(r.body).toMatchObject({ alertPrefix: 'BLOCKER:', alertRegex: '/fail(ed)?/i', alertTarget: 'C0123ABCD45', healthAlerts: false, webhook: null });
  });

  it('checks a Slack channel when it is chosen, and refuses one the owner is not in (or the bot cannot post to)', async () => {
    db.channelCheck = { ok: false, code: 'alert_channel_not_member', error: "You aren't a member of channel C0123ABCD45" };
    const r = await updateAutomationFor(alice, 'cmauto00001', { alertPrefix: 'BLOCKER:', alertTarget: 'C0123ABCD45' });
    expect(r).toMatchObject({ status: 400, body: { code: 'alert_channel_not_member' } });
    expect(db.automationUpdates).toEqual([]);
    expect(checkAlertChannel).toHaveBeenCalledWith({ id: 'alice', slackUserId: 'U-alice', googleEmail: 'alice@example.com' }, 'C0123ABCD45');
  });

  it('checks the channel of an automation created off, since Run now still runs it', async () => {
    db.channelCheck = { ok: false, code: 'alert_channel_bot_absent', error: 'no' };
    const r = await createAutomationFor(alice, { name: 'nightly', instanceId: 'box1', schedule: '0 2 * * *', timezone: 'UTC', prompt: 'x', enabled: false, alertPrefix: 'BLOCKER:', alertTarget: 'C0123ABCD45' });
    expect(r).toMatchObject({ status: 400, body: { code: 'alert_channel_bot_absent' } });
    expect(checkAlertChannel).toHaveBeenCalledTimes(1);
  });

  it('does not check the DM or the project channel', async () => {
    db.channelCheck = { ok: false, code: 'alert_channel_not_member', error: 'no' };
    for (const alertTarget of ['dm', 'project']) expect((await updateAutomationFor(alice, 'cmauto00001', { alertTarget })).status, alertTarget).toBe(200);
    expect(checkAlertChannel).not.toHaveBeenCalled();
  });

  it('checks a kept channel on every save, and refuses one the owner has since left, before anything is written', async () => {
    db.automation = { ...db.automation!, alertTarget: 'C0123ABCD45' };
    db.channelCheck = { ok: false, code: 'alert_channel_not_member', error: 'no' };
    for (const body of [{ alertTarget: 'C0123ABCD45' }, { prompt: 'triage again' }]) {
      expect(await updateAutomationFor(alice, 'cmauto00001', body)).toMatchObject({ status: 400, body: { code: 'alert_channel_not_member' } });
    }
    expect(checkAlertChannel).toHaveBeenCalledTimes(2);
    expect(db.automationUpdates).toEqual([]);
    // Pausing it is never refused.
    expect((await updateAutomationFor(alice, 'cmauto00001', { enabled: false })).status).toBe(200);
    expect(checkAlertChannel).toHaveBeenCalledTimes(2);
    // Any other save while it is off is checked (Run now still runs it), and so is turning it back on.
    db.automation = { ...db.automation!, enabled: false };
    expect(await updateAutomationFor(alice, 'cmauto00001', { prompt: 'later' })).toMatchObject({ status: 400, body: { code: 'alert_channel_not_member' } });
    expect(await updateAutomationFor(alice, 'cmauto00001', { enabled: true })).toMatchObject({ status: 400, body: { code: 'alert_channel_not_member' } });
    expect(checkAlertChannel).toHaveBeenCalledTimes(4);
    db.automation = { ...db.automation!, enabled: true };
    // Moving the alerts off the channel needs no check, so an owner who left can still fix it.
    expect((await updateAutomationFor(alice, 'cmauto00001', { alertTarget: 'dm' })).status).toBe(200);
    expect(checkAlertChannel).toHaveBeenCalledTimes(4);
  });

  it('refuses a regex that does not compile, or could backtrack for ever, before anything is written', async () => {
    for (const alertRegex of ['(open', '(a+)+$']) {
      const r = await updateAutomationFor(alice, 'cmauto00001', { alertRegex });
      expect(r.status, alertRegex).toBe(400);
      expect((r.body as { error: string }).error).toMatch(/alertRegex/);
    }
    expect(db.automationUpdates).toEqual([]);
  });

  it('with the flag off refuses a keyword, a channel or a webhook, but lets a form save the defaults back', async () => {
    db.alertsFlag = false;
    for (const body of [{ alertPrefix: 'BLOCKER:' }, { alertTarget: 'project' }, { webhook: { url: 'https://hooks.example.com/x' } }]) {
      expect(await updateAutomationFor(alice, 'cmauto00001', body), JSON.stringify(body)).toMatchObject({ status: 403, body: { code: 'automation_alerts_disabled' } });
    }
    expect((await updateAutomationFor(alice, 'cmauto00001', { alertPrefix: null, alertRegex: null, alertTarget: 'dm', healthAlerts: true })).status).toBe(200);
  });
});

describe('the webhook', () => {
  it('seals the URL with a fresh secret, keeps only the host on the row and shows the secret once', async () => {
    const r = await updateAutomationFor(alice, 'cmauto00001', { webhook: { url: 'https://hooks.example.com/services/x' } });
    expect(r.status).toBe(200);
    const secret = (r.body as { webhookSecret: string }).webhookSecret;
    expect(secret).toMatch(/^whsec_/);
    expect(db.creds).toEqual([{ op: 'write', provider: 'awh-cmauto00001', value: { url: 'https://hooks.example.com/services/x', secret } }]);
    expect(db.automationUpdates.at(-1)).toMatchObject({ webhookHost: 'hooks.example.com' });
    expect(JSON.stringify(db.automationUpdates)).not.toContain('services/x');
    expect(r.body).toMatchObject({ webhook: { host: 'hooks.example.com' } });
  });

  it('a save refused after its checks (the enabled limit) leaves the credential alone: no secret rotated behind the caller', async () => {
    db.automation = { ...db.automation!, enabled: false };
    db.enabledCount = 99;
    const r = await updateAutomationFor(alice, 'cmauto00001', { enabled: true, webhook: { url: 'https://hooks.example.com/new' } });
    expect(r.status).toBe(429);
    expect(db.creds).toEqual([]);
    expect(await updateAutomationFor(alice, 'cmauto00001', { enabled: true, webhook: null })).toMatchObject({ status: 429 });
    expect(db.creds).toEqual([]);
  });

  it('the credential and the row are one transaction: a row write that fails leaves the old credential in place', async () => {
    db.failUpdate = true;
    await expect(updateAutomationFor(alice, 'cmauto00001', { webhook: { url: 'https://hooks.example.com/new' } })).rejects.toThrow('db down');
    expect(db.creds).toEqual([]);
    expect(db.automationUpdates).toEqual([]);
  });

  it('a stored credential that can no longer be read (a retired key) does not block replacing it', async () => {
    db.readCred = () => { throw new Error('KMS: key disabled'); };
    const r = await updateAutomationFor(alice, 'cmauto00001', { webhook: { url: 'https://hooks.example.com/new' } });
    expect(r.status).toBe(200);
    expect(db.creds.map(c => c.op)).toEqual(['write']);
  });

  it('removing a webhook whose credential delete fails saves nothing: the row still names it, and the save fails', async () => {
    db.failDelete = true;
    await expect(updateAutomationFor(alice, 'cmauto00001', { webhook: null })).rejects.toThrow('db down');
    expect(db.automationUpdates).toEqual([]);
  });

  it('every committed save republishes the README of an automation in a space, a webhook removal included', async () => {
    db.automation = { ...db.automation!, spaceName: 'team' };
    db.folders = true;
    await updateAutomationFor(alice, 'cmauto00001', { webhook: null });
    expect(db.readmes).toEqual(['cmauto00001']);
  });

  it('null removes the URL and the secret', async () => {
    const r = await updateAutomationFor(alice, 'cmauto00001', { webhook: null });
    expect(r.status).toBe(200);
    expect(db.creds).toEqual([{ op: 'delete', provider: 'awh-cmauto00001' }]);
    expect(db.automationUpdates.at(-1)).toMatchObject({ webhookHost: null });
    expect(r.body).not.toHaveProperty('webhookSecret');
  });

  it('refuses a URL that is not https on a public host name, and answers 503 with no credential store', async () => {
    for (const url of ['http://hooks.example.com/x', 'https://169.254.169.254/latest', 'https://hooks.example.com:8080/x']) {
      expect((await updateAutomationFor(alice, 'cmauto00001', { webhook: { url } })).status, url).toBe(400);
    }
    db.store = false;
    expect(await updateAutomationFor(alice, 'cmauto00001', { webhook: { url: 'https://hooks.example.com/x' } })).toMatchObject({ status: 503, body: { code: 'credential_store_off' } });
    expect(db.creds).toEqual([]);
  });

  it('create with a webhook and no credential store makes nothing', async () => {
    db.store = false;
    const r = await createAutomationFor(alice, { name: 'nightly', instanceId: 'box1', schedule: '0 2 * * *', timezone: 'UTC', prompt: 'x', webhook: { url: 'https://hooks.example.com/x' } });
    expect(r).toMatchObject({ status: 503, body: { code: 'credential_store_off' } });
  });

  it('a create whose webhook transaction fails stores no credential and takes the automation back', async () => {
    db.createProject = true;
    db.failUpdate = true;
    const r = await createAutomationFor(alice, { name: 'nightly', instanceId: 'box1', schedule: '0 2 * * *', timezone: 'UTC', prompt: 'x', webhook: { url: 'https://hooks.example.com/x' } }).catch(err => err as Error);
    expect((r as Error).message).toBe('db down');
    expect(db.creds).toEqual([]);
    expect(db.deleted).toEqual(['cmauto00002']);
  });

  it('deleting the automation forgets its webhook, whatever the row says', async () => {
    for (const webhookHost of ['hooks.example.com', null]) {
      db.creds = [];
      db.automation = { ...db.automation!, webhookHost };
      await deleteAutomationFor(alice, 'cmauto00001');
      expect(db.creds, String(webhookHost)).toEqual([{ op: 'delete', provider: 'awh-cmauto00001' }]);
    }
  });
});
