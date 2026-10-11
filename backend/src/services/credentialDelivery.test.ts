import { describe, it, expect, vi } from 'vitest';

const registry = vi.hoisted(() => ({ agent: null as unknown, sent: [] as unknown[] }));
const db = vi.hoisted(() => ({ updates: [] as { where: { id: string }; data: { githubDeliveredAt: Date | null } }[] }));
vi.mock('../db', () => ({
  prisma: {
    user: { findUnique: async () => ({ claudeGatewayEnabled: true }) },
    instance: {
      update: async (args: { where: { id: string }; data: { githubDeliveredAt: Date | null } }) => {
        db.updates.push(args);
        return {};
      },
    },
  },
}));
vi.mock('./agentRegistry', () => ({
  connectedOwnedBoxIds: () => [],
  instanceAgentTransport: () => registry.agent,
  sendToInstanceAgent: vi.fn(async (...args: unknown[]) => { registry.sent.push(args); }),
}));
const store = vi.hoisted(() => ({ config: null as unknown, read: async (): Promise<unknown> => null }));
vi.mock('./credentialStore', () => ({
  getCredentialStoreConfig: () => store.config,
  githubStoreDeps: () => ({ read: () => store.read() }),
}));

const { deliverToInstance, planDelivery, providersFor, refusalFor, REASONS } = await import('./credentialDelivery');

const ec2Box = { kind: 'owned-box', user: { id: 'u' }, instance: { id: 'i', userId: 'u', kind: 'ec2' } } as never;
const externalBox = { kind: 'owned-box', user: { id: 'u' }, instance: { id: 'i', userId: 'u', kind: 'external' } } as never;
const V1 = ['credentials-v1'];

const BROKER = { url: 'https://agent.termag.example.com', login: 'octocat' };
const BOTH = ['credentials-v1', 'github-broker-v1'];
const OFF = { claudeSettings: null, claudeOffReason: 'claude-why', githubBroker: null, githubOffReason: 'github-why' };
const ALL = BOTH;

describe('planDelivery', () => {
  it('sends a broker-capable box the broker, and no GitHub token or key', () => {
    const steps = planDelivery({ ...OFF, claudeSettings: { env: {} }, githubBroker: BROKER }, BOTH);
    expect(steps).toEqual([
      { type: 'credentials-apply', provider: 'claude-gateway', payload: { env: {} } },
      { type: 'credentials-apply', provider: 'github', payload: { broker: 'https://agent.termag.example.com', login: 'octocat' } },
    ]);
    expect(JSON.stringify(steps)).not.toMatch(/token|ssh|PRIVATE/i);
  });

  it('removes GitHub from an agent that only knows the pre-broker delivery', () => {
    const [, github] = planDelivery({ ...OFF, githubBroker: BROKER }, ['credentials-v1']);
    expect(github).toEqual({ type: 'credentials-remove', provider: 'github', reason: REASONS.oldAgent });
  });

  it('removes what is not stored, and says why, so a box without credentials is never silent', () => {
    expect(planDelivery(OFF, BOTH)).toEqual([
      { type: 'credentials-remove', provider: 'claude-gateway', reason: 'claude-why' },
      { type: 'credentials-remove', provider: 'github', reason: 'github-why' },
    ]);
  });
});

describe('providersFor', () => {
  it('offers the Claude gateway and GitHub to every agent', () => {
    expect(providersFor(BOTH)).toEqual(['claude-gateway', 'github']);
    expect(providersFor(V1)).toEqual(['claude-gateway', 'github']);
  });
});

describe('refusalFor', () => {
  it('needs a managed box, and nothing about how it connected', () => {
    expect(refusalFor({ conn: ec2Box, capabilities: V1 })).toBeNull();
    expect(refusalFor({ conn: { kind: 'user-agent', user: { id: 'u' } } as never, capabilities: V1 })).toBe(REASONS.notManaged);
  });

  it("never counts a user's own external machine, even with the capability", () => {
    expect(refusalFor({ conn: externalBox, capabilities: V1 })).toBe(REASONS.notManaged);
  });
});

