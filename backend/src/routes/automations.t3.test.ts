/**
 * Creating a t3 automation (routes/automations.ts): with no credential store
 * the task's webhook can't be kept, so nothing is made, rather than a project
 * archived behind a 503 that then blocks the name.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const created = vi.hoisted(() => ({ calls: 0, store: false }));
vi.mock('../db', () => ({
  prisma: {
    instance: { findFirst: async () => ({ id: 'box1', name: 'box', kind: 'ec2' }), findUnique: async () => ({ id: 'box1', name: 'box', kind: 'ec2' }) },
    project: { findFirst: async () => null },
    automation: { count: async () => 0 },
  },
}));
vi.mock('../middleware/auth', () => ({ requireAuth: () => {} }));
vi.mock('../services/featureFlags', () => ({ boolVariation: async () => true, jsonVariation: async () => null }));
vi.mock('../services/credentialStore', () => ({
  getCredentialStoreConfig: () => (created.store ? { kmsKeyArn: 'arn:aws:kms:us-east-1:1:key/x' } : null),
  writeCredentials: async () => {}, readCredential: async () => null, deleteCredentials: async () => {},
}));
vi.mock('../services/fireworksFlag', () => ({ fireworksOfferedTo: async () => null }));
vi.mock('./projects', () => ({
  createProjectFor: async () => { created.calls += 1; return { status: 500, body: {} }; },
  archiveOwnedProject: async () => ({}),
}));
vi.mock('./workstreams', () => ({ removeWorkstreamFor: async () => ({ status: 200, body: {} }) }));
vi.mock('../services/agentRegistry', () => ({ sendForProject: async () => ({}) }));
vi.mock('../services/automations/scheduler', () => ({ AUTOMATIONS_FLAG: 'automations-enabled', NOTES_PUSH_DELAY_MS: 0, decideAndStart: async () => ({ kind: 'start' }) }));
vi.mock('../services/automations/complete', () => ({ settleInterruptedRun: async () => {} }));
vi.mock('../services/automations/runner', () => ({ memoryDir: (home: string, id: string) => `${home}/.termag/automations/${id}/memory` }));
vi.mock('../services/automations/spaceSync', () => ({ SPACE_FOLDER_FLAG: 'automation-space-folder-enabled', SYNC_REFUSAL_TEXT: {}, checkSpaceForOwner: async () => ({ ok: true }), publishReadmeFor: async () => {} }));
vi.mock('../services/chatRunner', () => ({ chatKeyFor: (p: string, w: string) => `${p}--${w}` }));

const { createAutomationFor } = await import('./automations');

const user = { id: 'u1', unixUsername: 'alice', googleEmail: 'a@example.com', displayName: 'Alice' } as unknown as Express.User;
const body = {
  name: 'nightly-bump', instanceId: 'box1', schedule: '0 2 * * *', timezone: 'UTC', prompt: 'Bump dependencies',
  kind: 't3', t3: { taskId: 'scheduled-task:4f1c', hookPath: '/api/hooks/scheduled-task:4f1c/' + 'k'.repeat(43) },
};

beforeEach(() => {
  created.calls = 0;
  created.store = false;
});

describe('creating a t3 automation', () => {
  it('makes nothing when this termag has no credential store to keep the webhook', async () => {
    const res = await createAutomationFor(user, body);
    expect(res).toMatchObject({ status: 503, body: { code: 'credential_store_off' } });
    expect(created.calls).toBe(0);
  });

  it('goes on to make the project when there is one', async () => {
    created.store = true;
    await createAutomationFor(user, body);
    expect(created.calls).toBe(1);
  });
});
