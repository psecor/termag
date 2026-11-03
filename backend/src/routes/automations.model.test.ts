/**
 * PATCH /api/automations/:id with `backend` and `model` (routes/automations.ts,
 * services/automations/model.ts): the owner changes what the next run starts
 * on, validated as create is; main's agent row is the only row written, so a
 * run whose workstream exists keeps its own.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  automation: null as Record<string, unknown> | null,
  mainAgent: null as { id: string; provider: string | null; backend: string | null; model: string | null } | null,
  workflowUpdates: [] as Array<{ where: { id: string }; data: Record<string, unknown> }>,
  automationUpdates: [] as Array<Record<string, unknown>>,
  fireworks: null as unknown,
  flag: true,
}));

vi.mock('../db', () => ({
  prisma: {
    instance: { findUnique: async () => ({ id: 'box1', name: 'box', kind: 'box' }) },
    project: { updateMany: async () => ({ count: 0 }) },
    automation: {
      findFirst: async ({ where }: { where: { project: { OR: Array<{ userId?: string; shares?: { some: { userId: string } } }> } } }) => {
        const viewer = where.project.OR[0].userId!;
        const a = db.automation as { userId: string; shares: string[] } | null;
        return a && (a.userId === viewer || a.shares.includes(viewer)) ? db.automation : null;
      },
      count: async () => 0,
      update: async ({ data }: { data: Record<string, unknown> }) => { db.automationUpdates.push(data); return { ...db.automation!, ...data }; },
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
  boolVariation: async (key: string) => (key === 'automations-enabled' ? db.flag : false),
  jsonVariation: async () => null,
}));
vi.mock('../services/fireworksFlag', () => ({ fireworksOfferedTo: async () => db.fireworks }));
vi.mock('./projects', () => ({ createProjectFor: async () => ({ status: 500, body: {} }), archiveOwnedProject: async () => ({}) }));
vi.mock('./workstreams', () => ({ removeWorkstreamFor: async () => ({ status: 200, body: {} }) }));
vi.mock('../services/agentRegistry', () => ({ sendForProject: async () => ({}) }));
vi.mock('../services/automations/scheduler', () => ({ AUTOMATIONS_FLAG: 'automations-enabled', NOTES_PUSH_DELAY_MS: 0, decideAndStart: async () => ({ kind: 'start' }) }));
vi.mock('../services/automations/complete', () => ({ settleInterruptedRun: async () => {} }));
vi.mock('../services/automations/runner', () => ({ memoryDir: (home: string, id: string) => `${home}/.termag/automations/${id}/memory` }));
vi.mock('../services/automations/spaceSync', () => ({ SPACE_FOLDER_FLAG: 'automation-space-folder-enabled', SYNC_REFUSAL_TEXT: {}, checkSpaceForOwner: async () => ({ ok: true }), publishReadmeFor: async () => {} }));
vi.mock('../services/chatRunner', () => ({ chatKeyFor: (p: string, w: string) => `${p}--${w}` }));

const { updateAutomationFor, automationDetailFor } = await import('./automations');

const KIMI = 'accounts/fireworks/models/kimi-k3';
const FIREWORKS = { models: [{ id: KIMI, label: 'Kimi K3' }], defaultModel: KIMI, fastModel: KIMI };
const user = (id: string) => ({ id, googleEmail: `${id}@example.com`, unixUsername: id, displayName: id }) as unknown as Express.User;
const now = new Date('2026-10-29T12:00:00Z');

beforeEach(() => {
  db.automation = {
    id: 'a1', projectId: 'p1', userId: 'alice', shares: ['bob'], schedule: '0 9 * * *', timezone: 'UTC', prompt: 'triage', tier: 'full',
    enabled: true, prOnChange: true, wakeBox: false, notifySlack: false, maxRunMinutes: 60, keepRuns: 20,
    spaceName: null, spaceFolder: null, pausedReason: null, consecutiveFailures: 0, nextRunAt: null, lastOccurrence: null,
    createdAt: now, updatedAt: now,
    project: { name: 'triage', instanceId: 'box1', repoUrl: null, repoDefaultBranch: null, archived: false, userId: 'alice' },
  };
  db.mainAgent = { id: 'wf-main', provider: 'claude-chat', backend: null, model: 'sonnet' };
  db.workflowUpdates = [];
  db.automationUpdates = [];
  db.fireworks = FIREWORKS;
  db.flag = true;
});

describe('PATCH an automation\'s model', () => {
  it('shows main\'s choice on the view', async () => {
    const r = await automationDetailFor(user('alice'), 'a1');
    expect(r.body).toMatchObject({ chatProvider: 'claude-chat', backend: null, model: 'sonnet' });
  });

  it('moves the next runs to another Claude tier, writing only main\'s agent row', async () => {
    const r = await updateAutomationFor(user('alice'), 'a1', { backend: null, model: 'opus' });
    expect(r.status).toBe(200);
    expect(db.workflowUpdates).toEqual([{ where: { id: 'wf-main' }, data: { backend: null, model: 'opus' } }]);
    expect(r.body).toMatchObject({ backend: null, model: 'opus' });
    // The automation row itself gets no model column.
    expect(db.automationUpdates[0]).not.toHaveProperty('model');
  });

  it('moves them to one of the owner\'s Fireworks models, and back to Claude', async () => {
    let r = await updateAutomationFor(user('alice'), 'a1', { backend: 'fireworks', model: KIMI });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ backend: 'fireworks', model: KIMI });
    r = await updateAutomationFor(user('alice'), 'a1', { backend: null, model: 'haiku' });
    expect(r.body).toMatchObject({ backend: null, model: 'haiku' });
  });

  it('writes nothing when the choice is the one it has', async () => {
    const r = await updateAutomationFor(user('alice'), 'a1', { model: 'sonnet' });
    expect(r.status).toBe(200);
    expect(db.workflowUpdates).toEqual([]);
  });

  it('leaves the model alone on a save that does not name it', async () => {
    const r = await updateAutomationFor(user('alice'), 'a1', { prompt: 'triage harder' });
    expect(r.status).toBe(200);
    expect(db.workflowUpdates).toEqual([]);
  });

  it('refuses what create refuses, before writing anything', async () => {
    for (const body of [
      { model: 'gpt-9' },
      { backend: 'fireworks', model: 'accounts/fireworks/models/not-offered' },
      { backend: 'bedrock', model: 'opus' },
      { backend: 'fireworks', model: 'opus' },
    ]) {
      const r = await updateAutomationFor(user('alice'), 'a1', { ...body, prompt: 'changed too' });
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    db.fireworks = null;
    const off = await updateAutomationFor(user('alice'), 'a1', { backend: 'fireworks', model: KIMI });
    expect(off).toMatchObject({ status: 400, body: { error: 'Fireworks models are not on for you' } });
    expect(db.workflowUpdates).toEqual([]);
    expect(db.automationUpdates).toEqual([]);
  });

  it('is the owner\'s: a sharee is 403, a stranger 404, and the flag off is 403', async () => {
    expect((await updateAutomationFor(user('bob'), 'a1', { model: 'opus' })).status).toBe(403);
    expect((await updateAutomationFor(user('mallory'), 'a1', { model: 'opus' })).status).toBe(404);
    db.flag = false;
    expect((await updateAutomationFor(user('alice'), 'a1', { model: 'opus' })).status).toBe(403);
    expect(db.workflowUpdates).toEqual([]);
  });

  it('is a 409 on a project whose main has no agent row', async () => {
    db.mainAgent = null;
    const r = await updateAutomationFor(user('alice'), 'a1', { model: 'opus' });
    expect(r).toMatchObject({ status: 409, body: { code: 'no_agent' } });
    expect(db.automationUpdates).toEqual([]);
  });
});