describe('deliverToInstance', () => {
  const sentSteps = () => registry.sent.map(([, type, body]) => ({ type, ...(body as object) }));

  it('sends an external box no credential, only removes that say why', async () => {
    registry.agent = { conn: externalBox, capabilities: V1 };
    registry.sent = [];
    await deliverToInstance('i', 'u');
    expect(sentSteps()).toEqual([
      { type: 'credentials-remove', provider: 'claude-gateway', reason: REASONS.notManaged },
      { type: 'credentials-remove', provider: 'github', reason: REASONS.notManaged },
    ]);
  });

  it("plans a managed box's delivery from what is stored, not from how its agent connected", async () => {
    registry.agent = { conn: ec2Box, capabilities: V1 };
    registry.sent = [];
    await deliverToInstance('i', 'u');
    expect(sentSteps().map(s => (s as { reason?: string }).reason)).toEqual([REASONS.noGateway, REASONS.noStore]);
  });

  it('only removes, with reasons, on a managed box while the orchestrator has none of the env', async () => {
    registry.agent = { conn: ec2Box, capabilities: BOTH };
    registry.sent = [];
    await deliverToInstance('i', 'u');
    expect(sentSteps()).toEqual([
      { type: 'credentials-remove', provider: 'claude-gateway', reason: REASONS.noGateway },
      { type: 'credentials-remove', provider: 'github', reason: REASONS.noStore },
    ]);
  });

  it('tells a box it does not manage why it gets no credentials', async () => {
    registry.agent = { conn: externalBox, capabilities: V1 };
    registry.sent = [];
    await deliverToInstance('i', 'u');
    expect(sentSteps().map(s => (s as { provider?: string }).provider)).toEqual(['claude-gateway', 'github']);
  });

  it('still delivers Claude when the GitHub row cannot be decrypted, and leaves GitHub as it was', async () => {
    const env = {
      CLAUDE_GATEWAY_URL: 'https://claude-gateway.termag.example.com',
      CLAUDE_BEDROCK_REGION: 'us-east-2',
      CLAUDE_BEDROCK_MODELS: 'opus=us.anthropic.claude-opus-5-5,sonnet=us.anthropic.claude-sonnet-5-5,haiku=us.anthropic.claude-haiku-4-5',
      GITHUB_BROKER_URL: BROKER.url,
    };
    const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
    Object.assign(process.env, env);
    store.config = { kmsKeyId: 'k' };
    store.read = async () => { throw new Error('KMS unavailable'); };
    registry.agent = { conn: ec2Box, capabilities: ALL };
    registry.sent = [];
    try {
      await expect(deliverToInstance('i', 'u')).rejects.toThrow('KMS unavailable');
      expect(sentSteps().map(s => `${s.type} ${(s as { provider: string }).provider}`)).toEqual([
        'credentials-apply claude-gateway',
      ]);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      store.config = null;
      store.read = async () => null;
    }
  });

  it('sends nothing to an agent that predates credentials-v1', async () => {
    registry.agent = { conn: ec2Box, capabilities: [] };
    registry.sent = [];
    db.updates = [];
    await deliverToInstance('i', 'u');
    expect(registry.sent).toEqual([]);
    expect(db.updates).toEqual([]);
  });

  it('stamps githubDeliveredAt when the github apply resolves, and clears it on remove', async () => {
    const prev = process.env.GITHUB_BROKER_URL;
    process.env.GITHUB_BROKER_URL = 'https://agent.termag.example.com';
    store.config = { kmsKeyId: 'k' };
    registry.agent = { conn: ec2Box, capabilities: BOTH };
    try {
      store.read = async () => ({ login: 'octocat' });
      db.updates = [];
      registry.sent = [];
      await deliverToInstance('i', 'u');
      expect(db.updates).toHaveLength(1);
      expect(db.updates[0].where).toEqual({ id: 'i' });
      const stamped = db.updates[0].data.githubDeliveredAt;
      expect(stamped).toBeInstanceOf(Date);
      expect(Math.abs((stamped as Date).getTime() - Date.now())).toBeLessThan(5000);

      store.read = async () => null;
      db.updates = [];
      await deliverToInstance('i', 'u');
      expect(db.updates).toEqual([{ where: { id: 'i' }, data: { githubDeliveredAt: null } }]);
    } finally {
      if (prev === undefined) delete process.env.GITHUB_BROKER_URL;
      else process.env.GITHUB_BROKER_URL = prev;
      store.config = null;
      store.read = async () => null;
    }
  });

  it('does not stamp when the github send throws', async () => {
    const { sendToInstanceAgent } = await import('./agentRegistry');
    const prev = process.env.GITHUB_BROKER_URL;
    process.env.GITHUB_BROKER_URL = 'https://agent.termag.example.com';
    store.config = { kmsKeyId: 'k' };
    store.read = async () => ({ login: 'octocat' });
    registry.agent = { conn: ec2Box, capabilities: BOTH };
    db.updates = [];
    vi.mocked(sendToInstanceAgent).mockImplementation(async (...args: unknown[]) => {
      const body = args[2] as { provider?: string };
      if (body?.provider === 'github') throw new Error('broker down');
    });
    try {
      await expect(deliverToInstance('i', 'u')).rejects.toThrow('broker down');
      expect(db.updates).toEqual([]);
    } finally {
      vi.mocked(sendToInstanceAgent).mockImplementation(async (...args: unknown[]) => {
        registry.sent.push(args);
      });
      if (prev === undefined) delete process.env.GITHUB_BROKER_URL;
      else process.env.GITHUB_BROKER_URL = prev;
      store.config = null;
      store.read = async () => null;
    }
  });

  it('does not stamp when the only step is claude', async () => {
    const env = {
      CLAUDE_GATEWAY_URL: 'https://claude-gateway.termag.example.com',
      CLAUDE_BEDROCK_REGION: 'us-east-2',
      CLAUDE_BEDROCK_MODELS: 'opus=us.anthropic.claude-opus-5-5,sonnet=us.anthropic.claude-sonnet-5-5,haiku=us.anthropic.claude-haiku-4-5',
    };
    const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
    Object.assign(process.env, env);
    store.config = { kmsKeyId: 'k' };
    store.read = async () => { throw new Error('KMS unavailable'); };
    registry.agent = { conn: ec2Box, capabilities: V1 };
    registry.sent = [];
    db.updates = [];
    try {
      await expect(deliverToInstance('i', 'u')).rejects.toThrow('KMS unavailable');
      expect(sentSteps().map(s => `${s.type} ${(s as { provider: string }).provider}`)).toEqual([
        'credentials-apply claude-gateway',
      ]);
      expect(db.updates).toEqual([]);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      store.config = null;
      store.read = async () => null;
    }
  });
});
